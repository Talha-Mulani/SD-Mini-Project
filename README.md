# GeoCache Mini Project

## Project idea

This is a low-cost implementation of the GeoCache virtual lab. It runs one
gateway and three independent cache-node services on one computer. The nodes
represent Mumbai, Frankfurt, and Virginia, but they are local processes or
containers—not paid cloud regions.

The project demonstrates:

- Consistent hashing with 32 virtual nodes per cache node.
- Primary and replica placement.
- HTTP-based asynchronous replication.
- Node health and cache hit/miss metrics.
- Simulated network partitions and queued replication.
- Live PN-Counter conflict-free merging versus a naive counter.
- A browser dashboard for repeatable experiments.

## Run with Docker Compose

From this folder:

```bash
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000).

Stop it with:

```bash
docker compose down
```

## Run without Docker

Install dependencies:

```bash
npm install
```

Open four terminals in this folder:

```bash
NODE_ID=node-a REGION=Mumbai PORT=5001 PEERS=node-b=http://localhost:5002,node-c=http://localhost:5003 node cache-node/server.js
NODE_ID=node-b REGION=Frankfurt PORT=5002 PEERS=node-a=http://localhost:5001,node-c=http://localhost:5003 node cache-node/server.js
NODE_ID=node-c REGION=Virginia PORT=5003 PEERS=node-a=http://localhost:5001,node-b=http://localhost:5002 node cache-node/server.js
node gateway/server.js
```

Then open [http://localhost:3000](http://localhost:3000).

## Demonstration script

1. Click **Explain key placement** and record the primary and replica order.
2. Enter `user:42` and `active`, then click **SET key**. Explain local
   acknowledgement and asynchronous HTTP replication.
3. Click **GET key** and show a cache hit.
4. Cut a link, SET another key, and show that the cluster remains writable
   while the target node's queue grows.
5. Heal the link and click **Replay queued**. Explain eventual convergence.
6. Run the CRDT comparison and show why the live backend PN-Counter returns
   `3` while the naive counter would return `1`.
7. Use **Reset view** before repeating the demo, then capture the dashboard and
   metrics for the report.

## What to measure

| Experiment | Measurement |
|---|---|
| Add/remove node | Which primary/replica assignments change |
| Normal SET | Primary response and replica receipt counts |
| Partitioned SET | Queued messages and successful local writes |
| Recovery | Queue size before and after replay |
| CRDT comparison | Preserved updates versus lost updates |

## Showcase structure

Use a five-minute presentation:

1. **Problem (45 sec):** one cache node creates hotspots and a regional failure
   can make data unavailable.
2. **Architecture (60 sec):** gateway, hash ring, three cache nodes, and
   asynchronous replication.
3. **Live experiment (2 min):** SET/GET, cut a link, write during the
   partition, heal, and replay.
4. **CRDT result (45 sec):** compare the naive counter with PN-Counter.
5. **Results and limitations (30 sec):** local containers model regions; a
   production version would add persistence, authentication, monitoring, and
   real network latency.

## Project boundary

This is deliberately not a production Redis replacement. It uses in-memory
storage so the algorithms and failure behaviour remain visible and easy to
evaluate. Redis, persistent storage, WebSockets, metrics exporters, and cloud
deployment are optional future extensions.
