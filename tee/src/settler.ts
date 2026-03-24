/**
 * Onchain Settler
 *
 * Takes a SettlementBatch, signs it with the TEE private key,
 * and submits it to the CyberGateway contract on TON.
 *
 * The contract verifies the TEE signature before executing transfers.
 */

import nacl from "tweetnacl";
import { Address, beginCell, Cell, toNano } from "@ton/core";
import { TonClient, WalletContractV4, internal } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";
import type { SettlementBatch, NetPosition } from "./types";

export interface SettlerConfig {
  /** TON RPC endpoint */
  rpcEndpoint: string;
  /** CyberGateway contract address */
  gatewayAddress: string;
  /** TEE Ed25519 keypair (64 bytes: secret 32 + public 32) */
  teeKeypair: nacl.SignKeyPair;
  /** Wallet mnemonic for submitting transactions (pays gas) */
  walletMnemonic: string;
}

/**
 * Encode a batch of net positions into a Cell for the contract.
 *
 * Format:
 *   count: uint16
 *   For each entry (in linked ref cells if needed):
 *     from: Address (267 bits)
 *     to: Address (267 bits)
 *     amount: coins (up to 124 bits)
 */
export function encodeBatchData(positions: NetPosition[]): Cell {
  // Build entries as a chain of cells (each cell holds one entry + ref to next)
  // First cell: count + first entry
  // Subsequent entries in ref chain

  let builder = beginCell().storeUint(positions.length, 16);

  if (positions.length <= 1) {
    // Simple case: everything in one cell
    for (const pos of positions) {
      builder = builder
        .storeAddress(Address.parse(pos.from))
        .storeAddress(Address.parse(pos.to))
        .storeCoins(pos.amount);
    }
    return builder.endCell();
  }

  // For multiple entries, store first inline, rest in ref chain
  const first = positions[0];
  builder = builder
    .storeAddress(Address.parse(first.from))
    .storeAddress(Address.parse(first.to))
    .storeCoins(first.amount);

  // Build ref chain from last to first (reverse order)
  let refCell: Cell | null = null;
  for (let i = positions.length - 1; i >= 1; i--) {
    const pos = positions[i];
    let entryBuilder = beginCell()
      .storeAddress(Address.parse(pos.from))
      .storeAddress(Address.parse(pos.to))
      .storeCoins(pos.amount);

    if (refCell) {
      entryBuilder = entryBuilder.storeRef(refCell);
    }
    refCell = entryBuilder.endCell();
  }

  if (refCell) {
    builder = builder.storeRef(refCell);
  }

  return builder.endCell();
}

/**
 * Sign batch data with TEE private key.
 */
export function signBatch(
  batchData: Cell,
  teeKeypair: nacl.SignKeyPair
): Buffer {
  const hash = batchData.hash();
  const sig = nacl.sign.detached(
    new Uint8Array(hash),
    teeKeypair.secretKey
  );
  return Buffer.from(sig);
}

export class Settler {
  private client: TonClient;
  private config: SettlerConfig;
  private walletReady: Promise<{
    wallet: WalletContractV4;
    secretKey: Buffer;
  }>;

  constructor(config: SettlerConfig) {
    this.config = config;
    this.client = new TonClient({ endpoint: config.rpcEndpoint });
    this.walletReady = this.initWallet();
  }

  private async initWallet() {
    const keyPair = await mnemonicToPrivateKey(
      this.config.walletMnemonic.split(" ")
    );
    const wallet = WalletContractV4.create({
      publicKey: keyPair.publicKey,
      workchain: 0,
    });
    return { wallet, secretKey: keyPair.secretKey };
  }

  /**
   * Submit a settlement batch to the CyberGateway contract.
   */
  async settle(batch: SettlementBatch): Promise<string> {
    const { wallet, secretKey } = await this.walletReady;
    const walletContract = this.client.open(wallet);

    // Encode batch data
    const batchData = encodeBatchData(batch.positions);

    // Sign with TEE key
    const teeSignature = signBatch(batchData, this.config.teeKeypair);

    // Build BatchSettle message body
    // message BatchSettle {
    //   batch_id: uint64
    //   batch_data: Cell (ref)
    //   tee_signature: remaining (512 bits)
    // }
    const body = beginCell()
      .storeUint(0xeff0e173, 32)  // BatchSettle opcode (Tact-generated)
      .storeUint(batch.batchId, 64)
      .storeRef(batchData)
      .storeBuffer(teeSignature)   // 64 bytes = 512 bits
      .endCell();

    // Send transaction
    const seqno = await walletContract.getSeqno();
    await walletContract.sendTransfer({
      secretKey,
      seqno,
      messages: [
        internal({
          to: Address.parse(this.config.gatewayAddress),
          value: toNano("0.2"), // gas for batch processing
          body,
        }),
      ],
    });

    console.log(
      `[settler] Batch #${batch.batchId} submitted: ${batch.positions.length} positions, ` +
      `total ${batch.totalAmount} units, seqno=${seqno}`
    );

    return `batch:${batch.batchId}:seqno:${seqno}`;
  }
}
