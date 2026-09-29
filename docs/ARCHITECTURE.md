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
  store/                 Zustand store (the one network state)
tests/                   vitest engine tests + topology helpers
scripts/                 headless drivers (e2e-ping, e2e-commands)
docs/                    this documentation
```
