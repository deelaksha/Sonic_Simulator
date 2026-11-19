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
| `l3Ingress` via `runL3Ingress()` | `routerReceive`, after daemons, before local delivery/forwarding (replace / consume the frame) | NAT, FBS/PBR (`nat-daemon.ts`), PIM multicast forwarding |
| `hostIngress` | `hostReceive`, before the NIC filter | multicast receivers (`mcast-host.ts`) |
| `portIngress` / `allowEgress` (L2 features) | as above | SPAN/ERSPAN, storm control, DHCP snooping, IGMP snooping, EVPN ARP suppression |
| `toCpu` via `trapToCpu()` | link-local control frames; ARP / multicast / IP-to-me / TTL≤1 in `routerReceive` | CoPP (`lib/protocols/cpu-daemon.ts`: trap groups, CPU queues, policers) |

**VRF**: membership comes from the VRF config (`lib/models/vrf.ts`); every
route carries `vrf` and `longestPrefixMatch(table, dst, vrf = "default")`
only sees that VRF, so the default VRF is isolated automatically. Routers use
the ingress interface's VRF for local delivery and forwarding; ping takes
`-I <vrf>` / `vrf <name>`; static routes and `show ip route vrf <name>|all`
are per VRF.

**ECMP**: equal-best routes are picked per flow with `flowHash5` (src/dst IP,
protocol, ports) in `longestPrefixMatch(…, flowHash)`; one flow keeps one path.

## Visibility: CPU path, counters, logs, databases, QoS

- **Hardware vs VS data plane** — per switch (`features["dataplane-mode"]`, Device
  panel toggle). Frames forwarded in the ASIC carry `frame.meta.forwarded`;
  frames reaching the CPU mark their captures `trapped`. In hardware mode the
  store's tcpdump feed on front-panel ports shows only trapped rx and
  CPU-originated tx, like a real switch.
- **Drops** — every engine drop on a switch/router is classified to a SAI drop
  reason (`lib/control/drops.ts`) → `show dropcounters`, `show interfaces counters` DRP.
- **Counters** — `counters-daemon.ts` polls every 1 s (portstat rates);
  `macaging-daemon.ts` ages the FDB (`config mac aging_time`).
- **Syslog** — daemons call `logEvent()` (`lib/control/syslog.ts`); `show logging`,
  remote UDP/514 forwarding in `syslog-daemon.ts`.
- **SONiC DBs** — `lib/sonicdb/*` projects the model into CONFIG/APPL/STATE/ASIC/
  COUNTERS_DB for `sonic-db-cli` / `redis-cli` (read-only); `config save|reload|load`
  snapshot and restore (`persist.ts`: runtime keys are never saved).
- **QoS** — a flow-level model (`lib/protocols/qos-model.ts`) on top of the packet
  engine: iperf3 flows traced through the real path, DSCP→TC→queue, strict/DWRR,
  WRED/tail drop, PFC; feeds queue/PFC/port counters.
- **Protocol timeline** — control-tick events are kept in `controlEvents`
  (timeline "Protocol traffic" view).
- **Host TCP** — `lib/protocols/tcp-stack.ts` (listeners, handshake, data, FIN/RST)
  behind `nc`, `hping3`, `arping`, `mtr` (`lib/commands/nettools.ts`).

## Protocol depth (round 13)

| Area | Files | Lab |
|---|---|---|
| IPv6: radvd RA/SLAAC, OSPFv3, ICMPv6 errors, `ip -6` | `radv-*.ts`, `ospf6-*.ts`, `ipv6.ts` | `ipvx` |
| OSPFv2 multi-area, stub/NSSA, ranges, redistribution, VRF instances (`features["ospf:<vrf>"]`) | `ospf*.ts` | `ospf-areas` |
| BGP policy (prefix/community/as-path lists, route-maps), best path, multipath, IPv6 unicast, VRF instances | `bgp-policy.ts`, `bgp*.ts` | `bgp-policy` |
| EVPN symmetric IRB (L3VNI, type-5), SAG, ARP suppression, multihoming | `vxlan*.ts`, `evpn-*.ts`, `sag.ts` | `evpn-irb` |
| SPAN/ERSPAN, storm control, DHCP snooping, UDLD, errdisable, link tracking | `mirror.ts`, `storm-control.ts`, `dhcp-snooping.ts`, `udld-daemon.ts`, `errdisable.ts`, `link-track.ts` | `l2-protect` |
| IGMP (hosts + snooping), PIM-SM with RP/SPT | `mcast-*.ts`, `igmp-snooping.ts`, `pim-daemon.ts` | `multicast` |
| NAT/NAPT, FBS/PBR, IP SLA + tracked statics, load-share hash | `nat*.ts`, `pbr.ts`, `ipsla-daemon.ts`, `loadshare-hash.ts` | `l3-services` |

