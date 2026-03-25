import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { toNano, beginCell, Address } from "@ton/core";
import { CyberGateway } from "../build/CyberGateway/tact_CyberGateway";
import nacl from "tweetnacl";
import "@ton/test-utils";

/**
 * Helper: simulate a deposit by sending JettonTransferNotification
 */
async function simulateDeposit(
  blockchain: Blockchain,
  gateway: SandboxContract<CyberGateway>,
  depositor: Address,
  amount: bigint
) {
  const fakeJettonWallet = await blockchain.treasury("fake-jetton");
  const forwardPayload = beginCell().storeUint(0, 1).storeUint(0, 8).endCell().beginParse();
  await gateway.send(
    fakeJettonWallet.getSender(),
    { value: toNano("0.2") },
    {
      $$type: "JettonTransferNotification",
      query_id: 0n,
      amount,
      sender: depositor,
      forward_payload: forwardPayload,
    }
  );
}

/**
 * Helper: settle a single-entry batch
 */
async function settleBatch(
  gateway: SandboxContract<CyberGateway>,
  sender: SandboxContract<TreasuryContract>,
  teeKeypair: nacl.SignKeyPair,
  batchId: bigint,
  from: Address,
  to: Address,
  amount: bigint
) {
  const batchData = beginCell()
    .storeUint(1, 16)
    .storeAddress(from)
    .storeAddress(to)
    .storeCoins(amount)
    .endCell();

  const hash = batchData.hash();
  const sig = nacl.sign.detached(new Uint8Array(hash), teeKeypair.secretKey);
  const sigSlice = beginCell().storeBuffer(Buffer.from(sig)).endCell().beginParse();

  return gateway.send(
    sender.getSender(),
    { value: toNano("0.5") },
    {
      $$type: "BatchSettle",
      batch_id: batchId,
      batch_data: batchData,
      tee_signature: sigSlice,
    }
  );
}

