# GeoCache Active-Active (v2.0)

## Enterprise Multi-Region Distributed Cache with Consistent Hashing, Hybrid Logical Clocks & Resilient Queue Replay

[![Test Suite](https://img.shields.io/badge/tests-17%20passing-brightgreen)](#automated-test-suite)
[![Architecture](https://img.shields.io/badge/architecture-active--active%20multi--region-blue)](#system-architecture)
[![Consistency](https://img.shields.io/badge/clocks-hybrid%20logical%20clocks%20(HLC)-purple)](#hybrid-logical-clocks-hlc)
[![Cloud](https://img.shields.io/badge/cloud-aws%20cloudwatch%20%2B%20terraform-orange)](#cloud--vm-deployment)

GeoCache is a production-grade active-active, multi-region distributed caching and data replication engine designed for global scale and zero-downtime resilience. Built around three active hubs—**Mumbai (`ap-south-1`)**, **Frankfurt (`eu-central-1`)**, and **Virginia (`us-east-1`)**—every region accepts concurrent reads and writes with sub-millisecond local latency, durable transactional guarantees, and eventual consistency convergence.

While demonstrated through an e-commerce flash-sale scenario (**GlobalCart**), the core hero of this project is the **GeoCache Distributed Engine**:
- **Geo-Aware Consistent Hash Ring** with 128 virtual nodes per region.
- **Hybrid Logical Clocks (HLC)** solving physical clock drift and leap-second anomalies.
- **Conflict-Free Replicated Data Types (CRDTs)**: PN-Counters for inventory reservations and OR-Sets for concurrent cart mutations.
- **Multi-Tier Caching** with **XFetch Probabilistic Early Expiration** to eliminate cache stampedes / thundering herds.
- **Resilient Micro-Batch Replication Pipeline** with link-level Circuit Breakers, AWS Full Jitter Backoff, Dead-Letter Queues (DLQ), and Fast-Forward Replay.
- **AWS CloudWatch Observability**: Structured JSON logging with native Embedded Metric Format (EMF) telemetry and distributed trace correlation (`x-trace-id`).

---

## System Architecture

```text
                                       Global Ingress
                                             |
                         AWS Route 53 / Latency-Aware Router
                                             |
                  +--------------------------+--------------------------+
                  |                          |                          |
                  v                          v                          v
          Mumbai Region              Frankfurt Region            Virginia Region
          (ap-south-1)                 (eu-central-1)               (us-east-1)
       +--------------------+      +--------------------+      +--------------------+
       |  Regional Gateway  |      |  Regional Gateway  |      |  Regional Gateway  |
       |  Consistent Ring   |      |  Consistent Ring   |      |  Consistent Ring   |
       +---------+----------+      +---------+----------+      +---------+----------+
                 |                           |                           |
       +---------v----------+      +---------v----------+      +---------v----------+
       | L1 In-Memory Cache |      | L1 In-Memory Cache |      | L1 In-Memory Cache |
       | (XFetch Stampede)  |      | (XFetch Stampede)  |      | (XFetch Stampede)  |
       +---------+----------+      +---------+----------+      +---------+----------+
                 |                           |                           |
       +---------v----------+      +---------v----------+      +---------v----------+
       | L2 Regional Redis  |      | L2 Regional Redis  |      | L2 Regional Redis  |
       | Cache-Aside Clust  |      | Cache-Aside Clust  |      | Cache-Aside Clust  |
       +---------+----------+      +---------+----------+      +---------+----------+
                 |                           |                           |
       +---------v----------+      +---------v----------+      +---------v----------+
       | PostgreSQL Store   |      | PostgreSQL Store   |      | PostgreSQL Store   |
       | - Records & HLC    |      | - Records & HLC    |      | - Records & HLC    |
       | - Outbox Queue     |      | - Outbox Queue     |      | - Outbox Queue     |
       | - DLQ Isolation    |      | - DLQ Isolation    |      | - DLQ Isolation    |
       +---------+----------+      +---------+----------+      +---------+----------+
                 |                           |                           |
       +---------v----------+      +---------v----------+      +---------v----------+
       | Outbox Queue Worker|      | Outbox Queue Worker|      | Outbox Queue Worker|
       | - Circuit Breaker  |      | - Circuit Breaker  |      | - Circuit Breaker  |
       | - Micro-Batching   |      | - Micro-Batching   |      | - Micro-Batching   |
       +---------+----------+      +---------+----------+      +---------+----------+
                 \__________________ Asynchronous Micro-Batch __________________/
                                 Mutual HMAC-SHA256 Links
```

---

## Core Engineering Features

### 1. Consistent Hash Ring with Virtual Nodes (`lib/hashRing.js`)
- Uses cryptographic SHA-256 to map cache keys to an unsigned 32-bit integer ring $[0, 2^{32} - 1]$.
- Configured with **128 virtual nodes** per physical region to ensure uniform distribution and prevent hot spots.
- Computes Dynamo-style **preference lists** ($N=3$ replicas) for quorum and asynchronous cross-region fan-out.
- Provides partition ownership lookup in $O(\log N)$ time via binary search.

### 2. Hybrid Logical Clocks (HLC) (`lib/hlc.js`)
- Solves NTP clock skew and backwards clock drift across AWS regions (based on Kulkarni et al., VLDB 2014).
- Maintains state $(l, c)$ where $l$ captures physical wall-clock time and $c$ orders events occurring within the same millisecond.
- Guarantees strict causality: if $e_1 \to e_2$, then $HLC(e_1) < HLC(e_2)$.
- Packed into sortable monotonic tokens `<timestamp_ms>:<counter>:<node_id>`.

### 3. Conflict-Free Replicated Data Types (CRDTs) (`lib/crdt.js`)
- **PN-Counter (Positive-Negative Counter)**:
  - Vector of increments $P$ and decrements $N$ per region.
  - Value = $\sum P - \sum N$.
  - Guarantees zero lost reservations or overselling during network partitions.
- **OR-Set (Observed-Remove Set with Add-Wins)**:
  - Add-Wins semantics for shopping carts and user collections.
  - Elements tagged with UUID tokens; concurrent adds and removes resolve with Add-Wins.
- **LWW-Register**:
  - Deterministic tie-breaker with HLC for user preferences and order status transitions.

### 4. Multi-Tier Cache Hierarchy with XFetch (`lib/cache.js`)
- **L1 In-Memory LRU**: Sub-millisecond micro-cache for ultra-hot read traffic.
- **L2 Redis Cache**: Shared regional cache with Redis 7 append-only persistence.
- **XFetch Algorithm (VLDB 2015)**:
  - Evaluates probabilistic early refresh:
    $$\Delta \cdot \beta \cdot -\ln(\text{random}()) > (\text{expiry} - \text{now})$$
  - Asynchronously computes and rehydrates hot keys *before* hard TTL expiration, completely eliminating the **Cache Stampede / Thundering Herd** failure mode.

### 5. Resilient Replication Queue & Fast-Forward Replay (`lib/queue.js`)
- **Link-Level Circuit Breakers**:
  - States: `CLOSED` (healthy), `OPEN` (partitioned/broken), `HALF_OPEN` (probing recovery).
  - Stops socket saturation when a link fails; buffers events in durable PostgreSQL outbox.
- **High-Throughput Micro-Batch Replay**:
  - Automatically drains up to 50-100 events per HTTP payload via `/internal/replicate-batch`.
  - Achieves 2,000+ events/sec drain rate upon partition healing.
- **AWS Full Jitter Exponential Backoff**:
  - Jittered retry backoff prevents synchronized thundering retry storms across regions.
- **Dead-Letter Queue (DLQ) & Poison Pill Isolation**:
  - Corrupt or poison events exceeding 10 retries are isolated into `replication_dlq`, preventing head-of-line blocking for valid transactions.

### 6. CloudWatch Observability & Distributed Tracing (`lib/logger.js`)
- Generates AWS CloudWatch **Embedded Metric Format (EMF)** JSON lines directly on stdout.
- CloudWatch automatically graphs high-resolution metrics without custom log metric filters:
  - `ReplicationLagMs`, `QueueDepth`, `CacheHitsL1`, `CacheHitsL2`, `CacheMisses`, `ConflictsResolved`, `DeadLetterCount`.
- Propagates distributed W3C / X-Ray trace IDs (`x-trace-id`) across gateways, regions, and replication queues.

---

## Quickstart (Local Docker Compose)

```powershell
# 1. Install dependencies and run test suite
npm install
npm test

# 2. Start full multi-region cluster (3 Regions + Toxiproxy + Gateway)
docker compose up --build
```

Access the control room:
- **Control Center & Chaos Studio**: [http://localhost:3100](http://localhost:3100)
- **Mumbai Storefront**: [http://localhost:3100/mumbai.html](http://localhost:3100/mumbai.html)
- **Frankfurt Storefront**: [http://localhost:3100/frankfurt.html](http://localhost:3100/frankfurt.html)
- **Virginia Storefront**: [http://localhost:3100/virginia.html](http://localhost:3100/virginia.html)

---

## Chaos Engineering & Queue Replay Benchmark

Run the automated chaos benchmark:

```powershell
npm run benchmark
```

What the benchmark executes:
1. Verifies baseline latency across all 3 regional nodes.
2. Injects an asynchronous network partition between Mumbai and Frankfurt via Toxiproxy.
3. Pumps 50 concurrent atomic writes into partitioned Mumbai.
4. Verifies outbox queue backlog accumulation and circuit breaker transition to `OPEN`.
5. Reconnects and heals the link.
6. Times the fast-forward micro-batch replay and logs the exact throughput (events/sec) to reach 0 pending events!

---

## Production Cloud & VM Deployment

GeoCache is architected to run across real cloud VMs (AWS EC2, Hetzner, GCP Compute Engine, DigitalOcean).

### Option A: AWS Multi-Region Deployment with Terraform

The `terraform/` directory contains complete multi-region infrastructure definitions:
- Provisions 3 VPCs in `ap-south-1` (Mumbai), `eu-central-1` (Frankfurt), and `us-east-1` (Virginia).
- Provisions EC2 Graviton instances (`t4g.medium`).
- Attaches IAM Instance Profiles for CloudWatch Logs and EMF metric extraction.
- Configures security groups and auto-executes `terraform/userdata.sh`.

```bash
cd terraform
terraform init
terraform apply
```

### Option B: Standalone VM Provisioning (`scripts/setup-vm.sh`)

To deploy on any fresh Ubuntu/Debian VM:

```bash
sudo ./scripts/setup-vm.sh <region_name> <port> '<peers_json>'

# Example for Mumbai node:
sudo ./scripts/setup-vm.sh mumbai 5001 '{"frankfurt":"http://10.20.1.5:5002","virginia":"http://10.30.1.8:5003"}'
```

This script:
1. Installs Node.js 22 LTS, Redis, and PostgreSQL.
2. Initializes the database schema and creates dedicated system users.
3. Deploys a production `systemd` service with automatic restarts.
4. Configures journald log streaming to CloudWatch Agent.

---

## Automated Test Suite

Run the full integration and unit test suite:

```bash
npm test
```

Suite overview:
- `tests/hlc.test.js`: Monotonic ordering, logical counter increments, remote clock updates, and cross-region serialization.
- `tests/hashRing.test.js`: Deterministic placement, ring uniformity, preference lists, and node removal/addition stability.
- `tests/crdt.test.js`: PN-Counter join-semilattice properties, OR-Set Add-Wins semantics, and HLC conflict resolution.
- `tests/replication.test.js`: End-to-end causality verification, circuit breaker transitions, HMAC-SHA256 signature verification, anti-replay nonce rejection, and payload tampering detection.

---

## Summary of Architectural Algorithms

| Subsystem | Mechanism | Purpose |
|---|---|---|
| **Partitioning** | Consistent Hashing (SHA-256) | Deterministic key-to-region sharding with 128 virtual nodes |
| **Ordering** | Hybrid Logical Clock (HLC) | Monotonic causal ordering without NTP clock sync fragility |
| **Conflict Resolution** | PN-Counter / OR-Set / LWW | Conflict-free convergence for inventory counters and shopping carts |
| **Cache Stampede** | XFetch Algorithm | Probabilistic early cache renewal under heavy concurrency |
| **Replication** | Transactional Outbox + Micro-Batching | High-throughput atomic replication without distributed 2PC |
| **Resilience** | Circuit Breaker + AWS Full Jitter | Fast failure isolation, self-healing, and storm prevention |
| **Security** | Mutual HMAC-SHA256 + Nonces | Inter-region request signing, digest integrity, and anti-replay |
| **Observability** | CloudWatch EMF + Trace IDs | Zero-overhead structured logging and distributed tracing |
