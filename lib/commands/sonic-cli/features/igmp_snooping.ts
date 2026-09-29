/**
 * IGMP snooping — CONFIG-PLANE feature (no engine/packet backend; store + show).
 *
 * Real KLISH (data/device-capture/klish-xml/igmp_snooping.xml), per-VLAN in the
 * VLAN interface view (configure-vlan-view, entered via `interface Vlan <id>`):
 *
 *   sonic(conf-if-Vlan200)# ip igmp snooping                          enable on vlan
 *   sonic(conf-if-Vlan200)# ip igmp snooping querier                 enable querier
 *   sonic(conf-if-Vlan200)# ip igmp snooping fast-leave              enable fast-leave
 *   sonic(conf-if-Vlan200)# ip igmp snooping query-interval 20       1..18000  (def 125)
 *   sonic(conf-if-Vlan200)# ip igmp snooping last-member-query-interval 2000  100..25500 (def 1000)
 *   sonic(conf-if-Vlan200)# ip igmp snooping query-max-response-time 12   1..25 (def 10)
 *   sonic(conf-if-Vlan200)# ip igmp snooping version 3               1..3   (def 2)
 *   sonic(conf-if-Vlan200)# ip igmp snooping mrouter interface Ethernet4
 *   sonic(conf-if-Vlan200)# ip igmp snooping static-group 225.0.0.1 interface PortChannel2
 *   ... each with a `no ...` form (scalars reset to default; enables/lists cleared).
 *
 *   sonic# show ip igmp snooping [[vlan] <id>]          render per-vlan config
 *   sonic# show ip igmp snooping groups [[vlan] <id>]   render static groups
 *
 * We store exactly what CONFIG_DB would hold (CFG_L2MC_TABLE / mrouter / static
 * member) and render it back. dataPlaneNotSimulated: IGMP snooping actually
 * snoops IGMP report/leave packets to build a dynamic multicast forwarding
 * table; the sim has no data plane, so dynamically-learned groups are never
 * fabricated — only configured values are reflected.
 */
import { line, err, muted, OutputLine } from "../../types";
import type { Device } from "../../../models/device";
import { registerModal } from "../registry";
import { cpList, cpUpsert, cpRemove } from "../config-plane";

const ID = "igmp_snooping";

type StaticGroup = { group: string; intf: string };
type VlanRec = {
  vlan: string;
  querier?: boolean;
  fastLeave?: boolean;
  queryInterval?: number;
  lastMemberQueryInterval?: number;
  maxResponseTime?: number;
  version?: number;
  mrouters?: string[];
  staticGroups?: StaticGroup[];
};

