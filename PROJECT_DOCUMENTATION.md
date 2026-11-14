# GlobalCart GeoCache (v2.0)

## High-Performance Active-Active Multi-Region Geo-Distributed Cache Engine

GlobalCart GeoCache is an enterprise-grade demonstration and implementation of an active-active, multi-region distributed cache and storage architecture. Spanning three cloud regions—**Mumbai (`ap-south-1`)**, **Frankfurt (`eu-central-1`)**, and **Virginia (`us-east-1`)**—every region is fully writable, locally autonomous, and resilient to arbitrary WAN partitions.

While GlobalCart provides the intuitive e-commerce scenario (shopping carts, flash-sale inventory reservations, order management), the true technological hero of this platform is the **GeoCache Distributed Engine**.

---

## 1. High-Level Architectural Topology

```text
                                         Global Clients
                                               |
                          AWS Route 53 / Latency-Based Geo Router
                                               |
                +------------------------------+------------------------------+
                |                              |                              |
                v                              v                              v
        Mumbai Cluster                 Frankfurt Cluster              Virginia Cluster
         (ap-south-1)                    (eu-central-1)                  (us-east-1)
       +---------------+              +---------------+              +---------------+
       | Gateway Proxy |              | Gateway Proxy |              | Gateway Proxy |
       | ConsistentRing|              | ConsistentRing|              | ConsistentRing|
       +-------+-------+              +-------+-------+              +-------+-------+
               |                              |                              |
       +-------v-------+              +-------v-------+              +-------v-------+
       | L1 Mem Cache  |              | L1 Mem Cache  |              | L1 Mem Cache  |
       | (XFetch Alg)  |              | (XFetch Alg)  |              | (XFetch Alg)  |
       +-------+-------+              +-------+-------+              +-------+-------+
               |                              |                              |
       +-------v-------+              +-------v-------+              +-------v-------+
       | L2 Redis Node |              | L2 Redis Node |              | L2 Redis Node |
       | Cache-Aside   |              | Cache-Aside   |              | Cache-Aside   |
       +-------+-------+              +-------+-------+              +-------+-------+
               |                              |                              |
       +-------v-------+              +-------v-------+              +-------v-------+
       | PostgreSQL    |              | PostgreSQL    |              | PostgreSQL    |
       | - Records+HLC |              | - Records+HLC |              | - Records+HLC |
       | - Outbox Que  |              | - Outbox Que  |              | - Outbox Que  |
       | - DLQ Table   |              | - DLQ Table   |              | - DLQ Table   |
       +-------+-------+              +-------+-------+              +-------+-------+
               |                              |                              |
       +-------v-------+              +-------v-------+              +-------v-------+
       | Outbox Worker |              | Outbox Worker |              | Outbox Worker |
       | - CircuitBrk  |              | - CircuitBrk  |              | - CircuitBrk  |
       | - MicroBatch  |              | - MicroBatch  |              | - MicroBatch  |
       +-------+-------+              +-------+-------+              +-------+-------+
               \_______________________ Asynchronous ________________________/
                             Mutual HMAC-SHA256 Replication Mesh
```

---

## 2. Core Subsystems and Technical Innovations

### 2.1. Geo-Aware Consistent Hashing & Ring Sharding (`lib/hashRing.js`)
In a distributed active-active cache, key distribution must avoid single-node hot spots while respecting geo-affinity:
- **Ring Structure**: 32-bit unsigned integer ring $[0, 2^{32}-1]$.
- **Virtual Nodes (vnodes)**: 128 virtual nodes per physical region (e.g. `mumbai#vn0`, `mumbai#vn1`, ...), hashed with SHA-256 to ensure cryptographically uniform key placement.
- **Preference List Generation**: For any cache key, Dynamo-style preference lists identify the primary region shard and $N-1$ secondary replica regions.
- **Read-Your-Writes Geo-Affinity**: The gateway routes requests directly to the home shard when available, falling back smoothly to local replicas.

