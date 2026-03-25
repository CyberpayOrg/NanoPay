/**
 * TEE Aggregator — the brain of CyberNanoPay
 *
 * Orchestrates: signature verification → policy check → balance deduction → batching → settlement
 * Now with spending limits, daily caps, and HITL approval flow.
 *
 * This is the single source of truth for offchain balances.
 * Runs inside Phala TEE — state is tamper-proof.
 */

import { Ledger } from "./ledger";
import { Batcher } from "./batcher";
import { Settler, type SettlerConfig } from "./settler";
import { verifyAuthorization } from "./verifier";
import { ReceiptBuilder, type StandardReceipt } from "./receipt";
import type {
  PaymentAuthorization,
  VerifyResult,
  BalanceSnapshot,
  SpendingPolicy,
  PendingApproval,
  ApprovalCallback,
  SettlementBatch,
} from "./types";
import { randomBytes } from "crypto";

export interface AggregatorConfig {
  /** Known public keys per address (populated from onchain or registration) */
  publicKeyResolver: (address: string) => Promise<string | null>;

  /** Settler config for onchain submission */
  settler: SettlerConfig;

  /** TEE secret key for signing receipts (64 bytes) */
  teeSecretKey: Uint8Array;
  /** TEE public key hex */
  teePubkey: string;
  /** TEE platform identifier (e.g. "phala-sgx") */
  teePlatform?: string;
  /** TEE code image hash (from attestation) */
  teeCodeHash?: string;

  /** Max pending payments before auto-flush */
  batchMaxPending?: number;
  /** Max age of oldest pending payment before auto-flush (ms) */
  batchMaxAgeMs?: number;
  /** Auto-flush check interval (ms) — how often to check if flush is needed */
  flushCheckIntervalMs?: number;
  /** Min net amount (smallest unit) to trigger early flush */
  batchMinAmountFlush?: bigint;

  /** HITL: callback when a payment needs human approval */
  onApprovalNeeded?: (approval: PendingApproval) => void;
  /** HITL: auto-expire pending approvals after this many seconds (default: 300) */
  approvalTimeoutSec?: number;
}

export class Aggregator {
  private ledger = new Ledger();
  private batcher = new Batcher();
  private settler: Settler;
  private config: AggregatorConfig;
  private flushTimer?: ReturnType<typeof setInterval>;

  /** HITL: pending approvals waiting for human decision */
  private pendingApprovals = new Map<string, PendingApproval>();
  private approvalTimeout: number;

  /** Receipt store: confirmationId → receipt */
  private receipts = new Map<string, StandardReceipt>();
  /** Unsettled receipts waiting for Merkle proof attachment */
  private unsettledReceipts: StandardReceipt[] = [];
  private receiptBuilder: ReceiptBuilder;

  /** Failed batches waiting for retry */
  private failedBatches: Array<{ batch: SettlementBatch; attempts: number; nextRetryAt: number }> = [];

  constructor(config: AggregatorConfig) {
    this.config = config;
    this.settler = new Settler(config.settler);
    this.approvalTimeout = (config.approvalTimeoutSec ?? 300) * 1000;
    this.receiptBuilder = new ReceiptBuilder({
      teeSecretKey: config.teeSecretKey,
      teePubkey: config.teePubkey,
      teePlatform: config.teePlatform ?? "phala-sgx",
      teeCodeHash: config.teeCodeHash ?? "development",
    });
  }

