/**
 * ARP control-plane daemon: the time-driven half of the Linux neighbour table
 * (net/core/neighbour.c neigh_periodic_work / neigh_timer_handler) plus
 * gratuitous ARP. Runs on every device with an IP stack.
 *
 *   REACHABLE → STALE  after reachable_time. Linux picks a random value in
 *       [base/2, 3·base/2]; we use exactly base_reachable_time:
 *         SONiC front-panel / SVI: 1800 s  (files/image_config/sysctl/sysctl-net.conf:46
 *           net.ipv4.neigh.default.base_reachable_time_ms=1800000)
 *         per interface `ip arp timeout <25-65535>` overrides it
 *           (sonic-swss cfgmgr/intfmgr.cpp:678-712 writes base_reachable_time_ms)
 *         SONiC eth0 and all hosts/routers: Linux default 30 s (eth0 exists before
 *           sysctl-net.conf is applied, so neigh/default does not reach it — the same
 *           reason sysctl-net.conf:15-18 states eth0's arp_ignore explicitly).
 *   STALE (unused) → removed after gc_stale_time = 60 s. Simplification: Linux only
 *       garbage-collects once the table holds gc_thresh1 entries (1024 on SONiC,
 *       sysctl-net.conf:48); we always collect so aging is observable in a lab.
 *   INCOMPLETE → removed after gc_stale_time too (FAILED entries are gc'd).
 *   STALE in use → DELAY → unicast probe 5 s later, up to 3 probes 1 s apart,
 *       then the entry is deleted (FAILED). See ./arp.ts resolveArp.
 *   Carrier/admin down → the interface's dynamic entries are flushed
 *       (neigh_carrier_down / neigh_ifdown), IPv6 neighbours (ndpTable) included.
 *   Gratuitous ARP (request, sender IP = target IP, broadcast) when an L3
 *       interface comes up — SONiC sets net.ipv4.conf.all.arp_notify=1
 *       (sysctl-net.conf:24; devinet.c NETDEV_UP → inetdev_send_gratuitous_arp) —
 *       and when an address is added to an up interface (simulator choice, like
 *       `arping -U` from ifupdown/NetworkManager). The state present when the
 *       daemon first sees a device is its boot baseline: no GARP for it.
 */
