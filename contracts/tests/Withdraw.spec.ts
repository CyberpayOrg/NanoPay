import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { toNano, beginCell } from "@ton/core";
import { CyberGateway } from "../build/CyberGateway/tact_CyberGateway";
import nacl from "tweetnacl";
import "@ton/test-utils";

describe("CyberGateway Withdraw", () => {
  let blockchain: Blockchain;
  let owner: SandboxContract<TreasuryContract>;
  let gateway: SandboxContract<CyberGateway>;
  let jettonWallet: SandboxContract<TreasuryContract>;
  let depositor: SandboxContract<TreasuryContract>;

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    owner = await blockchain.treasury("owner");
    const teeKp = nacl.sign.keyPair();
    const pubkey = BigInt("0x" + Buffer.from(teeKp.publicKey).toString("hex"));
    jettonWallet = await blockchain.treasury("jetton-wallet");
    depositor = await blockchain.treasury("depositor");

    gateway = blockchain.openContract(
      await CyberGateway.fromInit(owner.address, pubkey)
    );

    await gateway.send(owner.getSender(), { value: toNano("0.5") }, { $$type: "Deploy", queryId: 0n });
    await gateway.send(owner.getSender(), { value: toNano("0.1") }, { $$type: "SetJettonWallet", wallet: jettonWallet.address });

    // Set short cooldown for testing (10 seconds)
    await gateway.send(owner.getSender(), { value: toNano("0.1") }, { $$type: "SetCooldown", seconds: 10n });

    // Deposit
    const fwd = beginCell().storeUint(0, 1).storeUint(2, 8).endCell().beginParse();
    await gateway.send(
      jettonWallet.getSender(),
      { value: toNano("0.1") },
      { $$type: "JettonTransferNotification", query_id: 0n, amount: 1000000n, sender: depositor.address, forward_payload: fwd }
    );
  });

  it("should initiate withdrawal", async () => {
    const result = await gateway.send(
      depositor.getSender(),
      { value: toNano("0.1") },
      { $$type: "InitiateWithdraw", amount: 500000n }
    );

    expect(result.transactions).toHaveTransaction({
      from: depositor.address,
      to: gateway.address,
      success: true,
    });

    // Balance should be reduced
    expect(await gateway.getBalance(depositor.address)).toBe(500000n);
    // Pending withdrawal should be set
    expect(await gateway.getPendingWithdrawal(depositor.address)).toBe(500000n);
  });

  it("should reject withdrawal exceeding balance", async () => {
    const result = await gateway.send(
      depositor.getSender(),
      { value: toNano("0.1") },
      { $$type: "InitiateWithdraw", amount: 2000000n }
    );

    expect(result.transactions).toHaveTransaction({
      from: depositor.address,
      to: gateway.address,
      success: false,
    });
  });

  it("should reject double withdrawal initiation", async () => {
    await gateway.send(
      depositor.getSender(),
      { value: toNano("0.1") },
      { $$type: "InitiateWithdraw", amount: 100000n }
    );

    const result = await gateway.send(
      depositor.getSender(),
      { value: toNano("0.1") },
      { $$type: "InitiateWithdraw", amount: 100000n }
    );

    expect(result.transactions).toHaveTransaction({
      from: depositor.address,
      to: gateway.address,
      success: false,
    });
  });

  it("should reject CompleteWithdraw before cooldown", async () => {
    await gateway.send(
      depositor.getSender(),
      { value: toNano("0.1") },
      { $$type: "InitiateWithdraw", amount: 500000n }
    );

    // Try to complete immediately (cooldown is 10s)
    const result = await gateway.send(
      depositor.getSender(),
      { value: toNano("0.1") },
      { $$type: "CompleteWithdraw" }
    );

    expect(result.transactions).toHaveTransaction({
      from: depositor.address,
      to: gateway.address,
      success: false,
    });
  });

  it("should complete withdrawal after cooldown", async () => {
    await gateway.send(
      depositor.getSender(),
      { value: toNano("0.1") },
      { $$type: "InitiateWithdraw", amount: 500000n }
    );

    // Advance time past cooldown
    blockchain.now = Math.floor(Date.now() / 1000) + 15;

    const result = await gateway.send(
      depositor.getSender(),
      { value: toNano("0.2") },
      { $$type: "CompleteWithdraw" }
    );

    expect(result.transactions).toHaveTransaction({
      from: depositor.address,
      to: gateway.address,
      success: true,
    });

    // Should send JettonTransfer to jetton wallet
    expect(result.transactions).toHaveTransaction({
      from: gateway.address,
      to: jettonWallet.address,
      success: true,
    });

    // Pending should be cleared
    expect(await gateway.getPendingWithdrawal(depositor.address)).toBe(0n);
  });

  it("should reject CompleteWithdraw with no pending", async () => {
    const result = await gateway.send(
      depositor.getSender(),
      { value: toNano("0.1") },
      { $$type: "CompleteWithdraw" }
    );

    expect(result.transactions).toHaveTransaction({
      from: depositor.address,
      to: gateway.address,
      success: false,
    });
  });
});
