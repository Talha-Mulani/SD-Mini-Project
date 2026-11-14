// Conflict-Free Replicated Data Types (CRDTs)
// Implements PN-Counter (Positive-Negative Counter), OR-Set (Observed-Remove Set), and LWW-Register
// mathematically guaranteeing convergence under arbitrary partition orderings and replays.

const HybridLogicalClock = require('./hlc');

class PNCounter {
  /**
   * @param {object} [state]
   * @param {Record<string, number>} [state.P] - Map of regional increments
   * @param {Record<string, number>} [state.N] - Map of regional decrements
   */
  constructor(state = {}) {
    this.P = { ...(state.P || {}) };
    this.N = { ...(state.N || {}) };
  }

  /**
   * Increment counter in a specific region.
   * @param {string} region
   * @param {number} [amount=1]
   */
  increment(region, amount = 1) {
    if (amount < 0) return this.decrement(region, -amount);
    this.P[region] = (this.P[region] || 0) + Number(amount);
    return this;
  }

  /**
   * Decrement counter in a specific region.
   * @param {string} region
   * @param {number} [amount=1]
   */
  decrement(region, amount = 1) {
    if (amount < 0) return this.increment(region, -amount);
    this.N[region] = (this.N[region] || 0) + Number(amount);
    return this;
  }

  /**
   * Current integer value of the counter (sum(P) - sum(N)).
   * @returns {number}
   */
  value() {
    const sumP = Object.values(this.P).reduce((sum, v) => sum + Number(v), 0);
    const sumN = Object.values(this.N).reduce((sum, v) => sum + Number(v), 0);
    return sumP - sumN;
  }

  /**
   * Merge with another PN-Counter state (least upper bound join).
   * For every region: P_new = max(P_a, P_b), N_new = max(N_a, N_b)
   * @param {PNCounter|object} other
   * @returns {PNCounter}
   */
  merge(other) {
    const otherP = other.P || {};
    const otherN = other.N || {};

    const allPRegions = new Set([...Object.keys(this.P), ...Object.keys(otherP)]);
    for (const r of allPRegions) {
      this.P[r] = Math.max(this.P[r] || 0, otherP[r] || 0);
    }

    const allNRegions = new Set([...Object.keys(this.N), ...Object.keys(otherN)]);
    for (const r of allNRegions) {
      this.N[r] = Math.max(this.N[r] || 0, otherN[r] || 0);
    }

    return this;
  }

  toJSON() {
    return {
      type: 'pn_counter',
      P: { ...this.P },
      N: { ...this.N },
      value: this.value()
    };
  }
}

class ORSet {
  /**
   * Observed-Remove Set with Add-Wins semantics.
   * @param {object} [state]
   * @param {Array<{ item: any, tag: string }>} [state.elements]
   * @param {string[]} [state.tombstones]
   */
  constructor(state = {}) {
    this.elements = Array.isArray(state.elements) ? [...state.elements] : [];
    this.tombstones = new Set(Array.isArray(state.tombstones) ? state.tombstones : []);
  }

  /**
   * Add an item to the set with a unique tag.
   * @param {any} item
   * @param {string} [tag]
   */
  add(item, tag) {
    const itemTag = tag || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    this.elements.push({ item, tag: itemTag });
    return itemTag;
  }

  /**
   * Remove an item from the set by marking all currently observed tags as tombstones.
   * @param {any} item
   */
  remove(item) {
    const targetStr = JSON.stringify(item);
    for (const entry of this.elements) {
      if (JSON.stringify(entry.item) === targetStr) {
        this.tombstones.add(entry.tag);
      }
    }
  }

  /**
   * Return the active items in the set (elements whose tags are not in tombstones).
   * @returns {any[]}
   */
  read() {
    const active = [];
    const seen = new Set();
    for (const entry of this.elements) {
      if (!this.tombstones.has(entry.tag)) {
        const str = JSON.stringify(entry.item);
        if (!seen.has(str)) {
          seen.add(str);
          active.push(entry.item);
        }
      }
    }
    return active;
  }

