# Networking Lab

An interactive, hands-on networking learning platform. Instead of reading theory,
you **build a network, configure devices, generate traffic, watch real simulated
packets move layer by layer, inspect every header, run Linux commands, break
things, and figure out why they failed.**

Built with Next.js (App Router) + TypeScript + React + Tailwind + React Flow +
Zustand. The networking behavior is a real, decoupled simulation engine — **nothing
is hardcoded** (`ping` output, `tcpdump`, `ip route`, `ip neigh`, the MAC table,
ARP cache — all derived from the same simulated packet journey and state).

## What works today (MVP-1, spec §55 + router/traceroute)

The core learning loop is complete end-to-end:

```
BUILD → CONFIGURE → GENERATE TRAFFIC → WATCH PACKETS → INSPECT → RUN COMMANDS →
UNDERSTAND WHY → MODIFY → EXPERIMENT AGAIN
```

- **Topology builder** — drag PC / Switch / Router / Server / Internet onto the
  canvas, connect ports by dragging between the colored dots, move/rename/delete.
- **Real L2 switch** — source MAC learning per VLAN, known-unicast forwarding,
  unknown-unicast/broadcast flooding, 802.1Q classify/tag/untag on the wire.
- **Real ARP** — request/reply/cache, INCOMPLETE on failure.
- **Real IPv4 + ICMP** — routing with longest-prefix match, ping with timing
  derived from the journey, and a router that discards the old frame, decrements
  TTL, and builds a **new** Ethernet frame for the next hop (spec §10).
- **Router + traceroute** — TTL expiry produces ICMP Time Exceeded; traceroute
  discovers each hop.
- **Linux terminal** — `ping`, `traceroute`, `ip addr|link|route|neigh` (show +
  `add`/`del`/`set`), `arp`, `tcpdump` (with filters), `ifconfig`, `route`,
  `hostname`, `help`, `clear`. Parsed, not string-matched. Only registered
  commands can run (spec §44).
- **Packet timeline + player** — ▶ / ⏸ / ⏭ / ⏮, click any event to inspect it.
- **Wireshark-style inspector** — expandable Ethernet / 802.1Q / ARP / IPv4 /
  ICMP layers with an OSI highlight panel.
- **Single source of truth** — the canvas, terminal, inspector, and tables all
  read/write ONE network state. Change an IP in the GUI and `ip addr` reflects it.
- **Save / load** — export and import a lab as JSON.

## Quick start

```bash
cd /home/sonic-claude2/deelaksha/Neworking
npm install          # already done in this workspace
npm run dev          # http://localhost:3000
```

Then in the app:

1. Click **Load sample lab** (PC1 — SW1 — PC2, pre-addressed).
2. Click **PC1**, focus the terminal, run `ping 192.168.1.20`.
3. Press **▶ Play** on the packet timeline and watch ARP → Ethernet → MAC
   learning → switch forwarding → ICMP echo → reply.
4. Click any timeline event to inspect the frame layer by layer.
5. Try `ip neigh`, `ip route`, `tcpdump -i eth0 icmp`, then break something
   (wrong IP, `ip link set eth0 down`) and diagnose it.

## Scripts

```bash
npm run dev         # dev server
npm run build       # production build
npm run typecheck   # tsc --noEmit
npm test            # vitest engine tests (MAC learning, ARP, routing, ICMP, VLAN)
npm run sim         # headless PC1—SW1—PC2 ping driver (see the full event stream)
npx tsx scripts/e2e-commands.ts   # headless terminal-command driver
```

## Documentation

| File | What |
|------|------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers, data flow, folder map |
| [SIMULATION_ENGINE.md](docs/SIMULATION_ENGINE.md) | How frames actually move |
| [PACKET_MODEL.md](docs/PACKET_MODEL.md) | The layered `Frame` + inspector |
| [PROTOCOLS.md](docs/PROTOCOLS.md) | Ethernet / ARP / IPv4 / ICMP + plugin API |
| [COMMANDS.md](docs/COMMANDS.md) | Terminal command reference |
| [SECURITY.md](docs/SECURITY.md) | Why this is safe for public users |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md) | Working on the code |
| [ROADMAP.md](docs/ROADMAP.md) | What's next (VLAN UI, DHCP, DNS, TCP, …) |

All project files live strictly under `/home/sonic-claude2/deelaksha/Neworking/`.
