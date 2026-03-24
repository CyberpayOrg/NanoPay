/**
 * Persistent Store — SQLite-backed audit log and approval history.
 *
 * Stores:
 * - Payment log (every verified payment)
 * - Approval log (HITL requests + decisions)
 * - Policy snapshots
 *
 * This is an append-only audit trail. The in-memory Ledger remains
 * the source of truth for real-time balances; this is for history/compliance.
 */

import Database from "better-sqlite3";
import path from "path";

const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "gateway.db");

export class Store {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const p = dbPath ?? process.env.DB_PATH ?? DEFAULT_DB_PATH;
    // Ensure directory exists
    const dir = path.dirname(p);
    require("fs").mkdirSync(dir, { recursive: true });

    this.db = new Database(p);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        confirmation_id TEXT NOT NULL,
        from_addr TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        amount TEXT NOT NULL,
        nonce TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmed',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id TEXT NOT NULL UNIQUE,
        from_addr TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        amount TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at TEXT NOT NULL DEFAULT (datetime('now')),
        decided_at TEXT,
        decided_by TEXT
      );

      CREATE TABLE IF NOT EXISTS policies (
        address TEXT PRIMARY KEY,
        spending_limit TEXT NOT NULL DEFAULT '0',
        daily_cap TEXT NOT NULL DEFAULT '0',
        hitl_threshold TEXT NOT NULL DEFAULT '0',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS deposits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        amount TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ledger_state (
        address TEXT PRIMARY KEY,
        balance TEXT NOT NULL DEFAULT '0',
        settled_balance TEXT NOT NULL DEFAULT '0',
        total_deposited TEXT NOT NULL DEFAULT '0',
        total_spent TEXT NOT NULL DEFAULT '0',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS listener_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_lt TEXT NOT NULL DEFAULT '0',
        last_hash TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_payments_from ON payments(from_addr);
      CREATE INDEX IF NOT EXISTS idx_payments_to ON payments(to_addr);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
    `);
  }

  // ── Payments ──

  logPayment(confirmationId: string, from: string, to: string, amount: bigint, nonce: string) {
    this.db.prepare(
      `INSERT INTO payments (confirmation_id, from_addr, to_addr, amount, nonce) VALUES (?, ?, ?, ?, ?)`
    ).run(confirmationId, from, to, amount.toString(), nonce);
  }

  getPayments(address: string, limit = 50): any[] {
    return this.db.prepare(
      `SELECT * FROM payments WHERE from_addr = ? OR to_addr = ? ORDER BY id DESC LIMIT ?`
    ).all(address, address, limit);
  }

  getRecentPayments(limit = 50): any[] {
    return this.db.prepare(
      `SELECT * FROM payments ORDER BY id DESC LIMIT ?`
    ).all(limit);
  }

  // ── Approvals ──

  logApprovalRequest(paymentId: string, from: string, to: string, amount: bigint) {
    this.db.prepare(
      `INSERT INTO approvals (payment_id, from_addr, to_addr, amount) VALUES (?, ?, ?, ?)`
    ).run(paymentId, from, to, amount.toString());
  }

  updateApproval(paymentId: string, status: "approved" | "rejected" | "expired", decidedBy?: string) {
    this.db.prepare(
      `UPDATE approvals SET status = ?, decided_at = datetime('now'), decided_by = ? WHERE payment_id = ?`
    ).run(status, decidedBy ?? null, paymentId);
  }

  getApprovalHistory(limit = 50): any[] {
    return this.db.prepare(
      `SELECT * FROM approvals ORDER BY id DESC LIMIT ?`
    ).all(limit);
  }

  // ── Policies ──

  savePolicy(address: string, spendingLimit: bigint, dailyCap: bigint, hitlThreshold: bigint) {
    this.db.prepare(
      `INSERT OR REPLACE INTO policies (address, spending_limit, daily_cap, hitl_threshold, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(address, spendingLimit.toString(), dailyCap.toString(), hitlThreshold.toString());
  }

  // ── Deposits ──

  logDeposit(address: string, amount: bigint) {
    this.db.prepare(
      `INSERT INTO deposits (address, amount) VALUES (?, ?)`
    ).run(address, amount.toString());
  }

  getDepositHistory(address: string, limit = 50): any[] {
    return this.db.prepare(
      `SELECT * FROM deposits WHERE address = ? ORDER BY id DESC LIMIT ?`
    ).all(address, limit);
  }

  // ── Stats ──

  getPaymentCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) as cnt FROM payments`).get() as any).cnt;
  }

  getApprovalCount(): { pending: number; approved: number; rejected: number } {
    const rows = this.db.prepare(
      `SELECT status, COUNT(*) as cnt FROM approvals GROUP BY status`
    ).all() as any[];
    const result = { pending: 0, approved: 0, rejected: 0 };
    for (const r of rows) {
      if (r.status in result) (result as any)[r.status] = r.cnt;
    }
    return result;
  }

  // ── Ledger State Persistence ──

  saveLedgerSnapshot(entries: Array<{
    address: string;
    balance: string;
    settledBalance: string;
    totalDeposited: string;
    totalSpent: string;
  }>): void {
    const upsert = this.db.prepare(
      `INSERT OR REPLACE INTO ledger_state (address, balance, settled_balance, total_deposited, total_spent, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    );

    const tx = this.db.transaction((rows: typeof entries) => {
      // Clear stale entries
      this.db.prepare(`DELETE FROM ledger_state`).run();
      for (const e of rows) {
        upsert.run(e.address, e.balance, e.settledBalance, e.totalDeposited, e.totalSpent);
      }
    });

    tx(entries);
    console.log(`[store] Saved ledger snapshot: ${entries.length} accounts`);
  }

  loadLedgerSnapshot(): Array<{
    address: string;
    balance: string;
    settledBalance: string;
    totalDeposited: string;
    totalSpent: string;
  }> {
    const rows = this.db.prepare(`SELECT * FROM ledger_state`).all() as any[];
    return rows.map((r) => ({
      address: r.address,
      balance: r.balance,
      settledBalance: r.settled_balance,
      totalDeposited: r.total_deposited,
      totalSpent: r.total_spent,
    }));
  }

  // ── Listener Cursor Persistence ──

  saveListenerCursor(lastLt: string, lastHash?: string): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO listener_cursor (id, last_lt, last_hash, updated_at)
       VALUES (1, ?, ?, datetime('now'))`
    ).run(lastLt, lastHash ?? null);
  }

  loadListenerCursor(): { lastLt: string; lastHash?: string } | null {
    const row = this.db.prepare(`SELECT * FROM listener_cursor WHERE id = 1`).get() as any;
    if (!row) return null;
    return { lastLt: row.last_lt, lastHash: row.last_hash ?? undefined };
  }

  close() {
    this.db.close();
  }
}
