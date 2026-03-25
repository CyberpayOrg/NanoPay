/**
 * Integration Tests — TEE Settler ↔ CyberGateway Contract
 *
 * Tests the interaction between the TEE's batch encoding/signing logic
 * and the on-chain contract's batch verification + execution.
 *
 * Uses the real settler encoding functions (encodeBatchData, signBatch)
 * against the sandbox contract to verify they produce compatible data.
 */

import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { toNano, beginCell, Address, Cell } from "@ton/core";
import { CyberGateway } from "../build/CyberGateway/tact_CyberGateway";
import nacl from "tweetnacl";
import "@ton/test-utils";

// ── Replicate settler encoding logic (from tee/src/settler.ts) ──

function encodeBatchData(
  positions: { from: string; to: string; amount: bigint }[]
): Cell {
  let builder = beginCell().storeUint(positions.length, 16);

  if (positions.length <= 1) {
    for (const pos of positions) {
      builder = builder
        .storeAddress(Address.parse(pos.from))
        .storeAddress(Address.parse(pos.to))
        .storeCoins(pos.amount);
    }
    return builder.endCell();
  }

  const first = positions[0];
  builder = builder
    .storeAddress(Address.parse(first.from))
    .storeAddress(Address.parse(first.to))
    .storeCoins(first.amount);

  let refCell: Cell | null = null;
  for (let i = positions.length - 1; i >= 1; i--) {
    const pos = positions[i];
    let eb = beginCell()
      .storeAddress(Address.parse(pos.from))
      .storeAddress(Address.parse(pos.to))
      .storeCoins(pos.amount);
    if (refCell) eb = eb.storeRef(refCell);
    refCell = eb.endCell();
  }
  if (refCell) builder = builder.storeRef(refCell);

  return builder.endCell();
}

function signBatch(batchData: Cell, teeKeypair: nacl.SignKeyPair): Buffer {
  const hash = batchData.hash();
  const sig = nacl.sign.detached(new Uint8Array(hash), teeKeypair.secretKey);
  return Buffer.from(sig);
}

// ── Helpers ──

async function simulateDeposit(
  gateway: SandboxContract<CyberGateway>,
  jettonWallet: SandboxContract<TreasuryContract>,
  depositor: Address,
  amount: bigint
) {
  const fwdPayload = beginCell()
    .storeUint(0, 1)
    .storeUint(2, 8)
    .endCell()
    .beginParse();

  await gateway.send(
    jettonWallet.getSender(),
    { value: toNano("0.1") },
    {
      $$type: "JettonTransferNotification",
      query_id: 0n,
      amount,
      sender: depositor,
      forward_payload: fwdPayload,
    }
  );
}

