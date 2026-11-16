# Active-Active GeoCache — Architecture Diagrams

## 1. Global Multi-Region Topology

```mermaid
flowchart TD
    subgraph Clients["Global Ingress Layer"]
        C1["Customer Asia (Mumbai)"]
        C2["Customer Europe (Frankfurt)"]
        C3["Customer Americas (Virginia)"]
    end

    subgraph Router["Global Routing & Ingress"]
        DNS["Route 53 Latency-Based Router"]
        GW["Global Control Gateway & Proxy (Port 3000)"]
        RING["128-Vnode Consistent Hash Ring (SHA-256)"]
        DNS --> GW
        GW --> RING
    end

    C1 --> DNS
    C2 --> DNS
    C3 --> DNS

    subgraph Mumbai["Mumbai Region (ap-south-1) - Port 5001"]
        direction TB
        M_API["Regional API & HLC Engine"]
        M_L1["L1 In-Memory Cache (XFetch Stampede Guard)"]
        M_L2[("L2 Regional Redis Cluster")]
        M_PG[("PostgreSQL Store")]
        M_OUT["Transactional Outbox Queue"]
        M_CB["Link Circuit Breakers"]

        M_API --> M_L1
        M_L1 --> M_L2
        M_L2 --> M_PG
        M_PG --> M_OUT
        M_OUT --> M_CB
    end

    subgraph Frankfurt["Frankfurt Region (eu-central-1) - Port 5002"]
        direction TB
        F_API["Regional API & HLC Engine"]
        F_L1["L1 In-Memory Cache (XFetch Stampede Guard)"]
        F_L2[("L2 Regional Redis Cluster")]
        F_PG[("PostgreSQL Store")]
        F_OUT["Transactional Outbox Queue"]
        F_CB["Link Circuit Breakers"]

        F_API --> F_L1
        F_L1 --> F_L2
        F_L2 --> F_PG
        F_PG --> F_OUT
        F_OUT --> F_CB
    end

    subgraph Virginia["Virginia Region (us-east-1) - Port 5003"]
        direction TB
        V_API["Regional API & HLC Engine"]
        V_L1["L1 In-Memory Cache (XFetch Stampede Guard)"]
        V_L2[("L2 Regional Redis Cluster")]
        V_PG[("PostgreSQL Store")]
        V_OUT["Transactional Outbox Queue"]
        V_CB["Link Circuit Breakers"]

        V_API --> V_L1
        V_L1 --> V_L2
        V_L2 --> V_PG
        V_PG --> V_OUT
        V_OUT --> V_CB
    end

    RING -. Preference Routing .-> M_API
    RING -. Preference Routing .-> F_API
    RING -. Preference Routing .-> V_API

    M_CB <== "Mutual HMAC-SHA256 Micro-Batch Mesh" ==> F_CB
    F_CB <== "Mutual HMAC-SHA256 Micro-Batch Mesh" ==> V_CB
    M_CB <== "Mutual HMAC-SHA256 Micro-Batch Mesh" ==> V_CB
```

---

## 2. Regional Node Internal Subsystems

```mermaid
flowchart LR
    subgraph Ingress["Client Request Ingress"]
        REQ["HTTP GET / PUT (x-trace-id)"]
    end

    subgraph AppNode["Regional Autonomous Node Engine"]
        direction TB
        HLC["Hybrid Logical Clock (l, c)"]
        AUTH["Security & Signature Validator"]
        CRDT["CRDT Conflict Resolver (PN-Counter / OR-Set / LWW)"]
    end

    subgraph CacheHierarchy["Multi-Tier Caching Pipeline"]
        L1["L1 In-Memory LRU (0.1ms)"]
        XF["XFetch Probabilistic Early Refresh"]
        L2[("L2 Redis Cluster (1.5ms)")]
    end

    subgraph Storage["Durable Relational Storage (PostgreSQL)"]
        REC[("records Table (JSONB + HLC)")]
        OUT[("replication_outbox (Partitioned Queue)")]
        DEDUP[("applied_events (Idempotency Filter)")]
        DLQ[("replication_dlq (Poison Pill Quarantine)")]
    end

    subgraph Worker["Outbox Replication Pipeline"]
        BATCH["Micro-Batch Draining Worker (200ms)"]
        CB["Circuit Breaker (CLOSED / OPEN / HALF_OPEN)"]
        JITTER["AWS Full Jitter Exponential Backoff"]
    end

    REQ --> AUTH
    AUTH --> HLC
    HLC --> L1
    L1 -. Hit .-> REQ
    L1 -. Miss or Near Expiry .-> XF
    XF --> L2
    L2 -. Miss .-> REC

    HLC --> REC
    REC -. Atomic TX .-> OUT
    OUT --> BATCH
    BATCH --> CB
    CB --> JITTER
    JITTER --> DLQ
```

