/**
 * Ed25519 Signature Verifier
 *
 * Verifies payment authorizations signed by TON wallets.
 *
 * Authorization message format (for signing):
 *   prefix:      "CyberGateway:v1:" (ASCII)
 *   from:        32 bytes (TON address hash)
 *   to:          32 bytes (TON address hash)
 *   amount:      16 bytes (uint128 big-endian)
 *   validBefore: 8 bytes (uint64 big-endian)
 *   nonce:       32 bytes
 *
 * Total: 17 + 32 + 32 + 16 + 8 + 32 = 137 bytes
 * The signer signs sha256(message) with their Ed25519 private key.
 */

import nacl from "tweetnacl";
import { Address } from "@ton/core";
import { sha256_sync } from "@ton/crypto";
import type { PaymentAuthorization } from "./types";

const MESSAGE_PREFIX = Buffer.from("CyberGateway:v1:");

/**
 * Build the canonical message bytes for a payment authorization.
 */
export function buildAuthMessage(auth: PaymentAuthorization): Buffer {
  const fromAddr = Address.parse(auth.from);
  const toAddr = Address.parse(auth.to);

  const buf = Buffer.alloc(MESSAGE_PREFIX.length + 32 + 32 + 16 + 8 + 32);
  let offset = 0;

  // Prefix
  MESSAGE_PREFIX.copy(buf, offset);
  offset += MESSAGE_PREFIX.length;

  // From address (hash part, 32 bytes)
  const fromHash = fromAddr.hash;
  fromHash.copy(buf, offset);
  offset += 32;

  // To address (hash part, 32 bytes)
  const toHash = toAddr.hash;
  toHash.copy(buf, offset);
  offset += 32;

  // Amount (uint128 big-endian)
  const amountBuf = Buffer.alloc(16);
  let amt = auth.amount;
  for (let i = 15; i >= 0; i--) {
    amountBuf[i] = Number(amt & 0xffn);
    amt >>= 8n;
  }
  amountBuf.copy(buf, offset);
  offset += 16;

  // ValidBefore (uint64 big-endian)
  const timeBuf = Buffer.alloc(8);
  let ts = BigInt(auth.validBefore);
  for (let i = 7; i >= 0; i--) {
    timeBuf[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  timeBuf.copy(buf, offset);
  offset += 8;

  // Nonce (32 bytes)
  const nonceBuf = Buffer.from(auth.nonce, "hex");
  if (nonceBuf.length !== 32) throw new Error("Nonce must be 32 bytes");
  nonceBuf.copy(buf, offset);

  return buf;
}

/**
 * Verify an Ed25519 payment authorization.
 *
 * @param auth - The payment authorization with signature
 * @param publicKey - The signer's Ed25519 public key (32 bytes, hex)
 * @returns true if signature is valid
 */
export function verifyAuthorization(
  auth: PaymentAuthorization,
  publicKey: string
): boolean {
  try {
    const message = buildAuthMessage(auth);
    const messageHash = sha256_sync(message);
    const sig = Buffer.from(auth.signature, "hex");
    const pubkey = Buffer.from(publicKey, "hex");

    if (sig.length !== 64) return false;
    if (pubkey.length !== 32) return false;

    return nacl.sign.detached.verify(
      new Uint8Array(messageHash),
      new Uint8Array(sig),
      new Uint8Array(pubkey)
    );
  } catch {
    return false;
  }
}

/**
 * Sign a payment authorization (for testing / agent SDK).
 */
export function signAuthorization(
  auth: Omit<PaymentAuthorization, "signature">,
  secretKey: Buffer
): string {
  const message = buildAuthMessage({ ...auth, signature: "" });
  const messageHash = sha256_sync(message);
  const sig = nacl.sign.detached(
    new Uint8Array(messageHash),
    new Uint8Array(secretKey)
  );
  return Buffer.from(sig).toString("hex");
}

// Receipt signing is now handled by receipt.ts (COSE_Sign1-style with Merkle proofs)