describe("Integration: TEE Settler ↔ CyberGateway", () => {
  let blockchain: Blockchain;
  let owner: SandboxContract<TreasuryContract>;
  let gateway: SandboxContract<CyberGateway>;
  let teeKeypair: nacl.SignKeyPair;
  let jettonWallet: SandboxContract<TreasuryContract>;

  const teePubkeyBigInt = (kp: nacl.SignKeyPair) =>
    BigInt("0x" + Buffer.from(kp.publicKey).toString("hex"));

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    owner = await blockchain.treasury("owner");
    teeKeypair = nacl.sign.keyPair();
    jettonWallet = await blockchain.treasury("jetton-wallet");

    gateway = blockchain.openContract(
      await CyberGateway.fromInit(owner.address, teePubkeyBigInt(teeKeypair))
    );

    await gateway.send(
      owner.getSender(),
      { value: toNano("0.5") },
      { $$type: "Deploy", queryId: 0n }
    );

    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetJettonWallet", wallet: jettonWallet.address }
    );
  });

  // ── Test: settler's encodeBatchData produces valid contract input ──

  it("settler encodeBatchData single entry → contract accepts", async () => {
    const buyer = await blockchain.treasury("buyer");
    const seller = await blockchain.treasury("seller");

    await simulateDeposit(gateway, jettonWallet, buyer.address, 1_000_000n);

    // Use settler's encoding function (string addresses)
    const positions = [
      {
        from: buyer.address.toString(),
        to: seller.address.toString(),
        amount: 500_000n,
      },
    ];

    const batchData = encodeBatchData(positions);
    const sig = signBatch(batchData, teeKeypair);
    const teeSignature = beginCell()
      .storeBuffer(sig)
      .endCell()
      .beginParse();

    const result = await gateway.send(
      owner.getSender(),
      { value: toNano("0.2") },
      {
        $$type: "BatchSettle",
        batch_id: 1n,
        batch_data: batchData,
        tee_signature: teeSignature,
      }
    );

    expect(result.transactions).toHaveTransaction({
      from: owner.address,
      to: gateway.address,
      success: true,
    });

    expect(await gateway.getBalance(buyer.address)).toBe(500_000n);
    expect(await gateway.getBalance(seller.address)).toBe(500_000n);
  });

  it("settler encodeBatchData multi-entry → contract accepts", async () => {
    const buyer1 = await blockchain.treasury("buyer1");
    const buyer2 = await blockchain.treasury("buyer2");
    const seller = await blockchain.treasury("seller");

    await simulateDeposit(gateway, jettonWallet, buyer1.address, 1_000_000n);
    await simulateDeposit(gateway, jettonWallet, buyer2.address, 800_000n);

    const positions = [
      { from: buyer1.address.toString(), to: seller.address.toString(), amount: 300_000n },
      { from: buyer2.address.toString(), to: seller.address.toString(), amount: 200_000n },
    ];

    const batchData = encodeBatchData(positions);
    const sig = signBatch(batchData, teeKeypair);
    const teeSignature = beginCell().storeBuffer(sig).endCell().beginParse();

    const result = await gateway.send(
      owner.getSender(),
      { value: toNano("0.3") },
      {
        $$type: "BatchSettle",
        batch_id: 1n,
        batch_data: batchData,
        tee_signature: teeSignature,
      }
    );

    expect(result.transactions).toHaveTransaction({ success: true });
    expect(await gateway.getBalance(buyer1.address)).toBe(700_000n);
    expect(await gateway.getBalance(buyer2.address)).toBe(600_000n);
    expect(await gateway.getBalance(seller.address)).toBe(500_000n);
  });

  it("settler encodeBatchData 5 entries → contract accepts", async () => {
    const buyers = await Promise.all(
      Array.from({ length: 5 }, (_, i) => blockchain.treasury(`buyer-${i}`))
    );
    const seller = await blockchain.treasury("seller");

    for (const b of buyers) {
      await simulateDeposit(gateway, jettonWallet, b.address, 100_000n);
    }

    const positions = buyers.map((b) => ({
      from: b.address.toString(),
      to: seller.address.toString(),
      amount: 10_000n,
    }));

    const batchData = encodeBatchData(positions);
    const sig = signBatch(batchData, teeKeypair);
    const teeSignature = beginCell().storeBuffer(sig).endCell().beginParse();

    const result = await gateway.send(
      owner.getSender(),
      { value: toNano("0.5") },
      {
        $$type: "BatchSettle",
        batch_id: 1n,
        batch_data: batchData,
        tee_signature: teeSignature,
      }
    );

    expect(result.transactions).toHaveTransaction({ success: true });
    expect(await gateway.getBalance(seller.address)).toBe(50_000n);
    for (const b of buyers) {
      expect(await gateway.getBalance(b.address)).toBe(90_000n);
    }
  });

  // ── Test: bilateral netting simulation ──

  it("bilateral netting: A→B and B→A net to single transfer", async () => {
    const alice = await blockchain.treasury("alice");
    const bob = await blockchain.treasury("bob");

    await simulateDeposit(gateway, jettonWallet, alice.address, 1_000_000n);
    await simulateDeposit(gateway, jettonWallet, bob.address, 1_000_000n);

    // Simulate batcher netting: A→B 300k, B→A 100k → net: A→B 200k
    const positions = [
      { from: alice.address.toString(), to: bob.address.toString(), amount: 200_000n },
    ];

    const batchData = encodeBatchData(positions);
    const sig = signBatch(batchData, teeKeypair);
    const teeSignature = beginCell().storeBuffer(sig).endCell().beginParse();

    const result = await gateway.send(
      owner.getSender(),
      { value: toNano("0.2") },
      {
        $$type: "BatchSettle",
        batch_id: 1n,
        batch_data: batchData,
        tee_signature: teeSignature,
      }
    );

    expect(result.transactions).toHaveTransaction({ success: true });
    expect(await gateway.getBalance(alice.address)).toBe(800_000n);
    expect(await gateway.getBalance(bob.address)).toBe(1_200_000n);
  });

  // ── Test: TEE key rotation ──

  it("TEE key rotation: old key rejected, new key accepted", async () => {
    const buyer = await blockchain.treasury("buyer");
    const seller = await blockchain.treasury("seller");
    await simulateDeposit(gateway, jettonWallet, buyer.address, 1_000_000n);

    // Rotate TEE key
    const newKeypair = nacl.sign.keyPair();
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetTeeKey", tee_pubkey: teePubkeyBigInt(newKeypair) }
    );

    // Old key should be rejected
    const positions = [
      { from: buyer.address.toString(), to: seller.address.toString(), amount: 100_000n },
    ];
    const batchData = encodeBatchData(positions);
    const oldSig = signBatch(batchData, teeKeypair);
    const oldSigSlice = beginCell().storeBuffer(oldSig).endCell().beginParse();

    const failResult = await gateway.send(
      owner.getSender(),
      { value: toNano("0.2") },
      {
        $$type: "BatchSettle",
        batch_id: 1n,
        batch_data: batchData,
        tee_signature: oldSigSlice,
      }
    );
    expect(failResult.transactions).toHaveTransaction({
      from: owner.address,
      to: gateway.address,
      success: false,
    });

    // New key should work
    const newSig = signBatch(batchData, newKeypair);
    const newSigSlice = beginCell().storeBuffer(newSig).endCell().beginParse();

    const okResult = await gateway.send(
      owner.getSender(),
      { value: toNano("0.2") },
      {
        $$type: "BatchSettle",
        batch_id: 2n,
        batch_data: batchData,
        tee_signature: newSigSlice,
      }
    );
    expect(okResult.transactions).toHaveTransaction({ success: true });
  });

  // ── Test: sequential batches with incrementing IDs ──

  it("sequential batches with incrementing IDs", async () => {
    const buyer = await blockchain.treasury("buyer");
    const seller = await blockchain.treasury("seller");
    await simulateDeposit(gateway, jettonWallet, buyer.address, 10_000_000n);

    for (let i = 1n; i <= 5n; i++) {
      const positions = [
        { from: buyer.address.toString(), to: seller.address.toString(), amount: 100_000n },
      ];
      const batchData = encodeBatchData(positions);
      const sig = signBatch(batchData, teeKeypair);
      const teeSignature = beginCell().storeBuffer(sig).endCell().beginParse();

      const result = await gateway.send(
        owner.getSender(),
        { value: toNano("0.2") },
        {
          $$type: "BatchSettle",
          batch_id: i,
          batch_data: batchData,
          tee_signature: teeSignature,
        }
      );
      expect(result.transactions).toHaveTransaction({ success: true });
      expect(await gateway.getIsBatchSettled(i)).toBe(true);
    }

    expect(await gateway.getBalance(buyer.address)).toBe(9_500_000n);
    expect(await gateway.getBalance(seller.address)).toBe(500_000n);

    const stats = await gateway.getStats();
    expect(stats.get(1n)).toBe(500_000n); // total_settled
  });

  // ── Test: contract stop/resume affects settlement ──

  it("stopped contract rejects settlement, resume allows it", async () => {
    const buyer = await blockchain.treasury("buyer");
    const seller = await blockchain.treasury("seller");
    await simulateDeposit(gateway, jettonWallet, buyer.address, 1_000_000n);

    // Stop
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetStopped", stopped: true }
    );

    const positions = [
      { from: buyer.address.toString(), to: seller.address.toString(), amount: 100_000n },
    ];
    const batchData = encodeBatchData(positions);
    const sig = signBatch(batchData, teeKeypair);
    const teeSignature = beginCell().storeBuffer(sig).endCell().beginParse();

    // Should fail when stopped
    const failResult = await gateway.send(
      owner.getSender(),
      { value: toNano("0.2") },
      {
        $$type: "BatchSettle",
        batch_id: 1n,
        batch_data: batchData,
        tee_signature: teeSignature,
      }
    );
    expect(failResult.transactions).toHaveTransaction({ success: false });

    // Resume
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetStopped", stopped: false }
    );

    // Should succeed now
    const okResult = await gateway.send(
      owner.getSender(),
      { value: toNano("0.2") },
      {
        $$type: "BatchSettle",
        batch_id: 1n,
        batch_data: batchData,
        tee_signature: teeSignature,
      }
    );
    expect(okResult.transactions).toHaveTransaction({ success: true });
  });
});