---

## 3. Circuit Breaker & Chaos Partition State Machine

```mermaid
stateDiagram-v2
    [*] --> CLOSED : Node Boots Up

    CLOSED --> OPEN : 3 Consecutive Network Failures
    CLOSED --> OPEN : Manual Link Cut (Chaos Studio)

    note right of OPEN
        Outbox events buffer safely on PostgreSQL disk.
        Pending counter climbs (1 -> 5 -> 50...).
        Zero socket leaks; zero thread blocking.
    end note

    OPEN --> HALF_OPEN : Cool-off Window Expires (3000ms)
    OPEN --> CLOSED : Manual Link Heal (Chaos Studio)

    HALF_OPEN --> CLOSED : Probe Batch Succeeds (200 OK)
    HALF_OPEN --> OPEN : Probe Fails (Connection Timeout)

    note right of CLOSED
        Fast-Forward Micro-Batch Replay.
        Drains up to 2,000 events/sec.
        Pending outbox returns to 0!
    end note
```

---

## 4. End-to-End Write & Replication Data Flow

```mermaid
sequenceDiagram
    autonumber
    actor Customer as Shopper in Mumbai
    participant GW as Global Gateway (Virginia)
    participant M_Node as Mumbai Node (Port 5001)
    participant M_DB as Mumbai PostgreSQL
    participant M_Worker as Mumbai Outbox Worker
    participant F_Node as Frankfurt Node (Port 5002)
    participant F_DB as Frankfurt PostgreSQL

    Customer->>GW: PUT /api/records/cart:user-123
    GW->>M_Node: Proxy to Mumbai Shard (x-trace-id: 1-xxx)
    M_Node->>M_Node: Generate HLC Timestamp (l, c) & UUID EventId
    M_Node->>M_DB: BEGIN TRANSACTION
    M_Node->>M_DB: UPDATE records SET value = ... WHERE key = 'cart:user-123'
    M_Node->>M_DB: INSERT INTO replication_outbox (Dest: 'frankfurt', status: 'pending')
    M_Node->>M_DB: INSERT INTO replication_outbox (Dest: 'virginia', status: 'pending')
    M_Node->>M_DB: COMMIT TRANSACTION
    M_Node->>M_Node: Update L1 In-Memory & L2 Redis Cache
    M_Node-->>GW: 201 Created (Accepted Locally in <5ms!)
    GW-->>Customer: 201 Created (Fast Response, No Cross-WAN Wait)

    Note over M_Worker,F_Node: Asynchronous Background Micro-Batch Replication (Every 200ms)

    M_Worker->>M_DB: SELECT 50 pending events FOR UPDATE SKIP LOCKED
    M_DB-->>M_Worker: Batch payload of events
    M_Worker->>M_Worker: Sign Payload with HMAC-SHA256 + Body Digest + Nonce
    M_Worker->>F_Node: POST /internal/replicate-batch (Header: x-geocache-signature)
    F_Node->>F_Node: Verify HMAC Signature & Anti-Replay Nonce
    F_Node->>F_Node: Advance Frankfurt HLC with Remote Clock
    F_Node->>F_DB: BEGIN TRANSACTION
    F_Node->>F_DB: INSERT INTO applied_events (Deduplication Check)
    F_Node->>F_DB: Apply CRDT / HLC Conflict Resolution & Save Record
    F_Node->>F_DB: COMMIT TRANSACTION
    F_Node->>F_Node: Update Frankfurt L1 Memory & L2 Redis
    F_Node-->>M_Worker: 200 OK (accepted: 50, applied: 50, duplicates: 0)
    M_Worker->>M_DB: UPDATE replication_outbox SET status = 'delivered'
```
