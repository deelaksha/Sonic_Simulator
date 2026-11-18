/**
 * ACL data plane (orchagent aclorch + the ASIC ACL stage), as a DataPlaneHook.
 *
 * Every frame entering (portIngress) or leaving (portEgress) a device is
 * checked against the ACL tables bound to the matching bind points
 * (ACL_TABLE ports@ + stage, xfmr_acl.go addPortBinding):
 *
 *   port         the physical port, or the PortChannel of a LAG member
 *   Vlan<N>      the VLAN the frame is classified into on a bridge port (covers
 *                bridged and SVI-routed traffic, which both enter on a port)
 *   Switch       global binding (xfmr_acl.go:68-76 ACL_GLOBAL_PORT)
 *
 * Each bound table is an independent lookup (SAI ACL groups are evaluated in
 * parallel): inside a table the lowest seq wins (PRIORITY = 65536 - seq), an
 * IP/IPv6 table drops anything of its family that no rule matched
 * (aclorch DEFAULT_DROP_ANY), and the frame is dropped if any table drops it.
 * Per-rule packet/byte counters are kept in the device's ACL state.
 *
 * Egress is evaluated once per frame: on the PortChannel (not again on the
 * member it hashes to) and on the physical bridge port (not on the SVI that
 * handed the frame to the bridge).
 */
import { registerDataPlaneHook, lagOf } from "../control/hooks";
import { Device, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { peekFeatureState } from "../models/feature-state";
import { SimContext } from "../engine/context";
import {
  AclState,
  AclTable,
  AclType,
  DEFAULT_DENY,
  counterKey,
  implicitDenyApplies,
  parseRule,
  ruleMatches,
  ruleName,
  tableSees,
} from "./acl-rules";

type Stage = "ingress" | "egress";

const isPortChannel = (i: NetInterface): boolean => /^PortChannel\d+$/.test(i.name);

/** VLAN a frame belongs to on a bridge port (null for routed / non-bridge ports). */
function vlanOf(device: Device, port: NetInterface, frame: Frame): number | null {
  if (!isSwitch(device.type) || port.ipv4.length > 0) return null;
  if (port.logical && !isPortChannel(port)) return null;
  if (port.vlan.mode === "access") return port.vlan.accessVlan;
  return frame.vlan?.vlanId ?? port.vlan.nativeVlan;
}

function bump(st: AclState, key: string, frame: Frame): void {
  const c = ((st.counters ??= {})[key] ??= { packets: 0, bytes: 0 });
  c.packets += 1;
  c.bytes += frame.meta.sizeBytes;
}

/** One table lookup: true = forward, false = drop, null = table did not apply. */
function lookup(st: AclState, t: AclTable, frame: Frame, vid: number | null): { permit: boolean; rule: string } | null {
  const type = (t.type ?? "ip") as AclType;
  if (!tableSees(type, frame)) return null;
  const rules = [...(st.rules[t.name] ?? [])].sort((a, b) => a.seq - b.seq);
  for (const r of rules) {
    let hit = false;
    try {
      hit = ruleMatches(parseRule(type, r.match), frame, vid);
    } catch {
      hit = false; // an unparsable rule is not programmed (aclorch rejects it)
    }
    if (!hit) continue;
    bump(st, counterKey(t.name, ruleName(r.seq)), frame);
    return { permit: r.action !== "deny", rule: `seq ${r.seq} ${r.action}` };
  }
  if (!implicitDenyApplies(type, frame)) return null;
  bump(st, counterKey(t.name, DEFAULT_DENY), frame);
  return { permit: false, rule: "implicit deny" };
}

function evaluate(ctx: SimContext, device: Device, iface: NetInterface, frame: Frame, stage: Stage): boolean {
  const st = peekFeatureState<AclState>(device, "acl");
  if (!st || iface.management || !st.tables.some((t) => t.ports.length > 0)) return true;
  let port = iface;
  const lag = lagOf(device, iface);
  if (lag === null) return true; // non-collecting member: the engine drops it anyway
  if (lag) {
    if (stage === "egress") return true; // already evaluated on the PortChannel
    port = lag;
  }
  if (iface.logical && !isPortChannel(iface)) return true; // SVI/loopback/sub-if: evaluated on the wire port
  const vid = vlanOf(device, port, frame);
  const points = new Set([port.name, "Switch"]);
  if (vid !== null) points.add(`Vlan${vid}`);

  let permit = true;
  for (const t of st.tables) {
    if ((t.stage ?? "ingress").toLowerCase() !== stage) continue;
    if (!t.ports.some((p) => points.has(p))) continue;
    const r = lookup(st, t, frame, vid);
    if (!r || r.permit) continue;
    permit = false;
    ctx.emit({
      type: "FRAME_DROPPED",
      deviceId: device.id,
      deviceName: device.name,
      interfaceId: iface.id,
      interfaceName: iface.name,
      message: `${device.name} ${port.name}: ${stage} ACL ${t.name} ${r.rule} — ${frame.meta.summary} denied`,
      osiLayers: t.type === "mac" ? [2] : [3, 4],
      frame,
    });
  }
  return permit;
}

registerDataPlaneHook({
  id: "acl",
  portIngress: (ctx, device, iface, frame) => evaluate(ctx, device, iface, frame, "ingress"),
  portEgress: (ctx, device, iface, frame) => evaluate(ctx, device, iface, frame, "egress"),
});
