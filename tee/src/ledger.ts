/**
 * Offchain Balance Ledger
 *
 * The core of CyberGateway's nanopayment system.
 * Maintains real-time available balances for all depositors.
 *
 * This runs inside a Phala TEE — the ledger state is tamper-proof.
 * No one (including the operator) can forge balance changes.
 *
 * Key invariant: sum(all balances) == total onchain deposits - total settled
 */

import type { BalanceSnapshot, SpendingPolicy } from "./types";

/** Serializable ledger entry for persistence */
export interface LedgerSnapshot {
  address: string;
  balance: string;
  settledBalance: string;
  totalDeposited: string;
  totalSpent: string;
}

const SECONDS_PER_DAY = 86400;

export class Ledger {
  /** Available balance per address */
  private balances = new Map<string, bigint>();

  /** Cumulative stats per address */
  private totalDeposited = new Map<string, bigint>();
  private totalSpent = new Map<string, bigint>();

  /** Used nonces for replay protection */
  private usedNonces = new Set<string>();

  /** Global stats */
  private _totalDeposits = 0n;
  private _totalDeducted = 0n;

  /** Settled (on-chain confirmed) balance per address */
  private settledBalances = new Map<string, bigint>();

  /** Per-depositor spending policies */
  private policies = new Map<string, SpendingPolicy>();

  /** Daily spending tracker: address → { amount, resetTime } */
  private dailyTracker = new Map<string, { spent: bigint; resetTime: number }>();

  // ── Deposits (called when onchain deposit event is observed) ──

  /**
   * Credit a deposit to a user's available balance.
   * Called by the chain listener when a DepositEvent is detected onchain.
   */
  deposit(address: string, amount: bigint): void {
    if (amount <= 0n) throw new Error("Deposit amount must be positive");

    const current = this.balances.get(address) ?? 0n;
    this.balances.set(address, current + amount);

    const prevDeposited = this.totalDeposited.get(address) ?? 0n;
    this.totalDeposited.set(address, prevDeposited + amount);

    this._totalDeposits += amount;

    // Deposits are on-chain, so they're settled by definition
    const prevSettled = this.settledBalances.get(address) ?? 0n;
    this.settledBalances.set(address, prevSettled + amount);
  }

  // ── Spending Policies ──

  setPolicy(address: string, policy: SpendingPolicy): void {
    this.policies.set(address, policy);
  }

  getPolicy(address: string): SpendingPolicy | undefined {
    return this.policies.get(address);
  }

  /**
   * Get daily spent amount (resets automatically after 24h).
   */
  getDailySpent(address: string): bigint {
    const tracker = this.dailyTracker.get(address);
    if (!tracker) return 0n;
    if (Date.now() / 1000 >= tracker.resetTime) return 0n;
    return tracker.spent;
  }

  // ── Payment authorization verification + deduction ──

  /**
   * Check if a payment can be made and deduct immediately.
   * Returns { ok: true } or { ok: false, error, needsApproval }.
   *
   * needsApproval = true means the payment exceeds HITL threshold
   * and should be held for human approval.
   */
  tryDeduct(from: string, amount: bigint, nonce: string): {
    ok: boolean;
    error?: string;
    needsApproval?: boolean;
  } {
    // Replay protection
    if (this.usedNonces.has(nonce)) return { ok: false, error: "Nonce already used" };

    // Balance check
    const available = this.balances.get(from) ?? 0n;
    if (available < amount) return { ok: false, error: "Insufficient balance" };

    // Policy checks
    const policy = this.policies.get(from);
    if (policy) {
      // Per-payment spending limit
      if (policy.spendingLimit > 0n && amount > policy.spendingLimit) {
        return { ok: false, error: `Exceeds spending limit (${policy.spendingLimit})` };
      }

      // Daily cap
      if (policy.dailyCap > 0n) {
        const now = Math.floor(Date.now() / 1000);
        let tracker = this.dailyTracker.get(from);
        if (!tracker || now >= tracker.resetTime) {
          tracker = { spent: 0n, resetTime: now + SECONDS_PER_DAY };
        }
        if (tracker.spent + amount > policy.dailyCap) {
          return { ok: false, error: `Exceeds daily cap (${policy.dailyCap}, spent: ${tracker.spent})` };
        }
        // Update daily tracker (will be committed below)
        tracker.spent += amount;
        this.dailyTracker.set(from, tracker);
      }

      // HITL threshold — check BEFORE daily cap is committed
      if (policy.hitlThreshold > 0n && amount >= policy.hitlThreshold) {
        // Rollback daily tracker since we didn't actually deduct
        if (policy.dailyCap > 0n) {
          const tracker = this.dailyTracker.get(from);
          if (tracker) {
            tracker.spent -= amount;
            this.dailyTracker.set(from, tracker);
          }
        }
        return { ok: false, needsApproval: true, error: "Requires human approval" };
      }
    }

    // Atomic deduct
    this.balances.set(from, available - amount);
    this.usedNonces.add(nonce);

    // Stats
    const prevSpent = this.totalSpent.get(from) ?? 0n;
    this.totalSpent.set(from, prevSpent + amount);
    this._totalDeducted += amount;

    return { ok: true };
  }

