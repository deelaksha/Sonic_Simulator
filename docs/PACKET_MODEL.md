# Packet Model

`lib/models/packet.ts`. A `Frame` is the one object that travels the wire. Each
network layer is an optional, typed sub-header:

```ts
interface Frame {
  id: string;
  ethernet: EthernetHeader;      // src/dst MAC + EtherType
  vlan?: Dot1QTag;               // 802.1Q (present only on tagged/trunk frames)
  arp?: ArpPayload;              // op, sender/target MAC+IP
  ipv4?: Ipv4Header;             // src/dst IP, TTL, protocol, id
  icmp?: IcmpPayload;            // echo-request/reply, time-exceeded, unreachable
  meta: { sizeBytes: number; summary: string };
}
```

TCP / UDP / DNS / DHCP / NTP / HTTP layers slot in the same way as those protocols
are added (see ROADMAP).

## One source of truth → derived inspector

The Wireshark-style inspector (spec §14) is **derived** from the typed frame via
`describeFrame(frame): InspectorLayer[]` — it is never stored separately. Each
`InspectorLayer` carries its OSI layer number so the UI can cross-highlight the
OSI panel (spec §31).

```
Frame ──describeFrame()──▶ [ {osiLayer:2, "Ethernet II", fields[...]},
                             {osiLayer:2, "802.1Q ...", ...},
                             {osiLayer:3, "IPv4 ...", ...},
                             {osiLayer:3, "ICMP ...", ...} ]
```

## Frame sizes

`lib/protocols/ethernet.ts` computes a realistic-ish wire size (14-byte header +
optional 4-byte 802.1Q tag + payload + 4-byte FCS, min 64). ICMP echo carries a
56-byte data payload → a 64-byte ICMP message, which is why `ping` prints
`64 bytes from ...` and `tcpdump` prints `length 64` — both derived, not literals.

## Immutability

Events snapshot frames with `cloneFrame` (deep copy) so the timeline is stable
even as switches tag/untag and routers re-frame copies downstream.
