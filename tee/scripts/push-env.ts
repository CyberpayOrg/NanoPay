/**
 * Push encrypted environment variables to Phala Cloud CVM
 *
 * Usage:
 *   PHALA_API_TOKEN=phak_xxx npx tsx scripts/push-env.ts
 *
 * Reads env vars from ../tee/.env and encrypts them for the CVM.
 * Requires: @phala/cloud package
 */

import { encryptEnvVars, parseEnvVars } from "@phala/cloud";
import fs from "fs";
import path from "path";

const CVM_ID = process.env.CVM_ID;
const API_TOKEN = process.env.PHALA_API_TOKEN;
const PUBKEY = process.env.CVM_PUBKEY;

if (!CVM_ID || !PUBKEY) {
  console.error("Error: CVM_ID and CVM_PUBKEY env vars are required");
  process.exit(1);
}

if (!API_TOKEN) {
  console.error("Error: PHALA_API_TOKEN env var is required");
  process.exit(1);
}

// Read env vars from .env file
const envFile = path.resolve(__dirname, "../.env");
if (!fs.existsSync(envFile)) {
  console.error(`Error: .env file not found at ${envFile}`);
  process.exit(1);
}
const ENV_VARS = fs.readFileSync(envFile, "utf-8");

async function main() {
  console.log("Encrypting environment variables...");

  const envVars = parseEnvVars(ENV_VARS);
  const envKeys = envVars.map((e) => e.key);
  console.log(`Keys: ${envKeys.join(", ")}`);

  const encrypted = await encryptEnvVars(envVars, PUBKEY);
  console.log(`Encrypted payload length: ${encrypted.length}`);

  console.log("\nPATCHing CVM envs...");
  const res = await fetch(`https://cloud-api.phala.com/api/v1/cvms/${CVM_ID}/envs`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_TOKEN}`,
    },
    body: JSON.stringify({
      encrypted_env: encrypted,
      env_keys: envKeys,
    }),
  });

  const data = await res.json();
  console.log(`Status: ${res.status}`);
  console.log(JSON.stringify(data, null, 2));

  if (res.ok) {
    console.log("\n✓ Environment variables pushed successfully");
    console.log("CVM will restart with new env vars.");
    console.log(`\nHealth check: curl https://${CVM_ID}-4030.dstack-pha-prod5.phala.network/health`);
  } else {
    console.error("\n✗ Failed to push env vars");
  }
}

main().catch(console.error);
