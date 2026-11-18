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

## Control plane (running protocols)

ARP aging, LLDP, BFD, OSPF, BGP and SNMP run continuously as **daemons**
registered with `lib/control/daemon.ts`; the engine and store only talk to
that registry:

```
ControlDaemon
  nextDue(device, now)   earliest wall-clock ms work is due (timers, expiries)
  tick(ctx, device, now) send Hellos/keepalives/LLDPDUs, expire neighbours
  receiveL2(...)         link-local frames 01:80:C2:00:00:0X (never bridged)
  receiveL3(...)         IPv4 packets addressed to the device (incl. multicast)
  describe(frame)        tcpdump text
```

- The page calls `store.controlTick()` every 100 ms; the network is cloned and
  committed only when a daemon is due and something changed.
- Packets are real bytes (`lib/control/packet.ts`: checksummed IPv4/UDP/TCP,
  `Frame.rawL3`), so tcpdump, sFlow and the Scapy inspector decode them.
- Switch ports with an IPv4 address are routed ports; SVIs punt broadcast and
  multicast to the CPU. Routes carry FRR administrative distance and
  `show ip route` renders FRR 10.3 zebra output for every source
  (`lib/commands/sonic/frr-route.ts`).
- BFD serves OSPF/BGP through `lib/control/bfd-api.ts` (as bfdd serves ospfd/bgpd).
- Protocol modules: `lib/protocols/{arp,lldp,bfd,ospf,bgp,snmp}-daemon.ts` (+ `*-wire`,
  `*-show` helpers). Feature labs register in `lib/labs/` on the shared
  `routedTriangle` topology.

## Data-plane hooks and VRF

Features that change forwarding register a `DataPlaneHook`
(`lib/control/hooks.ts`) instead of editing the engine:

| Hook | Called from | Used by |
|---|---|---|
| `portIngress` / `portEgress` | `deliverToDevice` / `transmit` | ACL |
| `lagOf` / `egressMember` | ingress member → PortChannel; PortChannel → hashed member | LACP |
| `allowEgress` | bridge flooding/forwarding | MCLAG peer-link isolation |
| `flood` / `forwardVirtual` + `bridgeInput()` | VLAN flood / MAC entry on a virtual port / decap input | VXLAN (`vtep:<ip>` ports) |
| `isLocalMac` | SVI punt | VRRP virtual MAC |

**VRF**: membership comes from the VRF config (`lib/models/vrf.ts`); every
route carries `vrf` and `longestPrefixMatch(table, dst, vrf = "default")`
only sees that VRF, so the default VRF is isolated automatically. Routers use
the ingress interface's VRF for local delivery and forwarding; ping takes
`-I <vrf>` / `vrf <name>`; static routes and `show ip route vrf <name>|all`
are per VRF.
