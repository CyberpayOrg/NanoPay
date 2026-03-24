/**
 * CyberNanoPay Mini App — Backend Server
 *
 * Serves the Telegram Mini App frontend and proxies API calls to TEE.
 * Validates Telegram WebApp initData for authentication.
 *
 * Endpoints:
 *   GET  /                    — Serve Mini App HTML
 *   GET  /api/account         — Get balance, policy, daily spent
 *   GET  /api/history         — Payment history
 *   GET  /api/approvals       — Pending HITL approvals
 *   POST /api/topup           — Simulate deposit (dev) / trigger real deposit
 *   POST /api/policy          — Update spending policy
 *   POST /api/approve/:id     — Approve pending payment
 *   POST /api/reject/:id      — Reject pending payment
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import crypto from "crypto";
import "dotenv/config";

const PORT = parseInt(process.env.PORT ?? "4033");
const TEE_URL = process.env.TEE_URL ?? "http://localhost:4030";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

type Variables = {
  address: string;
  initData: string;
};

const app = new Hono<{ Variables: Variables }>();

// ── Telegram WebApp Auth ──

/**
 * Validate Telegram Mini App initData.
 * Returns parsed user data or null if invalid.
 * See: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function validateInitData(initData: string): Record<string, string> | null {
  if (!initData || !BOT_TOKEN) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  params.delete("hash");
  const entries = Array.from(params.entries());
  entries.sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const computedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (computedHash !== hash) return null;

  const result: Record<string, string> = {};
  for (const [k, v] of params.entries()) {
    result[k] = v;
  }
  result.hash = hash;
  return result;
}

/**
 * Extract user address from initData.
 * In production, map Telegram user ID → TON address via registration.
 * For now, use query_id or user.id as lookup key.
 */
function extractAddress(initData: string): string | null {
  const data = validateInitData(initData);
  if (!data) return null;

  // Try to get address from start_param (deep link: ?startapp=<address>)
  if (data.start_param) return data.start_param;

  // Fallback: parse user object for ID
  try {
    const user = JSON.parse(data.user ?? "{}");
    return user.id ? `tg_${user.id}` : null;
  } catch {
    return null;
  }
}

// ── Auth middleware ──

async function authMiddleware(c: any, next: any) {
  const initData = c.req.header("X-Telegram-Init-Data") ?? "";
  const address =
    c.req.header("X-Address") ?? extractAddress(initData) ?? "";

  if (!address) {
    return c.json({ error: "No address provided" }, 401);
  }

  c.set("address", address);
  c.set("initData", initData);
  await next();
}

// ── API Routes ──

// Account overview: balance + policy + daily spent
app.get("/api/account", authMiddleware, async (c) => {
  const address = c.get("address");
  try {
    const res = await fetch(`${TEE_URL}/balance/${address}`);
    const data = await res.json();
    return c.json(data);
  } catch (err) {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

// Payment history
app.get("/api/history", authMiddleware, async (c) => {
  const address = c.get("address");
  const limit = c.req.query("limit") ?? "50";
  try {
    const res = await fetch(
      `${TEE_URL}/history/payments/${address}?limit=${limit}`
    );
    return c.json(await res.json());
  } catch {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

// Deposit history
app.get("/api/deposits", authMiddleware, async (c) => {
  const address = c.get("address");
  const limit = c.req.query("limit") ?? "50";
  try {
    const res = await fetch(
      `${TEE_URL}/history/deposits/${address}?limit=${limit}`
    );
    return c.json(await res.json());
  } catch {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

// Pending HITL approvals
app.get("/api/approvals", authMiddleware, async (c) => {
  try {
    const res = await fetch(`${TEE_URL}/approvals`);
    return c.json(await res.json());
  } catch {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

// Top up (simulate deposit for dev; in production triggers real Jetton transfer)
app.post("/api/topup", authMiddleware, async (c) => {
  const address = c.get("address");
  const body = await c.req.json<{ amount: string }>();
  try {
    const res = await fetch(`${TEE_URL}/simulate-deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, amount: body.amount }),
    });
    return c.json(await res.json());
  } catch {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

// Update spending policy
app.post("/api/policy", authMiddleware, async (c) => {
  const address = c.get("address");
  const body = await c.req.json<{
    spendingLimit: string;
    dailyCap: string;
    hitlThreshold: string;
  }>();
  try {
    const res = await fetch(`${TEE_URL}/policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, ...body }),
    });
    return c.json(await res.json());
  } catch {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

// Approve / Reject HITL
app.post("/api/approve/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  try {
    const res = await fetch(`${TEE_URL}/approve/${id}`, { method: "POST" });
    return c.json(await res.json());
  } catch {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

app.post("/api/reject/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  try {
    const res = await fetch(`${TEE_URL}/reject/${id}`, { method: "POST" });
    return c.json(await res.json());
  } catch {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

// Global stats
app.get("/api/stats", async (c) => {
  try {
    const res = await fetch(`${TEE_URL}/stats`);
    return c.json(await res.json());
  } catch {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

// ── Serve static frontend ──
app.use("/assets/*", serveStatic({ root: "./public" }));

// Serve main HTML for all non-API routes (SPA)
app.get("/*", async (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }
  const fs = await import("fs");
  const html = fs.readFileSync("public/index.html", "utf-8");
  return c.html(html);
});

// ── Start ──

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[cyber-nano-pay-miniapp] http://localhost:${info.port}`);
});
