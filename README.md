# CyberNanoPay — Gas-Free Nanopayment Infrastructure for AI Agents on TON

Sub-cent USDT micropayments for AI agents. Zero gas per payment. x402-compatible. TEE-secured. Telegram-native.

## The Problem

AI agents need to pay for API calls, compute, data, and services — often thousands of times per day at sub-cent amounts. On-chain transactions are too slow and too expensive for this. Existing payment rails don't work for machine-to-machine micropayments.

## The Solution

CyberNanoPay is a nanopayment protocol on TON that lets AI agents make instant, gas-free USDT payments through offchain Ed25519 signature authorization, with periodic on-chain batch settlement secured by Phala TEE.

```
Agent (buyer)
  │  1. Deposit USDT → CyberGateway contract (one-time on-chain tx)
  │  2. Sign Ed25519 payment authorization (offchain, zero gas)
  ▼
Phala TEE Aggregator
  │  Verify signature → enforce policy → deduct balance → issue receipt
  │  Batch queue accumulates...
  ▼
CyberGateway Contract (TON, Tact)
  │  TEE submits batchSettle() periodically
  │  Contract verifies TEE signature → executes batch Jetton transfers
  ▼
Sellers receive USDT
```

## Key Features

**Zero-Gas Micropayments**
- Buyers sign Ed25519 payment authorizations offchain — no gas, no waiting
- TEE verifies and deducts instantly (~1ms per payment)
- Payments as small as $0.0001 USDT are economically viable

**x402 Protocol Compatible**
- HTTP 402 native payment flow: request → 402 → sign → retry → 200
- Any API can be paywalled with one middleware: `requirePayment({ amount, to })`
- Agents pay for resources the same way browsers handle auth — via HTTP headers

**TEE-Secured (Phala Network)**
- Aggregator runs inside Phala TDX enclave — state is tamper-proof
- TEE-signed receipts (COSE_Sign1-style) with Merkle proofs for each payment
- Remote attestation verifiable by any party via `/attestation` endpoint
- Deterministic key derivation from enclave identity

**On-Chain Batch Settlement**
- CyberGateway smart contract (Tact) on TON
- TEE signs batch data → contract verifies Ed25519 → executes Jetton transfers
- Bilateral netting reduces on-chain transfers (A→B $3 + B→A $1 = A→B $2)
- Large payments get on-chain user signature verification (VerifiedBatchSettle)

**Spending Controls & Human-in-the-Loop**
- Per-agent spending limits (max per payment)
- Daily caps (max total per 24h)
- HITL threshold — payments above threshold require human approval via Telegram
- Delegate mechanism — authorize another address to spend on your behalf

**Telegram Integration**
- HITL Bot: real-time approval notifications with inline ✅/❌ buttons
- Mini App: wallet management, balance, history, policy configuration
- Bot commands: `/balance`, `/approvals`, `/policy`, `/stats`, `/wallet`

## Architecture

```
cyber-nano-pay/
├── contracts/          # TON smart contract (Tact)
│   └── cyber_gateway.tact    — Deposit, BatchSettle, VerifiedBatchSettle,
│                                Withdraw, SpendingLimits, HITL, Delegates
├── tee/                # Phala TEE Aggregator
│   └── src/
│       ├── aggregator.ts      — Core: verify → policy → deduct → batch → settle
│       ├── ledger.ts          — Offchain balance ledger (tamper-proof in TEE)
│       ├── batcher.ts         — Batch accumulator with bilateral netting
│       ├── settler.ts         — On-chain batch submission
│       ├── verifier.ts        — Ed25519 signature verification
│       ├── receipt.ts         — COSE_Sign1-style TEE-signed receipts
│       ├── merkle.ts          — Merkle tree for batch inclusion proofs
│       ├── listener.ts        — On-chain event listener (deposits, settlements)
│       ├── attestation.ts     — Phala TDX attestation integration
│       ├── store.ts           — SQLite audit log & state persistence
│       └── server.ts          — HTTP API (Hono)
├── gateway/            # x402 HTTP Gateway
│   └── src/server.ts          — requirePayment() middleware, proxy to TEE
├── telegram/           # Telegram HITL Bot
│   └── src/bot.ts             — Approval notifications, wallet commands
├── miniapp/            # Telegram Mini App
│   └── src/server.ts          — Wallet UI backend, WebApp auth
├── sdk/                # Client SDK
│   ├── src/buyer.ts           — Sign authorizations, x402 payAndFetch()
│   └── src/seller.ts          — Verify payments, check balance, get receipts
└── test/               # E2E and integration tests
    ├── e2e.ts                 — Full nanopayment flow (100 rapid payments)
    ├── x402-flow.ts           — HTTP 402 payment flow through gateway
    ├── policy-hitl.ts         — Spending limits + HITL approval flow
    └── trigger-hitl.ts        — Trigger Telegram HITL notification
```