function readVlan(device: Device, vlan: string): VlanRec | undefined {
  return cpList(device, ID, "vlans").find((v) => v.vlan === vlan) as VlanRec | undefined;
}
function writeVlan(device: Device, rec: VlanRec): void {
  cpRemove(device, ID, "vlans", "vlan", rec.vlan); // full replace so `no` can drop keys
  cpUpsert(device, ID, "vlans", rec as Record<string, unknown>, "vlan");
}
function num(v: string | undefined, min: number, max: number): number | null {
  if (v === undefined || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n < min || n > max ? null : n;
}

// configure-vlan-view: `ip igmp snooping ...` on the current Vlan interface.
registerModal({
  id: "igmp_snooping",
  views: ["configure-vlan-view"],
  keywords: ["ip"],
  run({ isNo, args, ctx, ifname }) {
    if (args[0]?.toLowerCase() !== "igmp" || args[1]?.toLowerCase() !== "snooping") return null; // not ours
    const vlan = ifname;
    if (!vlan) return { output: [err("% ip igmp snooping requires a VLAN interface context.")] };
    const opt = args[2]?.toLowerCase();

    // Base: `ip igmp snooping` (enable) / `no ip igmp snooping` (disable on vlan).
    if (!opt) {
      if (isNo) cpRemove(ctx.device, ID, "vlans", "vlan", vlan);
      else if (!readVlan(ctx.device, vlan)) writeVlan(ctx.device, { vlan });
      return { output: [] };
    }

    const rec: VlanRec = readVlan(ctx.device, vlan) ?? { vlan };

    switch (opt) {
      case "querier":
        if (isNo) delete rec.querier;
        else rec.querier = true;
        break;
      case "fast-leave":
        if (isNo) delete rec.fastLeave;
        else rec.fastLeave = true;
        break;
      case "query-interval":
        if (isNo) delete rec.queryInterval;
        else {
          const n = num(args[3], 1, 18000);
          if (n === null) return { output: [err("% query-interval must be an integer in 1..18000 (seconds).")] };
          rec.queryInterval = n;
        }
        break;
      case "last-member-query-interval":
        if (isNo) delete rec.lastMemberQueryInterval;
        else {
          const n = num(args[3], 100, 25500);
          if (n === null) return { output: [err("% last-member-query-interval must be an integer in 100..25500 (ms).")] };
          rec.lastMemberQueryInterval = n;
        }
        break;
      case "query-max-response-time":
        if (isNo) delete rec.maxResponseTime;
        else {
          const n = num(args[3], 1, 25);
          if (n === null) return { output: [err("% query-max-response-time must be an integer in 1..25 (seconds).")] };
          rec.maxResponseTime = n;
        }
        break;
      case "version":
        if (isNo) delete rec.version;
        else {
          const n = num(args[3], 1, 3);
          if (n === null) return { output: [err("% version must be 1, 2 or 3.")] };
          rec.version = n;
        }
        break;
      case "mrouter": {
        if (args[3]?.toLowerCase() !== "interface" || !args[4]) return { output: [err("% usage: ip igmp snooping mrouter interface <name>")] };
        const intf = args[4];
        const list = (rec.mrouters ?? []).filter((m) => m !== intf);
        if (!isNo) list.push(intf);
        rec.mrouters = list;
        break;
      }
      case "static-group": {
        const group = args[3];
        if (!group || args[4]?.toLowerCase() !== "interface" || !args[5]) {
          return { output: [err("% usage: ip igmp snooping static-group <group-addr> interface <name>")] };
        }
        const intf = args[5];
        const list = (rec.staticGroups ?? []).filter((g) => !(g.group === group && g.intf === intf));
        if (!isNo) list.push({ group, intf });
        rec.staticGroups = list;
        break;
      }
      default:
        return { output: [err(`% Unknown IGMP snooping option "${args[2]}".`)] };
    }

    writeVlan(ctx.device, rec);
    return { output: [] };
  },
});

const vlanNum = (v: string) => v.replace(/^Vlan/i, "");
const byVlan = (a: VlanRec, b: VlanRec) => Number(vlanNum(a.vlan)) - Number(vlanNum(b.vlan));

// enable-view: `show ip igmp snooping [groups] [[vlan] <id>]` renders stored config.
registerModal({
  id: "igmp_snooping-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "ip" || args[1]?.toLowerCase() !== "igmp" || args[2]?.toLowerCase() !== "snooping") {
      return null; // not ours
    }
    let rest = args.slice(3);
    const groups = rest[0]?.toLowerCase() === "groups";
    if (groups) rest = rest.slice(1);
    if (rest[0]?.toLowerCase() === "vlan") rest = rest.slice(1);
    const filter = rest[0]; // optional bare vlan-id

    let vlans = (cpList(ctx.device, ID, "vlans") as VlanRec[]).slice().sort(byVlan);
    if (filter) vlans = vlans.filter((v) => vlanNum(v.vlan) === filter);

    if (!vlans.length) return { output: [muted("IGMP snooping is not configured on any VLAN.")] };

    const out: OutputLine[] = [];
    if (groups) {
      // Only statically-configured groups are shown; dynamically-learned groups
      // require a data plane the sim does not model.
      out.push(muted("(dynamically-learned groups are not simulated; showing static-group config only)"));
      for (const v of vlans) {
        const id = vlanNum(v.vlan);
        out.push(line(`Vlan ID: ${id}`));
        out.push(line("-".repeat(9 + id.length)));
        const sg = v.staticGroups ?? [];
        sg.forEach((g, i) => {
          out.push(line(`${i + 1} (*, ${g.group})`));
          out.push(line(`  Outgoing Ports: ${g.intf}`));
        });
        out.push(line(`Total number of entries: ${sg.length}`));
        out.push(line(""));
      }
    } else {
      for (const v of vlans) {
        out.push(line(`Vlan ID: ${vlanNum(v.vlan)}`));
        out.push(line(`Querier: ${v.querier ? "Enabled" : "Disabled"}`));
        out.push(line(`IGMP Operation mode: IGMPv${v.version ?? 2}`));
        out.push(line(`Is Fast-Leave Enabled: ${v.fastLeave ? "Enabled" : "Disabled"}`));
        out.push(line(`Query interval: ${v.queryInterval ?? 125}`));
        out.push(line(`Last Member Query Interval: ${v.lastMemberQueryInterval ?? 1000}`));
        out.push(line(`Max Response time: ${v.maxResponseTime ?? 10}`));
        if (v.mrouters?.length) out.push(line(`Mrouter Interfaces: ${v.mrouters.join(",")}`));
        out.push(line(""));
      }
    }
    return { output: out };
  },
});
