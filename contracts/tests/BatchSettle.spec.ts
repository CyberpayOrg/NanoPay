import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Cell, toNano, beginCell, Address } from "@ton/core";
import { CyberGateway } from "../build/CyberGateway/tact_CyberGateway";
import nacl from "tweetnacl";
import "@ton/test-utils";

/**
 * Tests for BatchSettle — the core TEE → onchain settlement flow.
 * Simulates: deposit → TEE signs batch → contract verifies + transfers.
 */
describe("CyberGateway BatchSettle", () => {
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

    // Deploy
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.5") },
      { $$type: "Deploy", queryId: 0n }
    );

    // Set jetton wallet
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetJettonWallet", wallet: jettonWallet.address }
    );
  });

  // Helper: simulate deposit via JettonTransferNotification
  async function simulateDeposit(depositor: Address, amount: bigint) {
    // Build forward_payload: either_bit=0, op=2 (deposit)
    const fwdPayload = beginCell()
      .storeUint(0, 1) // either bit = 0 (inline)
      .storeUint(2, 8) // op = 2 (deposit)
      .endCell()
      .beginParse();

    await gateway.send(
      jettonWallet.getSender(),
      { value: toNano("0.1") },
      {
        $$type: "JettonTransferNotification",
        query_id: 0n,
        amount: amount,
        sender: depositor,
        forward_payload: fwdPayload,
      }
    );
  }

  // Helper: build and sign a batch
  function buildSignedBatch(
    batchId: bigint,
    entries: { from: Address; to: Address; amount: bigint }[]
  ) {
    // Build batch_data cell: count(u16) + entries
    let builder = beginCell().storeUint(entries.length, 16);

    if (entries.length <= 1) {
      for (const e of entries) {
        builder = builder
          .storeAddress(e.from)
          .storeAddress(e.to)
          .storeCoins(e.amount);
      }
    } else {
      // First entry inline
      builder = builder
        .storeAddress(entries[0].from)
        .storeAddress(entries[0].to)
        .storeCoins(entries[0].amount);

      // Rest in ref chain
      let refCell: Cell | null = null;
      for (let i = entries.length - 1; i >= 1; i--) {
        let eb = beginCell()
          .storeAddress(entries[i].from)
          .storeAddress(entries[i].to)
          .storeCoins(entries[i].amount);
        if (refCell) eb = eb.storeRef(refCell);
        refCell = eb.endCell();
      }
      if (refCell) builder = builder.storeRef(refCell);
    }

    const batchData = builder.endCell();

    // Sign with TEE key
    const hash = batchData.hash();
    const sig = nacl.sign.detached(new Uint8Array(hash), teeKeypair.secretKey);
    const teeSignature = beginCell()
      .storeBuffer(Buffer.from(sig))
      .endCell()
      .beginParse();

    return { batchData, teeSignature };
  }

  it("should process deposit via JettonTransferNotification", async () => {
    const depositor = (await blockchain.treasury("depositor")).address;
    await simulateDeposit(depositor, 1000000n);

    const balance = await gateway.getBalance(depositor);
    expect(balance).toBe(1000000n);

    const stats = await gateway.getStats();
    expect(stats.get(0n)).toBe(1000000n); // total_deposits
  });

  it("should settle a single-entry batch", async () => {
    const buyer = await blockchain.treasury("buyer");
    const seller = await blockchain.treasury("seller");

    // Deposit
    await simulateDeposit(buyer.address, 1000000n);

    // Build batch: buyer → seller 500000
    const { batchData, teeSignature } = buildSignedBatch(1n, [
      { from: buyer.address, to: seller.address, amount: 500000n },
    ]);

    // Submit batch
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

    // Check balances
    expect(await gateway.getBalance(buyer.address)).toBe(500000n);
    expect(await gateway.getBalance(seller.address)).toBe(500000n);

    // Check stats
    const stats = await gateway.getStats();
    expect(stats.get(1n)).toBe(500000n); // total_settled

    // Check batch is marked as settled
    expect(await gateway.getIsBatchSettled(1n)).toBe(true);
  });

  it("should reject replay of same batch_id", async () => {
    const buyer = await blockchain.treasury("buyer");
    const seller = await blockchain.treasury("seller");

    await simulateDeposit(buyer.address, 1000000n);

    const { batchData, teeSignature } = buildSignedBatch(1n, [
      { from: buyer.address, to: seller.address, amount: 100000n },
    ]);

    // First submission — should succeed
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.2") },
      {
        $$type: "BatchSettle",
        batch_id: 1n,
        batch_data: batchData,
        tee_signature: teeSignature,
      }
    );

    // Second submission with same batch_id — should fail
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
      success: false,
    });
  });

  it("should reject batch with invalid TEE signature", async () => {
    const buyer = await blockchain.treasury("buyer");
    const seller = await blockchain.treasury("seller");

    await simulateDeposit(buyer.address, 1000000n);

    // Build batch data
    const batchData = beginCell()
      .storeUint(1, 16)
      .storeAddress(buyer.address)
      .storeAddress(seller.address)
      .storeCoins(100000n)
      .endCell();

    // Sign with WRONG key
    const fakeKp = nacl.sign.keyPair();
    const hash = batchData.hash();
    const fakeSig = nacl.sign.detached(new Uint8Array(hash), fakeKp.secretKey);
    const teeSignature = beginCell()
      .storeBuffer(Buffer.from(fakeSig))
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
      success: false,
    });
  });

  it("should reject batch with insufficient balance", async () => {
    const buyer = await blockchain.treasury("buyer");
    const seller = await blockchain.treasury("seller");

    await simulateDeposit(buyer.address, 100n); // Only 100

    const { batchData, teeSignature } = buildSignedBatch(1n, [
      { from: buyer.address, to: seller.address, amount: 1000n }, // Trying to send 1000
    ]);

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
      success: false,
    });
  });

  it("should settle multi-entry batch", async () => {
    const buyer1 = await blockchain.treasury("buyer1");
    const buyer2 = await blockchain.treasury("buyer2");
    const seller = await blockchain.treasury("seller");

    await simulateDeposit(buyer1.address, 1000000n);
    await simulateDeposit(buyer2.address, 500000n);

    const { batchData, teeSignature } = buildSignedBatch(1n, [
      { from: buyer1.address, to: seller.address, amount: 300000n },
      { from: buyer2.address, to: seller.address, amount: 200000n },
    ]);

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

    expect(result.transactions).toHaveTransaction({
      from: owner.address,
      to: gateway.address,
      success: true,
    });

    expect(await gateway.getBalance(buyer1.address)).toBe(700000n);
    expect(await gateway.getBalance(buyer2.address)).toBe(300000n);
    expect(await gateway.getBalance(seller.address)).toBe(500000n);
  });
});