## Smart Contract (Tact)

The `CyberGateway` contract handles:

| Function | Description |
|---|---|
| Deposit | Receive USDT Jetton (TEP-74) → credit balance |
| BatchSettle | TEE submits batch with Ed25519 signature → contract verifies → executes transfers |
| VerifiedBatchSettle | Large payments: TEE signature + per-item user Ed25519 signatures verified on-chain |
| InitiateWithdraw / CompleteWithdraw | Two-phase withdrawal with configurable cooldown |
| SpendingLimit / DailyCap | On-chain enforced per-depositor limits |
| HITL Approval | RequestApproval → ApprovePayment / RejectPayment |
| Delegate | Authorize another address to spend on your behalf |
| RegisterPubkey | Register Ed25519 public key for on-chain signature verification |

## TEE Receipt Format

Every payment produces a standardized receipt (COSE_Sign1-inspired):

```json
{
  "version": "CyberNanoPay:receipt:v2",
  "protected": {
    "alg": "EdDSA",
    "teePlatform": "phala-tdx",
    "teeCodeHash": "a1b2c3...",
    "teePubkey": "d4e5f6...",
    "contentType": "application/cyberpay-receipt+json"
  },
  "payload": {
    "confirmationId": "abc123...",
    "from": "EQ...",
    "to": "EQ...",
    "amount": "1000",
    "nonce": "...",
    "confirmedAt": 1711234567,
    "remainingBalance": "9999000",
    "batchId": "42",
    "merkleProof": { "index": 3, "path": [...], "root": "..." }
  },
  "signature": "ed25519-sig-hex"
}
```

Receipts include Merkle proofs after batch settlement, linking each payment to the on-chain `batch_data_hash`. Anyone can verify a receipt using the TEE public key from the attestation endpoint.

## SDK Usage

**Buyer (AI Agent):**

```typescript
import { CyberNanoPayBuyer } from "cyber-nano-pay-sdk";

const buyer = new CyberNanoPayBuyer({
  keypair: myEd25519Keypair,
  address: "EQ...",
  gatewayUrl: "https://gateway.cyberpay.dev",
});

// Pay for a 402-protected API (automatic x402 flow)
const response = await buyer.payAndFetch("https://api.example.com/ai/generate");
const data = await response.json();

// Or sign manually
const auth = buyer.signAuthorization({ to: sellerAddress, amount: 1000n });
```

**Seller (API Provider):**

```typescript
import { requirePayment } from "cyber-nano-pay-gateway";

// One line to paywall any endpoint
app.get("/api/data", requirePayment({ amount: "1000", to: myAddress }), handler);
```

## Running Locally

```bash
# 1. Start TEE aggregator
cd tee && cp .env.example .env && npm install && npm start

# 2. Start HTTP gateway
cd gateway && cp .env.example .env && npm install && npm start

# 3. Start Telegram bot (optional, for HITL)
cd telegram && cp .env.example .env && npm install && npm start

# 4. Run E2E test
cd test && npm install && npx tsx e2e.ts
```

## Security Model

- **TEE Isolation**: Aggregator state (balances, nonces) lives inside Phala TDX enclave. The operator cannot read or modify it.
- **Replay Protection**: Every payment has a unique nonce. Used nonces are tracked in the TEE ledger.
- **Signature Verification**: Ed25519 signatures verified both offchain (TEE) and on-chain (contract).
- **Two-Phase Withdrawal**: Configurable cooldown prevents instant drain attacks.
- **Spending Policies**: Per-agent limits enforced at both TEE and contract level.
- **HITL Safety Net**: Large payments require human approval via Telegram before execution.
- **Merkle Receipts**: Each payment receipt includes a Merkle proof linking it to the on-chain batch, enabling independent verification.
- **Batch Retry**: Failed settlements retry with exponential backoff (max 5 attempts) before flagging for manual intervention.

## Tech Stack

- **Smart Contract**: Tact (TON) — CyberGateway with Jetton TEP-74 support
- **TEE**: Phala Network TDX — deterministic key derivation, remote attestation
- **Backend**: TypeScript, Hono, better-sqlite3
- **Telegram**: grammY (Bot), Telegram Mini App with WebApp auth
- **Crypto**: tweetnacl (Ed25519), @ton/core, @ton/crypto
- **Protocol**: x402 (HTTP 402 Payment Required)

## License

MIT