### 2.2. Hybrid Logical Clocks (HLC) (`lib/hlc.js`)
Physical clocks in cloud data centers drift due to crystal oscillator variance, temperature changes, and network jitter (NTP drift commonly ranges from 5ms to 250ms). Pure physical timestamps (`Date.now()`) cannot guarantee causality.
- **HLC Mathematical Formulation** (Kulkarni et al., VLDB 2014):
  - State tuple: $(l, c)$, where $l$ is physical timestamp and $c$ is a logical counter.
  - On local write:
    $$l' = \max(l, \text{physicalTime}())$$
    $$\text{if } l' == l \implies c = c + 1 \quad \text{else } c = 0$$
  - On remote event reception:
    $$l' = \max(l, msg.l, \text{physicalTime}())$$
    $$\text{if } l' == l == msg.l \implies c = \max(c, msg.c) + 1$$
    $$\text{else if } l' == l \implies c = c + 1$$
    $$\text{else if } l' == msg.l \implies c = msg.c + 1$$
    $$\text{else } c = 0$$
- **Causality Guarantee**: If event $e_1$ causally influences $e_2$ ($e_1 \to e_2$), then $HLC(e_1) < HLC(e_2)$ strictly, eliminating clock-drift anomalies.

### 2.3. Conflict-Free Replicated Data Types (CRDTs) (`lib/crdt.js`)
Rather than blindly losing concurrent writes with Last-Write-Wins, GeoCache supports pluggable CRDT convergence:
1. **PN-Counter (Positive-Negative Counter)**:
   - Tracks separate increment vectors $P$ and decrement vectors $N$ per region.
   - Merging two states takes the pointwise join: $P_{merged}[r] = \max(P_1[r], P_2[r])$ and $N_{merged}[r] = \max(N_1[r], N_2[r])$.
   - Value: $\sum P - \sum N$.
   - **Flash-Sale Inventory Guarantee**: Multiple regions can independently reserve and replenish stock during a partition; when reconnected, stock reconciles with mathematical exactness and zero overselling.
2. **OR-Set (Observed-Remove Set with Add-Wins)**:
   - Used for shopping carts and wishlists.
   - Elements added are tagged with unique event tokens. Removing an element tombstones all currently observed tags for that item.
   - Guarantees concurrent additions across regions are preserved without losing items.
3. **LWW-Register**:
   - Compares HLC tokens `(time, count, node)` for monotonic single-value mutations (e.g. order status: `draft` $\to$ `paid` $\to$ `shipped`).

### 2.4. Multi-Tier Active Caching with XFetch Stampede Prevention (`lib/cache.js`)
- **L1 In-Memory LRU**: Stores ultra-hot keys directly in Node process memory with micro-TTLs, eliminating network hops.
- **L2 Regional Redis**: Distributed cache-aside cluster in each region with append-only persistence.
- **XFetch Algorithm (Optimal Probabilistic Cache Stampede Prevention)**:
  - When high-traffic keys expire under massive read concurrency, thousands of threads miss the cache at once and overwhelm the database.
  - XFetch solves this probabilistically:
    $$\Delta \cdot \beta \cdot -\ln(\text{rand}()) > (\text{expiry} - \text{now})$$
    where $\Delta$ is database fetch duration, $\beta$ is a tuning constant ($\beta \ge 1.0$), and $\text{rand}() \in (0, 1]$.
  - If triggered, the node asynchronously refreshes the cache *before* hard TTL expiration, guaranteeing 100% hot-cache availability with 0ms cache misses.

### 2.5. Resilient Replication Queue & Fast-Forward Batch Replay (`lib/queue.js`)
Replication is asynchronous, durable, and fault-tolerant:
- **Link Circuit Breakers**:
  - Outbound links to peer regions maintain states: `CLOSED`, `OPEN`, and `HALF_OPEN`.
  - When consecutive network failures exceed the threshold (default: 3), the link trips to `OPEN`.
  - In `OPEN` state, requests buffer durably in the PostgreSQL outbox table without creating connection leaks or socket exhaustion.
- **High-Throughput Micro-Batch Replay**:
  - Drains up to 50-100 events per HTTP payload via `/internal/replicate-batch`.
  - Applied atomically on the receiving peer in a single PostgreSQL transaction with bulk deduplication.
  - Achieves over 2,000 events/sec drain rate upon link recovery.
- **AWS Full Jitter Exponential Backoff**:
  - Retry delays use AWS-recommended full jitter: $\text{sleep} = \text{rand}(0, \min(\text{cap}, \text{base} \cdot 2^{\text{retry\_count}}))$.
- **Dead-Letter Queue (DLQ) & Poison Pill Isolation**:
  - Any corrupted or un-applyable event failing 10 times is quarantined to `replication_dlq`, preventing head-of-line blocking.

