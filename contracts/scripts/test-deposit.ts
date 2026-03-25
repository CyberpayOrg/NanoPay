/**
 * Test Deposit — Send a fake JettonTransferNotification to CyberGateway
 *
 * Since the contract doesn't validate the sender is the actual jetton_wallet,
 * we can simulate a deposit by sending JettonTransferNotification directly.
 * This is for TESTNET ONLY.
 *
 * Usage: npx ts-node scripts/test-deposit.ts [amount_in_units] [depositor_address]
 */

import { mnemonicToPrivateKey } from "@ton/crypto";
import { TonClient, WalletContractV4 } from "@ton/ton";
import { toNano, Address, beginCell } from "@ton/core";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const amount = BigInt(process.argv[2] ?? "10000000"); // default 10 USDT (6 decimals)
  const mnemonic = process.env.WALLET_MNEMONIC!;
  const rpcEndpoint = process.env.TON_RPC ?? "https://testnet.toncenter.com/api/v2/jsonRPC";
  const apiKey = process.env.TONCENTER_API_KEY;
  const gatewayAddr = process.env.GATEWAY_ADDRESS!;

  const keyPair = await mnemonicToPrivateKey(mnemonic.split(" "));
  const client = new TonClient({ endpoint: rpcEndpoint, apiKey: apiKey || undefined });
  const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
  const walletContract = client.open(wallet);
  const walletSender = walletContract.sender(keyPair.secretKey);

  // Depositor = our own wallet (or custom address from argv)
  const depositorAddr = process.argv[3]
    ? Address.parse(process.argv[3])
    : wallet.address;

  console.log(`Gateway:   ${gatewayAddr}`);
  console.log(`Depositor: ${depositorAddr.toString()}`);
  console.log(`Amount:    ${amount} (${Number(amount) / 1e6} USDT)`);

  // Build JettonTransferNotification body (opcode 0x7362d09c)
  const body = beginCell()
    .storeUint(0x7362d09c, 32)  // opcode
    .storeUint(0, 64)           // query_id
    .storeCoins(amount)         // amount
    .storeAddress(depositorAddr) // sender (the depositor)
    .storeUint(0, 1)            // empty forward_payload (either bit = 0)
    .endCell();

  console.log("\nSending JettonTransferNotification...");
  await walletContract.sendTransfer({
    seqno: await walletContract.getSeqno(),
    secretKey: keyPair.secretKey,
    messages: [
      {
        info: {
          type: "internal",
          ihrDisabled: true,
          bounce: true,
          bounced: false,
          dest: Address.parse(gatewayAddr),
          value: { coins: toNano("0.1") },
          ihrFee: 0n,
          forwardFee: 0n,
          createdLt: 0n,
          createdAt: 0,
        },
        body,
      },
    ],
  });

  console.log("✓ Transaction sent. Waiting for confirmation...");

  // Wait and check TEE balance
  await new Promise((r) => setTimeout(r, 15000));

  const teeUrl = process.env.TEE_URL ?? "https://3c84244ec8585d9d81678e9f8933c2b63bbfe5cd-4030.dstack-pha-prod5.phala.network";
  try {
    const res = await fetch(`${teeUrl}/balance/${depositorAddr.toString()}`);
    const data = await res.json();
    console.log(`\nTEE balance for ${depositorAddr.toString()}:`);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.log("(Could not check TEE balance — listener may need more time)");
  }
}

main().catch(console.error);
