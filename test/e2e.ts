/**
 * End-to-End Test — Full Nanopayment Flow
 *
 * Simulates:
 * 1. Agent deposits USDT (simulated)
 * 2. Agent signs payment authorization
 * 3. Seller verifies via TEE
 * 4. TEE deducts balance + adds to batch
 * 5. Batch settles (simulated)
 *
 * Run: npx tsx test/e2e.ts
 * Requires: TEE server running on localhost:4030
 */

import nacl from "tweetnacl";
import { Address } from "@ton/core";

const TEE_URL = "http://localhost:4030";
const GATEWAY_URL = "http://localhost:4031";

// Helper to generate a test TON address from a keypair
function keypairToAddress(publicKey: Buffer): string {
  // Simplified: use raw address format for testing
  // In production, derive from wallet contract
  return new Address(0, publicKey.subarray(0, 32)).toString();
}

async function main() {
  console.log("=== CyberNanoPay E2E Test ===\n");

  // ── Setup: Generate test keypairs ──

  const buyerKp = nacl.sign.keyPair();
  const sellerKp = nacl.sign.keyPair();

  const buyerAddress = keypairToAddress(Buffer.from(buyerKp.publicKey));
  const sellerAddress = keypairToAddress(Buffer.from(sellerKp.publicKey));

  console.log(`Buyer:  ${buyerAddress}`);
  console.log(`Seller: ${sellerAddress}`);
  console.log(`Buyer pubkey: ${Buffer.from(buyerKp.publicKey).toString("hex")}`);

  // ── Step 1: Register buyer's public key with TEE ──

  console.log("\n1. Registering buyer public key...");
  let res = await fetch(`${TEE_URL}/register-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: buyerAddress,
      publicKey: Buffer.from(buyerKp.publicKey).toString("hex"),
    }),
  });
  console.log("   →", await res.json());

  // ── Step 2: Simulate deposit ──

  console.log("\n2. Simulating deposit of 10,000,000 units (= $10 USDT)...");
  res = await fetch(`${TEE_URL}/simulate-deposit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: buyerAddress,
      amount: "10000000",
    }),
  });
  console.log("   →", await res.json());

  // ── Step 3: Check balance ──

  console.log("\n3. Checking balance...");
  res = await fetch(`${TEE_URL}/balance/${buyerAddress}`);
  console.log("   →", await res.json());

  // ── Step 4: Sign and submit payment authorization ──

  console.log("\n4. Signing payment authorization ($0.001 = 1000 units)...");

  const { randomBytes } = await import("crypto");
  const { sha256_sync } = await import("@ton/crypto");

  const MESSAGE_PREFIX = Buffer.from("CyberGateway:v1:");
  const nonce = randomBytes(32).toString("hex");
  const validBefore = Math.floor(Date.now() / 1000) + 300;
  const amount = 1000n;

  // Build message
  const fromAddr = Address.parse(buyerAddress);
  const toAddr = Address.parse(sellerAddress);
  const buf = Buffer.alloc(MESSAGE_PREFIX.length + 32 + 32 + 16 + 8 + 32);
  let offset = 0;

  MESSAGE_PREFIX.copy(buf, offset); offset += MESSAGE_PREFIX.length;
  fromAddr.hash.copy(buf, offset); offset += 32;
  toAddr.hash.copy(buf, offset); offset += 32;

  const amountBuf = Buffer.alloc(16);
  let amt = amount;
  for (let i = 15; i >= 0; i--) {
    amountBuf[i] = Number(amt & 0xffn);
    amt >>= 8n;
  }
  amountBuf.copy(buf, offset); offset += 16;

  const timeBuf = Buffer.alloc(8);
  let ts = BigInt(validBefore);
  for (let i = 7; i >= 0; i--) {
    timeBuf[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  timeBuf.copy(buf, offset); offset += 8;
  Buffer.from(nonce, "hex").copy(buf, offset);

  const messageHash = sha256_sync(buf);
  const sig = nacl.sign.detached(new Uint8Array(messageHash), buyerKp.secretKey);
  const signature = Buffer.from(sig).toString("hex");

  console.log(`   Nonce: ${nonce.substring(0, 16)}...`);
  console.log(`   Signature: ${signature.substring(0, 32)}...`);

  // Submit to TEE
  console.log("\n5. Submitting payment to TEE for verification...");
  res = await fetch(`${TEE_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: buyerAddress,
      to: sellerAddress,
      amount: amount.toString(),
      validBefore,
      nonce,
      signature,
    }),
  });
  const verifyResult = await res.json();
  console.log("   →", verifyResult);

  // ── Step 5: Check updated balance ──

  console.log("\n6. Checking balance after payment...");
  res = await fetch(`${TEE_URL}/balance/${buyerAddress}`);
  console.log("   Buyer:", await res.json());

  // ── Step 6: Try replay (should fail) ──

  console.log("\n7. Attempting replay attack (same nonce)...");
  res = await fetch(`${TEE_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: buyerAddress,
      to: sellerAddress,
      amount: amount.toString(),
      validBefore,
      nonce,
      signature,
    }),
  });
  console.log("   →", await res.json());

  // ── Step 7: Multiple payments ──

  console.log("\n8. Sending 100 rapid payments ($0.001 each)...");
  let successCount = 0;
  const start = Date.now();

  for (let i = 0; i < 100; i++) {
    const n = randomBytes(32).toString("hex");
    const vb = Math.floor(Date.now() / 1000) + 300;

    const b = Buffer.alloc(MESSAGE_PREFIX.length + 32 + 32 + 16 + 8 + 32);
    let o = 0;
    MESSAGE_PREFIX.copy(b, o); o += MESSAGE_PREFIX.length;
    fromAddr.hash.copy(b, o); o += 32;
    toAddr.hash.copy(b, o); o += 32;
    amountBuf.copy(b, o); o += 16;
    const tb = Buffer.alloc(8);
    let t = BigInt(vb);
    for (let j = 7; j >= 0; j--) { tb[j] = Number(t & 0xffn); t >>= 8n; }
    tb.copy(b, o); o += 8;
    Buffer.from(n, "hex").copy(b, o);

    const h = sha256_sync(b);
    const s = nacl.sign.detached(new Uint8Array(h), buyerKp.secretKey);

    const r = await fetch(`${TEE_URL}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: buyerAddress,
        to: sellerAddress,
        amount: "1000",
        validBefore: vb,
        nonce: n,
        signature: Buffer.from(s).toString("hex"),
      }),
    });
    const result = await r.json() as any;
    if (result.success) successCount++;
  }

  const elapsed = Date.now() - start;
  console.log(`   ${successCount}/100 succeeded in ${elapsed}ms (${(elapsed / 100).toFixed(1)}ms/payment)`);

  // ── Step 8: Final stats ──

  console.log("\n9. Final stats...");
  res = await fetch(`${TEE_URL}/stats`);
  console.log("   →", await res.json());

  res = await fetch(`${TEE_URL}/balance/${buyerAddress}`);
  console.log("   Buyer balance:", await res.json());

  console.log("\n=== E2E Test Complete ===");
}

main().catch(console.error);
