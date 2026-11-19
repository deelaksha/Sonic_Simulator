/**
 * DHCPv4 snooping data plane on the config KLISH `ip dhcp snooping …`
 * (features/dhcp_snooping.ts, data/device-capture/klish-xml/dhcp_snooping.xml)
 * stores in "cp_dhcp_snooping": global enable, the snooping VLAN list, trusted
 * ports and `verify mac-address`.
 *
 * Snooping acts on a frame entering a switch port when it is enabled globally
 * AND on the frame's VLAN (dhcp_snooping.xml: "Enable DHCPv4 snooping
 * globally" / "on Vlan"):
 *   - DHCP server messages (OFFER / ACK / NAK, UDP source port 67) arriving on
 *     an UNTRUSTED port are dropped — a rogue server behind an access port can
 *     never answer a client;
 *   - an ACK arriving on a TRUSTED port creates a dynamic binding
 *     {client MAC, leased IP, VLAN, client port, lease} for a client learned
 *     behind an untrusted port (`show ip dhcp snooping binding`);
 *   - with `verify mac-address`, a client message on an untrusted port whose
 *     Ethernet source differs from the DHCP chaddr is dropped.
 * Drops go through the engine (reason DHCP_SNOOPING in lib/control/drops.ts)
 * and are counted per port.
 *
 * Dynamic ARP inspection is not part of this KLISH model (no `ip arp
 * inspection` in the captured XML), so ARP is not filtered.
 */
import { registerDataPlaneHook } from "../control/hooks";
import { cpGet, cpList } from "../commands/sonic-cli/config-plane";
import { Device, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { featureState, peekFeatureState } from "../models/feature-state";
import { normalizeMac } from "../models/mac";

export interface SnoopBinding {
  mac: string;
  ip: string;
  vlan: number;
  iface: string;
  /** Lease (s) granted by the server, and when it was learned (wall ms). */
  lease: number;
  learnedAt: number;
}

export interface SnoopState {
  bindings: SnoopBinding[];
  /** port → DHCP frames dropped there. */
  drops: Record<string, number>;
}

export function peekSnoopState(device: Device): SnoopState | undefined {
  return peekFeatureState<SnoopState>(device, "dhcp-snooping");
}

/** "Vlan10,20", "Vlan20,70-100,142", "Vlan 2" → VLAN ids. */
export function parseVlanList(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.replace(/vlan/gi, "").replace(/\s+/g, "").split(",")) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let v = a; v <= b && v <= 4094; v++) out.push(v);
  }
  return out;
}

function snoopingOn(device: Device, vid: number): boolean {
  if (!cpGet(device, "dhcp_snooping")?.v4_enabled) return false;
  return cpList(device, "dhcp_snooping", "v4_vlans").some((v) => parseVlanList(String(v.vlan)).includes(vid));
}

export const isTrusted = (device: Device, port: string) => cpList(device, "dhcp_snooping", "v4_trust").some((t) => t.iface === port);

/** Bindings still within their lease at `nowMs` (expired ones are removed). */
export function liveBindings(device: Device, nowMs: number): SnoopBinding[] {
  const st = peekSnoopState(device);
  if (!st) return [];
  st.bindings = st.bindings.filter((b) => nowMs < b.learnedAt + b.lease * 1000);
  return st.bindings;
}

const vlanOf = (iface: NetInterface, frame: Frame) =>
  frame.vlan?.vlanId ?? (iface.vlan.mode === "access" ? iface.vlan.accessVlan : iface.vlan.nativeVlan);

registerDataPlaneHook({
  id: "dhcp-snooping",
  portIngress(ctx, device, iface, frame) {
    if (!isSwitch(device.type) || !frame.udp || !device.config.features?.cp_dhcp_snooping) return true;
    const u = frame.udp;
    const fromServer = frame.dhcp ? ["offer", "ack", "nak"].includes(frame.dhcp.messageType) : u.srcPort === 67 && u.dstPort === 68;
    const fromClient = frame.dhcp ? !fromServer : u.srcPort === 68 && u.dstPort === 67;
    if (!fromServer && !fromClient) return true;
    const vid = vlanOf(iface, frame);
    if (iface.ipv4.length > 0 || !snoopingOn(device, vid)) return true;
    const trusted = isTrusted(device, iface.name);
    const st = featureState<SnoopState>(device, "dhcp-snooping", () => ({ bindings: [], drops: {} }));
    const drop = () => {
      st.drops[iface.name] = (st.drops[iface.name] ?? 0) + 1;
      return false;
    };

    if (fromServer) {
      if (!trusted) return drop();
      const d = frame.dhcp;
      if (d?.messageType === "ack" && d.yourIp) {
        const mac = normalizeMac(d.clientMac);
        const fdb = device.macTable.find((e) => normalizeMac(e.mac) === mac && e.vlan === vid);
        const port = fdb && device.interfaces.find((i) => i.id === fdb.interfaceId);
        if (port && !isTrusted(device, port.name)) {
          st.bindings = st.bindings.filter((b) => !(b.mac === mac && b.vlan === vid));
          st.bindings.push({ mac, ip: d.yourIp, vlan: vid, iface: port.name, lease: d.leaseSeconds ?? 86400, learnedAt: ctx.wallNow() });
        }
      }
      return true;
    }

    // Client message: source MAC verification on untrusted ports.
    if (!trusted && frame.dhcp && cpGet(device, "dhcp_snooping")?.v4_verify_mac && normalizeMac(frame.ethernet.srcMac) !== normalizeMac(frame.dhcp.clientMac)) {
      return drop();
    }
    return true;
  },
});
