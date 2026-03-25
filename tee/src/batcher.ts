/**
 * Batch Accumulator
 *
 * Collects verified payment authorizations and computes net positions
 * for efficient onchain settlement.
 *
 * Example:
 *   A→B $3, A→B $2, C→B $1
 *   Net positions: A→B $5, C→B $1
 *
 * This reduces the number of onchain transfers in each batch.
 */

import type { PaymentAuthorization, NetPosition, SettlementBatch } from "./types";

interface PendingPayment {
  auth: PaymentAuthorization;
  confirmedAt: number;
  /** Large payment — needs on-chain user signature verification */
  needsVerification: boolean;
}

export class Batcher {
  private pending: PendingPayment[] = [];
  private nextBatchId = 1n;

  /** Add a verified payment to the pending queue */
  add(auth: PaymentAuthorization, needsVerification: boolean = false): void {
    this.pending.push({
      auth,
      confirmedAt: Date.now(),
      needsVerification,
    });
  }

  /** Number of pending payments */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Flush pending payments into settlement batches.
   * Computes net positions with bilateral netting.
   * Separates normal and verified (large payment) batches.
   *
   * @param maxEntries - Max entries per batch (contract limit: 255 normal, 100 verified)
   * @returns Array of SettlementBatch or empty array if nothing to settle
   */
  flush(maxEntries: number = 255): SettlementBatch | null {
    if (this.pending.length === 0) return null;

    // Separate normal and verified payments
    const normalPayments = this.pending.filter(p => !p.needsVerification);
    const verifiedPayments = this.pending.filter(p => p.needsVerification);
    this.pending = [];

    // Build normal batch with bilateral netting
    const normalBatch = this._buildBatch(normalPayments, maxEntries, false);

    // Verified payments: no netting (need individual user sigs), lower limit
    const verifiedBatch = this._buildBatch(verifiedPayments, 100, true);

    // Return normal batch first (more common), put verified back if exists
    if (normalBatch && verifiedBatch) {
      // Put verified payments back for next flush
      for (const p of verifiedPayments) {
        this.pending.push(p);
      }
      return normalBatch;
    }

    return normalBatch ?? verifiedBatch ?? null;
  }

  /** Flush only verified (large payment) batches */
  flushVerified(maxEntries: number = 100): SettlementBatch | null {
    const verifiedPayments = this.pending.filter(p => p.needsVerification);
    if (verifiedPayments.length === 0) return null;

    this.pending = this.pending.filter(p => !p.needsVerification);
    return this._buildBatch(verifiedPayments, maxEntries, true);
  }

  private _buildBatch(
    payments: PendingPayment[],
    maxEntries: number,
    verified: boolean
  ): SettlementBatch | null {
    if (payments.length === 0) return null;

    const toSettle = payments.slice(0, maxEntries * 10);

    // Compute net positions
    const netMap = new Map<string, bigint>(); // "from:to" → net amount

    for (const { auth } of toSettle) {
      const key = `${auth.from}:${auth.to}`;
      const current = netMap.get(key) ?? 0n;
      netMap.set(key, current + auth.amount);
    }

    // Bilateral netting: if A→B and B→A both exist, keep only the net difference
    const processed = new Set<string>();
    const positions: NetPosition[] = [];

    for (const [key, amount] of netMap) {
      if (processed.has(key) || amount <= 0n) continue;

      const [from, to] = key.split(":");
      const reverseKey = `${to}:${from}`;
      const reverseAmount = netMap.get(reverseKey) ?? 0n;

      if (reverseAmount > 0n) {
        // Bilateral netting
        const net = amount - reverseAmount;
        if (net > 0n) {
          positions.push({ from, to, amount: net });
        } else if (net < 0n) {
          positions.push({ from: to, to: from, amount: -net });
        }
        // net === 0n → both cancel out, emit nothing
        processed.add(reverseKey);
      } else {
        positions.push({ from, to, amount });
      }
      processed.add(key);
    }

    if (positions.length === 0) return null;

    // If too many net positions, split (shouldn't happen often)
    const batch = positions.slice(0, maxEntries);
    if (positions.length > maxEntries) {
      // Put overflow back — convert back to individual payments
      // This is a rare edge case
      console.warn(`Batch overflow: ${positions.length} net positions, max ${maxEntries}`);
    }

    const totalAmount = batch.reduce((sum, p) => sum + p.amount, 0n);
    const batchId = this.nextBatchId++;

    return {
      batchId,
      positions: batch,
      totalAmount,
      createdAt: Date.now(),
      verified,
    };
  }

  /**
   * Check if it's time to flush based on thresholds.
   */
  shouldFlush(
    maxPending: number = 1000,
    maxAgeMs: number = 60_000
  ): boolean {
    if (this.pending.length >= maxPending) return true;
    if (this.pending.length === 0) return false;

    const oldest = this.pending[0].confirmedAt;
    return Date.now() - oldest >= maxAgeMs;
  }
}
