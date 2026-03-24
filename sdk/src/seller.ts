/**
 * CyberNanoPay Seller SDK
 *
 * For merchants/API providers to:
 * 1. Verify incoming payments via the TEE
 * 2. Check their accumulated balance
 * 3. Withdraw earnings
 */

export interface SellerConfig {
  /** Seller's TON address */
  address: string;
  /** Gateway API URL */
  gatewayUrl: string;
}

export class CyberNanoPaySeller {
  private config: SellerConfig;

  constructor(config: SellerConfig) {
    this.config = config;
  }

  /**
   * Verify a payment authorization via the TEE.
   * Call this when you receive a Payment-Signature header.
   */
  async verifyPayment(authorization: {
    from: string;
    to: string;
    amount: string;
    validBefore: number;
    nonce: string;
    signature: string;
  }): Promise<{
    success: boolean;
    error?: string;
    confirmationId?: string;
    remainingBalance?: string;
    receipt?: any;
  }> {
    const res = await fetch(`${this.config.gatewayUrl}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(authorization),
    });
    return res.json() as any;
  }

  /**
   * Check accumulated balance (from received payments).
   */
  async getBalance(): Promise<{
    available: string;
    settled: string;
    unsettled: string;
    totalDeposited: string;
    totalSpent: string;
  }> {
    const res = await fetch(
      `${this.config.gatewayUrl}/balance/${this.config.address}`
    );
    return res.json() as any;
  }

  /**
   * Get TEE attestation to verify the gateway is running in a TEE.
   */
  async getAttestation(): Promise<{
    teePublicKey: string;
    platform: string;
    timestamp: number;
  }> {
    const res = await fetch(`${this.config.gatewayUrl}/attestation`);
    return res.json() as any;
  }

  /**
   * Get a receipt by confirmation ID (for dispute resolution / proof).
   */
  async getReceipt(confirmationId: string): Promise<any> {
    const res = await fetch(`${this.config.gatewayUrl}/receipt/${confirmationId}`);
    return res.json() as any;
  }

  /**
   * Get all receipts for this seller address.
   */
  async getReceipts(limit = 50): Promise<{ receipts: any[] }> {
    const res = await fetch(
      `${this.config.gatewayUrl}/receipts/${this.config.address}?role=to&limit=${limit}`
    );
    return res.json() as any;
  }
}
