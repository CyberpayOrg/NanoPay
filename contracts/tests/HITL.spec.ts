import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { toNano, beginCell } from "@ton/core";
import { CyberGateway } from "../build/CyberGateway/tact_CyberGateway";
import nacl from "tweetnacl";
import "@ton/test-utils";

describe("CyberGateway HITL Approvals", () => {
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

    // Deposit 1000 units
    const fakeJettonWallet = await blockchain.treasury("fake-jetton");
    const forwardPayload = beginCell().storeUint(0, 1).storeUint(0, 8).endCell().beginParse();
    await gateway.send(
      fakeJettonWallet.getSender(),
      { value: toNano("0.2") },
      {
        $$type: "JettonTransferNotification",
        query_id: 0n,
        amount: 1000n,
        sender: depositorWallet.address,
        forward_payload: forwardPayload,
      }
    );
  });

  it("should request approval (owner only)", async () => {
    const result = await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      {
        $$type: "RequestApproval",
        payment_id: 1n,
        from: depositorWallet.address,
        to: sellerWallet.address,
        amount: 500n,
      }
    );
    expect(result.transactions).toHaveTransaction({ success: true });
    expect(await gateway.getPendingApproval(1n)).toBe(500n);
  });

  it("should reject RequestApproval from non-owner", async () => {
    const attacker = await blockchain.treasury("attacker");
    const result = await gateway.send(
      attacker.getSender(),
      { value: toNano("0.1") },
      {
        $$type: "RequestApproval",
        payment_id: 1n,
        from: depositorWallet.address,
        to: sellerWallet.address,
        amount: 500n,
      }
    );
    expect(result.transactions).toHaveTransaction({ success: false });
  });

  it("should approve payment and transfer funds", async () => {
    // Request approval
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      {
        $$type: "RequestApproval",
        payment_id: 1n,
        from: depositorWallet.address,
        to: sellerWallet.address,
        amount: 300n,
      }
    );

    // Approve
    const result = await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "ApprovePayment", payment_id: 1n }
    );
    expect(result.transactions).toHaveTransaction({ success: true });

    // Check balances
    expect(await gateway.getBalance(depositorWallet.address)).toBe(700n);
    expect(await gateway.getBalance(sellerWallet.address)).toBe(300n);

    // Pending should be cleared
    expect(await gateway.getPendingApproval(1n)).toBe(0n);
  });

  it("should reject payment and NOT transfer funds", async () => {
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      {
        $$type: "RequestApproval",
        payment_id: 2n,
        from: depositorWallet.address,
        to: sellerWallet.address,
        amount: 400n,
      }
    );

    const result = await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "RejectPayment", payment_id: 2n }
    );
    expect(result.transactions).toHaveTransaction({ success: true });

    // Depositor balance unchanged (funds were NOT locked in RequestApproval)
    expect(await gateway.getBalance(depositorWallet.address)).toBe(1000n);
    expect(await gateway.getBalance(sellerWallet.address)).toBe(0n);
    expect(await gateway.getPendingApproval(2n)).toBe(0n);
  });

  it("should reject approve for non-existent payment", async () => {
    const result = await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "ApprovePayment", payment_id: 999n }
    );
    expect(result.transactions).toHaveTransaction({ success: false });
  });

  it("should reject approve from non-owner", async () => {
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      {
        $$type: "RequestApproval",
        payment_id: 3n,
        from: depositorWallet.address,
        to: sellerWallet.address,
        amount: 100n,
      }
    );

    const attacker = await blockchain.treasury("attacker");
    const result = await gateway.send(
      attacker.getSender(),
      { value: toNano("0.1") },
      { $$type: "ApprovePayment", payment_id: 3n }
    );
    expect(result.transactions).toHaveTransaction({ success: false });
  });
});