  /**
   * Force deduct — bypasses policy checks (used after HITL approval).
   * Still checks balance and nonce.
   */
  forceDeduct(from: string, amount: bigint, nonce: string): {
    ok: boolean;
    error?: string;
  } {
    if (this.usedNonces.has(nonce)) return { ok: false, error: "Nonce already used" };

    const available = this.balances.get(from) ?? 0n;
    if (available < amount) return { ok: false, error: "Insufficient balance" };

    // Update daily tracker (approved HITL payments still count toward daily cap)
    const policy = this.policies.get(from);
    if (policy && policy.dailyCap > 0n) {
      const now = Math.floor(Date.now() / 1000);
      let tracker = this.dailyTracker.get(from);
      if (!tracker || now >= tracker.resetTime) {
        tracker = { spent: 0n, resetTime: now + SECONDS_PER_DAY };
      }
      tracker.spent += amount;
      this.dailyTracker.set(from, tracker);
    }

    this.balances.set(from, available - amount);
    this.usedNonces.add(nonce);

    const prevSpent = this.totalSpent.get(from) ?? 0n;
    this.totalSpent.set(from, prevSpent + amount);
    this._totalDeducted += amount;

    return { ok: true };
  }

  // ── Balance after batch settlement ──

  /**
   * After a batch is settled onchain, credit the receivers.
   * The senders were already deducted at authorization time.
   */
  creditSettlement(to: string, amount: bigint): void {
    const current = this.balances.get(to) ?? 0n;
    this.balances.set(to, current + amount);

    // Settlement is on-chain confirmed, so it's settled
    const prevSettled = this.settledBalances.get(to) ?? 0n;
    this.settledBalances.set(to, prevSettled + amount);
  }

  // ── Withdrawal lock ──

  /**
   * Lock funds for withdrawal (deduct from available).
   * Called when user initiates withdrawal.
   */
  lockForWithdrawal(address: string, amount: bigint): boolean {
    const available = this.balances.get(address) ?? 0n;
    if (available < amount) return false;
    this.balances.set(address, available - amount);
    return true;
  }

  /**
   * Unlock funds if withdrawal is cancelled.
   */
  unlockWithdrawal(address: string, amount: bigint): void {
    const current = this.balances.get(address) ?? 0n;
    this.balances.set(address, current + amount);
  }

  // ── Queries ──

  getBalance(address: string): bigint {
    return this.balances.get(address) ?? 0n;
  }

  /** Get the on-chain settled portion of balance */
  getSettledBalance(address: string): bigint {
    return this.settledBalances.get(address) ?? 0n;
  }

  getSnapshot(address: string): BalanceSnapshot {
    return {
      address,
      available: this.balances.get(address) ?? 0n,
      pendingOutgoing: 0n, // TODO: track pending batch amounts
      totalDeposited: this.totalDeposited.get(address) ?? 0n,
      totalSpent: this.totalSpent.get(address) ?? 0n,
    };
  }

  isNonceUsed(nonce: string): boolean {
    return this.usedNonces.has(nonce);
  }

  get totalDeposits(): bigint { return this._totalDeposits; }
  get totalDeducted(): bigint { return this._totalDeducted; }
  get accountCount(): number { return this.balances.size; }

  // ── Serialization (for persistence) ──

  /** Serialize ledger state for persistence */
  serialize(): LedgerSnapshot[] {
    const entries: LedgerSnapshot[] = [];
    const allAddresses = new Set([
      ...this.balances.keys(),
      ...this.totalDeposited.keys(),
      ...this.totalSpent.keys(),
      ...this.settledBalances.keys(),
    ]);

    for (const addr of allAddresses) {
      entries.push({
        address: addr,
        balance: (this.balances.get(addr) ?? 0n).toString(),
        settledBalance: (this.settledBalances.get(addr) ?? 0n).toString(),
        totalDeposited: (this.totalDeposited.get(addr) ?? 0n).toString(),
        totalSpent: (this.totalSpent.get(addr) ?? 0n).toString(),
      });
    }
    return entries;
  }

  /** Restore ledger state from persistence */
  restore(entries: LedgerSnapshot[]): void {
    this.balances.clear();
    this.totalDeposited.clear();
    this.totalSpent.clear();
    this.settledBalances.clear();
    this._totalDeposits = 0n;
    this._totalDeducted = 0n;

    for (const e of entries) {
      const balance = BigInt(e.balance);
      const settled = BigInt(e.settledBalance);
      const deposited = BigInt(e.totalDeposited);
      const spent = BigInt(e.totalSpent);

      if (balance !== 0n) this.balances.set(e.address, balance);
      if (settled !== 0n) this.settledBalances.set(e.address, settled);
      if (deposited !== 0n) this.totalDeposited.set(e.address, deposited);
      if (spent !== 0n) this.totalSpent.set(e.address, spent);

      this._totalDeposits += deposited;
      this._totalDeducted += spent;
    }

    console.log(`[ledger] Restored ${entries.length} accounts`);
  }

  // ── Nonce cleanup (prevent unbounded memory growth) ──

  /**
   * Prune old nonces. Call periodically.
   * In production, nonces should include a timestamp prefix
   * so we can prune by age.
   */
  pruneNonces(maxSize: number = 1_000_000): void {
    if (this.usedNonces.size > maxSize) {
      // Simple strategy: clear all and rely on validBefore expiry
      // In production, use a time-bucketed approach
      const arr = Array.from(this.usedNonces);
      const toRemove = arr.slice(0, arr.length - maxSize);
      for (const n of toRemove) {
        this.usedNonces.delete(n);
      }
    }
  }
}