describe("CyberGateway Spending Limits & Daily Caps", () => {
  let blockchain: Blockchain;
  let owner: SandboxContract<TreasuryContract>;
  let gateway: SandboxContract<CyberGateway>;
  let teeKeypair: nacl.SignKeyPair;
  let depositorWallet: SandboxContract<TreasuryContract>;
  let sellerWallet: SandboxContract<TreasuryContract>;

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    owner = await blockchain.treasury("owner");
    depositorWallet = await blockchain.treasury("depositor");
    sellerWallet = await blockchain.treasury("seller");
    teeKeypair = nacl.sign.keyPair();

    const pubkeyBigInt = BigInt("0x" + Buffer.from(teeKeypair.publicKey).toString("hex"));
    gateway = blockchain.openContract(
      await CyberGateway.fromInit(owner.address, pubkeyBigInt)
    );

    await gateway.send(
      owner.getSender(),
      { value: toNano("0.5") },
      { $$type: "Deploy", queryId: 0n }
    );

    // Deposit 1000 units for depositor
    await simulateDeposit(blockchain, gateway, depositorWallet.address, 1000n);
  });

  // ── Spending Limit Tests ──

  it("should set spending limit (owner)", async () => {
    const result = await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetSpendingLimit", depositor: depositorWallet.address, limit: 100n }
    );
    expect(result.transactions).toHaveTransaction({ success: true });
    expect(await gateway.getSpendingLimit(depositorWallet.address)).toBe(100n);
  });

  it("should reject spending limit from non-owner", async () => {
    const attacker = await blockchain.treasury("attacker");
    const result = await gateway.send(
      attacker.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetSpendingLimit", depositor: depositorWallet.address, limit: 100n }
    );
    expect(result.transactions).toHaveTransaction({ success: false });
  });

  it("should enforce spending limit in BatchSettle", async () => {
    // Set limit to 50
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetSpendingLimit", depositor: depositorWallet.address, limit: 50n }
    );

    // Try to settle 100 (exceeds limit of 50)
    const result = await settleBatch(
      gateway, owner, teeKeypair, 1n,
      depositorWallet.address, sellerWallet.address, 100n
    );
    expect(result.transactions).toHaveTransaction({
      from: owner.address,
      to: gateway.address,
      success: false,
    });
  });

  it("should allow settlement within spending limit", async () => {
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetSpendingLimit", depositor: depositorWallet.address, limit: 200n }
    );

    const result = await settleBatch(
      gateway, owner, teeKeypair, 1n,
      depositorWallet.address, sellerWallet.address, 100n
    );
    expect(result.transactions).toHaveTransaction({
      from: owner.address,
      to: gateway.address,
      success: true,
    });
  });

  // ── Self-service Spending Limit ──

  it("should allow depositor to set own spending limit", async () => {
    const result = await gateway.send(
      depositorWallet.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetSelfSpendingLimit", limit: 50n }
    );
    expect(result.transactions).toHaveTransaction({ success: true });
    expect(await gateway.getSpendingLimit(depositorWallet.address)).toBe(50n);
  });

  it("should reject depositor raising own spending limit", async () => {
    // Owner sets limit to 50
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetSpendingLimit", depositor: depositorWallet.address, limit: 50n }
    );

    // Depositor tries to raise to 100
    const result = await gateway.send(
      depositorWallet.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetSelfSpendingLimit", limit: 100n }
    );
    expect(result.transactions).toHaveTransaction({ success: false });
  });

  // ── Daily Cap Tests ──

  it("should set daily cap (owner)", async () => {
    const result = await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetDailyCap", depositor: depositorWallet.address, cap: 500n }
    );
    expect(result.transactions).toHaveTransaction({ success: true });
    expect(await gateway.getDailyCap(depositorWallet.address)).toBe(500n);
  });

  it("should enforce daily cap across multiple settlements", async () => {
    // Set daily cap to 150
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetDailyCap", depositor: depositorWallet.address, cap: 150n }
    );

    // First settlement: 100 (ok, 100 <= 150)
    const r1 = await settleBatch(
      gateway, owner, teeKeypair, 1n,
      depositorWallet.address, sellerWallet.address, 100n
    );
    expect(r1.transactions).toHaveTransaction({ success: true });

    // Second settlement: 100 (fail, 100+100=200 > 150)
    const r2 = await settleBatch(
      gateway, owner, teeKeypair, 2n,
      depositorWallet.address, sellerWallet.address, 100n
    );
    expect(r2.transactions).toHaveTransaction({
      from: owner.address,
      to: gateway.address,
      success: false,
    });
  });

  it("should allow settlement within daily cap", async () => {
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetDailyCap", depositor: depositorWallet.address, cap: 500n }
    );

    const r1 = await settleBatch(
      gateway, owner, teeKeypair, 1n,
      depositorWallet.address, sellerWallet.address, 200n
    );
    expect(r1.transactions).toHaveTransaction({ success: true });

    const r2 = await settleBatch(
      gateway, owner, teeKeypair, 2n,
      depositorWallet.address, sellerWallet.address, 200n
    );
    expect(r2.transactions).toHaveTransaction({ success: true });
  });

  // ── Self-service Daily Cap ──

  it("should allow depositor to set own daily cap", async () => {
    const result = await gateway.send(
      depositorWallet.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetSelfDailyCap", cap: 300n }
    );
    expect(result.transactions).toHaveTransaction({ success: true });
    expect(await gateway.getDailyCap(depositorWallet.address)).toBe(300n);
  });

  // ── No limit = unlimited ──

  it("should allow unlimited settlement when no limits set", async () => {
    const result = await settleBatch(
      gateway, owner, teeKeypair, 1n,
      depositorWallet.address, sellerWallet.address, 900n
    );
    expect(result.transactions).toHaveTransaction({ success: true });
  });
});
