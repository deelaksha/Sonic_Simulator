# Roadmap

## Done — MVP-1 (spec §55) + bonus L3

- Topology builder (drag/connect/rename/delete/save/load)
- Real L2 switch: MAC learning, flood/forward, 802.1Q forwarding plane
- ARP, IPv4, ICMP, longest-prefix routing
- Linux terminal: ping, traceroute, ip (addr/link/route/neigh, incl. writes),
  arp, tcpdump, ifconfig, route, hostname, help, clear
- Router forwarding (TTL, new frame, Time Exceeded) + traceroute — brings in most
  of spec §56 (MVP-2) at the engine level
- Packet timeline + player, Wireshark-style inspector, OSI panel
- **Interactive event inspection**: clicking a timeline event shows engine-computed
  structured detail — MAC-table lookup (learn/forward/flood as real tables),
  routing lookup (routing table with longest-prefix highlight + decision), ARP
  lookup (cache hit/miss + resolution), packet encapsulation view, protocol-unit
  terminology (Frame/Packet/Segment/Datagram/Message), and a raw/details view
- Single source of truth across UI/terminal/engine
- Engine unit tests

## Next — MVP-2 finish (spec §56)

- Multi-segment UI scenario PC1—SW1—R1—SW2—PC2 as a guided lab
- `ss` / `netstat` once sockets exist
- Per-hop before/after frame diff visualization in the inspector (§10 has the data)

## Then — MVP-3 (spec §57) and beyond

- **VLAN control plane + UI** (§8, §24): VLAN database, access/trunk config panel,
  router-on-a-stick. The forwarding plane already classifies/tags/untags.
- **DHCP** (§22): DORA, UDP 67/68.
- **DNS** (§21): query/response, NXDOMAIN, name resolution in `ping`/`curl`.
- **TCP** (§27): handshake, data, teardown, sockets → `ss`.
- **UDP** (§28), **NTP** (§23), **NAT** (§30), **HTTP** (§29, `curl`).
- **STP** (§25), **LACP/PortChannel** (§26), **IPv6**, OSPF/BGP/ACL/VRF/LLDP/SNMP.

## Architecture migration

Move the concrete protocol modules behind the `ProtocolEngine` plugin registry
(`lib/engine/plugin.ts`) once ~3+ L4/L7 protocols exist, so protocols register
independently instead of being wired into device-receive dispatch. Kept concrete
for MVP-1 deliberately (simplicity while the set is small).

## Learning-experience features (spec §38–§40, §48–§50)

- Protocol Labs selector that pre-builds a topology + objectives per protocol
- Learn / Experiment / Challenge modes; challenge validators
- Troubleshooting scenarios with injected faults
- Learning dashboard / progress

## Optional advanced (spec §43)

- "Real Linux Lab Mode" via network namespaces + veth, sandboxed in a
  container/VM only. Not for public/default use.
