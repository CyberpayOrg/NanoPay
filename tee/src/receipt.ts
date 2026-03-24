/**
 * Standardized TEE Receipt — COSE_Sign1 inspired format
 *
 * Structure follows IETF SCITT / COSE_Sign1 principles:
 * - Protected header: algorithm + TEE attestation reference
 * - Payload: payment data + Merkle proof
 * - Signature: TEE Ed25519 signature
 *
 * Since we don't pull in a full CBOR library, we use a JSON-serializable
 * envelope that mirrors COSE_Sign1 semantics. Consumers can verify using
 * the TEE public key from the attestation endpoint.
 */

import nacl from "tweetnacl";
import { createHash } from "crypto";
import { MerkleTree, buildPaymentLeaf, type MerkleProof } from "./merkle";

// ── Types ──

/** COSE_Sign1-style protected header */
export interface ReceiptHeader {
  /** Signing algorithm */
  alg: "EdDSA";
  /** TEE platform identifier */
  teePlatform: string;
  /** Hash of the TEE code image (from attestation) */
  teeCodeHash: string;
  /** TEE public key (hex) — verifier cross-checks with attestation report */
  teePubkey: string;
  /** Content type */
  contentType: "application/cyberpay-receipt+json";
}

/** Receipt payload — the actual payment proof */
export interface ReceiptPayload {
  /** Unique confirmation ID */
  confirmationId: string;
  /** Buyer address */
  from: string;
  /** Seller address */
  to: string;
  /** Amount in smallest unit (string for JSON serialization) */
  amount: string;
  /** Original nonce */
  nonce: string;
  /** Unix timestamp when TEE confirmed */
  confirmedAt: number;
  /** Buyer's remaining balance after deduction (string) */
  remainingBalance: string;
  /** Batch ID if already settled (string or null) */
  batchId: string | null;
  /** Merkle proof linking this payment to the batch root */
  merkleProof: MerkleProof | null;
}

/** Complete COSE_Sign1-style receipt envelope */
export interface StandardReceipt {
  /** Version identifier */
  version: "CyberNanoPay:receipt:v2";
  /** Protected header (signed) */
  protected: ReceiptHeader;
  /** Receipt payload */
  payload: ReceiptPayload;
  /** Ed25519 signature over sha256(protected + payload) — hex */
  signature: string;
}

// ── Receipt Builder ──

export interface ReceiptBuilderConfig {
  teeSecretKey: Uint8Array;
  teePubkey: string;
  teePlatform: string;
  teeCodeHash: string;
}

export class ReceiptBuilder {
  private config: ReceiptBuilderConfig;

  constructor(config: ReceiptBuilderConfig) {
    this.config = config;
  }

  /** Build and sign a receipt for a single payment (before batch settlement) */
  buildReceipt(payment: {
    confirmationId: string;
    from: string;
    to: string;
    amount: bigint;
    nonce: string;
    confirmedAt: number;
    remainingBalance: bigint;
  }): StandardReceipt {
    const header: ReceiptHeader = {
      alg: "EdDSA",
      teePlatform: this.config.teePlatform,
      teeCodeHash: this.config.teeCodeHash,
      teePubkey: this.config.teePubkey,
      contentType: "application/cyberpay-receipt+json",
    };

    const payload: ReceiptPayload = {
      confirmationId: payment.confirmationId,
      from: payment.from,
      to: payment.to,
      amount: payment.amount.toString(),
      nonce: payment.nonce,
      confirmedAt: payment.confirmedAt,
      remainingBalance: payment.remainingBalance.toString(),
      batchId: null,
      merkleProof: null,
    };

    const signature = this._sign(header, payload);

    return {
      version: "CyberNanoPay:receipt:v2",
      protected: header,
      payload,
      signature,
    };
  }