  /**
   * Merge with another ORSet state.
   * Elements union, tombstones union.
   * @param {ORSet|object} other
   * @returns {ORSet}
   */
  merge(other) {
    const otherElements = Array.isArray(other.elements) ? other.elements : [];
    const otherTombstones = other.tombstones instanceof Set
      ? other.tombstones
      : new Set(Array.isArray(other.tombstones) ? other.tombstones : []);

    const tagMap = new Map();
    for (const entry of this.elements) {
      tagMap.set(entry.tag, entry);
    }
    for (const entry of otherElements) {
      if (!tagMap.has(entry.tag)) {
        tagMap.set(entry.tag, entry);
      }
    }

    this.elements = Array.from(tagMap.values());
    for (const tag of otherTombstones) {
      this.tombstones.add(tag);
    }

    return this;
  }

  toJSON() {
    return {
      type: 'or_set',
      elements: this.elements,
      tombstones: Array.from(this.tombstones),
      items: this.read()
    };
  }
}

class LWWRegister {
  /**
   * Last-Write-Wins Register backed by HLC.
   * @param {any} value
   * @param {{ time: number, count: number, node: string }} hlc
   */
  constructor(value = null, hlc = null) {
    this.value = value;
    this.hlc = hlc || { time: 0, count: 0, node: '' };
  }

  /**
   * Write new value with new HLC.
   * @param {any} value
   * @param {{ time: number, count: number, node: string }} newHlc
   */
  set(value, newHlc) {
    if (HybridLogicalClock.compare(newHlc, this.hlc) > 0) {
      this.value = value;
      this.hlc = newHlc;
      return true;
    }
    return false;
  }

  /**
   * Merge with another LWW-Register.
   * @param {LWWRegister|object} other
   * @returns {LWWRegister}
   */
  merge(other) {
    if (!other || !other.hlc) return this;
    if (HybridLogicalClock.compare(other.hlc, this.hlc) > 0) {
      this.value = other.value;
      this.hlc = other.hlc;
    }
    return this;
  }

  toJSON() {
    return {
      type: 'lww',
      value: this.value,
      hlc: this.hlc
    };
  }
}

/**
 * Universal Conflict Resolver for Active-Active Geocache
 */
class ConflictResolver {
  /**
   * Resolve conflict between existing record in database/cache and incoming remote event.
   * @param {object} existing
   * @param {object} incoming
   * @returns {{ applied: boolean, mergedValue: any, conflictResolved: boolean, resolvedType: string }}
   */
  static resolve(existing, incoming) {
    if (!existing) {
      return {
        applied: true,
        mergedValue: incoming.value,
        conflictResolved: false,
        resolvedType: incoming.dataType || 'lww'
      };
    }

    const type = incoming.dataType || (incoming.value && incoming.value.type) || 'lww';

    if (type === 'pn_counter') {
      const counter1 = new PNCounter(existing.value);
      const counter2 = new PNCounter(incoming.value);
      counter1.merge(counter2);
      return {
        applied: true,
        mergedValue: counter1.toJSON(),
        conflictResolved: true,
        resolvedType: 'pn_counter'
      };
    }

    if (type === 'or_set') {
      const set1 = new ORSet(existing.value);
      const set2 = new ORSet(incoming.value);
      set1.merge(set2);
      return {
        applied: true,
        mergedValue: set1.toJSON(),
        conflictResolved: true,
        resolvedType: 'or_set'
      };
    }

    // Default: LWW with HLC
    const incomingHlc = incoming.hlc || { time: Number(incoming.version || 0), count: 0, node: incoming.originRegion };
    const existingHlc = existing.hlc || {
      time: Number(existing.hlc_time || existing.version || 0),
      count: Number(existing.hlc_count || 0),
      node: existing.origin_region || existing.originRegion || ''
    };

    const comp = HybridLogicalClock.compare(incomingHlc, existingHlc);
    if (comp > 0) {
      return {
        applied: true,
        mergedValue: incoming.value,
        conflictResolved: true,
        resolvedType: 'lww_winner'
      };
    }

    return {
      applied: false,
      mergedValue: existing.value,
      conflictResolved: true,
      resolvedType: 'lww_suppressed'
    };
  }
}

module.exports = {
  PNCounter,
  ORSet,
  LWWRegister,
  ConflictResolver
};
