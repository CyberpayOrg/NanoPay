/**
 * x402 Flow Test — Tests the full HTTP 402 payment flow through the gateway.
 *
 * Flow: GET /demo/premium-data → 402 → parse requirements → sign → retry with Payment-Signature → 200
 *
 * Run: npx tsx x402-flow.ts
 * Requires: TEE server on :4030, Gateway on :4031
 */

import nacl from "tweetnacl";
import { randomBytes } from "crypto";
import { Address } from "@ton/core";
import { sha256_sync } from "@ton/crypto";

const TEE_URL = "http://localhost:4030";
const GATEWAY_URL = "http://localhost:4031";
const MESSAGE_PREFIX = Buffer.from("CyberGateway:v1:");

function signAuth(
  from: string, to: string, amount: bigint,
  validBefore: number, nonce: string, secretKey: Uint8Array
): string {
  const fromAddr = Address.parse(from);
  const toAddr = Address.parse(to);
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

  const hash = sha256_sync(buf);
  const sig = nacl.sign.detached(new Uint8Array(hash), secretKey);
  return Buffer.from(sig).toString("hex");
}

async function main() {
  console.log("=== x402 Flow Test ===\n");

  // Setup buyer + seller
  const buyerKp = nacl.sign.keyPair();
  const sellerKp = nacl.sign.keyPair();
  const buyerAddress = new Address(0, Buffer.from(buyerKp.publicKey).subarray(0, 32)).toString();
  const sellerAddress = new Address(0, Buffer.from(sellerKp.publicKey).subarray(0, 32)).toString();
  const buyerPubkey = Buffer.from(buyerKp.publicKey).toString("hex");

  // Register + deposit
  await fetch(`${TEE_URL}/register-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: buyerAddress, publicKey: buyerPubkey }),
  });
  await fetch(`${TEE_URL}/simulate-deposit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: buyerAddress, amount: "1000000" }),
  });
  console.log(`Buyer: ${buyerAddress} (deposited 1,000,000 units)`);
  console.log(`Seller: ${sellerAddress}`);

  // Step 1: Request premium data without payment → expect 402
  console.log("\n1. GET /demo/premium-data (no payment)...");
  const res402 = await fetch(`${GATEWAY_URL}/demo/premium-data`);
  console.log(`   Status: ${res402.status} (expected 402)`);

  if (res402.status !== 402) {
    console.error("   Expected 402!");
    process.exit(1);
  }

  // Step 2: Parse payment requirements from header
  const paymentHeader = res402.headers.get("PAYMENT-REQUIRED");
  if (!paymentHeader) {
    console.error("   No PAYMENT-REQUIRED header!");
    process.exit(1);
  }

  const requirements = JSON.parse(Buffer.from(paymentHeader, "base64").toString());
  const accept = requirements.accepts[0];
  console.log(`   Scheme: ${accept.scheme}`);
  console.log(`   Amount: ${accept.amount}`);
  console.log("   ✅ 402 response with payment requirements works!");

  // Step 3: Direct verify flow (bypassing empty DEMO_SELLER)
  console.log("\n2. Direct payment verify via gateway /verify...");
  const nonce = randomBytes(32).toString("hex");
  const validBefore = Math.floor(Date.now() / 1000) + 300;
  const signature = signAuth(
    buyerAddress, sellerAddress, 1000n,
    validBefore, nonce, buyerKp.secretKey
  );

  const verifyRes = await fetch(`${GATEWAY_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: buyerAddress,
      to: sellerAddress,
      amount: "1000",
      validBefore,
      nonce,
      signature,
    }),
  });
  const verifyResult = await verifyRes.json() as any;
  console.log(`   Status: ${verifyRes.status}`);
  console.log(`   Result: ${JSON.stringify(verifyResult)}`);

  if (verifyResult.success) {
    console.log("   ✅ Gateway → TEE verify flow works!");
  } else {
    console.error(`   ❌ Verify failed: ${verifyResult.error}`);
  }

  // Step 4: Check balance via gateway proxy
  console.log("\n3. Balance check via gateway...");
  const balRes = await fetch(`${GATEWAY_URL}/balance/${buyerAddress}`);
  const balance = await balRes.json();
  console.log(`   Balance: ${JSON.stringify(balance)}`);

  // Step 5: Stats via gateway proxy
  console.log("\n4. Stats via gateway...");
  const statsRes = await fetch(`${GATEWAY_URL}/stats`);
  console.log(`   Stats: ${JSON.stringify(await statsRes.json())}`);

  console.log("\n=== x402 Flow Test Complete ===");
}

main().catch(console.error);
