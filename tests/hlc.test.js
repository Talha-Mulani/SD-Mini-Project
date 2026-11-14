const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const HybridLogicalClock = require('../lib/hlc');

describe('Hybrid Logical Clock (HLC)', () => {
  it('should monotonically increment logical counter within same physical millisecond', () => {
    const hlc = new HybridLogicalClock('mumbai');
    hlc.getPhysicalTime = () => 1000;

    const t1 = hlc.now();
    assert.equal(t1.time, 1000);
    assert.equal(t1.count, 0);
    assert.equal(t1.node, 'mumbai');

    const t2 = hlc.now();
    assert.equal(t2.time, 1000);
    assert.equal(t2.count, 1);

    const t3 = hlc.now();
    assert.equal(t3.time, 1000);
    assert.equal(t3.count, 2);
  });

  it('should reset logical counter when physical time advances', () => {
    const hlc = new HybridLogicalClock('frankfurt');
    let currentTime = 2000;
    hlc.getPhysicalTime = () => currentTime;

    hlc.now(); // 2000, count 0
    hlc.now(); // 2000, count 1

    currentTime = 2005;
    const tNext = hlc.now();
    assert.equal(tNext.time, 2005);
    assert.equal(tNext.count, 0);
  });

  it('should advance local clock when receiving remote message with higher timestamp', () => {
    const localHlc = new HybridLogicalClock('mumbai');
    localHlc.getPhysicalTime = () => 1000;
    localHlc.now(); // local is at 1000, count 0

    // Remote message arrives from Virginia with future timestamp 1500
    const remoteTimestamp = { time: 1500, count: 5, node: 'virginia' };
    const updated = localHlc.update(remoteTimestamp);

    assert.equal(updated.time, 1500);
    assert.equal(updated.count, 6); // advances past remote count

    // Subsequent local event preserves the advanced time even if physical clock is behind
    const nextLocal = localHlc.now();
    assert.equal(nextLocal.time, 1500);
    assert.equal(nextLocal.count, 7);
  });

  it('should deterministically compare timestamps', () => {
    const tA = { time: 1000, count: 1, node: 'mumbai' };
    const tB = { time: 1000, count: 2, node: 'mumbai' };
    const tC = { time: 1005, count: 0, node: 'frankfurt' };
    const tD = { time: 1000, count: 1, node: 'virginia' }; // tie-breaker by node

    assert.ok(HybridLogicalClock.compare(tA, tB) < 0);
    assert.ok(HybridLogicalClock.compare(tB, tC) < 0);
    assert.ok(HybridLogicalClock.compare(tA, tD) < 0); // 'mumbai' < 'virginia'
    assert.ok(HybridLogicalClock.compare(tD, tA) > 0);
    assert.equal(HybridLogicalClock.compare(tA, { ...tA }), 0);
  });

  it('should serialize and deserialize preserving ordering', () => {
    const original = { time: 1731412345000, count: 42, node: 'mumbai' };
    const serialized = HybridLogicalClock.serialize(original);
    const restored = HybridLogicalClock.deserialize(serialized);

    assert.deepEqual(restored, original);
  });
});
