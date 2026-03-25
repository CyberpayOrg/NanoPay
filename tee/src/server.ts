/**
 * CyberNanoPay TEE HTTP Server
 *
 * Exposes the aggregator as an HTTP API for sellers and facilitators.
 * In production, this runs inside a Phala TEE worker.
 *
 * Endpoints:
 *   POST /verify          — Verify + deduct a payment authorization
 *   GET  /balance/:addr   — Check a depositor's available balance
 *   GET  /stats           — Global stats
 *   POST /flush           — Force batch settlement (admin)
 *   GET  /health          — Health check
 *   GET  /attestation     — TEE attestation info
 *
 *   POST /policy          — Set spending policy for a depositor
 *   GET  /policy/:addr    — Get spending policy
 *
 *   GET  /approvals       — List pending HITL approvals
 *   POST /approve/:id     — Approve a pending payment
 *   POST /reject/:id      — Reject a pending payment
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import nacl from "tweetnacl";
import { Aggregator, type AggregatorConfig } from "./aggregator";
import { Store } from "./store";
import { ChainListener } from "./listener";
import { getAttestation, deriveTeeSecret } from "./attestation";
import type { PaymentAuthorization, SpendingPolicy, PendingApproval } from "./types";
import "dotenv/config";

// ── Config ──

const PORT = parseInt(process.env.PORT ?? "4030");
const RPC_ENDPOINT = process.env.TON_RPC ?? "https://toncenter.com/api/v2/jsonRPC";
const GATEWAY_ADDRESS = process.env.GATEWAY_ADDRESS ?? "";
const WALLET_MNEMONIC = process.env.WALLET_MNEMONIC ?? "";
const TELEGRAM_BOT_URL = process.env.TELEGRAM_BOT_URL ?? "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY ?? "";

// ── Helpers ──

async function loadTeeKeypair(): Promise<nacl.SignKeyPair> {
  const derived = await deriveTeeSecret();
  if (derived) {
    const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(derived));
    console.log(`[tee] Keypair derived from Phala enclave`);
    return kp;
  }
  const seed = process.env.TEE_SEED;
  if (seed) {
    return nacl.sign.keyPair.fromSeed(Buffer.from(seed, "hex"));
  }
  const kp = nacl.sign.keyPair();
  console.log(`[tee] Generated ephemeral keypair (development mode)`);
  return kp;
}

function adminGuard(c: any): Response | null {
  if (!ADMIN_TOKEN) return null;
  const auth = c.req.header("Authorization");
  if (!auth || auth !== `Bearer ${ADMIN_TOKEN}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return null;
}

const knownPublicKeys = new Map<string, string>();

async function resolvePublicKey(address: string): Promise<string | null> {
  return knownPublicKeys.get(address) ?? null;
}

async function notifyTelegramBot(approval: PendingApproval): Promise<void> {
  if (!TELEGRAM_BOT_URL) return;
  try {
    await fetch(`${TELEGRAM_BOT_URL}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentId: approval.paymentId,
        from: approval.auth.from,
        to: approval.auth.to,
        amount: approval.auth.amount.toString(),
        requestedAt: approval.requestedAt,
      }),
    });
  } catch (err) {
    console.error(`[tee] Failed to notify Telegram bot:`, err);
  }
}

// ── Main ──

async function main() {
  const teeKeypair = await loadTeeKeypair();
  const teePubkeyHex = Buffer.from(teeKeypair.publicKey).toString("hex");
  console.log(`[tee] Public key: ${teePubkeyHex}`);

  // Fetch attestation report
  const attestation = await getAttestation(teePubkeyHex);
  console.log(`[tee] Attestation: platform=${attestation.platform}, codeHash=${attestation.codeHash}`);

  const store = new Store();

  const aggregatorConfig: AggregatorConfig = {
    publicKeyResolver: resolvePublicKey,
    settler: {
      rpcEndpoint: RPC_ENDPOINT,
      gatewayAddress: GATEWAY_ADDRESS,
      teeKeypair,
      walletMnemonic: WALLET_MNEMONIC,
    },
    teeSecretKey: teeKeypair.secretKey,
    teePubkey: teePubkeyHex,
    teePlatform: attestation.platform,
    teeCodeHash: attestation.codeHash,
    batchMaxPending: 5000,
    batchMaxAgeMs: 3_600_000,
    flushCheckIntervalMs: 30_000,
    onApprovalNeeded: (approval) => {
      store.logApprovalRequest(approval.paymentId, approval.auth.from, approval.auth.to, approval.auth.amount);
      notifyTelegramBot(approval);
    },
    approvalTimeoutSec: 300,
  };

  const aggregator = new Aggregator(aggregatorConfig);

  // Restore ledger state
  const savedLedger = store.loadLedgerSnapshot();
  if (savedLedger.length > 0) {
    aggregator.restoreLedger(savedLedger);
    console.log(`[startup] Restored ${savedLedger.length} accounts from snapshot`);
  }

  // ── HTTP Server ──

  const app = new Hono();

  app.use("*", cors());

  app.get("/health", (c) => c.json({ status: "ok", tee: attestation.platform }));

  app.get("/debug/dstack", async (c) => {
    const denied = adminGuard(c);
    if (denied) return denied;
    const fs = await import("fs");
    const socketPaths = ["/var/run/dstack.sock", "/var/run/tappd.sock"];
    const checks: Record<string, any> = {
      DSTACK_SIMULATOR_ENDPOINT: process.env.DSTACK_SIMULATOR_ENDPOINT ?? "(not set)",
    };
    for (const p of socketPaths) {
      checks[p] = fs.existsSync(p) ? "exists" : "missing";
    }
    // Try connecting to dstack via HTTP fallback
    try {
      const res = await fetch("http://localhost:8090/Info", { method: "POST", body: "{}", signal: AbortSignal.timeout(2000) });
      checks["http://localhost:8090"] = `status=${res.status}`;
      if (res.ok) checks.info = await res.json();
    } catch (err: any) {
      checks["http://localhost:8090"] = err.message;
    }
    return c.json(checks);
  });

  app.get("/attestation", (c) => c.json({
    teePublicKey: teePubkeyHex,
    platform: attestation.platform,
    codeHash: attestation.codeHash,
    quote: attestation.quote,
    isDevelopment: attestation.isDevelopment,
    timestamp: Date.now(),
  }));

  app.post("/verify", async (c) => {
    const body = await c.req.json<PaymentAuthorization>();
    const auth: PaymentAuthorization = { ...body, amount: BigInt(body.amount) };
    const result = await aggregator.verifyAndDeduct(auth);
    if (result.success && result.confirmationId) {
      store.logPayment(result.confirmationId, auth.from, auth.to, auth.amount, auth.nonce);
    }
    return c.json({
      ...result,
      remainingBalance: result.remainingBalance?.toString(),
      receipt: result.receipt ?? undefined,
    }, result.success ? 200 : 402);
  });

  app.get("/balance/:address", (c) => {
    const address = c.req.param("address");
    const snapshot = aggregator.getSnapshot(address);
    const policy = aggregator.getPolicy(address);
    const dailySpent = aggregator.getDailySpent(address);
    const onchainBalance = aggregator.getSettledBalance(address);
    return c.json({
      address: snapshot.address,
      available: snapshot.available.toString(),
      settled: onchainBalance.toString(),
      unsettled: (snapshot.available - onchainBalance).toString(),
      totalDeposited: snapshot.totalDeposited.toString(),
      totalSpent: snapshot.totalSpent.toString(),
      policy: policy ? {
        spendingLimit: policy.spendingLimit.toString(),
        dailyCap: policy.dailyCap.toString(),
        hitlThreshold: policy.hitlThreshold.toString(),
      } : null,
      dailySpent: dailySpent.toString(),
    });
  });

  app.get("/stats", (c) => {
    const stats = aggregator.getStats();
    return c.json({
      totalDeposits: stats.totalDeposits.toString(),
      totalDeducted: stats.totalDeducted.toString(),
      accountCount: stats.accountCount,
      pendingBatchCount: stats.pendingBatchCount,
      pendingApprovalCount: stats.pendingApprovalCount,
    });
  });

  // ── Spending Policy ──

  app.post("/policy", async (c) => {
    const denied = adminGuard(c);
    if (denied) return denied;
    const body = await c.req.json<{
      address: string; spendingLimit: string; dailyCap: string; hitlThreshold: string;
    }>();
    const policy: SpendingPolicy = {
      spendingLimit: BigInt(body.spendingLimit),
      dailyCap: BigInt(body.dailyCap),
      hitlThreshold: BigInt(body.hitlThreshold),
    };
    aggregator.setPolicy(body.address, policy);
    store.savePolicy(body.address, policy.spendingLimit, policy.dailyCap, policy.hitlThreshold);
    return c.json({ success: true });
  });

  app.get("/policy/:address", (c) => {
    const address = c.req.param("address");
    const policy = aggregator.getPolicy(address);
    if (!policy) return c.json({ policy: null });
    return c.json({
      policy: {
        spendingLimit: policy.spendingLimit.toString(),
        dailyCap: policy.dailyCap.toString(),
        hitlThreshold: policy.hitlThreshold.toString(),
      },
    });
  });

  // ── HITL Approvals ──

  app.get("/approvals", (c) => {
    const approvals = aggregator.getPendingApprovals();
    return c.json({
      approvals: approvals.map((a) => ({
        paymentId: a.paymentId,
        from: a.auth.from,
        to: a.auth.to,
        amount: a.auth.amount.toString(),
        requestedAt: a.requestedAt,
        status: a.status,
      })),
    });
  });

  app.post("/approve/:id", async (c) => {
    const denied = adminGuard(c);
    if (denied) return denied;
    const id = c.req.param("id");
    const result = await aggregator.approvePayment(id);
    if (result.success) store.updateApproval(id, "approved", "api");
    return c.json(result, result.success ? 200 : 400);
  });

  app.post("/reject/:id", (c) => {
    const denied = adminGuard(c);
    if (denied) return denied;
    const id = c.req.param("id");
    const result = aggregator.rejectPayment(id);
    if (result.success) store.updateApproval(id, "rejected", "api");
    return c.json(result, result.success ? 200 : 400);
  });

  // ── Admin endpoints ──

  app.post("/register-key", async (c) => {
    const denied = adminGuard(c);
    if (denied) return denied;
    const { address, publicKey } = await c.req.json<{ address: string; publicKey: string }>();
    knownPublicKeys.set(address, publicKey);
    return c.json({ success: true });
  });

  app.post("/simulate-deposit", async (c) => {
    const denied = adminGuard(c);
    if (denied) return denied;
    const { address, amount } = await c.req.json<{ address: string; amount: string }>();
    aggregator.recordDeposit(address, BigInt(amount));
    store.logDeposit(address, BigInt(amount));
    return c.json({ success: true, balance: aggregator.getBalance(address).toString() });
  });

  app.post("/flush", async (c) => {
    const denied = adminGuard(c);
    if (denied) return denied;
    const settled = await aggregator.forceFlush();
    return c.json({ settled });
  });

  // ── Flush-for-withdraw ──

  // ── Demo: On-chain deposit (testnet only) ──
  // Sends a real JettonTransferNotification to the CyberGateway contract
  // Returns the transaction explorer URL

  app.post("/demo/onchain-deposit", async (c) => {
    const denied = adminGuard(c);
    if (denied) return denied;

    if (!GATEWAY_ADDRESS || !WALLET_MNEMONIC) {
      return c.json({ error: "GATEWAY_ADDRESS or WALLET_MNEMONIC not configured" }, 500);
    }

    const { depositor, amount } = await c.req.json<{ depositor: string; amount: string }>();
    if (!depositor || !amount) return c.json({ error: "depositor and amount required" }, 400);

    try {
      const { mnemonicToPrivateKey } = await import("@ton/crypto");
      const { TonClient, WalletContractV4 } = await import("@ton/ton");
      const { toNano, Address, beginCell } = await import("@ton/core");

      const keyPair = await mnemonicToPrivateKey(WALLET_MNEMONIC.split(" "));
      const client = new TonClient({
        endpoint: RPC_ENDPOINT,
        apiKey: TONCENTER_API_KEY || undefined,
      });
      const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
      const walletContract = client.open(wallet);

      const depositorAddr = Address.parse(depositor);
      const gatewayAddr = Address.parse(GATEWAY_ADDRESS);

      // Build JettonTransferNotification (opcode 0x7362d09c)
      const body = beginCell()
        .storeUint(0x7362d09c, 32)
        .storeUint(0, 64)
        .storeCoins(BigInt(amount))
        .storeAddress(depositorAddr)
        .storeUint(0, 1)
        .endCell();

      const seqno = await walletContract.getSeqno();
      await walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [{
          info: {
            type: "internal" as const,
            ihrDisabled: true,
            bounce: true,
            bounced: false,
            dest: gatewayAddr,
            value: { coins: toNano("0.1") },
            ihrFee: 0n,
            forwardFee: 0n,
            createdLt: 0n,
            createdAt: 0,
          },
          body,
        }],
      });

      // Determine explorer URL
      const isTestnet = RPC_ENDPOINT.includes("testnet");
      const explorerBase = isTestnet ? "https://testnet.tonviewer.com" : "https://tonviewer.com";
      const contractUrl = `${explorerBase}/${GATEWAY_ADDRESS}`;
      const walletUrl = `${explorerBase}/${wallet.address.toString()}`;

      return c.json({
        success: true,
        depositor: depositorAddr.toString(),
        amount,
        contractUrl,
        walletUrl,
        wallet: wallet.address.toString(),
        gateway: GATEWAY_ADDRESS,
        message: "Transaction sent. TEE listener will detect the deposit within ~10s.",
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  const lastFlushRequest = new Map<string, number>();

  app.post("/flush-for-withdraw", async (c) => {
    const { address } = await c.req.json<{ address: string }>();
    const balance = aggregator.getBalance(address);
    if (balance <= 0n) return c.json({ error: "No balance to withdraw" }, 403);

    const lastRequest = lastFlushRequest.get(address) ?? 0;
    const cooldown = 3_600_000;
    if (Date.now() - lastRequest < cooldown) {
      const waitSec = Math.ceil((cooldown - (Date.now() - lastRequest)) / 1000);
      return c.json({ error: `Rate limited. Try again in ${waitSec}s` }, 429);
    }

    if (aggregator.getStats().pendingBatchCount === 0) {
      return c.json({ settled: false, message: "No pending payments to settle", balance: balance.toString() });
    }

    lastFlushRequest.set(address, Date.now());
    const settled = await aggregator.forceFlush();
    return c.json({ settled, balance: aggregator.getBalance(address).toString() });
  });

  // ── History ──

  app.get("/history/payments/:address", (c) => {
    const address = c.req.param("address");
    const limit = parseInt(c.req.query("limit") ?? "50");
    return c.json({ payments: store.getPayments(address, limit) });
  });

  app.get("/history/payments", (c) => {
    const limit = parseInt(c.req.query("limit") ?? "50");
    return c.json({ payments: store.getRecentPayments(limit) });
  });

  app.get("/history/approvals", (c) => {
    const limit = parseInt(c.req.query("limit") ?? "50");
    return c.json({ approvals: store.getApprovalHistory(limit) });
  });

  app.get("/history/deposits/:address", (c) => {
    const address = c.req.param("address");
    const limit = parseInt(c.req.query("limit") ?? "50");
    return c.json({ deposits: store.getDepositHistory(address, limit) });
  });

  // ── Receipts ──

  app.get("/receipt/:id", (c) => {
    const id = c.req.param("id");
    const receipt = aggregator.getReceipt(id);
    if (!receipt) return c.json({ error: "Receipt not found" }, 404);
    return c.json(receipt);
  });

  app.get("/receipts/:address", (c) => {
    const address = c.req.param("address");
    const role = (c.req.query("role") ?? "both") as "from" | "to" | "both";
    const limit = parseInt(c.req.query("limit") ?? "50");
    return c.json({ receipts: aggregator.getReceipts(address, role, limit) });
  });

  app.post("/receipt/verify", async (c) => {
    const receipt = await c.req.json<import("./receipt").StandardReceipt>();
    const { verifyStandardReceipt } = await import("./receipt");
    const result = verifyStandardReceipt(receipt, teePubkeyHex);
    return c.json({ ...result, teePubkey: teePubkeyHex });
  });

  // ── Chain Listener ──

  let listener: ChainListener | undefined;

  if (GATEWAY_ADDRESS) {
    listener = new ChainListener({
      rpcEndpoint: RPC_ENDPOINT,
      gatewayAddress: GATEWAY_ADDRESS,
      apiKey: TONCENTER_API_KEY || undefined,
      pollIntervalMs: 5_000,
      onDeposit: (depositor, amount) => {
        aggregator.recordDeposit(depositor, amount);
        store.logDeposit(depositor, amount);
      },
      onWithdrawCompleted: (depositor, amount) => {
        console.log(`[listener] Withdraw completed: ${depositor} -${amount}`);
      },
      onBatchSettled: (batchId, count, totalAmount) => {
        console.log(`[listener] Batch #${batchId} confirmed: ${count} transfers, total=${totalAmount}`);
      },
    });

    const cursor = store.loadListenerCursor();
    if (cursor) {
      listener.setLastLt(cursor.lastLt, cursor.lastHash);
      console.log(`[startup] Restored listener cursor: lt=${cursor.lastLt}`);
    }

    listener.start();
  }

  // ── Start ──

  aggregator.start();

  const SNAPSHOT_INTERVAL = 5 * 60_000;
  const snapshotTimer = setInterval(() => {
    store.saveLedgerSnapshot(aggregator.serializeLedger());
    if (listener) store.saveListenerCursor(listener.getLastLt());
  }, SNAPSHOT_INTERVAL);

  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[cyber-nano-pay-tee] Listening on http://localhost:${info.port}`);
    console.log(`[cyber-nano-pay-tee] TEE pubkey: ${teePubkeyHex}`);
    console.log(`[cyber-nano-pay-tee] Platform: ${attestation.platform} (dev=${attestation.isDevelopment})`);
    if (!ADMIN_TOKEN) console.log(`[cyber-nano-pay-tee] WARNING: ADMIN_TOKEN not set`);
    if (!GATEWAY_ADDRESS) console.log(`[cyber-nano-pay-tee] WARNING: GATEWAY_ADDRESS not set`);
  });

  process.on("SIGINT", () => {
    console.log("[shutdown] Saving state...");
    store.saveLedgerSnapshot(aggregator.serializeLedger());
    if (listener) {
      store.saveListenerCursor(listener.getLastLt());
      listener.stop();
    }
    clearInterval(snapshotTimer);
    aggregator.stop();
    store.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