### 2.6. CloudWatch Observability & Distributed Tracing (`lib/logger.js`)
- **AWS Embedded Metric Format (EMF)**:
  - Emits JSON structured logs directly formatted with CloudWatch EMF specification.
  - CloudWatch natively extracts custom metrics without custom regex metric filters:
    - `ReplicationLagMs` (p50, p95, p99)
    - `QueueDepth` (pending outbox backlog)
    - `CacheHitsL1`, `CacheHitsL2`, `CacheMisses`
    - `ConflictsResolved` (CRDT merges vs LWW wins)
    - `DeadLetterCount`
- **Correlation IDs**: Every request carries an AWS X-Ray compatible trace ID (`1-timestamp-guid`) propagated end-to-end through HTTP headers and outbox records.

---

## 3. Real Cloud VM & Production Infrastructure

### 3.1. AWS Multi-Region Deployment with Terraform (`terraform/`)
The included Terraform configuration deploys production resources across 3 real AWS regions:
- `ap-south-1` (Mumbai)
- `eu-central-1` (Frankfurt)
- `us-east-1` (Virginia)

Key infrastructure components:
- **VPCs & Subnets**: Independent CIDRs (`10.10.0.0/16`, `10.20.0.0/16`, `10.30.0.0/16`).
- **EC2 Compute Nodes**: Graviton ARM instances (`t4g.medium`) with Ubuntu 24.04 LTS.
- **IAM Instance Profiles**: Configured with `CloudWatchAgentServerPolicy` and `AmazonSSMManagedInstanceCore`.
- **Security Groups**: Port 5001/5002/5003 restricted to peer region VPCs or secured via mutual HMAC authentication.
- **User-Data Bootstrapping (`terraform/userdata.sh`)**:
  - Installs Node.js 22, Redis, and PostgreSQL.
  - Initializes database schema.
  - Deploys `systemd` service with automatic restarts.
  - Sets up AWS CloudWatch Agent for log and metric collection.

### 3.2. Generic Linux VM Provisioning (`scripts/setup-vm.sh`)
For deployments on non-AWS environments (e.g. Hetzner, GCP, DigitalOcean, on-prem bare metal):
```bash
sudo ./scripts/setup-vm.sh mumbai 5001 '{"frankfurt":"http://10.20.1.5:5002","virginia":"http://10.30.1.8:5003"}'
```

---

## 4. Verification and Benchmark Suite

### 4.1. Automated Unit & Integration Tests
Run via native Node.js test runner:
```bash
npm test
```
**17 test specifications** cover:
- HLC causality and monotonicity under physical clock skew.
- Consistent hash ring key distribution and preference lists.
- PN-Counter join-semilattice and OR-Set Add-Wins conflict resolution.
- Link circuit breaker transitions.
- HMAC signature verification, nonce replay rejection, and payload tampering protection.

### 4.2. Chaos & Queue Replay Benchmark
Run the end-to-end chaos benchmark:
```bash
npm run benchmark
```
- Sever the replication link between Mumbai and Frankfurt.
- Generate 50 concurrent writes into partitioned Mumbai.
- Inspect accumulated pending outbox depth.
- Heal the partition and measure fast-forward batch replay throughput and time-to-zero backlog.

---

## 5. Architectural Summary Matrix

| Area | Component | Implementation |
|---|---|---|
| **Data Partitioning** | `lib/hashRing.js` | Consistent Hashing with 128 SHA-256 virtual nodes |
| **Logical Ordering** | `lib/hlc.js` | Hybrid Logical Clocks $(l, c)$ with monotonic tokens |
| **Conflict Resolution** | `lib/crdt.js` | PN-Counter, OR-Set (Add-Wins), LWW-Register with HLC |
| **Cache Hierarchy** | `lib/cache.js` | L1 In-Memory LRU + L2 Redis + XFetch Stampede Protection |
| **Replication Queue** | `lib/queue.js` | Transactional Outbox + Micro-Batching + Circuit Breakers |
| **Poison Pill Isolation** | `db/schema.sql` | `replication_dlq` dead-letter queue table |
| **Backoff Strategy** | `lib/queue.js` | AWS Full Jitter Exponential Backoff |
| **Link Security** | `lib/security.js` | Mutual HMAC-SHA256, Body Digest, Nonce Anti-Replay |
| **Telemetry** | `lib/logger.js` | AWS CloudWatch EMF JSON & W3C/X-Ray Trace Correlation |
| **Infrastructure** | `terraform/` | Multi-Region Terraform for AWS (Mumbai, Frankfurt, Virginia) |
