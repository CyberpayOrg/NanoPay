/**
 * End-to-End Tests — Full CyberNanoPay Lifecycle
 *
 * Simulates the complete flow:
 *   1. Deposit USDT → contract
 *   2. TEE verifies payments (offchain) → accumulates batch
 *   3. TEE signs + submits BatchSettle → contract executes
 *   4. Merchant withdraws settled funds
 *
 * Also tests edge cases: spending limits + settlement,
 * HITL approval + settlement, multi-merchant scenarios.
 */

import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { toNano, beginCell, Address, Cell } from "@ton/core";
import { CyberGateway } from "../build/CyberGateway/tact_CyberGateway";
import nacl from "tweetnacl";
import "@ton/test-utils";

// ── Settler encoding (mirrors tee/src/settler.ts) ──

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

function signBatch(batchData: Cell, kp: nacl.SignKeyPair): Buffer {
  return Buffer.from(nacl.sign.detached(new Uint8Array(batchData.hash()), kp.secretKey));
}

// ── Helpers ──

async function deposit(
  gateway: SandboxContract<CyberGateway>,
  jettonWallet: SandboxContract<TreasuryContract>,
  depositor: Address,
  amount: bigint
) {
  const fwd = beginCell().storeUint(0, 1).storeUint(2, 8).endCell().beginParse();
  await gateway.send(
    jettonWallet.getSender(),
    { value: toNano("0.1") },
    {
      $$type: "JettonTransferNotification",
      query_id: 0n,
      amount,
      sender: depositor,
      forward_payload: fwd,
    }
  );
}

async function settle(
  gateway: SandboxContract<CyberGateway>,
  sender: SandboxContract<TreasuryContract>,
  teeKeypair: nacl.SignKeyPair,
  batchId: bigint,
  positions: { from: string; to: string; amount: bigint }[]
) {
  const batchData = encodeBatchData(positions);
  const sig = signBatch(batchData, teeKeypair);
  const teeSignature = beginCell().storeBuffer(sig).endCell().beginParse();
  return gateway.send(
    sender.getSender(),
    { value: toNano("0.3") },
    {
      $$type: "BatchSettle",
      batch_id: batchId,
      batch_data: batchData,
      tee_signature: teeSignature,
    }
  );
}