Routed multicast data is not trapped to the CPU (only 224.0.0.x and IGMP/PIM are);
IPv6 forwarding is per VRF (`longestPrefixMatch6(table, dst, vrf)`).

## Lab missions and troubleshooting labs

`lib/missions`: a `Mission` (`types.ts`) runs on a registered lab. Kind `mission`
= guided objectives that latch once met; kind `troubleshoot` = `inject(api)` breaks
the freshly loaded lab through a *silent* `LabApi` (nothing echoed), and the ticket
states only the symptom; solved when every objective holds at once. Objectives are
checked every second (`missionTick`, from `app/page.tsx`) through `CheckCtx`
(`check.ts`): ping / show-command probes run on a deep copy, so checking never
changes the learner's network. Each mission carries a reference `solution`
(shown on request) and an `explanation`. Content: one file per lab in
`lib/missions/content/`. UI: the inspector's Missions tab
(`components/inspector/MissionsPanel.tsx`); solved missions are kept per viewer
in browser storage. `tests/missions-all.test.ts` proves every mission starts
unsolved and is solved by its own solution.

## 3D hardware view

`components/switch3d/DeviceView.tsx` (double-click a switch, router, PC, server or the internet node, or
use the Device panel button) draws the device as a real box in CSS 3D from fixed
camera positions — no free rotation: the panel where its ports are, angled, and
inside (lid off). Over the canvas/inspector area; the terminal stays usable.
- `faces.tsx`: switch (1U faceplate: OLED, system LEDs, MGMT + console, two port
  rows), router (1U: console / AUX / USB, routed ports), PC (desktop rear I/O: PSU,
  USB, video, audio, NIC), server (1U rear: dual PSU, VGA, serial, BMC, NIC ports).
  The internet node is drawn as the ISP handoff (fiber ONT) with a cloud inside
  view describing what the simulator models (answers any routed address; DNS,
  NTP, HTTP).
  Link LEDs from oper state, activity blinks when frame counters change, cables to
  the real peers.
- `internals.tsx`: switch ports → ASIC — PCIe → CPU (traps); router ports → route
  processor (software forwarding); host ports → NIC — PCIe → CPU (OS stack).
- `panels.tsx`: port inspector (counters, rates, drops, VLAN/LAG/LLDP, last frames;
  shutdown via KLISH on switches, `ip link set` elsewhere; unplug) and the CPU /
  route processor / operating-system panel.
Data: `lib/switch3d/model.ts`.

**View realistic** (`components/switch3d/RealisticScene.tsx`, toggle at the top-left
of the canvas): the whole lab as hardware — network gear in a rack (ONT shelf,
routers, switches, rack servers), PCs on a desk (monitor + tower with NIC), and patch
cables drawn port-to-port from each connection (measured from the port elements on
screen). Dashed = link down; a dot runs along a cable in the direction a port's TX
counter moved. Clicking a device selects it (the Device panel opens the hardware
view). When a command runs (ping,
traceroute…), its FRAME_SENT events (`packetHops`, lib/switch3d/model.ts) are replayed
hop by hop: a labelled packet (ARP amber, request green, reply blue) travels along the
exact cable in the sent direction, the receiving device is outlined, a caption shows
the hop; speed 0.5–2× and Replay. The route so far stays lit: used cables carry
marching arrows in the direction(s) frames flowed and a step number (order of first
use), unused cables dim, and a Route card lists each frame type's path
(`routeSummary`; ARP shown as one-wire pairs since it is never forwarded). Playback state is shared (store `packetAnim`: hop index, speed, replay
counter) and advanced by one `PacketClock` mounted in the page, so Replay / speed in
any view drive every view in sync. The same player (`components/switch3d/packetPlayer.tsx`) drives
the topology canvas: its edges are `PacketEdge`s (components/topology) that carry
the packet along their own curve, and the receiving node glows. The hardware view uses it
too: on the panel a packet badge slides into / out of the exact port; inside, the
packet follows the device's real path — switch: port → ASIC → port for transit,
continuing over PCIe to the CPU only for frames to/from the switch itself
(`hopUsesCpu`); router: port → route processor; host: port → NIC → CPU; ONT:
port → SoC → fiber → cloud. The main area (topology,
realistic scene, hardware view) has a full-screen toggle (⤢ / Esc), like the terminal.