import { registerDaemon } from "../control/daemon";
import { Device, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { SimContext } from "../engine/context";
import { sviVlanId } from "./switch";
import { arpRuntime, peekArpRuntime, buildArpRequest, sendArpProbe, deleteArp, RETRANS_MS, UCAST_PROBES } from "./arp";

export const SONIC_BASE_REACHABLE_S = 1800; // sysctl-net.conf:46
export const LINUX_BASE_REACHABLE_S = 30;
export const GC_STALE_MS = 60_000;

/** base_reachable_time (ms) of the interface an entry lives on. */
export function reachableMs(device: Device, iface: NetInterface | undefined): number {
  const custom = iface ? peekArpRuntime(device)?.timeouts?.[iface.name] : undefined;
  if (custom) return custom * 1000;
  if (isSwitch(device.type) && iface && !iface.management) return SONIC_BASE_REACHABLE_S * 1000;
  return LINUX_BASE_REACHABLE_S * 1000;
}

const isUp = (i: NetInterface) => i.adminState === "up" && i.operState === "up";

/** "up|mac|addr,addr" — what the daemon compares to notice link-up, MAC changes, or new addresses. */
function ifaceSig(i: NetInterface): string {
  return `${isUp(i) ? 1 : 0}|${i.mac.toUpperCase()}|${i.ipv4.map((a) => a.address).join(",")}`;
}

/** Interfaces that can carry ARP: physical/mgmt ports and switch SVIs. */
function arpInterfaces(device: Device): NetInterface[] {
  return device.interfaces.filter((i) => !i.logical || (isSwitch(device.type) && sviVlanId(i) !== null));
}

function dueTimes(device: Device, now: number): number | undefined {
  const rt = peekArpRuntime(device);
  if (!rt?.nb || !rt.ifs) return now;
  for (const i of arpInterfaces(device)) if (rt.ifs[i.id] !== ifaceSig(i)) return now;
  let due: number | undefined;
  const at = (t: number) => {
    if (due === undefined || t < due) due = t;
  };
  for (const e of device.arpTable) {
    const t = rt.nb[e.ip];
    if (!t) return now;
    if (t.perm) continue;
    if (t.probeAt !== undefined) at(t.probeAt);
    else if (e.state === "reachable") at(t.t + reachableMs(device, device.interfaces.find((i) => i.id === e.interfaceId)));
    else at(Math.max(t.t, t.used ?? 0) + GC_STALE_MS);
  }
  return due;
}

function gratuitous(ctx: SimContext, device: Device, iface: NetInterface, ip: string): void {
  ctx.emit({
    type: "ARP_REQUEST",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: iface.id,
    interfaceName: iface.name,
    message: `${device.name}: gratuitous ARP ${ip} is-at ${iface.mac}`,
    osiLayers: [2],
  });
  ctx.transmit(device.id, iface.id, buildArpRequest(iface.mac, ip, ip));
}

registerDaemon({
  id: "arp",

  nextDue(device, now) {
    if (device.state === "down") return undefined;
    return dueTimes(device, now);
  },

  tick(ctx, device, now) {
    const first = !peekArpRuntime(device)?.ifs;
    const rt = arpRuntime(device);

    // --- interface events: carrier flush + gratuitous ARP ---
    for (const i of arpInterfaces(device)) {
      const sig = ifaceSig(i);
      const prev = rt.ifs[i.id];
      if (prev === sig) continue;
      rt.ifs[i.id] = sig;
      if (first) continue; // boot baseline
      const [wasUp, prevMac = "", prevAddrs = ""] = (prev ?? "0||").split("|");
      if (!isUp(i)) {
        for (const e of device.arpTable.filter((x) => x.interfaceId === i.id && !rt.nb[x.ip]?.perm)) deleteArp(device, e.ip);
        // neigh_carrier_down / neigh_ifdown flush the IPv6 neighbour table (nd_tbl) too.
        if (device.ndpTable?.some((x) => x.interfaceId === i.id)) device.ndpTable = device.ndpTable.filter((x) => x.interfaceId !== i.id);
        continue;
      }
      const macChanged = prevMac && prevMac !== i.mac.toUpperCase();
      const old = wasUp === "1" ? prevAddrs.split(",") : [];
      for (const a of i.ipv4) {
        if (macChanged || !old.includes(a.address)) gratuitous(ctx, device, i, a.address);
      }
    }

    // --- per-entry timers ---
    for (const e of [...device.arpTable]) {
      const t = (rt.nb[e.ip] ??= { t: now });
      if (t.perm) continue;
      if (t.probeAt !== undefined) {
        if (now < t.probeAt) continue;
        if (e.state === "reachable") {
          delete t.probeAt;
          delete t.probes;
          continue;
        }
        if ((t.probes ?? 0) >= UCAST_PROBES || !sendArpProbe(ctx, device, e)) {
          deleteArp(device, e.ip); // FAILED
          continue;
        }
        t.probes = (t.probes ?? 0) + 1;
        const after = device.arpTable.find((x) => x.ip === e.ip);
        if (after?.state === "reachable") {
          delete rt.nb[e.ip].probeAt;
          delete rt.nb[e.ip].probes;
        } else t.probeAt = now + RETRANS_MS;
        continue;
      }
      if (e.state === "reachable") {
        if (now >= t.t + reachableMs(device, device.interfaces.find((i) => i.id === e.interfaceId))) {
          e.state = "stale";
          t.t = now;
        }
      } else if (now >= Math.max(t.t, t.used ?? 0) + GC_STALE_MS) {
        deleteArp(device, e.ip);
      }
    }
    // Timers of entries removed by commands (`config arp clear`, `ip neigh flush`).
    for (const ip of Object.keys(rt.nb)) if (!device.arpTable.some((e) => e.ip === ip)) delete rt.nb[ip];
    return true;
  },
});