describe("E2E: Full CyberNanoPay Lifecycle", () => {
  let blockchain: Blockchain;
  let owner: SandboxContract<TreasuryContract>;
  let gateway: SandboxContract<CyberGateway>;
  let teeKeypair: nacl.SignKeyPair;
  let jettonWallet: SandboxContract<TreasuryContract>;

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    owner = await blockchain.treasury("owner");
    teeKeypair = nacl.sign.keyPair();
    jettonWallet = await blockchain.treasury("jetton-wallet");

    const pubkey = BigInt("0x" + Buffer.from(teeKeypair.publicKey).toString("hex"));
    gateway = blockchain.openContract(
      await CyberGateway.fromInit(owner.address, pubkey)
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
    // Short cooldown for testing
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetCooldown", seconds: 5n }
    );
  });

  // ══════════════════════════════════════════════
  // Scenario 1: Happy path — deposit → settle → withdraw
  // ══════════════════════════════════════════════

  it("full lifecycle: deposit → batch settle → withdraw", async () => {
    const buyer = await blockchain.treasury("buyer");
    const merchant = await blockchain.treasury("merchant");

    // Step 1: Buyer deposits 10 USDT (10_000_000 smallest units)
    await deposit(gateway, jettonWallet, buyer.address, 10_000_000n);
    expect(await gateway.getBalance(buyer.address)).toBe(10_000_000n);

    // Step 2: TEE processes payments offchain, then settles batch
    // Simulates: buyer paid merchant 3 USDT across multiple micro-payments
    const result = await settle(gateway, owner, teeKeypair, 1n, [
      { from: buyer.address.toString(), to: merchant.address.toString(), amount: 3_000_000n },
    ]);
    expect(result.transactions).toHaveTransaction({ success: true });

    expect(await gateway.getBalance(buyer.address)).toBe(7_000_000n);
    expect(await gateway.getBalance(merchant.address)).toBe(3_000_000n);

    // Step 3: Merchant initiates withdrawal
    const initResult = await gateway.send(
      merchant.getSender(),
      { value: toNano("0.1") },
      { $$type: "InitiateWithdraw", amount: 3_000_000n }
    );
    expect(initResult.transactions).toHaveTransaction({ success: true });
    expect(await gateway.getPendingWithdrawal(merchant.address)).toBe(3_000_000n);
    expect(await gateway.getBalance(merchant.address)).toBe(0n);

    // Step 4: Wait for cooldown, then complete withdrawal
    blockchain.now = Math.floor(Date.now() / 1000) + 10;

    const completeResult = await gateway.send(
      merchant.getSender(),
      { value: toNano("0.2") },
      { $$type: "CompleteWithdraw" }
    );
    expect(completeResult.transactions).toHaveTransaction({ success: true });

    // Should send JettonTransfer to jetton wallet
    expect(completeResult.transactions).toHaveTransaction({
      from: gateway.address,
      to: jettonWallet.address,
      success: true,
    });

    expect(await gateway.getPendingWithdrawal(merchant.address)).toBe(0n);

    // Verify stats
    const stats = await gateway.getStats();
    expect(stats.get(0n)).toBe(10_000_000n); // total_deposits
    expect(stats.get(1n)).toBe(3_000_000n);  // total_settled
    expect(stats.get(2n)).toBe(3_000_000n);  // total_withdrawn
  });

  // ══════════════════════════════════════════════
  // Scenario 2: Multi-merchant, multi-batch
  // ══════════════════════════════════════════════

  it("multi-merchant: buyer pays 3 merchants across 2 batches", async () => {
    const buyer = await blockchain.treasury("buyer");
    const m1 = await blockchain.treasury("merchant1");
    const m2 = await blockchain.treasury("merchant2");
    const m3 = await blockchain.treasury("merchant3");

    await deposit(gateway, jettonWallet, buyer.address, 50_000_000n);

    // Batch 1: buyer → m1 (5M), buyer → m2 (3M)
    const r1 = await settle(gateway, owner, teeKeypair, 1n, [
      { from: buyer.address.toString(), to: m1.address.toString(), amount: 5_000_000n },
      { from: buyer.address.toString(), to: m2.address.toString(), amount: 3_000_000n },
    ]);
    expect(r1.transactions).toHaveTransaction({ success: true });

    // Batch 2: buyer → m3 (2M), buyer → m1 (1M)
    const r2 = await settle(gateway, owner, teeKeypair, 2n, [
      { from: buyer.address.toString(), to: m3.address.toString(), amount: 2_000_000n },
      { from: buyer.address.toString(), to: m1.address.toString(), amount: 1_000_000n },
    ]);
    expect(r2.transactions).toHaveTransaction({ success: true });

    expect(await gateway.getBalance(buyer.address)).toBe(39_000_000n);
    expect(await gateway.getBalance(m1.address)).toBe(6_000_000n);
    expect(await gateway.getBalance(m2.address)).toBe(3_000_000n);
    expect(await gateway.getBalance(m3.address)).toBe(2_000_000n);
  });

  // ══════════════════════════════════════════════
  // Scenario 3: Spending limit blocks oversized settlement
  // ══════════════════════════════════════════════

  it("spending limit: blocks single payment exceeding limit", async () => {
    const buyer = await blockchain.treasury("buyer");
    const merchant = await blockchain.treasury("merchant");

    await deposit(gateway, jettonWallet, buyer.address, 10_000_000n);

    // Owner sets spending limit: max 1M per payment
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetSpendingLimit", depositor: buyer.address, limit: 1_000_000n }
    );

    // Try to settle 2M (exceeds limit)
    const failResult = await settle(gateway, owner, teeKeypair, 1n, [
      { from: buyer.address.toString(), to: merchant.address.toString(), amount: 2_000_000n },
    ]);
    expect(failResult.transactions).toHaveTransaction({ success: false });

    // Settle 800K (within limit) — should work
    const okResult = await settle(gateway, owner, teeKeypair, 2n, [
      { from: buyer.address.toString(), to: merchant.address.toString(), amount: 800_000n },
    ]);
    expect(okResult.transactions).toHaveTransaction({ success: true });
  });

  // ══════════════════════════════════════════════
  // Scenario 4: Daily cap across multiple batches
  // ══════════════════════════════════════════════

  it("daily cap: blocks settlement when daily total exceeded", async () => {
    const buyer = await blockchain.treasury("buyer");
    const merchant = await blockchain.treasury("merchant");

    await deposit(gateway, jettonWallet, buyer.address, 50_000_000n);

    // Set daily cap: 5M per day
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetDailyCap", depositor: buyer.address, cap: 5_000_000n }
    );

    // Batch 1: 3M (ok, 3M <= 5M)
    const r1 = await settle(gateway, owner, teeKeypair, 1n, [
      { from: buyer.address.toString(), to: merchant.address.toString(), amount: 3_000_000n },
    ]);
    expect(r1.transactions).toHaveTransaction({ success: true });

    // Batch 2: 3M (fail, 3M + 3M = 6M > 5M)
    const r2 = await settle(gateway, owner, teeKeypair, 2n, [
      { from: buyer.address.toString(), to: merchant.address.toString(), amount: 3_000_000n },
    ]);
    expect(r2.transactions).toHaveTransaction({ success: false });

    // Batch 3: 2M (ok, 3M + 2M = 5M <= 5M)
    const r3 = await settle(gateway, owner, teeKeypair, 3n, [
      { from: buyer.address.toString(), to: merchant.address.toString(), amount: 2_000_000n },
    ]);
    expect(r3.transactions).toHaveTransaction({ success: true });
  });

  // ══════════════════════════════════════════════
  // Scenario 5: HITL approval → settlement → withdraw
  // ══════════════════════════════════════════════

  it("HITL: request approval → approve → funds transferred", async () => {
    const buyer = await blockchain.treasury("buyer");
    const merchant = await blockchain.treasury("merchant");

    await deposit(gateway, jettonWallet, buyer.address, 10_000_000n);

    // TEE requests approval for large payment
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      {
        $$type: "RequestApproval",
        payment_id: 1n,
        from: buyer.address,
        to: merchant.address,
        amount: 5_000_000n,
      }
    );
    expect(await gateway.getPendingApproval(1n)).toBe(5_000_000n);

    // Human approves
    const approveResult = await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "ApprovePayment", payment_id: 1n }
    );
    expect(approveResult.transactions).toHaveTransaction({ success: true });

    expect(await gateway.getBalance(buyer.address)).toBe(5_000_000n);
    expect(await gateway.getBalance(merchant.address)).toBe(5_000_000n);

    // Merchant withdraws
    await gateway.send(
      merchant.getSender(),
      { value: toNano("0.1") },
      { $$type: "InitiateWithdraw", amount: 5_000_000n }
    );

    blockchain.now = Math.floor(Date.now() / 1000) + 10;

    const withdrawResult = await gateway.send(
      merchant.getSender(),
      { value: toNano("0.2") },
      { $$type: "CompleteWithdraw" }
    );
    expect(withdrawResult.transactions).toHaveTransaction({
      from: gateway.address,
      to: jettonWallet.address,
      success: true,
    });
  });

  // ══════════════════════════════════════════════
  // Scenario 6: HITL rejection — funds stay with buyer
  // ══════════════════════════════════════════════

  it("HITL: request approval → reject → buyer keeps funds", async () => {
    const buyer = await blockchain.treasury("buyer");
    const merchant = await blockchain.treasury("merchant");

    await deposit(gateway, jettonWallet, buyer.address, 10_000_000n);

    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      {
        $$type: "RequestApproval",
        payment_id: 1n,
        from: buyer.address,
        to: merchant.address,
        amount: 8_000_000n,
      }
    );

    // Reject
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "RejectPayment", payment_id: 1n }
    );

    // Buyer balance unchanged
    expect(await gateway.getBalance(buyer.address)).toBe(10_000_000n);
    expect(await gateway.getBalance(merchant.address)).toBe(0n);
  });

  // ══════════════════════════════════════════════
  // Scenario 7: Partial withdraw — buyer withdraws remaining
  // ══════════════════════════════════════════════

  it("buyer deposits, pays merchant, withdraws remaining balance", async () => {
    const buyer = await blockchain.treasury("buyer");
    const merchant = await blockchain.treasury("merchant");

    await deposit(gateway, jettonWallet, buyer.address, 10_000_000n);

    // Settle: buyer → merchant 6M
    await settle(gateway, owner, teeKeypair, 1n, [
      { from: buyer.address.toString(), to: merchant.address.toString(), amount: 6_000_000n },
    ]);

    // Buyer withdraws remaining 4M
    await gateway.send(
      buyer.getSender(),
      { value: toNano("0.1") },
      { $$type: "InitiateWithdraw", amount: 4_000_000n }
    );

    blockchain.now = Math.floor(Date.now() / 1000) + 10;

    const result = await gateway.send(
      buyer.getSender(),
      { value: toNano("0.2") },
      { $$type: "CompleteWithdraw" }
    );
    expect(result.transactions).toHaveTransaction({
      from: gateway.address,
      to: jettonWallet.address,
      success: true,
    });

    expect(await gateway.getBalance(buyer.address)).toBe(0n);
  });

  // ══════════════════════════════════════════════
  // Scenario 8: Withdraw before cooldown fails
  // ══════════════════════════════════════════════

  it("withdraw before cooldown is rejected", async () => {
    const merchant = await blockchain.treasury("merchant");
    await deposit(gateway, jettonWallet, merchant.address, 5_000_000n);

    await gateway.send(
      merchant.getSender(),
      { value: toNano("0.1") },
      { $$type: "InitiateWithdraw", amount: 5_000_000n }
    );

    // Try immediately (cooldown is 5s)
    const result = await gateway.send(
      merchant.getSender(),
      { value: toNano("0.2") },
      { $$type: "CompleteWithdraw" }
    );
    expect(result.transactions).toHaveTransaction({ success: false });
  });

  // ══════════════════════════════════════════════
  // Scenario 9: Multiple deposits + settlements + stats
  // ══════════════════════════════════════════════

  it("stats accumulate correctly across deposits and settlements", async () => {
    const b1 = await blockchain.treasury("b1");
    const b2 = await blockchain.treasury("b2");
    const m = await blockchain.treasury("m");

    await deposit(gateway, jettonWallet, b1.address, 5_000_000n);
    await deposit(gateway, jettonWallet, b2.address, 3_000_000n);

    await settle(gateway, owner, teeKeypair, 1n, [
      { from: b1.address.toString(), to: m.address.toString(), amount: 2_000_000n },
      { from: b2.address.toString(), to: m.address.toString(), amount: 1_000_000n },
    ]);

    await settle(gateway, owner, teeKeypair, 2n, [
      { from: b1.address.toString(), to: m.address.toString(), amount: 1_000_000n },
    ]);

    const stats = await gateway.getStats();
    expect(stats.get(0n)).toBe(8_000_000n);  // total_deposits: 5M + 3M
    expect(stats.get(1n)).toBe(4_000_000n);  // total_settled: 2M + 1M + 1M
    expect(stats.get(2n)).toBe(0n);          // total_withdrawn: 0

    expect(await gateway.getBalance(b1.address)).toBe(2_000_000n);
    expect(await gateway.getBalance(b2.address)).toBe(2_000_000n);
    expect(await gateway.getBalance(m.address)).toBe(4_000_000n);
  });

  // ══════════════════════════════════════════════
  // Scenario 10: Self-service spending limit
  // ══════════════════════════════════════════════

  it("depositor sets own spending limit, cannot raise above owner-set", async () => {
    const buyer = await blockchain.treasury("buyer");
    const merchant = await blockchain.treasury("merchant");

    await deposit(gateway, jettonWallet, buyer.address, 10_000_000n);

    // Buyer sets own limit to 500K
    const r1 = await gateway.send(
      buyer.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetSelfSpendingLimit", limit: 500_000n }
    );
    expect(r1.transactions).toHaveTransaction({ success: true });

    // Settlement of 600K should fail
    const failResult = await settle(gateway, owner, teeKeypair, 1n, [
      { from: buyer.address.toString(), to: merchant.address.toString(), amount: 600_000n },
    ]);
    expect(failResult.transactions).toHaveTransaction({ success: false });

    // Settlement of 400K should succeed
    const okResult = await settle(gateway, owner, teeKeypair, 2n, [
      { from: buyer.address.toString(), to: merchant.address.toString(), amount: 400_000n },
    ]);
    expect(okResult.transactions).toHaveTransaction({ success: true });

    // Buyer tries to raise limit — should fail
    const raiseResult = await gateway.send(
      buyer.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetSelfSpendingLimit", limit: 1_000_000n }
    );
    expect(raiseResult.transactions).toHaveTransaction({ success: false });
  });

  // ══════════════════════════════════════════════
  // Scenario 11: Delegate mechanism
  // ══════════════════════════════════════════════

  it("delegate: add and remove delegate", async () => {
    const depositor = await blockchain.treasury("depositor");
    const delegate = await blockchain.treasury("delegate");

    // Add delegate
    const addResult = await gateway.send(
      depositor.getSender(),
      { value: toNano("0.1") },
      { $$type: "AddDelegate", delegate: delegate.address }
    );
    expect(addResult.transactions).toHaveTransaction({ success: true });

    const stored = await gateway.getDelegate(depositor.address);
    expect(stored?.toString()).toBe(delegate.address.toString());

    // Remove delegate
    const removeResult = await gateway.send(
      depositor.getSender(),
      { value: toNano("0.1") },
      { $$type: "RemoveDelegate", delegate: delegate.address }
    );
    expect(removeResult.transactions).toHaveTransaction({ success: true });

    const removed = await gateway.getDelegate(depositor.address);
    expect(removed).toBeNull();
  });

  // ══════════════════════════════════════════════
  // Scenario 12: Register pubkey for verified batch
  // ══════════════════════════════════════════════

  it("register user pubkey for on-chain verification", async () => {
    const user = await blockchain.treasury("user");
    const userKp = nacl.sign.keyPair();
    const pubkeyBigInt = BigInt("0x" + Buffer.from(userKp.publicKey).toString("hex"));

    const result = await gateway.send(
      user.getSender(),
      { value: toNano("0.1") },
      { $$type: "RegisterPubkey", pubkey: pubkeyBigInt }
    );
    expect(result.transactions).toHaveTransaction({ success: true });

    const stored = await gateway.getUserPubkey(user.address);
    expect(stored).toBe(pubkeyBigInt);
  });
});
