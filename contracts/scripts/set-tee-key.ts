/**
 * Update TEE public key on CyberGateway contract
 *
 * Usage: npx ts-node scripts/set-tee-key.ts
 *
 * Fetches the current TEE pubkey from the CVM attestation endpoint,
 * then sends SetTeeKey message to the contract.
 */

import { mnemonicToPrivateKey } from "@ton/crypto";
import { TonClient, WalletContractV4 } from "@ton/ton";
import { toNano, Address } from "@ton/core";
import { CyberGateway } from "../build/CyberGateway/tact_CyberGateway";
import * as dotenv from "dotenv";

dotenv.config();

const CVM_BASE = "https://af1c105306ec350be2965d98f181d48c305501ac-4030.dstack-pha-prod5.phala.network";

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // Fetch TEE pubkey from CVM
  console.log("Fetching TEE pubkey from CVM...");
  const res = await fetch(`${CVM_BASE}/attestation`);
  const attestation = await res.json();
  const teePubkeyHex: string = attestation.teePublicKey;
  console.log(`TEE pubkey: ${teePubkeyHex}`);
  console.log(`Platform: ${attestation.platform}`);

  // Init wallet
  const mnemonic = process.env.WALLET_MNEMONIC!;
  const network = (process.env.NETWORK ?? "testnet") as "mainnet" | "testnet";
  const rpcEndpoint = process.env.TON_RPC ?? "https://testnet.toncenter.com/api/v2/jsonRPC";
  const apiKey = process.env.TONCENTER_API_KEY;

  const keyPair = await mnemonicToPrivateKey(mnemonic.split(" "));
  const client = new TonClient({ endpoint: rpcEndpoint, apiKey: apiKey || undefined });
  const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
  const walletContract = client.open(wallet);
  const walletSender = walletContract.sender(keyPair.secretKey);

  // Load contract
  const gatewayAddr = process.env.GATEWAY_ADDRESS;
  if (!gatewayAddr) throw new Error("GATEWAY_ADDRESS env var is required");
  const gateway = CyberGateway.fromAddress(Address.parse(gatewayAddr));
  const gatewayContract = client.open(gateway);

  // Check current TEE key
  const currentKey = await gatewayContract.getTeePublicKey();
  const currentHex = currentKey.toString(16).padStart(64, "0");
  console.log(`\nCurrent on-chain TEE key: ${currentHex}`);

  if (currentHex === teePubkeyHex) {
    console.log("TEE key already matches. No update needed.");
    return;
  }

  // Send SetTeeKey
  console.log(`\nUpdating TEE key on contract...`);
  const newKey = BigInt("0x" + teePubkeyHex);

  await gatewayContract.send(walletSender, { value: toNano("0.05") }, {
    $$type: "SetTeeKey",
    tee_pubkey: newKey,
  });

  console.log("SetTeeKey message sent. Waiting for confirmation...");
  await sleep(10000);

  // Verify
  const updatedKey = await gatewayContract.getTeePublicKey();
  const updatedHex = updatedKey.toString(16).padStart(64, "0");
  console.log(`\nUpdated on-chain TEE key: ${updatedHex}`);
  console.log(`Match: ${updatedHex === teePubkeyHex ? "✓" : "✗"}`);
}

main().catch(console.error);