  /** Start the auto-flush check timer. */
  start(): void {
    const interval = this.config.flushCheckIntervalMs ?? 30_000; // check every 30s
    this.flushTimer = setInterval(() => this.tryFlush(), interval);
    console.log(
      `[aggregator] Started — flush check every ${interval}ms, ` +
      `maxPending=${this.config.batchMaxPending ?? 5000}, ` +
      `maxAge=${this.config.batchMaxAgeMs ?? 3_600_000}ms`
    );
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  // ── Deposit (called by chain listener) ──

  recordDeposit(address: string, amount: bigint): void {
    this.ledger.deposit(address, amount);
    console.log(`[aggregator] Deposit: ${address} +${amount}`);
  }

  // ── Spending Policy Management ──

  setPolicy(address: string, policy: SpendingPolicy): void {
    this.ledger.setPolicy(address, policy);
    console.log(
      `[aggregator] Policy set for ${address}: ` +
      `limit=${policy.spendingLimit} dailyCap=${policy.dailyCap} hitl=${policy.hitlThreshold}`
    );
  }

  getPolicy(address: string): SpendingPolicy | undefined {
    return this.ledger.getPolicy(address);
  }

  getDailySpent(address: string): bigint {
    return this.ledger.getDailySpent(address);
  }

  // ── Payment verification (the hot path) ──

  /**
   * Verify a payment authorization and deduct from sender's balance.
   * Now enforces spending limits, daily caps, and HITL thresholds.
   */
  async verifyAndDeduct(auth: PaymentAuthorization): Promise<VerifyResult> {
    // 1. Basic validation
    if (auth.amount <= 0n) {
      return { success: false, error: "Amount must be positive" };
    }

    if (auth.validBefore <= Math.floor(Date.now() / 1000)) {
      return { success: false, error: "Authorization expired" };
    }

    if (this.ledger.isNonceUsed(auth.nonce)) {
      return { success: false, error: "Nonce already used (replay)" };
    }

    // 2. Resolve public key for the sender
    const pubkey = await this.config.publicKeyResolver(auth.from);
    if (!pubkey) {
      return { success: false, error: "Unknown sender (no public key)" };
    }

    // 3. Verify Ed25519 signature
    if (!verifyAuthorization(auth, pubkey)) {
      return { success: false, error: "Invalid signature" };
    }

    // 4. Check balance, policy, and deduct atomically
    const result = this.ledger.tryDeduct(auth.from, auth.amount, auth.nonce);

    if (!result.ok) {
      // HITL: payment needs human approval
      if (result.needsApproval) {
        const paymentId = randomBytes(8).toString("hex");
        const pending: PendingApproval = {
          paymentId,
          auth,
          requestedAt: Date.now(),
          status: "pending",
        };
        this.pendingApprovals.set(paymentId, pending);

        // Notify via callback (Telegram bot will hook into this)
        if (this.config.onApprovalNeeded) {
          this.config.onApprovalNeeded(pending);
        }

        console.log(
          `[aggregator] HITL: payment ${paymentId} from ${auth.from} ` +
          `amount=${auth.amount} held for approval`
        );

        return {
          success: false,
          error: `Payment held for approval (id: ${paymentId})`,
          confirmationId: paymentId,
        };
      }

      return { success: false, error: result.error };
    }

    // 5. Add to batch queue (mark large payments for on-chain verification)
    const policy = this.ledger.getPolicy(auth.from);
    const isLargePayment = policy?.hitlThreshold
      ? auth.amount >= policy.hitlThreshold
      : false;
    this.batcher.add(auth, isLargePayment);

    // 6. Generate confirmation + standardized TEE-signed receipt
    const confirmationId = randomBytes(16).toString("hex");
    const remainingBalance = this.ledger.getBalance(auth.from);
    const confirmedAt = Math.floor(Date.now() / 1000);

    const receipt = this.receiptBuilder.buildReceipt({
      confirmationId,
      from: auth.from,
      to: auth.to,
      amount: auth.amount,
      nonce: auth.nonce,
      confirmedAt,
      remainingBalance,
    });

    this.receipts.set(confirmationId, receipt);
    this.unsettledReceipts.push(receipt);

    console.log(
      `[aggregator] Payment confirmed: ${auth.from} → ${auth.to} ` +
      `amount=${auth.amount} remaining=${remainingBalance} conf=${confirmationId}`
    );

    return {
      success: true,
      remainingBalance,
      confirmationId,
      receipt,
    };
  }

  // ── HITL Approval Flow ──

  /**
   * Approve a pending payment. Called by Telegram bot after human confirms.
   */
  async approvePayment(paymentId: string): Promise<{ success: boolean; error?: string }> {
    const pending = this.pendingApprovals.get(paymentId);
    if (!pending) return { success: false, error: "No such pending approval" };
    if (pending.status !== "pending") return { success: false, error: `Already ${pending.status}` };

    // Check if expired
    if (Date.now() - pending.requestedAt > this.approvalTimeout) {
      pending.status = "expired";
      this.pendingApprovals.delete(paymentId);
      return { success: false, error: "Approval expired" };
    }

    // Now deduct with HITL bypass — use a fresh nonce check but skip policy
    const auth = pending.auth;
    const available = this.ledger.getBalance(auth.from);
    if (available < auth.amount) {
      pending.status = "rejected";
      this.pendingApprovals.delete(paymentId);
      return { success: false, error: "Insufficient balance (changed since request)" };
    }

    // Force deduct bypassing policy (nonce was not consumed in the initial tryDeduct)
    const deductResult = this.ledger.forceDeduct(auth.from, auth.amount, auth.nonce);
    if (!deductResult.ok) {
      pending.status = "rejected";
      this.pendingApprovals.delete(paymentId);
      return { success: false, error: deductResult.error };
    }

    // Add to batch (approved large payments always go to verified batch)
    this.batcher.add(auth, true);
    pending.status = "approved";
    this.pendingApprovals.delete(paymentId);

    console.log(`[aggregator] HITL: payment ${paymentId} APPROVED`);
    return { success: true };
  }

  /**
   * Reject a pending payment. Funds stay with sender.
   */
  rejectPayment(paymentId: string): { success: boolean; error?: string } {
    const pending = this.pendingApprovals.get(paymentId);
    if (!pending) return { success: false, error: "No such pending approval" };
    if (pending.status !== "pending") return { success: false, error: `Already ${pending.status}` };

    pending.status = "rejected";
    this.pendingApprovals.delete(paymentId);
    console.log(`[aggregator] HITL: payment ${paymentId} REJECTED`);
    return { success: true };
  }

  /** List all pending approvals */
  getPendingApprovals(): PendingApproval[] {
    // Clean up expired
    const now = Date.now();
    for (const [id, p] of this.pendingApprovals) {
      if (now - p.requestedAt > this.approvalTimeout) {
        p.status = "expired";
        this.pendingApprovals.delete(id);
      }
    }
    return Array.from(this.pendingApprovals.values());
  }

  // ── Batch settlement ──

  async tryFlush(): Promise<boolean> {
    const maxPending = this.config.batchMaxPending ?? 5000;
    const maxAge = this.config.batchMaxAgeMs ?? 3_600_000;

    // First, retry any failed batches that are due
    await this._retryFailedBatches();

    if (!this.batcher.shouldFlush(maxPending, maxAge)) {
      return false;
    }

    // Flush normal batch
    const batch = this.batcher.flush();
    let settled = false;

    if (batch) {
      settled = await this._settleBatch(batch);
    }

    // Also flush verified batch if any
    const verifiedBatch = this.batcher.flushVerified();
    if (verifiedBatch) {
      const vSettled = await this._settleBatch(verifiedBatch);
      settled = settled || vSettled;
    }

    return settled;
  }

  /** Settle a batch, with failure tracking for retry */
  private async _settleBatch(batch: SettlementBatch): Promise<boolean> {
    console.log(
      `[aggregator] Flushing batch #${batch.batchId}: ` +
      `${batch.positions.length} positions, total=${batch.totalAmount}` +
      (batch.verified ? " [VERIFIED]" : "")
    );

    try {
      const txRef = await this.settler.settle(batch);
      console.log(`[aggregator] Batch #${batch.batchId} settled: ${txRef}`);

      for (const pos of batch.positions) {
        this.ledger.creditSettlement(pos.to, pos.amount);
      }
      this._attachMerkleProofs(batch.batchId);
      return true;
    } catch (err) {
      console.error(`[aggregator] Batch #${batch.batchId} settlement failed:`, err);
      // Queue for retry with exponential backoff
      this.failedBatches.push({
        batch,
        attempts: 1,
        nextRetryAt: Date.now() + 30_000, // first retry in 30s
      });
      return false;
    }
  }

  /** Retry failed batches with exponential backoff (max 5 attempts) */
  private async _retryFailedBatches(): Promise<void> {
    if (this.failedBatches.length === 0) return;

    const now = Date.now();
    const stillFailed: typeof this.failedBatches = [];

    for (const entry of this.failedBatches) {
      if (now < entry.nextRetryAt) {
        stillFailed.push(entry);
        continue;
      }

      console.log(
        `[aggregator] Retrying batch #${entry.batch.batchId} (attempt ${entry.attempts + 1})`
      );

      try {
        const txRef = await this.settler.settle(entry.batch);
        console.log(`[aggregator] Batch #${entry.batch.batchId} retry succeeded: ${txRef}`);

        for (const pos of entry.batch.positions) {
          this.ledger.creditSettlement(pos.to, pos.amount);
        }
        this._attachMerkleProofs(entry.batch.batchId);
      } catch (err) {
        entry.attempts++;
        if (entry.attempts >= 5) {
          console.error(
            `[aggregator] Batch #${entry.batch.batchId} PERMANENTLY FAILED after ${entry.attempts} attempts. ` +
            `Manual intervention required. Positions: ${JSON.stringify(entry.batch.positions.map(p => ({
              from: p.from, to: p.to, amount: p.amount.toString()
            })))}`
          );
          // Don't re-queue — needs manual intervention
        } else {
          // Exponential backoff: 30s, 60s, 120s, 240s
          const delay = 30_000 * Math.pow(2, entry.attempts - 1);
          entry.nextRetryAt = Date.now() + delay;
          stillFailed.push(entry);
          console.error(
            `[aggregator] Batch #${entry.batch.batchId} retry failed (attempt ${entry.attempts}), ` +
            `next retry in ${delay / 1000}s`
          );
        }
      }
    }

    this.failedBatches = stillFailed;
  }

  async forceFlush(): Promise<boolean> {
    const batch = this.batcher.flush();
    if (!batch) return false;
    return this._settleBatch(batch);
  }

  /** Attach Merkle proofs to all unsettled receipts and update the receipt store */
  private _attachMerkleProofs(batchId: bigint): void {
    if (this.unsettledReceipts.length === 0) return;

    const toAttach = [...this.unsettledReceipts];
    this.unsettledReceipts = [];

    const updated = this.receiptBuilder.attachMerkleProofs(toAttach, batchId);

    for (const receipt of updated) {
      this.receipts.set(receipt.payload.confirmationId, receipt);
    }

    console.log(
      `[aggregator] Attached Merkle proofs to ${updated.length} receipts, ` +
      `batch #${batchId}, root=${updated[0]?.payload.merkleProof?.root ?? "n/a"}`
    );
  }

  // ── Queries ──

  getBalance(address: string): bigint {
    return this.ledger.getBalance(address);
  }

  /** Get the portion of balance that has been settled on-chain */
  getSettledBalance(address: string): bigint {
    return this.ledger.getSettledBalance(address);
  }

  getSnapshot(address: string): BalanceSnapshot {
    return this.ledger.getSnapshot(address);
  }

  /** Get a receipt by confirmation ID */
  getReceipt(confirmationId: string): StandardReceipt | undefined {
    return this.receipts.get(confirmationId);
  }

  /** Get all receipts for an address (as buyer or seller) */
  getReceipts(address: string, role: "from" | "to" | "both" = "both", limit = 50): StandardReceipt[] {
    const results: StandardReceipt[] = [];
    for (const r of this.receipts.values()) {
      if (role === "from" && r.payload.from !== address) continue;
      if (role === "to" && r.payload.to !== address) continue;
      if (role === "both" && r.payload.from !== address && r.payload.to !== address) continue;
      results.push(r);
      if (results.length >= limit) break;
    }
    return results;
  }

  getStats() {
    return {
      totalDeposits: this.ledger.totalDeposits,
      totalDeducted: this.ledger.totalDeducted,
      accountCount: this.ledger.accountCount,
      pendingBatchCount: this.batcher.pendingCount,
      pendingApprovalCount: this.pendingApprovals.size,
    };
  }

  /** Serialize ledger state for persistence */
  serializeLedger() {
    return this.ledger.serialize();
  }

  /** Restore ledger state from persistence */
  restoreLedger(entries: import("./ledger").LedgerSnapshot[]) {
    this.ledger.restore(entries);
  }
}
