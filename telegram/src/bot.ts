/**
 * CyberNanoPay Telegram HITL Bot
 *
 * Human-in-the-loop approval bot for large payments.
 *
 * Two roles:
 * 1. Telegram Bot — sends approval requests to owner, handles approve/reject callbacks
 * 2. HTTP Server — receives notifications from TEE aggregator (POST /notify)
 *
 * Flow:
 *   TEE detects large payment → POST /notify → Bot sends inline keyboard to owner
 *   Owner taps ✅ Approve or ❌ Reject → Bot calls TEE /approve/:id or /reject/:id
 */

import { Bot, InlineKeyboard } from "grammy";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import "dotenv/config";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID ?? "";
const TEE_URL = process.env.TEE_URL ?? "http://localhost:4030";
const MINIAPP_URL = process.env.MINIAPP_URL ?? "http://localhost:4033";
const HTTP_PORT = parseInt(process.env.PORT ?? "4032");

if (!BOT_TOKEN) {
  console.error("[telegram] TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

// ── Telegram Bot ──

const bot = new Bot(BOT_TOKEN);

// /start command
bot.command("start", (ctx) => {
  ctx.reply(
    "🔐 CyberNanoPay HITL Bot\n\n" +
    "I'll notify you when a large payment needs approval.\n" +
    "Use /wallet to open your CyberNanoPay wallet.\n" +
    "Use /balance <address> to check balances.\n" +
    "Use /approvals to see pending approvals.\n" +
    "Use /policy <address> to check spending policy."
  );
});

// /wallet command — opens Mini App
bot.command("wallet", (ctx) => {
  const addr = ctx.match?.trim() || "";
  const url = addr ? `${MINIAPP_URL}?address=${addr}` : MINIAPP_URL;
  ctx.reply("💳 Open your CyberNanoPay wallet:", {
    reply_markup: {
      inline_keyboard: [[
        { text: "💳 Open Wallet", web_app: { url } }
      ]]
    }
  });
});

// /balance command
bot.command("balance", async (ctx) => {
  const addr = ctx.match?.trim();
  if (!addr) return ctx.reply("Usage: /balance <address>");

  try {
    const res = await fetch(`${TEE_URL}/balance/${addr}`);
    const data = await res.json() as any;
    let msg = `💰 Balance for ${addr.slice(0, 12)}...\n\n`;
    msg += `Available: ${data.available}\n`;
    msg += `Total Deposited: ${data.totalDeposited}\n`;
    msg += `Total Spent: ${data.totalSpent}\n`;
    msg += `Daily Spent: ${data.dailySpent}\n`;
    if (data.policy) {
      msg += `\n📋 Policy:\n`;
      msg += `  Spending Limit: ${data.policy.spendingLimit}\n`;
      msg += `  Daily Cap: ${data.policy.dailyCap}\n`;
      msg += `  HITL Threshold: ${data.policy.hitlThreshold}\n`;
    }
    ctx.reply(msg);
  } catch (err) {
    ctx.reply(`❌ Error: ${err}`);
  }
});

// /approvals command
bot.command("approvals", async (ctx) => {
  try {
    const res = await fetch(`${TEE_URL}/approvals`);
    const data = await res.json() as any;
    if (!data.approvals?.length) {
      return ctx.reply("✅ No pending approvals");
    }
    let msg = `⏳ Pending Approvals (${data.approvals.length}):\n\n`;
    for (const a of data.approvals) {
      msg += `ID: ${a.paymentId}\n`;
      msg += `From: ${a.from.slice(0, 12)}...\n`;
      msg += `To: ${a.to.slice(0, 12)}...\n`;
      msg += `Amount: ${a.amount}\n`;
      msg += `---\n`;
    }
    ctx.reply(msg);
  } catch (err) {
    ctx.reply(`❌ Error: ${err}`);
  }
});

// /policy command
bot.command("policy", async (ctx) => {
  const addr = ctx.match?.trim();
  if (!addr) return ctx.reply("Usage: /policy <address>");

  try {
    const res = await fetch(`${TEE_URL}/policy/${addr}`);
    const data = await res.json() as any;
    if (!data.policy) return ctx.reply("No policy set for this address");
    ctx.reply(
      `📋 Policy for ${addr.slice(0, 12)}...\n\n` +
      `Spending Limit: ${data.policy.spendingLimit}\n` +
      `Daily Cap: ${data.policy.dailyCap}\n` +
      `HITL Threshold: ${data.policy.hitlThreshold}`
    );
  } catch (err) {
    ctx.reply(`❌ Error: ${err}`);
  }
});

// /stats command
bot.command("stats", async (ctx) => {
  try {
    const res = await fetch(`${TEE_URL}/stats`);
    const data = await res.json() as any;
    ctx.reply(
      `📊 CyberNanoPay Stats\n\n` +
      `Total Deposits: ${data.totalDeposits}\n` +
      `Total Deducted: ${data.totalDeducted}\n` +
      `Accounts: ${data.accountCount}\n` +
      `Pending Batch: ${data.pendingBatchCount}\n` +
      `Pending Approvals: ${data.pendingApprovalCount}`
    );
  } catch (err) {
    ctx.reply(`❌ Error: ${err}`);
  }
});

// Handle inline keyboard callbacks (approve/reject)
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const [action, paymentId] = data.split(":");

  if (!paymentId) {
    return ctx.answerCallbackQuery({ text: "Invalid callback" });
  }

  const endpoint = action === "approve" ? "approve" : "reject";

  try {
    const res = await fetch(`${TEE_URL}/${endpoint}/${paymentId}`, {
      method: "POST",
    });
    const result = await res.json() as any;

    if (result.success) {
      const emoji = action === "approve" ? "✅" : "❌";
      await ctx.editMessageText(
        ctx.callbackQuery.message?.text + `\n\n${emoji} ${action.toUpperCase()}D`
      );
      await ctx.answerCallbackQuery({
        text: `Payment ${action}d successfully`,
      });
    } else {
      await ctx.answerCallbackQuery({
        text: `Failed: ${result.error}`,
        show_alert: true,
      });
    }
  } catch (err) {
    await ctx.answerCallbackQuery({
      text: `Error: ${err}`,
      show_alert: true,
    });
  }
});

