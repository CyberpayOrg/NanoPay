/**
 * Test: Spending Policy + HITL Approval Flow
 *
 * Run: npx tsx test/policy-hitl.ts
 * Requires: TEE server running on localhost:4030
 */

import nacl from "tweetnacl";
import { Address } from "@ton/core";
import { randomBytes } from "crypto";
import { sha256_sync } from "@ton/crypto";

const TEE_URL = "http://localhost:4030";
const MESSAGE_PREFIX = Buffer.from("CyberGateway:v1:");

function keypairToAddress(publicKey: Buffer): string {
  return new Address(0, publicKey.subarray(0, 32)).toString();
}

function signPayment(
  buyerKp: nacl.SignKeyPair,
  buyerAddress: string,
  sellerAddress: string,
  amount: bigint,
  validBefore: number,
  nonce: string
): string {
  const fromAddr = Address.parse(buyerAddress);
  const toAddr = Address.parse(sellerAddress);
  const buf = Buffer.alloc(MESSAGE_PREFIX.length + 32 + 32 + 16 + 8 + 32);
  let offset = 0;
  MESSAGE_PREFIX.copy(buf, offset); offset += MESSAGE_PREFIX.length;
  fromAddr.hash.copy(buf, offset); offset += 32;
  toAddr.hash.copy(buf, offset); offset += 32;
  const amountBuf = Buffer.alloc(16);
  let amt = amount;
  for (let i = 15; i >= 0; i--) { amountBuf[i] = Number(amt & 0xffn); amt >>= 8n; }
  amountBuf.copy(buf, offset); offset += 16;
  const timeBuf = Buffer.alloc(8);
  let ts = BigInt(validBefore);
  for (let i = 7; i >= 0; i--) { timeBuf[i] = Number(ts & 0xffn); ts >>= 8n; }
  timeBuf.copy(buf, offset); offset += 8;
  Buffer.from(nonce, "hex").copy(buf, offset);
  const messageHash = sha256_sync(buf);
  const sig = nacl.sign.detached(new Uint8Array(messageHash), buyerKp.secretKey);
  return Buffer.from(sig).toString("hex");
}

async function submitPayment(
  buyerKp: nacl.SignKeyPair,
  buyerAddress: string,
  sellerAddress: string,
  amount: bigint
) {
  const nonce = randomBytes(32).toString("hex");
  const validBefore = Math.floor(Date.now() / 1000) + 300;
  const signature = signPayment(buyerKp, buyerAddress, sellerAddress, amount, validBefore, nonce);
  const res = await fetch(`${TEE_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: buyerAddress, to: sellerAddress,
      amount: amount.toString(), validBefore, nonce, signature,
    }),
  });
  return await res.json() as any;
}

async function main() {
  console.log("=== Policy + HITL Test ===\n");

  const buyerKp = nacl.sign.keyPair();
  const sellerKp = nacl.sign.keyPair();
  const buyerAddress = keypairToAddress(Buffer.from(buyerKp.publicKey));
  const sellerAddress = keypairToAddress(Buffer.from(sellerKp.publicKey));

  // Setup
  await fetch(`${TEE_URL}/register-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: buyerAddress, publicKey: Buffer.from(buyerKp.publicKey).toString("hex") }),
  });
  await fetch(`${TEE_URL}/simulate-deposit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: buyerAddress, amount: "10000000" }),
  });

  // ── Test 1: Set spending policy ──
  console.log("1. Setting spending policy: limit=5000, dailyCap=20000, hitl=3000");
  await fetch(`${TEE_URL}/policy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: buyerAddress,
      spendingLimit: "5000",
      dailyCap: "20000",
      hitlThreshold: "3000",
    }),
  });

  // Verify policy
  const policyRes = await fetch(`${TEE_URL}/policy/${buyerAddress}`);
  console.log("   Policy:", await policyRes.json());

  // ── Test 2: Payment within limit (should succeed) ──
  console.log("\n2. Payment 1000 (within limit)...");
  let result = await submitPayment(buyerKp, buyerAddress, sellerAddress, 1000n);
  console.log("   →", result.success ? "✅ OK" : `❌ ${result.error}`);

  // ── Test 3: Payment exceeding spending limit (should fail) ──
  console.log("\n3. Payment 6000 (exceeds spending limit of 5000)...");
  result = await submitPayment(buyerKp, buyerAddress, sellerAddress, 6000n);
  console.log("   →", result.success ? "✅ OK" : `❌ ${result.error}`);

  // ── Test 4: Payment triggering HITL (>= 3000 threshold) ──
  console.log("\n4. Payment 3000 (triggers HITL threshold)...");
  result = await submitPayment(buyerKp, buyerAddress, sellerAddress, 3000n);
  console.log("   →", result.success ? "✅ OK" : `❌ ${result.error}`);
  const hitlPaymentId = result.confirmationId;
  console.log("   Payment ID:", hitlPaymentId);

  // ── Test 5: Check pending approvals ──
  console.log("\n5. Checking pending approvals...");
  const approvalsRes = await fetch(`${TEE_URL}/approvals`);
  const approvals = await approvalsRes.json() as any;
  console.log("   Pending:", approvals.approvals?.length ?? 0);

  // ── Test 6: Approve the payment ──
  if (hitlPaymentId) {
    console.log(`\n6. Approving payment ${hitlPaymentId}...`);
    const approveRes = await fetch(`${TEE_URL}/approve/${hitlPaymentId}`, { method: "POST" });
    const approveResult = await approveRes.json() as any;
    console.log("   →", approveResult.success ? "✅ Approved" : `❌ ${approveResult.error}`);
  }

  // ── Test 7: Daily cap enforcement ──
  console.log("\n7. Testing daily cap (filling up to cap)...");
  // Already spent: 1000 (test2) + 3000 (HITL approved) = 4000
  // Cap is 20000, so we can spend 16000 more
  // Send 4 x 4000 = 16000 (staying under spending limit of 5000 per tx)
  let dailySuccess = 0;
  for (let i = 0; i < 4; i++) {
    result = await submitPayment(buyerKp, buyerAddress, sellerAddress, 2000n);
    if (result.success) dailySuccess++;
  }
  // Now at 4000 + 8000 = 12000. Send more to hit cap.
  for (let i = 0; i < 4; i++) {
    result = await submitPayment(buyerKp, buyerAddress, sellerAddress, 2000n);
    if (result.success) dailySuccess++;
  }
  console.log(`   ${dailySuccess}/8 succeeded (should be 8, total daily: 20000)`);

  // Next payment should fail (daily cap exceeded: 20000 + 2000 > 20000)
  console.log("\n8. Payment after daily cap exhausted...");
  result = await submitPayment(buyerKp, buyerAddress, sellerAddress, 2000n);
  console.log("   →", result.success ? "❌ Should have failed" : `✅ Correctly rejected: ${result.error}`);

  // ── Test 8: Reject a HITL payment ──
  console.log("\n9. Testing HITL reject...");
  result = await submitPayment(buyerKp, buyerAddress, sellerAddress, 3000n);
  const rejectId = result.confirmationId;
  if (rejectId) {
    const rejectRes = await fetch(`${TEE_URL}/reject/${rejectId}`, { method: "POST" });
    const rejectResult = await rejectRes.json() as any;
    console.log("   →", rejectResult.success ? "✅ Rejected" : `❌ ${rejectResult.error}`);
  }

  // Final balance
  console.log("\n10. Final balance...");
  const balRes = await fetch(`${TEE_URL}/balance/${buyerAddress}`);
  console.log("   →", await balRes.json());

  console.log("\n=== Policy + HITL Test Complete ===");
}

main().catch(console.error);
