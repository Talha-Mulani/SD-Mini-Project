const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const ConsistentHashRing = require('../lib/hashRing');

describe('Consistent Hash Ring', () => {
  const regions = ['mumbai', 'frankfurt', 'virginia'];

  it('should map keys deterministically to nodes', () => {
    const ring = new ConsistentHashRing(regions);

    const node1 = ring.getNode('cart:user-101');
    const node2 = ring.getNode('cart:user-101');
    assert.equal(node1, node2, 'Same key must always map to same node');
    assert.ok(regions.includes(node1));
  });

  it('should distribute keys relatively evenly across regions', () => {
    const ring = new ConsistentHashRing(regions, { vnodes: 256 });
    const keys = Array.from({ length: 3000 }, (_, i) => `record:sku-${i}-${Math.random()}`);

    const stats = ring.analyzeDistribution(keys);
    for (const region of regions) {
      assert.ok(stats[region], `Region ${region} should have assigned keys`);
      // Each region should receive roughly 33.3% of keys (+/- 10%)
      assert.ok(
        stats[region].percentage > 23 && stats[region].percentage < 43,
        `Distribution for ${region} (${stats[region].percentage}%) should be reasonably balanced`
      );
    }
  });

  it('should return a valid preference list without duplicates', () => {
    const ring = new ConsistentHashRing(regions);
    const prefList = ring.getPreferenceList('inventory:shoe-101', 3);

    assert.equal(prefList.length, 3);
    assert.equal(new Set(prefList).size, 3, 'Preference list should contain distinct physical nodes');
    assert.equal(prefList[0], ring.getNode('inventory:shoe-101'), 'First item in preference list must be primary');
  });

  it('should adapt gracefully when a node is removed or added', () => {
    const ring = new ConsistentHashRing(['mumbai', 'frankfurt']);
    const primaryBefore = ring.getNode('cart:user-500');

    ring.addNode('virginia');
    const primaryAfter = ring.getNode('cart:user-500');
    assert.ok(['mumbai', 'frankfurt', 'virginia'].includes(primaryAfter));

    ring.removeNode('virginia');
    const primaryRestored = ring.getNode('cart:user-500');
    assert.equal(primaryRestored, primaryBefore, 'Removing newly added node restores prior assignment');
  });
});