  /**
   * Attach Merkle proof to existing receipts after batch is built.
   * Re-signs the receipt with the updated payload.
   */
  attachMerkleProofs(
    receipts: StandardReceipt[],
    batchId: bigint
  ): StandardReceipt[] {
    if (receipts.length === 0) return [];

    // Build Merkle tree from receipt payloads
    const leaves = receipts.map((r) =>
      buildPaymentLeaf({
        confirmationId: r.payload.confirmationId,
        from: r.payload.from,
        to: r.payload.to,
        amount: BigInt(r.payload.amount),
        nonce: r.payload.nonce,
        confirmedAt: r.payload.confirmedAt,
      })
    );

    const tree = new MerkleTree(leaves);

    // Update each receipt with Merkle proof and batch ID, re-sign
    return receipts.map((receipt, index) => {
      const updatedPayload: ReceiptPayload = {
        ...receipt.payload,
        batchId: batchId.toString(),
        merkleProof: tree.getProof(index),
      };

      const signature = this._sign(receipt.protected, updatedPayload);

      return {
        ...receipt,
        payload: updatedPayload,
        signature,
      };
    });
  }

  /** Get the Merkle root for a set of receipts (matches batch_data_hash on-chain) */
  computeMerkleRoot(receipts: StandardReceipt[]): string {
    const leaves = receipts.map((r) =>
      buildPaymentLeaf({
        confirmationId: r.payload.confirmationId,
        from: r.payload.from,
        to: r.payload.to,
        amount: BigInt(r.payload.amount),
        nonce: r.payload.nonce,
        confirmedAt: r.payload.confirmedAt,
      })
    );
    return new MerkleTree(leaves).root;
  }

  /** Sign: sha256(canonicalize(header) + canonicalize(payload)) */
  private _sign(header: ReceiptHeader, payload: ReceiptPayload): string {
    const message = this._buildSigningInput(header, payload);
    const sig = nacl.sign.detached(
      new Uint8Array(message),
      this.config.teeSecretKey
    );
    return Buffer.from(sig).toString("hex");
  }

  private _buildSigningInput(header: ReceiptHeader, payload: ReceiptPayload): Buffer {
    // Canonical JSON (sorted keys) → sha256
    const headerJson = JSON.stringify(header, Object.keys(header).sort());
    const payloadJson = JSON.stringify(payload, Object.keys(payload).sort());
    const combined = `${headerJson}\n${payloadJson}`;
    return createHash("sha256").update(combined).digest();
  }
}

// ── Verification (anyone can do this) ──

/**
 * Verify a StandardReceipt:
 * 1. Check TEE signature
 * 2. If Merkle proof present, verify it against the root
 */
export function verifyStandardReceipt(
  receipt: StandardReceipt,
  teePubkey?: string
): { valid: boolean; merkleValid?: boolean; error?: string } {
  try {
    const pubkeyHex = teePubkey ?? receipt.protected.teePubkey;
    const pubkey = Buffer.from(pubkeyHex, "hex");
    if (pubkey.length !== 32) return { valid: false, error: "Invalid TEE pubkey length" };

    // Rebuild signing input
    const headerJson = JSON.stringify(receipt.protected, Object.keys(receipt.protected).sort());
    const payloadJson = JSON.stringify(receipt.payload, Object.keys(receipt.payload).sort());
    const combined = `${headerJson}\n${payloadJson}`;
    const message = createHash("sha256").update(combined).digest();

    const sig = Buffer.from(receipt.signature, "hex");
    if (sig.length !== 64) return { valid: false, error: "Invalid signature length" };

    const sigValid = nacl.sign.detached.verify(
      new Uint8Array(message),
      new Uint8Array(sig),
      new Uint8Array(pubkey)
    );

    if (!sigValid) return { valid: false, error: "TEE signature invalid" };

    // Verify Merkle proof if present
    let merkleValid: boolean | undefined;
    if (receipt.payload.merkleProof) {
      const leaf = buildPaymentLeaf({
        confirmationId: receipt.payload.confirmationId,
        from: receipt.payload.from,
        to: receipt.payload.to,
        amount: BigInt(receipt.payload.amount),
        nonce: receipt.payload.nonce,
        confirmedAt: receipt.payload.confirmedAt,
      });
      const leafHash = createHash("sha256").update(leaf).digest("hex");
      merkleValid = MerkleTree.verify(leafHash, receipt.payload.merkleProof);
    }

    return { valid: true, merkleValid };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}
