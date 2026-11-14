// Inter-Region Cryptographic Security and Anti-Replay Verification
// Secures cross-region replication links with HMAC-SHA256 and sliding timestamp windows.

const crypto = require('crypto');

class RegionSecurity {
  /**
   * @param {string} [secret] - Shared secret or API key for region-to-region communication
   */
  constructor(secret = process.env.INTER_REGION_SECRET || 'geocache-default-inter-region-cluster-secret') {
    this.secret = secret;
    this.allowedWindowMs = 60000; // 60-second anti-replay window
    this.seenNonces = new Map(); // nonce -> expiry timestamp
  }

  /**
   * Clean up expired anti-replay nonces periodically
   */
  pruneNonces() {
    const now = Date.now();
    for (const [nonce, expiry] of this.seenNonces) {
      if (now > expiry) {
        this.seenNonces.delete(nonce);
      }
    }
  }

  /**
   * Create authentication headers for an outgoing inter-region replication request.
   * @param {string|object} body - Request payload
   * @param {string} originRegion - Sending region name
   * @returns {Record<string, string>}
   */
  createHeaders(body, originRegion) {
    const timestamp = Date.now().toString();
    const nonce = crypto.randomUUID();
    const payloadStr = typeof body === 'string' ? body : JSON.stringify(body);
    const bodyHash = crypto.createHash('sha256').update(payloadStr).digest('hex');

    const signaturePayload = `${originRegion}:${timestamp}:${nonce}:${bodyHash}`;
    const signature = crypto.createHmac('sha256', this.secret).update(signaturePayload).digest('hex');

    return {
      'x-geocache-region': originRegion,
      'x-geocache-timestamp': timestamp,
      'x-geocache-nonce': nonce,
      'x-geocache-signature': signature,
      'x-geocache-body-hash': bodyHash,
      'content-type': 'application/json'
    };
  }

  /**
   * Verify an incoming inter-region replication request.
   * @param {import('express').Request} req
   * @returns {{ valid: boolean, reason?: string }}
   */
  verifyRequest(req) {
    // If running in development without strict security enabled, allow pass-through
    if (process.env.SECURITY_MODE === 'permissive') {
      return { valid: true };
    }

    const region = req.headers['x-geocache-region'];
    const timestamp = Number(req.headers['x-geocache-timestamp']);
    const nonce = req.headers['x-geocache-nonce'];
    const signature = req.headers['x-geocache-signature'];
    const bodyHash = req.headers['x-geocache-body-hash'];

    if (!region || !timestamp || !nonce || !signature || !bodyHash) {
      return { valid: false, reason: 'Missing authentication headers' };
    }

    // 1. Check anti-replay timestamp window
    const now = Date.now();
    if (Math.abs(now - timestamp) > this.allowedWindowMs) {
      return { valid: false, reason: 'Timestamp outside anti-replay window' };
    }

    // 2. Check nonce deduplication
    this.pruneNonces();
    if (this.seenNonces.has(nonce)) {
      return { valid: false, reason: 'Replay attack detected: duplicate nonce' };
    }
    this.seenNonces.set(nonce, now + this.allowedWindowMs);

    // 3. Verify payload digest
    const payloadStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const computedBodyHash = crypto.createHash('sha256').update(payloadStr).digest('hex');
    if (computedBodyHash !== bodyHash) {
      return { valid: false, reason: 'Payload hash mismatch' };
    }

    // 4. Verify HMAC signature
    const signaturePayload = `${region}:${timestamp}:${nonce}:${bodyHash}`;
    const expectedSignature = crypto.createHmac('sha256', this.secret).update(signaturePayload).digest('hex');

    if (signature !== expectedSignature) {
      return { valid: false, reason: 'Invalid HMAC signature' };
    }

    return { valid: true };
  }
}

module.exports = RegionSecurity;
