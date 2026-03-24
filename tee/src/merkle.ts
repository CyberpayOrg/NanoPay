/**
 * Merkle Tree for batch receipt proofs.
 *
 * Each leaf = sha256(receipt data for one payment).
 * Root is stored on-chain as batch_data_hash.
 * Individual Merkle proofs let any party verify their payment was in the batch.
 */

import { createHash } from "crypto";

export type MerkleProof = {
  /** Leaf index in the tree */
  index: number;
  /** Sibling hashes from leaf to root, each with direction */
  path: Array<{ hash: string; direction: "left" | "right" }>;
  /** The Merkle root */
  root: string;
};

/** SHA-256 hash, returns hex string */
function sha256(data: Buffer | string): string {
  return createHash("sha256")
    .update(typeof data === "string" ? Buffer.from(data, "hex") : data)
    .digest("hex");
}

/** Hash two nodes together (sorted for consistency) */
function hashPair(left: string, right: string): string {
  const buf = Buffer.alloc(64);
  Buffer.from(left, "hex").copy(buf, 0);
  Buffer.from(right, "hex").copy(buf, 32);
  return sha256(buf);
}

export class MerkleTree {
  readonly leaves: string[];
  readonly layers: string[][];
  readonly root: string;

  constructor(leafData: Buffer[]) {
    if (leafData.length === 0) {
      this.leaves = [];
      this.layers = [[]];
      this.root = sha256(Buffer.alloc(32));
      return;
    }

    // Hash each leaf
    this.leaves = leafData.map((d) => sha256(d));

    // Pad to power of 2 with duplicate of last leaf
    const padded = [...this.leaves];
    while (padded.length > 1 && (padded.length & (padded.length - 1)) !== 0) {
      padded.push(padded[padded.length - 1]);
    }

    // Build layers bottom-up
    this.layers = [padded];
    let current = padded;

    while (current.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i];
        const right = current[i + 1] ?? left;
        next.push(hashPair(left, right));
      }
      this.layers.push(next);
      current = next;
    }

    this.root = current[0];
  }

  /** Generate a Merkle proof for a leaf at the given index */
  getProof(index: number): MerkleProof {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error(`Index ${index} out of range [0, ${this.leaves.length})`);
    }

    const path: MerkleProof["path"] = [];
    let idx = index;

    // Pad index space to match padded tree
    for (let layer = 0; layer < this.layers.length - 1; layer++) {
      const currentLayer = this.layers[layer];
      const isRight = idx % 2 === 1;
      const siblingIdx = isRight ? idx - 1 : idx + 1;

      if (siblingIdx < currentLayer.length) {
        path.push({
          hash: currentLayer[siblingIdx],
          direction: isRight ? "left" : "right",
        });
      }

      idx = Math.floor(idx / 2);
    }

    return { index, path, root: this.root };
  }

  /** Verify a Merkle proof against a leaf hash and root */
  static verify(leafHash: string, proof: MerkleProof): boolean {
    let current = leafHash;

    for (const { hash, direction } of proof.path) {
      if (direction === "left") {
        current = hashPair(hash, current);
      } else {
        current = hashPair(current, hash);
      }
    }

    return current === proof.root;
  }
}

/** Build leaf data buffer for a payment (canonical format for Merkle tree) */
export function buildPaymentLeaf(payment: {
  confirmationId: string;
  from: string;
  to: string;
  amount: bigint;
  nonce: string;
  confirmedAt: number;
}): Buffer {
  // Simple canonical encoding: concat all fields as fixed-size buffers
  const buf = Buffer.alloc(16 + 64 + 64 + 16 + 32 + 8); // 200 bytes
  let offset = 0;

  // confirmationId (16 bytes)
  Buffer.from(payment.confirmationId, "hex").copy(buf, offset, 0, 16);
  offset += 16;

  // from address as UTF-8 padded to 64 bytes
  Buffer.from(payment.from).copy(buf, offset);
  offset += 64;

  // to address as UTF-8 padded to 64 bytes
  Buffer.from(payment.to).copy(buf, offset);
  offset += 64;

  // amount (uint128 big-endian)
  let amt = payment.amount;
  for (let i = offset + 15; i >= offset; i--) {
    buf[i] = Number(amt & 0xffn);
    amt >>= 8n;
  }
  offset += 16;

  // nonce (32 bytes)
  Buffer.from(payment.nonce, "hex").copy(buf, offset);
  offset += 32;

  // confirmedAt (uint64 big-endian)
  let ts = BigInt(payment.confirmedAt);
  for (let i = offset + 7; i >= offset; i--) {
    buf[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }

  return buf;
}