// ── HTTP Server (receives notifications from TEE) ──

const httpApp = new Hono();

httpApp.get("/health", (c) => c.json({ status: "ok", service: "telegram-hitl" }));

/**
 * POST /notify — called by TEE when a payment needs approval
 */
httpApp.post("/notify", async (c) => {
  const body = await c.req.json<{
    paymentId: string;
    from: string;
    to: string;
    amount: string;
    requestedAt: number;
  }>();

  const chatId = OWNER_CHAT_ID;
  if (!chatId) {
    return c.json({ error: "No OWNER_CHAT_ID configured" }, 500);
  }

  const message =
    `🔔 Payment Approval Required\n\n` +
    `ID: ${body.paymentId}\n` +
    `From: ${body.from}\n` +
    `To: ${body.to}\n` +
    `Amount: ${body.amount}\n` +
    `Time: ${new Date(body.requestedAt).toISOString()}`;

  const keyboard = new InlineKeyboard()
    .text("✅ Approve", `approve:${body.paymentId}`)
    .text("❌ Reject", `reject:${body.paymentId}`);

  try {
    await bot.api.sendMessage(chatId, message, {
      reply_markup: keyboard,
    });
    return c.json({ success: true });
  } catch (err) {
    console.error("[telegram] Failed to send message:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// ── Start both ──

async function main() {
  // Start Telegram bot (long polling)
  bot.start({
    onStart: () => console.log(`[telegram] Bot started`),
  });

  // Start HTTP server for TEE notifications
  serve({ fetch: httpApp.fetch, port: HTTP_PORT }, (info) => {
    console.log(`[telegram] HTTP server on http://localhost:${info.port}`);
  });
}

main().catch(console.error);

process.on("SIGINT", () => {
  bot.stop();
  process.exit(0);
});
