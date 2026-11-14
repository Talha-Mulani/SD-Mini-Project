// Consistent Hash Ring with Virtual Nodes and Geo-Partitioning
// Provides deterministic key-to-node placement, replica preference lists, and shard affinity.

const crypto = require('crypto');

class ConsistentHashRing {
  /**
   * @param {string[]} nodes - Array of physical region/node names (e.g. ['mumbai', 'frankfurt', 'virginia'])
   * @param {object} [options]
   * @param {number} [options.vnodes=128] - Virtual nodes per physical region
   */
  constructor(nodes = [], options = {}) {
    this.vnodes = options.vnodes || 128;
    this.ring = []; // Array of { hash: number, node: string }
    this.nodes = new Set();

    for (const node of nodes) {
      this.addNode(node);
    }
  }

  /**
   * Hash a string to an unsigned 32-bit integer [0, 2^32 - 1].
   * Uses SHA-256 for cryptographic uniformity across the ring.
   * @param {string} str
   * @returns {number}
   */
  static hash(str) {
    const digest = crypto.createHash('sha256').update(String(str)).digest();
    return digest.readUInt32BE(0);
  }

  /**
   * Add a physical region/node to the ring with its virtual nodes.
   * @param {string} node
   */
  addNode(node) {
    if (!node || this.nodes.has(node)) return;
    this.nodes.add(node);

    for (let i = 0; i < this.vnodes; i++) {
      const vnodeKey = `${node}#vn${i}`;
      const hash = ConsistentHashRing.hash(vnodeKey);
      this.ring.push({ hash, node, vnodeKey });
    }

    this.ring.sort((a, b) => a.hash - b.hash);
  }

  /**
   * Remove a physical region/node from the ring.
   * @param {string} node
   */
  removeNode(node) {
    if (!node || !this.nodes.has(node)) return;
    this.nodes.delete(node);
    this.ring = this.ring.filter(item => item.node !== node);
  }

  /**
   * Get the primary node responsible for a given key.
   * Binary searches the sorted ring to find the first vnode with hash >= keyHash.
   * Wraps around to ring[0] if keyHash exceeds the highest vnode.
   * @param {string} key
   * @returns {string|null}
   */
  getNode(key) {
    if (this.ring.length === 0) return null;

    const keyHash = ConsistentHashRing.hash(key);
    let low = 0;
    let high = this.ring.length - 1;

    // Binary search for first element >= keyHash
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.ring[mid].hash >= keyHash) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    const index = low < this.ring.length ? low : 0;
    return this.ring[index].node;
  }

  /**
   * Get an ordered preference list of N distinct replica nodes for a key.
   * Dynamo-style preference list: walk clockwise on the ring, picking unique physical nodes.
   * @param {string} key
   * @param {number} [count=3]
   * @returns {string[]}
   */
  getPreferenceList(key, count = 3) {
    if (this.ring.length === 0) return [];

    const keyHash = ConsistentHashRing.hash(key);
    let low = 0;
    let high = this.ring.length - 1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.ring[mid].hash >= keyHash) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    const startIndex = low < this.ring.length ? low : 0;
    const result = [];
    const seen = new Set();
    const ringLen = this.ring.length;

    for (let i = 0; i < ringLen && result.length < count && result.length < this.nodes.size; i++) {
      const entry = this.ring[(startIndex + i) % ringLen];
      if (!seen.has(entry.node)) {
        seen.add(entry.node);
        result.push(entry.node);
      }
    }

    return result;
  }

  /**
   * Calculate distribution statistics across all registered nodes for a sample set of keys.
   * Useful for observability and partition health checks.
   * @param {string[]} sampleKeys
   * @returns {Record<string, { count: number, percentage: number }>}
   */
  analyzeDistribution(sampleKeys = []) {
    const counts = {};
    for (const node of this.nodes) {
      counts[node] = 0;
    }

    for (const key of sampleKeys) {
      const node = this.getNode(key);
      if (node) counts[node] = (counts[node] || 0) + 1;
    }

    const total = sampleKeys.length || 1;
    const stats = {};
    for (const [node, count] of Object.entries(counts)) {
      stats[node] = {
        count,
        percentage: Number(((count / total) * 100).toFixed(2))
      };
    }
    return stats;
  }
}

module.exports = ConsistentHashRing;
