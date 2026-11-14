const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const HybridLogicalClock = require('../lib/hlc');
const ConsistentHashRing = require('../lib/hashRing');
const { ConflictResolver, PNCounter, ORSet } = require('../lib/crdt');
const RegionSecurity = require('../lib/security');
const { PeerCircuitBreaker } = require('../lib/queue');

describe('Active-Active GeoCache System Integration', () => {
  it('should maintain causality across 3 regions using HLC', () => {
    const hlcMumbai = new HybridLogicalClock('mumbai');
    const hlcFrankfurt = new HybridLogicalClock('frankfurt');
    const hlcVirginia = new HybridLogicalClock('virginia');

    // 1. Mumbai initiates write
    const event1 = hlcMumbai.now();

    // 2. Event replicates to Frankfurt; Frankfurt advances its clock
    hlcFrankfurt.update(event1);
    const event2 = hlcFrankfurt.now(); // Caused by event1

    // 3. Event replicates to Virginia; Virginia advances clock
    hlcVirginia.update(event2);
    const event3 = hlcVirginia.now(); // Caused by event2

    assert.ok(HybridLogicalClock.compare(event1, event2) < 0, 'event1 must precede causally dependent event2');
    assert.ok(HybridLogicalClock.compare(event2, event3) < 0, 'event2 must precede causally dependent event3');
    assert.ok(HybridLogicalClock.compare(event1, event3) < 0, 'event1 must precede event3');
  });

  it('should handle circuit breaker state transitions on simulated partition', () => {
    const cb = new PeerCircuitBreaker('frankfurt', 'http://peer:5002', {
      failureThreshold: 2,
      recoveryTimeoutMs: 100
    });

    assert.equal(cb.state, 'CLOSED');
    assert.ok(cb.isAvailable());

    // 1st failure
    cb.recordFailure();
    assert.equal(cb.state, 'CLOSED');

    // 2nd failure triggers OPEN
    cb.recordFailure();
    assert.equal(cb.state, 'OPEN');
    assert.equal(cb.isAvailable(), false, 'Link must be blocked while OPEN');

    // Wait past recoveryTimeoutMs
    cb.lastFailureTime = Date.now() - 200;
    assert.ok(cb.isAvailable(), 'Link must transition to HALF_OPEN to allow probe');
    assert.equal(cb.state, 'HALF_OPEN');

    // Probe succeeds
    cb.recordSuccess();
    assert.equal(cb.state, 'CLOSED');
    assert.equal(cb.consecutiveFailures, 0);
  });

  it('should sign and verify cross-region packets with HMAC, reject replay, and reject tampering', () => {
    const security = new RegionSecurity('super-secret-production-cluster-key');
    const payload = { eventId: '123', key: 'cart:42', value: { qty: 2 } };

    const headers = security.createHeaders(payload, 'mumbai');
    assert.ok(headers['x-geocache-signature']);

    // 1. Valid verification
    const check1 = security.verifyRequest({ headers: { ...headers }, body: payload });
    assert.equal(check1.valid, true);

    // 2. Replay attack rejection (reusing exact same nonce)
    const checkReplay = security.verifyRequest({ headers: { ...headers }, body: payload });
    assert.equal(checkReplay.valid, false);
    assert.match(checkReplay.reason, /duplicate nonce/);

    // 3. Tampered payload rejection (new nonce, but body modified after signature)
    const headers2 = security.createHeaders(payload, 'mumbai');
    const tamperedReq = {
      headers: { ...headers2 },
      body: { eventId: '123', key: 'cart:42', value: { qty: 9999 } }
    };
    const checkTamper = security.verifyRequest(tamperedReq);
    assert.equal(checkTamper.valid, false);
    assert.match(checkTamper.reason, /Payload hash mismatch/);
  });
});
