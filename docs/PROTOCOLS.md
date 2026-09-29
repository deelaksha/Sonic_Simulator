# Protocols

Each protocol lives in `lib/protocols/*` as focused functions that operate through
`SimContext`. MVP-1 implements the L1–L3 + ICMP path required for the acceptance
flow.

| Module | Responsibility | Spec |
|--------|----------------|------|
| `ethernet.ts` | Frame building + wire sizes | §7 |
| `switch.ts` | MAC learning, flood/forward, 802.1Q classify/tag/untag | §7, §8 |
| `arp.ts` | Request/reply, cache, resolve-with-broadcast | §11 |
| `ipv4.ts` | IP output: route lookup → next-hop ARP → new frame → transmit | §9 |
| `icmp.ts` | Echo request/reply, error messages | §16 |
| `host.ts` | Host receive: accept local, never forward | §16 |
| `router.ts` | Forward: TTL--, re-ARP, NEW frame, Time Exceeded | §9, §10, §17 |

## Switching (real logical state)

- **Ingress classify** — access ports assign their access VLAN and reject tagged
  frames; trunk ports read the tag (must be allowed) or use the native VLAN.
- **Learn** — source MAC → ingress port, keyed by VLAN. Broadcast/multicast
  sources are never learned. A MAC that appears on a new port "moves".
- **Forward** — known unicast → single egress port; unknown unicast / broadcast /
  multicast → flood to all other ports in that VLAN.
- **Egress transform** — access ports send untagged; trunk ports tag unless the
  frame is on the native VLAN.

## Router (the key L3 lesson — spec §10)

On forwarding, the router **discards the incoming Ethernet frame**, decrements the
IP TTL, does a fresh route lookup + next-hop ARP, and **builds a brand-new
Ethernet frame** (new src/dst MAC) for the egress link. If TTL reaches zero it
returns ICMP Time Exceeded; if there's no route it returns Destination
Unreachable. Compare the ingress vs. egress frame in the inspector to see L2
change while L3 endpoints stay the same.

## Plugin API (spec §47)

`lib/engine/plugin.ts` defines `ProtocolEngine` — the shape these modules migrate
to as the protocol count grows (TCP, UDP, DNS, DHCP, NTP, NAT, HTTP, STP, LACP,
IPv6, OSPF, BGP...). MVP-1 keeps concrete modules for clarity while the set is
small; see ROADMAP for the migration plan.
