/**
 * Deploy TestUSDT Jetton + Mint to wallet + Set CyberGateway jetton_wallet
 *
 * Usage: npx ts-node scripts/deploy-test-usdt.ts
 */

import { mnemonicToPrivateKey } from "@ton/crypto";
import { TonClient, WalletContractV4 } from "@ton/ton";
import { toNano, Address, beginCell } from "@ton/core";
import { TestUSDT } from "../build/TestUSDT/tact_TestUSDT";
import { CyberGateway } from "../build/CyberGateway/tact_CyberGateway";
import * as dotenv from "dotenv";

dotenv.config();

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function callWithRetry<T>(fn: () => Promise<T>, retries = 5, delay = 5000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e: any) {
      if (i < retries - 1 && (e?.response?.status === 429 || e?.response?.status === 502)) {
        await sleep(delay);
        delay *= 1.5;
      } else throw e;
    }
  }
  throw new Error("Max retries");
}

async function main() {
  const mnemonic = process.env.WALLET_MNEMONIC!;
  const rpcEndpoint = process.env.TON_RPC ?? "https://testnet.toncenter.com/api/v2/jsonRPC";
  const apiKey = process.env.TONCENTER_API_KEY;
  const gatewayAddr = process.env.GATEWAY_ADDRESS!;

  const keyPair = await mnemonicToPrivateKey(mnemonic.split(" "));
  const client = new TonClient({ endpoint: rpcEndpoint, apiKey: apiKey || undefined });
  const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
  const walletContract = client.open(wallet);
  const walletSender = walletContract.sender(keyPair.secretKey);

  console.log(`Wallet: ${wallet.address.toString()}`);

  // ── 1. Deploy TestUSDT Jetton Master ──
  // Content cell: TEP-64 on-chain metadata
  // https://github.com/ton-blockchain/TEPs/blob/master/text/0064-token-data-standard.md
  const contentDict = beginCell();

  // Helper: build snake-data cell for a string value
  function snakeCell(value: string) {
    return beginCell().storeUint(0, 8).storeStringTail(value).endCell();
  }

  // Metadata dictionary (sha256 of key → value cell)
  const { Dictionary, Cell: CoreCell } = require("@ton/core");
  const { sha256_sync } = require("@ton/crypto");

  const dict = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
  dict.set(sha256_sync("name"), snakeCell("TestUSDT"));
  dict.set(sha256_sync("symbol"), snakeCell("tUSDT"));
  dict.set(sha256_sync("decimals"), snakeCell("6"));
  dict.set(sha256_sync("description"), snakeCell("Test USDT for CyberNanoPay testnet"));
  dict.set(sha256_sync("image"), snakeCell("https://tether.to/images/logoCircle.png"));

  const content = beginCell()
    .storeUint(0, 8) // on-chain metadata prefix
    .storeDict(dict)
    .endCell();

  const jettonMaster = await TestUSDT.fromInit(wallet.address, content);
  console.log(`\nJetton Master: ${jettonMaster.address.toString()}`);

  const masterState = await callWithRetry(() => client.getContractState(jettonMaster.address));
  if (masterState.state === "active") {
    console.log("Jetton Master already deployed.");
  } else {
    console.log("Deploying TestUSDT Jetton Master...");
    const masterContract = client.open(jettonMaster);
    await callWithRetry(async () => {
      await masterContract.send(walletSender, { value: toNano("0.3") }, {
        $$type: "Mint",
        to: wallet.address,
        amount: 0n,
      });
    });
    // Wait for deploy
    for (let i = 0; i < 20; i++) {
      await sleep(3000);
      const s = await callWithRetry(() => client.getContractState(jettonMaster.address));
      if (s.state === "active") { console.log("✓ Jetton Master deployed"); break; }
      console.log(`  Waiting... (${i + 1}/20)`);
    }
  }

  // ── 2. Mint 1,000,000 TestUSDT (6 decimals = 1,000,000,000,000 units) ──
  const mintAmount = 1_000_000_000_000n; // 1M USDT
  console.log(`\nMinting ${Number(mintAmount) / 1e6} TestUSDT to ${wallet.address.toString()}...`);
  const masterContract = client.open(jettonMaster);
  await callWithRetry(async () => {
    await masterContract.send(walletSender, { value: toNano("0.2") }, {
      $$type: "Mint",
      to: wallet.address,
      amount: mintAmount,
    });
  });
  await sleep(10000);
  console.log("✓ Minted");

  // ── 3. Get CyberGateway's Jetton Wallet address ──
  const gatewayAddress = Address.parse(gatewayAddr);
  const gwJettonWallet = await callWithRetry(() => masterContract.getGetWalletAddress(gatewayAddress));
  console.log(`\nCyberGateway Jetton Wallet: ${gwJettonWallet.toString()}`);

  // ── 4. Set jetton_wallet on CyberGateway ──
  console.log("Setting jetton_wallet on CyberGateway...");
  const gateway = CyberGateway.fromAddress(gatewayAddress);
  const gwContract = client.open(gateway);
  await callWithRetry(async () => {
    await gwContract.send(walletSender, { value: toNano("0.05") }, {
      $$type: "SetJettonWallet",
      wallet: gwJettonWallet,
    });
  });
  await sleep(10000);
  console.log("✓ jetton_wallet set");

  // ── 5. Get our own Jetton Wallet address ──
  const myJettonWallet = await callWithRetry(() => masterContract.getGetWalletAddress(wallet.address));
  console.log(`\nOur Jetton Wallet: ${myJettonWallet.toString()}`);

  // ── Summary ──
  const isTestnet = rpcEndpoint.includes("testnet");
  const explorer = isTestnet ? "https://testnet.tonviewer.com" : "https://tonviewer.com";
  console.log(`\n── Summary ──`);
  console.log(`Jetton Master:    ${jettonMaster.address.toString()}`);
  console.log(`Our Jetton Wallet: ${myJettonWallet.toString()}`);
  console.log(`GW Jetton Wallet:  ${gwJettonWallet.toString()}`);
  console.log(`Explorer: ${explorer}/${jettonMaster.address.toString()}`);
}

main().catch(console.error);
