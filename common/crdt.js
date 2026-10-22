function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeMax(left = {}, right = {}) {
  const result = { ...left };
  for (const [id, value] of Object.entries(right)) {
    result[id] = Math.max(result[id] || 0, value);
  }
  return result;
}

function createCounter() {
  return { p: {}, n: {} };
}

function increment(state, nodeId, amount = 1) {
  const next = clone(state);
  const bucket = amount >= 0 ? next.p : next.n;
  bucket[nodeId] = (bucket[nodeId] || 0) + Math.abs(amount);
  return next;
}

function mergeCounter(left, right) {
  return { p: mergeMax(left.p, right.p), n: mergeMax(left.n, right.n) };
}

function value(state) {
  return Object.values(state.p).reduce((sum, item) => sum + item, 0)
    - Object.values(state.n).reduce((sum, item) => sum + item, 0);
}

module.exports = { createCounter, increment, mergeCounter, value };
