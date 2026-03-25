/**
 * Chain Listener — monitors CyberGateway contract for on-chain events.
 *
 * Watches for:
 *   - DepositEvent: user deposited USDT → credit TEE ledger
 *   - WithdrawCompletedEvent: user withdrew → debit TEE ledger
 *   - BatchSettleEvent: batch settled on-chain → confirmation
 *
 * Uses TON API polling (getTransactions) since TON doesn't have
 * native event subscriptions. Polls every N seconds.
 */

import { TonClient, Address } from "@ton/ton";
import { Cell, Slice } from "@ton/core";

export interface ListenerConfig {
  /** TON RPC endpoint */
  rpcEndpoint: string;
  /** CyberGateway contract address */
  gatewayAddress: string;
  /** Toncenter API key (optional, avoids rate limiting) */
  apiKey?: string;
  /** Poll interval in ms (default: 5000) */
  pollIntervalMs?: number;
  /** Callbacks */
  onDeposit: (depositor: string, amount: bigint) => void;
  onWithdrawCompleted: (depositor: string, amount: bigint) => void;
  onBatchSettled: (batchId: bigint, count: number, totalAmount: bigint) => void;
}

// Tact events are emitted as external out messages

export class ChainListener {
  private client: TonClient;
  private config: ListenerConfig;
  private timer?: ReturnType<typeof setInterval>;
  private lastLt = "0";
  /** base64-encoded transaction hash (as expected by @ton/ton HttpApi) */
  private lastHash: string | undefined;
  private gatewayAddr: Address;

  constructor(config: ListenerConfig) {
    this.config = config;
    this.client = new TonClient({
      endpoint: config.rpcEndpoint,
      apiKey: config.apiKey,
    });
    this.gatewayAddr = Address.parse(config.gatewayAddress);
  }

  async start(): Promise<void> {
    // Initialize: get latest transaction to set cursor
    await this._initCursor();

    const interval = this.config.pollIntervalMs ?? 5_000;
    this.timer = setInterval(() => this._poll(), interval);
    console.log(
      `[listener] Started — polling ${this.config.gatewayAddress} every ${interval}ms`
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      console.log("[listener] Stopped");
    }
  }

  /** Get the last processed logical time (for persistence) */
  getLastLt(): string {
    return this.lastLt;
  }

  /** Resume from a previously saved cursor */
  setLastLt(lt: string, hash?: string): void {
    this.lastLt = lt;
    // Validate hash is base64 (not hex) — old versions stored hex incorrectly
    if (hash && /^[A-Za-z0-9+/=]+$/.test(hash) && hash.length <= 48) {
      this.lastHash = hash;
    } else {
      // Invalid or hex hash from old version — discard, will re-init
      this.lastHash = undefined;
      if (hash) console.log(`[listener] Discarded invalid stored hash, will re-init cursor`);
    }
  }

  private async _initCursor(): Promise<void> {
    // If we have lt but no hash (e.g. discarded invalid hash), re-fetch
    if (this.lastLt !== "0" && this.lastHash) {
      console.log(`[listener] Resuming from saved cursor lt=${this.lastLt}`);
      return;
    }
    try {
      const txs = await this.client.getTransactions(this.gatewayAddr, {
        limit: 1,
      });
      if (txs.length > 0) {
        this.lastLt = txs[0].lt.toString();
        this.lastHash = txs[0].hash().toString("base64");
        console.log(`[listener] Cursor initialized at lt=${this.lastLt}`);
      }
    } catch (err: any) {
      const msg = err?.response?.data?.error ?? err?.message ?? String(err);
      console.error(`[listener] Failed to init cursor: ${msg}`);
    }
  }

