// Multi-Tier Active-Active Cache Engine (L1 Memory + L2 Redis)
// Features:
// - L1 Micro-LRU Cache (zero network latency for hot keys)
// - L2 Redis Geo-Cache with connection pooling
// - XFetch: Optimal Probabilistic Early Expiration (VLDB 2015) preventing Cache Stampedes / Thundering Herd

class MultiTierGeoCache {
  /**
   * @param {object} options
   * @param {any} options.redisClient - Connected Redis client instance
   * @param {number} [options.l1MaxItems=500] - Max items in process memory
   * @param {number} [options.l1TtlMs=5000] - L1 Micro-TTL (e.g. 5 seconds)
   * @param {number} [options.l2TtlSec=3600] - L2 Redis TTL (e.g. 1 hour)
   * @param {number} [options.beta=1.0] - XFetch beta coefficient
   */
  constructor({ redisClient, l1MaxItems = 500, l1TtlMs = 5000, l2TtlSec = 3600, beta = 1.0 }) {
    this.redis = redisClient;
    this.l1MaxItems = l1MaxItems;
    this.l1TtlMs = l1TtlMs;
    this.l2TtlSec = l2TtlSec;
    this.beta = beta;

    this.l1 = new Map(); // key -> { record, expiry, delta }
    this.inFlightRefreshes = new Set();
  }

  cacheKey(key) {
    return `geocache:record:${key}`;
  }

  /**
   * Check if a key in L1 is valid or expired.
   * @param {string} key
   * @returns {object|null}
   */
  getL1(key) {
    const entry = this.l1.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.l1.delete(key);
      return null;
    }
    // Refresh LRU order
    this.l1.delete(key);
    this.l1.set(key, entry);
    return entry.record;
  }

  /**
   * Set record into L1 cache with micro-TTL and LRU eviction.
   * @param {string} key
   * @param {object} record
   * @param {number} [delta=10]
   */
  setL1(key, record, delta = 10) {
    if (this.l1.size >= this.l1MaxItems) {
      // Evict oldest (first inserted) item
      const oldestKey = this.l1.keys().next().value;
      if (oldestKey) this.l1.delete(oldestKey);
    }
    this.l1.set(key, {
      record,
      expiry: Date.now() + this.l1TtlMs,
      delta
    });
  }

  /**
   * Invalidate L1 cache entry.
   * @param {string} key
   */
  invalidateL1(key) {
    this.l1.delete(key);
  }

  /**
   * Read-through get with L1 -> L2 -> Database loader with XFetch stampede protection.
   * @param {string} key
   * @param {() => Promise<object|null>} dbLoaderFn
   * @returns {Promise<{ record: object|null, source: 'l1'|'redis'|'postgres', xfetchTriggered: boolean }>}
   */
  async getOrLoad(key, dbLoaderFn) {
    // 1. Try L1 Cache
    const l1Record = this.getL1(key);
    if (l1Record) {
      return { record: l1Record, source: 'l1', xfetchTriggered: false };
    }

    // 2. Try L2 Redis Cache
    let redisEntry = null;
    const redisKey = this.cacheKey(key);

    try {
      if (this.redis && this.redis.isOpen) {
        const raw = await this.redis.get(redisKey);
        if (raw) {
          redisEntry = JSON.parse(raw);
        }
      }
    } catch {
      // Redis error: fallback gracefully to database
    }

    if (redisEntry) {
      const now = Date.now();
      const delta = redisEntry.delta || 15; // Database read latency in ms
      const expiry = redisEntry.expiresAt || (now + 60000);
      const ttlRemainingMs = expiry - now;

      // XFetch algorithm: delta * beta * ln(rand())
      // If delta * beta * -ln(rand) > ttlRemaining, recompute early!
      const rand = Math.random();
      const xfetchThreshold = -delta * this.beta * Math.log(rand);
      const shouldRefreshEarly = xfetchThreshold > ttlRemainingMs;

      // Put in L1 for immediate subsequent local reads
      this.setL1(key, redisEntry.record, delta);

      if (shouldRefreshEarly && !this.inFlightRefreshes.has(key)) {
        this.inFlightRefreshes.add(key);
        // Asynchronous non-blocking early refresh
        setImmediate(async () => {
          try {
            const start = Date.now();
            const fresh = await dbLoaderFn();
            const newDelta = Date.now() - start;
            if (fresh) {
              await this.set(key, fresh, newDelta);
            }
          } catch {
            // Ignore background refresh failure
          } finally {
            this.inFlightRefreshes.delete(key);
          }
        });
        return { record: redisEntry.record, source: 'redis', xfetchTriggered: true };
      }

      return { record: redisEntry.record, source: 'redis', xfetchTriggered: false };
    }

    // 3. Cache Miss: Load from PostgreSQL
    const start = Date.now();
    const dbRecord = await dbLoaderFn();
    const fetchDurationMs = Math.max(1, Date.now() - start);

    if (dbRecord) {
      await this.set(key, dbRecord, fetchDurationMs);
      return { record: dbRecord, source: 'postgres', xfetchTriggered: false };
    }

    return { record: null, source: 'postgres', xfetchTriggered: false };
  }

  /**
   * Set record across L1 and L2 caches.
   * @param {string} key
   * @param {object} record
   * @param {number} [delta=10]
   */
  async set(key, record, delta = 10) {
    this.setL1(key, record, delta);

    if (this.redis && this.redis.isOpen) {
      try {
        const payload = JSON.stringify({
          record,
          delta,
          expiresAt: Date.now() + (this.l2TtlSec * 1000)
        });
        await this.redis.set(this.cacheKey(key), payload, {
          EX: this.l2TtlSec
        });
      } catch {
        // Fallback gracefully if Redis write fails
      }
    }
  }

  /**
   * Invalidate key across all cache tiers.
   * @param {string} key
   */
  async invalidate(key) {
    this.invalidateL1(key);
    if (this.redis && this.redis.isOpen) {
      try {
        await this.redis.del(this.cacheKey(key));
      } catch {
        // Ignore redis del error
      }
    }
  }
}

module.exports = MultiTierGeoCache;
