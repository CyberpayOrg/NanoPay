/**
 * Core types for CyberGateway TEE aggregator.
 */

/** A signed payment authorization from a buyer */
export interface PaymentAuthorization {
  from: string;       // TON address (base64/raw)
  to: string;         // Seller TON address
  amount: bigint;     // Jetton smallest unit
  validBefore: number; // Unix timestamp
  nonce: string;      // Hex string, 32 bytes — replay protection
  signature: string;  // Ed25519 signature (hex, 128 chars)
}

/** Result of verifying + deducting a payment */
export interface VerifyResult {
  success: boolean;
  error?: string;
  /** Remaining available balance after deduction */
  remainingBalance?: bigint;
  /** Unique confirmation ID */
  confirmationId?: string;
  /** Standardized TEE-signed receipt (only on success) */
  receipt?: import("./receipt").StandardReceipt;
}

/** A net position entry for batch settlement */
export interface NetPosition {
  from: string;
  to: string;
  amount: bigint;
}

/** A batch ready for onchain settlement */
export interface SettlementBatch {
  batchId: bigint;
  positions: NetPosition[];
  totalAmount: bigint;
  createdAt: number;
  /** If true, this batch contains large payments that need on-chain user sig verification */
  verified?: boolean;
}

/** Snapshot of a depositor's state */
export interface BalanceSnapshot {
  address: string;
  available: bigint;
  pendingOutgoing: bigint;
  totalDeposited: bigint;
  totalSpent: bigint;
}

/** TEE attestation info */
export interface AttestationInfo {
  teePublicKey: string;
  platform: string;
  codeHash: string;
  timestamp: number;
}

// ── Spending Limits & HITL ──

/** Per-depositor spending policy */
export interface SpendingPolicy {
  /** Max amount per single payment (0 = unlimited) */
  spendingLimit: bigint;
  /** Max total amount per day (0 = unlimited) */
  dailyCap: bigint;
  /** Amount above which HITL approval is required (0 = no HITL) */
  hitlThreshold: bigint;
}

/** HITL pending approval */
export interface PendingApproval {
  paymentId: string;
  auth: PaymentAuthorization;
  requestedAt: number;
  /** Telegram chat ID to notify */
  chatId?: string;
  status: "pending" | "approved" | "rejected" | "expired";
}

/** HITL approval callback */
export type ApprovalCallback = (
  paymentId: string,
  approved: boolean
) => void;

// ── Payment Receipt ──

// Standardized receipt types are in receipt.ts (COSE_Sign1-style with Merkle proofs)
// Re-export for backward compatibility
export type { StandardReceipt as PaymentReceipt } from "./receipt";
