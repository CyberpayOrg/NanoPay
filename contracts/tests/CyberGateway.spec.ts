import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Cell, toNano, beginCell, Address } from "@ton/core";
import { CyberGateway } from "../build/CyberGateway/tact_CyberGateway";
import nacl from "tweetnacl";
import "@ton/test-utils";

describe("CyberGateway", () => {
  let blockchain: Blockchain;
  let owner: SandboxContract<TreasuryContract>;
  let gateway: SandboxContract<CyberGateway>;
  let teeKeypair: nacl.SignKeyPair;

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    owner = await blockchain.treasury("owner");
    teeKeypair = nacl.sign.keyPair();

    // Convert 32-byte pubkey to bigint
    const pubkeyBigInt = BigInt(
      "0x" + Buffer.from(teeKeypair.publicKey).toString("hex")
    );

    gateway = blockchain.openContract(
      await CyberGateway.fromInit(owner.address, pubkeyBigInt)
    );

    // Deploy
    const deployResult = await gateway.send(
      owner.getSender(),
      { value: toNano("0.5") },
      { $$type: "Deploy", queryId: 0n }
    );
    expect(deployResult.transactions).toHaveTransaction({
      from: owner.address,
      to: gateway.address,
      deploy: true,
      success: true,
    });
  });

  it("should deploy correctly", async () => {
    const stopped = await gateway.getStopped();
    expect(stopped).toBe(false);

    const cooldown = await gateway.getCooldown();
    expect(cooldown).toBe(86400n);

    const teePubkey = await gateway.getTeePublicKey();
    const expected = BigInt(
      "0x" + Buffer.from(teeKeypair.publicKey).toString("hex")
    );
    expect(teePubkey).toBe(expected);
  });

  it("should set jetton wallet (owner only)", async () => {
    const fakeWallet = (await blockchain.treasury("jetton-wallet")).address;

    const result = await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetJettonWallet", wallet: fakeWallet }
    );
    expect(result.transactions).toHaveTransaction({
      from: owner.address,
      to: gateway.address,
      success: true,
    });
  });

  it("should reject SetJettonWallet from non-owner", async () => {
    const attacker = await blockchain.treasury("attacker");
    const fakeWallet = (await blockchain.treasury("jetton-wallet")).address;

    const result = await gateway.send(
      attacker.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetJettonWallet", wallet: fakeWallet }
    );
    expect(result.transactions).toHaveTransaction({
      from: attacker.address,
      to: gateway.address,
      success: false,
    });
  });

  it("should set stopped flag", async () => {
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetStopped", stopped: true }
    );
    expect(await gateway.getStopped()).toBe(true);

    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetStopped", stopped: false }
    );
    expect(await gateway.getStopped()).toBe(false);
  });

  it("should update TEE key", async () => {
    const newKp = nacl.sign.keyPair();
    const newPubkey = BigInt(
      "0x" + Buffer.from(newKp.publicKey).toString("hex")
    );

    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetTeeKey", tee_pubkey: newPubkey }
    );

    expect(await gateway.getTeePublicKey()).toBe(newPubkey);
  });

  it("should update cooldown", async () => {
    await gateway.send(
      owner.getSender(),
      { value: toNano("0.1") },
      { $$type: "SetCooldown", seconds: 7200n }
    );
    expect(await gateway.getCooldown()).toBe(7200n);
  });

  it("should return zero balance for unknown address", async () => {
    const random = (await blockchain.treasury("random")).address;
    const balance = await gateway.getBalance(random);
    expect(balance).toBe(0n);
  });

  it("should return stats", async () => {
    const stats = await gateway.getStats();
    expect(stats.get(0n)).toBe(0n); // total_deposits
    expect(stats.get(1n)).toBe(0n); // total_settled
    expect(stats.get(2n)).toBe(0n); // total_withdrawn
  });
});