  private async _poll(): Promise<void> {
    try {
      // Fetch transactions after our cursor
      // Only pass hash if we have one — @ton/ton HttpApi expects base64
      const opts: any = {
        limit: 100,
        lt: this.lastLt,
        inclusive: false,
      };
      if (this.lastHash) opts.hash = this.lastHash;

      const txs = await this.client.getTransactions(this.gatewayAddr, opts);

      if (txs.length === 0) return;

      // Process oldest first
      const sorted = txs.reverse();

      for (const tx of sorted) {
        this._processTransaction(tx);
        this.lastLt = tx.lt.toString();
        this.lastHash = tx.hash().toString("base64");
      }
    } catch (err: any) {
      // Log concise error message, not the full AxiosError object
      const msg = err?.response?.data?.error ?? err?.message ?? String(err);
      console.error(`[listener] Poll error: ${msg}`);
    }
  }

  private _processTransaction(tx: any): void {
    // Tact emit() sends external out messages.
    // Event data is directly in msg.body with NO opcode prefix and NO ref wrapping.
    // TLB format: `_ field1 field2 ... = EventName`
    if (!tx.outMessages) return;

    for (const [, msg] of tx.outMessages) {
      if (msg.info.type !== "external-out") continue;
      if (!msg.body) continue;

      try {
        this._parseEvent(msg.body);
      } catch {
        // Not a recognized event, skip
      }
    }
  }

  private _parseEvent(body: Cell): void {
    // Tact events have NO opcode prefix. Data is directly in the cell.
    // We identify by field structure and bit count.

    const bits = body.beginParse().remainingBits;

    // BatchSettleEvent: uint64 + uint16 + coins + uint256 ≈ 338+ bits
    if (bits > 335) {
      try {
        const s = body.beginParse();
        if (this._tryParseBatchSettle(s)) return;
      } catch {}
    }

    // DepositEvent: address(267) + coins + coins ≈ 275-400+ bits
    // WithdrawCompletedEvent: address(267) + coins ≈ 271-390 bits
    // Try deposit first (3 fields), then withdraw (2 fields)
    try {
      const s = body.beginParse();
      if (this._tryParseDeposit(s)) return;
    } catch {}

    try {
      const s = body.beginParse();
      if (this._tryParseWithdraw(s)) return;
    } catch {}
  }

  private _tryParseDeposit(s: Slice): boolean {
    // DepositEvent: depositor(Address) + amount(coins) + new_balance(coins)
    const depositor = s.loadAddress();
    const amount = s.loadCoins();
    const newBalance = s.loadCoins();

    if (amount <= 0n) return false;

    console.log(
      `[listener] DepositEvent: ${depositor.toString()} +${amount} (balance: ${newBalance})`
    );
    this.config.onDeposit(depositor.toString(), amount);
    return true;
  }

  private _tryParseWithdraw(s: Slice): boolean {
    // WithdrawCompletedEvent: depositor(Address) + amount(coins)
    const depositor = s.loadAddress();
    const amount = s.loadCoins();

    if (amount <= 0n) return false;

    // Distinguish from DepositEvent: withdraw has exactly 2 fields
    // Check remaining bits — should be near 0
    if (s.remainingBits > 16) return false;

    console.log(
      `[listener] WithdrawCompletedEvent: ${depositor.toString()} -${amount}`
    );
    this.config.onWithdrawCompleted(depositor.toString(), amount);
    return true;
  }

  private _tryParseBatchSettle(s: Slice): boolean {
    // BatchSettleEvent: batch_id(uint64) + count(uint16) + total_amount(coins) + batch_data_hash(uint256)
    const batchId = s.loadUintBig(64);
    const count = s.loadUint(16);
    const totalAmount = s.loadCoins();
    s.loadUintBig(256); // batch_data_hash (not needed here)

    if (count <= 0 || count > 255) return false;
    if (totalAmount <= 0n) return false;

    console.log(
      `[listener] BatchSettleEvent: batch #${batchId}, ${count} transfers, total=${totalAmount}`
    );
    this.config.onBatchSettled(batchId, count, totalAmount);
    return true;
  }
}
