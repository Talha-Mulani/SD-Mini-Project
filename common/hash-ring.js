const crypto = require('crypto');

class HashRing {
  constructor(nodes = [], virtualNodes = 32) {
    this.virtualNodes = virtualNodes;
    this.nodes = new Map();
    nodes.forEach(node => this.addNode(node));
  }

  hash(value) {
    return crypto.createHash('sha256').update(String(value)).digest().readUInt32BE(0);
  }

  addNode(node) {
    this.nodes.set(node.id, node);
  }

  removeNode(id) {
    this.nodes.delete(id);
  }

  points() {
    const points = [];
    for (const node of this.nodes.values()) {
      for (let i = 0; i < this.virtualNodes; i++) {
        points.push({ position: this.hash(`${node.id}#${i}`), node });
      }
    }
    return points.sort((a, b) => a.position - b.position);
  }

  getReplicas(key, count = 3) {
    const points = this.points();
    if (!points.length) return [];
    const position = this.hash(key);
    let start = points.findIndex(point => point.position >= position);
    if (start < 0) start = 0;
    const replicas = [];
    const seen = new Set();
    for (let offset = 0; offset < points.length && replicas.length < this.nodes.size; offset++) {
      const node = points[(start + offset) % points.length].node;
      if (!seen.has(node.id)) {
        seen.add(node.id);
        replicas.push(node);
      }
    }
    return replicas.slice(0, Math.max(1, Math.min(count, replicas.length)));
  }

  snapshot() {
    return this.points().map(point => ({ position: point.position, nodeId: point.node.id }));
  }
}

module.exports = HashRing;
