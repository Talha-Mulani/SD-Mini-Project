const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PNCounter, ORSet, LWWRegister, ConflictResolver } = require('../lib/crdt');

describe('CRDT Engine', () => {
  describe('PNCounter', () => {
    it('should independently increment/decrement and compute correct value', () => {
      const counter = new PNCounter();
      counter.increment('mumbai', 10);
      counter.decrement('mumbai', 3);
      counter.increment('frankfurt', 5);

      assert.equal(counter.value(), 12);
    });

    it('should converge when merging concurrent operations from multiple regions', () => {
      // Region A (Mumbai) reserves 5 stock from initial 50
      const mumbaiNode = new PNCounter();
      mumbaiNode.increment('mumbai', 50);
      mumbaiNode.decrement('mumbai', 5);

      // Region B (Frankfurt) receives shipment of 20 and reserves 10
      const frankfurtNode = new PNCounter();
      frankfurtNode.increment('frankfurt', 20);
      frankfurtNode.decrement('frankfurt', 10);

      // After partition heals and events cross-replicate
      mumbaiNode.merge(frankfurtNode);
      frankfurtNode.merge(mumbaiNode);

      assert.equal(mumbaiNode.value(), 55); // (50 + 20) - (5 + 10) = 55
      assert.equal(frankfurtNode.value(), 55);
      assert.deepEqual(mumbaiNode.toJSON(), frankfurtNode.toJSON());
    });
  });

  describe('ORSet (Observed-Remove Set with Add-Wins)', () => {
    it('should add and remove items correctly', () => {
      const cart = new ORSet();
      cart.add({ sku: 'shoe-101', name: 'Sneakers' }, 'tag-1');
      cart.add({ sku: 'bag-205', name: 'Backpack' }, 'tag-2');

      assert.equal(cart.read().length, 2);

      cart.remove({ sku: 'shoe-101', name: 'Sneakers' });
      const active = cart.read();
      assert.equal(active.length, 1);
      assert.equal(active[0].sku, 'bag-205');
    });

    it('should resolve concurrent add and remove with Add-Wins semantics', () => {
      const baseCart = new ORSet();
      baseCart.add('item-A', 'tag-A1');

      // Region Mumbai observes item-A and deletes it
      const mumbaiCart = new ORSet(JSON.parse(JSON.stringify(baseCart.toJSON())));
      mumbaiCart.remove('item-A');

      // Concurrent Region Frankfurt adds item-A again with new tag
      const frankfurtCart = new ORSet(JSON.parse(JSON.stringify(baseCart.toJSON())));
      frankfurtCart.add('item-A', 'tag-A2');

      // Merge on both sides
      mumbaiCart.merge(frankfurtCart);
      frankfurtCart.merge(mumbaiCart);

      // Add-Wins guarantees item-A is retained because tag-A2 was not observed by Mumbai's remove
      assert.ok(mumbaiCart.read().includes('item-A'));
      assert.ok(frankfurtCart.read().includes('item-A'));
    });
  });

  describe('ConflictResolver', () => {
    it('should resolve LWW records deterministically using HLC', () => {
      const existing = {
        value: { status: 'draft' },
        hlc_time: 1000,
        hlc_count: 0,
        origin_region: 'mumbai'
      };

      const incomingOlder = {
        value: { status: 'cancelled' },
        hlc: { time: 999, count: 5, node: 'frankfurt' },
        dataType: 'lww'
      };

      const resOlder = ConflictResolver.resolve(existing, incomingOlder);
      assert.equal(resOlder.applied, false);
      assert.equal(resOlder.resolvedType, 'lww_suppressed');

      const incomingNewer = {
        value: { status: 'paid' },
        hlc: { time: 1000, count: 1, node: 'frankfurt' },
        dataType: 'lww'
      };

      const resNewer = ConflictResolver.resolve(existing, incomingNewer);
      assert.equal(resNewer.applied, true);
      assert.equal(resNewer.resolvedType, 'lww_winner');
      assert.deepEqual(resNewer.mergedValue, { status: 'paid' });
    });
  });
});
