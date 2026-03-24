/**
 * TEE Attestation — Phala Cloud TDX integration
 *
 * In production (Phala Cloud), fetches real attestation report from
 * the local TDX attestation service via unix socket or HTTP.
 *
 * In development, returns a mock attestation with "development" markers.
 */

import { createHash } from "crypto";
import http from "http";
import fs from "fs";

export interface AttestationReport {
  platform: string;
  codeHash: string;
  quote: string | null;
  timestamp: number;
  isDevelopment: boolean;
}

const DSTACK_SOCKET_PATHS = ["/var/run/dstack.sock", "/var/run/tappd.sock"];
const PHALA_HTTP_URL = "http://localhost:8090";

/**
 * Detect if we're running inside a Phala Cloud TDX enclave.
 */
export function isPhalaEnvironment(): boolean {
  if (process.env.DSTACK_SIMULATOR_ENDPOINT) return true;
  return DSTACK_SOCKET_PATHS.some((p) => fs.existsSync(p));
}

/** Make a JSON POST request via unix socket or HTTP */
function dstackPost(path: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);

    const simEndpoint = process.env.DSTACK_SIMULATOR_ENDPOINT;
    let options: http.RequestOptions;

    if (simEndpoint) {
      const url = new URL(simEndpoint);
      options = { hostname: url.hostname, port: url.port, path, method: "POST" };
    } else {
      const socketPath = DSTACK_SOCKET_PATHS.find((p) => fs.existsSync(p));
      if (socketPath) {
        options = { socketPath, path, method: "POST" };
      } else {
        const url = new URL(PHALA_HTTP_URL);
        options = { hostname: url.hostname, port: url.port, path, method: "POST" };
      }
    }

    options.headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    };

    const req = http.request(options, (res) => {
      let chunks = "";
      res.on("data", (c) => (chunks += c));
      res.on("end", () => {
        try { resolve(JSON.parse(chunks)); }
        catch { reject(new Error(`Invalid JSON from dstack: ${chunks.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

export async function getAttestation(teePubkey: string): Promise<AttestationReport> {
  if (!isPhalaEnvironment()) return devAttestation();

  const reportData = createHash("sha256")
    .update(Buffer.from(teePubkey, "hex"))
    .digest("hex");

  try {
    // Try new dstack API first, then legacy tappd API
    let data: any;
    try {
      data = await dstackPost("/GetQuote", { report_data: reportData });
    } catch {
      data = await dstackPost("/prpc/Tdx.GenerateQuote", { report_data: reportData });
    }
    const codeHash = process.env.TEE_CODE_HASH ?? extractCodeHash(data.quote) ?? "unknown";
    console.log(`[attestation] Got TDX attestation, codeHash=${codeHash}`);
    return { platform: "phala-tdx", codeHash, quote: data.quote ?? null, timestamp: Date.now(), isDevelopment: false };
  } catch (err) {
    console.error("[attestation] Failed to get Phala attestation:", (err as Error).message);
    return devAttestation();
  }
}

export async function deriveTeeSecret(): Promise<Buffer | null> {
  if (!isPhalaEnvironment()) return null;

  try {
    // Try new dstack API first, then legacy tappd API
    let data: any;
    try {
      data = await dstackPost("/GetKey", { path: "cyber-nano-pay/tee-keypair", purpose: "" });
    } catch {
      data = await dstackPost("/prpc/Tdx.DeriveKey", {
        path: "cyber-nano-pay/tee-keypair",
        subject: "ed25519-seed",
      });
    }
    if (!data.key) return null;
    return Buffer.from(data.key, "hex").subarray(0, 32);
  } catch {
    return null;
  }
}

function extractCodeHash(quote?: string): string | null {
  if (!quote) return null;
  try {
    const buf = Buffer.from(quote, "base64");
    if (buf.length < 632) return null;
    return buf.subarray(584, 632).toString("hex");
  } catch { return null; }
}

function devAttestation(): AttestationReport {
  return { platform: "development", codeHash: "development", quote: null, timestamp: Date.now(), isDevelopment: true };
}
