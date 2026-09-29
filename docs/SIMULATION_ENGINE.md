# Simulation Engine

`lib/engine/simulation.ts` — the `Simulation` class. It owns:

- a **simulated clock** (advances per hop; RTT is measured from it),
- an **event log** (`SimEvent[]` — the timeline),
- **capture buffers** (what `tcpdump` reads),
- the **frame-delivery loop**.

It implements `SimContext` (`lib/engine/context.ts`), the seam the protocol
modules use. Protocol modules depend only on that interface — never on the
concrete class — which keeps them decoupled and mirrors the future
`ProtocolEngine` plugin API (spec §47).

## The delivery loop (nothing is faked)

```
transmit(device, iface, frame)
  ├─ egress checks (admin/oper/link state) → drop with an explained event
  ├─ tx stats + capture(tx)
  ├─ emit FRAME_SENT (carries the link, for canvas animation)
  ├─ advance clock by link latency
  └─ deliverToDevice(peer)
        ├─ ingress checks → capture(rx) → emit FRAME_RECEIVED
        └─ dispatch by device type:
              switch → switchForward()   (learn + flood/forward)
              router → routerReceive()   (TTL--, re-ARP, NEW frame)
              host   → hostReceive()     (ARP / local ICMP / drop)
```

Delivery is recursive and synchronous: sending an ARP request drives the whole
flood → reply → learn chain to completion, so by the time `transmit()` returns
the ARP cache is populated. A step counter (`MAX_STEPS`) guards against loops
(important once STP/redundant links arrive).

## `runPing` (spec §16, §60)

For each probe:

1. Route lookup (longest-prefix match) to pick the egress interface + source IP.
2. `ipOutput()` — emits `ROUTE_LOOKUP`/`ROUTE_MATCH`, resolves next-hop ARP
   (sending a real request on a cache miss), builds the Ethernet frame, transmits.
3. The destination host auto-generates an echo reply via the same IP output path.
4. When the reply is delivered back to the origin, it's recorded; RTT = clock delta.

The **first probe pays the ARP cost** (slower); later probes hit the cache — a
real, observable behavior, not a cosmetic delay.

## `runTraceroute` (spec §17)

Sends probes with increasing TTL. Each router that decrements TTL to zero returns
ICMP Time Exceeded (sourced from its ingress interface). Traceroute reads those —
and the final echo reply from the destination — to build the hop list.

## Events (`lib/engine/events.ts`)

Every decision emits a typed `SimEvent` with a timestamp, the device/interface,
an OSI-layer set, a human-readable message, and (where relevant) an immutable
frame snapshot and the link it traversed. The timeline, canvas highlighting,
inspector, and tcpdump are all **views over this one stream**.
