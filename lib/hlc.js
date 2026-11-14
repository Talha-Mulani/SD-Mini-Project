// Hybrid Logical Clock (HLC) Implementation
// Based on Kulkarni et al. "Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases"
// Provides monotonic, causal ordering without relying purely on synchronized NTP clocks.

class HybridLogicalClock {
  /**
   * @param {string} nodeId - Region or node identifier (e.g. 'mumbai', 'frankfurt', 'virginia')
   */
  constructor(nodeId) {
    if (!nodeId) throw new Error('HybridLogicalClock requires a nodeId');
    this.nodeId = String(nodeId);
    this.l = 0; // Highest physical timestamp seen so far (milliseconds)
    this.c = 0; // Logical counter for events at the same physical millisecond
  }

  /**
   * Get current physical time in milliseconds.
   * Overridable for testing clock drift.
   * @returns {number}
   */
  getPhysicalTime() {
    return Date.now();
  }

  /**
   * Generate an HLC timestamp for a new local event or outgoing message.
   * Guarantees:
   * 1. l' = max(l, physicalNow)
   * 2. If l' == l, increment logical counter c
   * 3. Else, reset c to 0
   * @returns {{ time: number, count: number, node: string }}
   */
  now() {
    const pt = this.getPhysicalTime();
    const lOld = this.l;

    this.l = Math.max(lOld, pt);

    if (this.l === lOld) {
      this.c += 1;
    } else {
      this.c = 0;
    }

    return {
      time: this.l,
      count: this.c,
      node: this.nodeId
    };
  }

  /**
   * Update the local clock upon receiving a remote message with timestamp (m_l, m_c).
   * Ensures the local node's clock advances past any causally prior event.
   * @param {{ time: number, count: number, node?: string }} remoteHlc
   * @returns {{ time: number, count: number, node: string }}
   */
  update(remoteHlc) {
    if (!remoteHlc || typeof remoteHlc.time !== 'number') {
      return this.now();
    }

    const pt = this.getPhysicalTime();
    const lOld = this.l;
    const remoteTime = Number(remoteHlc.time);
    const remoteCount = Number(remoteHlc.count || 0);

    this.l = Math.max(lOld, remoteTime, pt);

    if (this.l === lOld && this.l === remoteTime) {
      this.c = Math.max(this.c, remoteCount) + 1;
    } else if (this.l === lOld) {
      this.c += 1;
    } else if (this.l === remoteTime) {
      this.c = remoteCount + 1;
    } else {
      this.c = 0;
    }

    return {
      time: this.l,
      count: this.c,
      node: this.nodeId
    };
  }

  /**
   * Compare two HLC timestamps deterministically.
   * Ordering rule:
   * 1. Higher `time` wins
   * 2. If `time` equals, higher `count` wins
   * 3. If both equal, tie-break lexicographically by `node`
   * @param {{ time: number, count: number, node?: string }} a
   * @param {{ time: number, count: number, node?: string }} b
   * @returns {number} Negative if a < b, positive if a > b, 0 if equal
   */
  static compare(a, b) {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;

    const timeDiff = Number(a.time) - Number(b.time);
    if (timeDiff !== 0) return timeDiff;

    const countDiff = Number(a.count || 0) - Number(b.count || 0);
    if (countDiff !== 0) return countDiff;

    const nodeA = String(a.node || '');
    const nodeB = String(b.node || '');
    if (nodeA < nodeB) return -1;
    if (nodeA > nodeB) return 1;
    return 0;
  }

  /**
   * Pack an HLC object into a standard sortable string format:
   * `<time_ms>:<count_padded>:<node>`
   * @param {{ time: number, count: number, node: string }} hlc
   * @returns {string}
   */
  static serialize(hlc) {
    if (!hlc) return '';
    const timeStr = String(hlc.time).padStart(15, '0');
    const countStr = String(hlc.count || 0).padStart(6, '0');
    return `${timeStr}:${countStr}:${hlc.node || ''}`;
  }

  /**
   * Parse a serialized HLC string back into an object.
   * @param {string} str
   * @returns {{ time: number, count: number, node: string }}
   */
  static deserialize(str) {
    if (!str || typeof str !== 'string') {
      return { time: 0, count: 0, node: '' };
    }
    const parts = str.split(':');
    return {
      time: Number(parts[0]) || 0,
      count: Number(parts[1]) || 0,
      node: parts.slice(2).join(':') || ''
    };
  }
}

module.exports = HybridLogicalClock;
