# Architecture

The golden rule (spec §61): **one network state**, consumed by everything.

```
        ┌──────────────────────────────────────────────┐
        │                    UI (React)                  │
        │  Toolbox · Canvas · Inspector · Terminal ·     │
        │           Packet Timeline                      │
        └───────────────┬────────────────────────────────┘
                        │  read + dispatch actions
                        ▼
        ┌──────────────────────────────────────────────┐
        │        Zustand store  (lib/store)              │
        │        THE single source of truth             │
        │   network: { devices, connections }           │
        │   events · captures · terminals · playback     │
        └───────────────┬────────────────────────────────┘
             ┌──────────┴───────────┐
             ▼                      ▼
   ┌──────────────────┐   ┌──────────────────────┐
   │ Command layer    │   │ Simulation engine     │
   │ (lib/commands)   │──▶│ (lib/engine)          │
   │ parse → registry │   │ Simulation orchestr.  │
   └──────────────────┘   └───────────┬───────────┘
                                       ▼
                          ┌──────────────────────────┐
                          │ Protocol modules          │
                          │ (lib/protocols)           │
                          │ ethernet arp ipv4 icmp    │
                          │ switch host router        │
                          └───────────┬───────────────┘
                                      ▼
                          ┌──────────────────────────┐
                          │ Models (lib/models)       │
                          │ device interface packet   │
                          │ route vlan topology ip mac│
                          └──────────────────────────┘
```

The simulation engine has **no React dependency** and can be run headless
(`npm run sim`). The UI is one consumer; the terminal is another; tests are a
third. They all operate on the same `NetworkState`.

## Data flow of a ping

1. User types `ping 192.168.1.20` in the Terminal → `store.runCommand`.
2. The store clones the network into a working draft and builds a `CommandContext`.
3. `execute()` resolves the `ping` handler from the **allowed-command registry**.
4. The handler calls `ctx.runSim(sim => sim.runPing(...))`.
5. `Simulation` walks frames hop-by-hop through the protocol modules, mutating
   the draft (ARP/MAC learning, stats) and emitting `SimEvent`s + captures.
6. The handler formats output from the returned `PingSummary`.
7. The store commits the draft as the new `network`, stores the events (timeline)
   and captures (for tcpdump), and appends terminal lines.
8. Canvas, inspector, tables, and timeline re-render from the new state.

## Folder map

```
app/                     Next.js App Router (layout, page, globals.css)
components/
  topology/              React Flow canvas + custom device node + icons
  toolbox/               device palette + lab lifecycle
  terminal/              Linux terminal
  timeline/              packet timeline + player
  inspector/             device config · packet inspector · OSI panel
lib/
  models/                pure types + helpers (single source of shapes)
  engine/                Simulation orchestrator, events, context, ids, plugin
  protocols/             ethernet · arp · ipv4 · icmp · switch · host · router
  commands/              parser · registry · ping · ip · arp · tcpdump · ...
  packetgen/             PacketEngine interface + Scapy (Pyodide Web Worker)
  sflow/                 sFlow agent / datagram codec / collector
  store/                 Zustand store (the one network state)
tests/                   vitest engine tests + topology helpers
scripts/                 headless drivers (e2e-ping, e2e-commands)
docs/                    this documentation
```

## Packet engine (multi-protocol traffic)

Traffic generation for arbitrary protocols is delegated to an existing packet
library instead of per-protocol simulator code. The seam is
`lib/packetgen/engine.ts`:

```
PacketEngine
  protocols()        → every layer the library knows (drives the layer picker)
  describe(proto)    → field names / types / defaults / enums (drives the field editor)
  build(layers)      → wire bytes + decode
  dissect(bytes)     → layer tree (packet inspector)
```

The implementation is **Scapy running in Pyodide** inside a Web Worker
(`lib/packetgen/scapy.worker.ts`, Python side in `scapy-source.ts`). Assets are
vendored into `public/packet-engine/` by `scripts/vendor-packet-engine.mjs`
(pinned, sha256-checked) and loaded on first use.

Engine bytes enter the simulator through `lib/packetgen/frame.ts`: the L2–L4
headers the forwarding engine acts on are parsed into the typed `Frame`, and
everything after the L2 header travels verbatim in `Frame.rawL3`. Switching,
routing (TTL/hop-limit re-applied, IPv4 checksum recomputed), sFlow sampling,
tcpdump and the inspector all work on those bytes. The engine crafts and
decodes packets; it does not run protocol state machines (a crafted DNS query
reaches the server but is not answered unless the simulator models that service).

To support another protocol: nothing in the simulator changes — the layer is
already in the engine's catalogue. To swap engines: implement `Transport` /
`PacketEngine` for the new library.
