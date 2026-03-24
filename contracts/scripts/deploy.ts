/**
 * CyberGateway Deployment Script
 *
 * Deploys the CyberGateway contract and configures:
 * 1. Deploy contract with owner + TEE pubkey
 * 2. Set Jetton wallet address (USDT)
 * 3. Verify deployment
 *
 * Usage:
 *   npx ts-node scripts/deploy.ts
 *
 * Required .env:
 *   WALLET_MNEMONIC=...
 *   TEE_PUBKEY=...           (64 hex chars, from TEE /attestation endpoint)
 *   JETTON_MASTER=...        (USDT Jetton master address, optional — set wallet after)
 *   NETWORK=mainnet|testnet  (optional, defaults to mainnet)
 */

import { mnemonicToPrivateKey } from "@ton/crypto";
import { TonClient, WalletContractV4 } from "@ton/ton";
import { toNano, Address } from "@ton/core";
import { CyberGateway } from "../build/CyberGateway/tact_CyberGateway";
import { getHttpEndpoint } from "@orbs-network/ton-access";
import * as dotenv from "dotenv";

dotenv.config();

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callWithRetry<T>(fn: () => Promise<T>, retries = 8, delay = 5000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const status = e?.response?.status;
      const retryable = status === 429 || status === 502 || status === 503 || e?.message?.includes("429");
      if (retryable && i < retries - 1) {
        console.log(`  Retryable error (${status ?? "unknown"}), waiting ${delay / 1000}s... (attempt ${i + 1}/${retries})`);
        await sleep(delay);
        delay = Math.min(delay * 1.5, 30000);
      } else {
        throw e;
      }
    }
  }
  throw new Error("Max retries exceeded");
}

async function waitForDeploy(client: TonClient, addr: Address, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(3000);
    const state = await callWithRetry(() => client.getContractState(addr));
    if (state.state === "active") return true;
    console.log(`  Waiting for deployment... (${i + 1}/${maxAttempts})`);
  }
  return false;
}

async function main() {
  // ── Validate env ──
  const mnemonic = process.env.WALLET_MNEMONIC;
  if (!mnemonic) throw new Error("WALLET_MNEMONIC not set in .env");

  const teePubkeyHex = process.env.TEE_PUBKEY;
  if (!teePubkeyHex || teePubkeyHex.length !== 64) {
    throw new Error("TEE_PUBKEY not set or invalid (need 64 hex chars)");
  }

  const network = (process.env.NETWORK ?? "mainnet") as "mainnet" | "testnet";

  // ── Get RPC endpoint ──
  const rpcEndpoint = process.env.TON_RPC ??
    await getHttpEndpoint({ network });
  const apiKey = process.env.TONCENTER_API_KEY;

  console.log(`Network: ${network}`);
  console.log(`RPC: ${rpcEndpoint}`);
  if (apiKey) console.log(`API Key: ${apiKey.slice(0, 8)}...`);

  // ── Init wallet ──
  const keyPair = await mnemonicToPrivateKey(mnemonic.split(" "));
  const client = new TonClient({
    endpoint: rpcEndpoint,
    apiKey: apiKey || undefined,
  });

  const wallet = WalletContractV4.create({
    publicKey: keyPair.publicKey,
    workchain: 0,
  });
  const walletContract = client.open(wallet);
  const walletSender = walletContract.sender(keyPair.secretKey);

  console.log(`Wallet: ${wallet.address.toString()}`);

  const balance = await callWithRetry(() => walletContract.getBalance());
  console.log(`Balance: ${Number(balance) / 1e9} TON`);

  if (balance < toNano("0.5")) {
    throw new Error("Need at least 0.5 TON for deployment + setup");
  }

  // ── Deploy CyberGateway ──
  const teePubkey = BigInt("0x" + teePubkeyHex);
  console.log(`\nTEE Public Key: ${teePubkeyHex}`);

  const gateway = await CyberGateway.fromInit(wallet.address, teePubkey);
  console.log(`Contract address: ${gateway.address.toString()}`);

  // Check if already deployed
  const existingState = await callWithRetry(() => client.getContractState(gateway.address));
  if (existingState.state === "active") {
    console.log("\nContract already deployed. Skipping deployment.");
  } else {
    console.log("\nDeploying CyberGateway...");
    const gatewayContract = client.open(gateway);

    await callWithRetry(async () => {
      await gatewayContract.send(walletSender, { value: toNano("0.3") }, {
        $$type: "Deploy",
        queryId: 0n,
      });
    });

    const deployed = await waitForDeploy(client, gateway.address);
    if (!deployed) throw new Error("Deployment timed out");
    console.log("✓ Contract deployed");
  }

  // ── Set Jetton Wallet (if provided) ──
  const jettonWalletEnv = process.env.JETTON_WALLET;
  if (jettonWalletEnv) {
    const walletAddr = Address.parse(jettonWalletEnv);
    const gatewayContract = client.open(gateway);
    await callWithRetry(async () => {
      await gatewayContract.send(walletSender, { value: toNano("0.05") }, {
        $$type: "SetJettonWallet",
        wallet: walletAddr,
      });
    });
    console.log(`✓ Jetton wallet set: ${walletAddr.toString()}`);
    await sleep(5000);
  }

  // ── Verify ──
  console.log("\n── Verification ──");
  await sleep(5000); // wait for chain to process
  const gatewayContract = client.open(gateway);

  const onchainTeeKey = await callWithRetry(() => gatewayContract.getTeePublicKey());
  console.log(`TEE pubkey on-chain: ${onchainTeeKey.toString(16).padStart(64, "0")}`);
  console.log(`TEE pubkey expected: ${teePubkeyHex}`);
  console.log(`Match: ${onchainTeeKey.toString(16).padStart(64, "0") === teePubkeyHex ? "✓" : "✗"}`);

  const owner = await callWithRetry(() => gatewayContract.getOwner());
  console.log(`Owner: ${owner.toString()}`);

  const stopped = await callWithRetry(() => gatewayContract.getStopped());
  console.log(`Stopped: ${stopped}`);

  const cooldown = await callWithRetry(() => gatewayContract.getCooldown());
  console.log(`Withdrawal cooldown: ${cooldown}s`);

  console.log("\n── Deployment Complete ──");
  console.log(`Contract: ${gateway.address.toString()}`);
  console.log(`\nAdd to TEE .env:`);
  console.log(`  GATEWAY_ADDRESS=${gateway.address.toString()}`);
}

main().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
