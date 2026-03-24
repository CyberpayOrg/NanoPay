/**
 * Trigger a single HITL approval request for Telegram demo.
 * Run: npx tsx test/trigger-hitl.ts
 */
import nacl from "tweetnacl";
import { Address } from "@ton/core";
import { randomBytes } from "crypto";
import { sha256_sync } from "@ton/crypto";

const TEE_URL = "http://localhost:4030";
const MESSAGE_PREFIX = Buffer.from("CyberGateway:v1:");

function keypairToAddress(pk: Buffer): string {
  return new Address(0, pk.subarray(0, 32)).toString();
}

async function main() {
  const buyerKp = nacl.sign.keyPair();
  const sellerKp = nacl.sign.keyPair();
  const buyer = keypairToAddress(Buffer.from(buyerKp.publicKey));
  const seller = keypairToAddress(Buffer.from(sellerKp.publicKey));

  // Setup
  await fetch(`${TEE_URL}/register-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: buyer, publicKey: Buffer.from(buyerKp.publicKey).toString("hex") }),
  });
  await fetch(`${TEE_URL}/simulate-deposit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: buyer, amount: "50000000" }), // $50
  });

  // Set policy: HITL threshold at 5000 ($0.005)
  await fetch(`${TEE_URL}/policy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: buyer,
      spendingLimit: "10000000",
      dailyCap: "20000000",
      hitlThreshold: "5000",
    }),
  });

  console.log(`Buyer: ${buyer}`);
  console.log(`Seller: ${seller}`);
  console.log(`Policy: limit=10M, dailyCap=20M, hitlThreshold=5000`);

  // Send a payment that triggers HITL (amount >= 5000)
  const nonce = randomBytes(32).toString("hex");
  const validBefore = Math.floor(Date.now() / 1000) + 300;
  const amount = 8000n; // $0.008, above 5000 threshold

  const fromAddr = Address.parse(buyer);
  const toAddr = Address.parse(seller);
  const buf = Buffer.alloc(MESSAGE_PREFIX.length + 32 + 32 + 16 + 8 + 32);
  let o = 0;
  MESSAGE_PREFIX.copy(buf, o); o += MESSAGE_PREFIX.length;
  fromAddr.hash.copy(buf, o); o += 32;
  toAddr.hash.copy(buf, o); o += 32;
  const ab = Buffer.alloc(16); let a = amount;
  for (let i = 15; i >= 0; i--) { ab[i] = Number(a & 0xffn); a >>= 8n; }
  ab.copy(buf, o); o += 16;
  const tb = Buffer.alloc(8); let t = BigInt(validBefore);
  for (let i = 7; i >= 0; i--) { tb[i] = Number(t & 0xffn); t >>= 8n; }
  tb.copy(buf, o); o += 8;
  Buffer.from(nonce, "hex").copy(buf, o);

  const hash = sha256_sync(buf);
  const sig = nacl.sign.detached(new Uint8Array(hash), buyerKp.secretKey);

  console.log(`\nSending payment of 8000 units (triggers HITL)...`);
  const res = await fetch(`${TEE_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: buyer, to: seller,
      amount: "8000", validBefore, nonce,
      signature: Buffer.from(sig).toString("hex"),
    }),
  });
  const result = await res.json() as any;
  console.log(`Result:`, result);
  console.log(`\n→ Check your Telegram! You should see an approval request.`);
  console.log(`→ Tap ✅ Approve or ❌ Reject to complete the flow.`);
}

main().catch(console.error);
