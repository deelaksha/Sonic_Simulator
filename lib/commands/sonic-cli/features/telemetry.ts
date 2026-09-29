/**
 * Telemetry / TAM (Telemetry And Monitoring) — CONFIG-PLANE feature (no engine
 * backend; store + show). Config lives in the dedicated `configure-tam-view`
 * sub-mode entered from configure-view via `tam` (bgp sub-mode template).
 *
 *   sonic(config)# tam                                enter TAM sub-mode
 *   sonic(config-tam)# switch-id 1234                 store scalar
 *   sonic(config-tam)# enterprise-id 5678             store scalar
 *   sonic(config-tam)# collector c1 ip 1.1.1.1 port 7071 [protocol UDP] [vrf V]
 *   sonic(config-tam)# sampler s1 rate 1000
 *   sonic(config-tam)# flow-group f1 src-ip 1.1.1.1/32 priority 100 ...
 *   sonic(config-tam)# no collector c1                clear list item
 *   sonic# show tam {switch|collectors|samplers|flowgroups} [name]  render
 *
 * Only configured values are reflected on show. Runtime attributes the real box
 * assigns (flow-group Id, packet counters, feature operational status) are NOT
 * fabricated. TAM's actual data plane (traffic sampling, IPFIX export, IFA/drop
 * monitoring) is not simulated — dataPlaneNotSimulated.
 */
import { line, err, muted, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet, cpUpsert, cpRemove, cpList } from "../config-plane";
import { subViewFrame } from "../../../sonic/grammar";

const ID = "telemetry";

function uint(v: string | undefined, max: number): number | null {
  if (v === undefined || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= max ? n : null;
}

/** Read keyword/value pairs (e.g. ["ip","1.1.1.1","port","7071"]) into a map. */
function pairs(args: string[], keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i].toLowerCase();
    if (keys.includes(k) && args[i + 1] !== undefined) {
      out[k] = args[i + 1];
      i++;
    }
  }
  return out;
}

// configure-view: `tam` — enter the TAM sub-mode (no entry effect).
registerModal({
  id: "telemetry-enter",
  views: ["configure-view"],
  keywords: ["tam"],
  run({ isNo }) {
    if (isNo) return null; // `no tam` is not a configure-view command
    return { output: [], enter: subViewFrame("configure-tam-view", "") };
  },
});

// configure-tam-view: switch-id / enterprise-id / collector / sampler / flow-group.
registerModal({
  id: "telemetry",
  views: ["configure-tam-view"],
  keywords: ["switch-id", "enterprise-id", "collector", "sampler", "flow-group"],
  run({ head, isNo, args, ctx }) {
    const dev = ctx.device;

    if (head === "switch-id" || head === "enterprise-id") {
      const key = head === "switch-id" ? "switch_id" : "enterprise_id";
      if (isNo) {
        cpUnset(dev, ID, key);
        return { output: [] };
      }
      const n = uint(args[0], 4294967295);
      if (n === null) return { output: [err(`% ${head} must be an integer (1..4294967295)`)] };
      cpSet(dev, ID, key, n);
      return { output: [] };
    }

    if (head === "collector") {
      const name = args[0];
      if (!name) return { output: [err("% collector name required")] };
      if (isNo) {
        cpRemove(dev, ID, "collectors", "name", name);
        return { output: [] };
      }
      const p = pairs(args.slice(1), ["ip", "port", "protocol", "vrf"]);
      if (!p.ip || !p.port) return { output: [err("% collector requires ip <addr> and port <num>")] };
      if (uint(p.port, 65535) === null && p.port !== "0") return { output: [err("% collector port must be 0..65535")] };
      const item: Record<string, unknown> = { name, ip: p.ip, port: p.port, protocol: (p.protocol ?? "UDP").toUpperCase() };
      if (p.vrf) item.vrf = p.vrf;
      cpUpsert(dev, ID, "collectors", item, "name");
      return { output: [] };
    }

    if (head === "sampler") {
      const name = args[0];
      if (!name) return { output: [err("% sampler name required")] };
      if (isNo) {
        cpRemove(dev, ID, "samplers", "name", name);
        return { output: [] };
      }
      if (args[1]?.toLowerCase() !== "rate" || uint(args[2], 4294967295) === null) {
        return { output: [err("% usage: sampler <name> rate <1..4294967295>")] };
      }
      cpUpsert(dev, ID, "samplers", { name, rate: Number(args[2]) }, "name");
      return { output: [] };
    }

    if (head === "flow-group") {
      const name = args[0];
      if (!name) return { output: [err("% flow-group name required")] };
      if (isNo) {
        cpRemove(dev, ID, "flowgroups", "name", name);
        return { output: [] };
      }
      const p = pairs(args.slice(1), ["src-ip", "dst-ip", "l4-src-port", "l4-dst-port", "priority", "protocol", "src-mac", "dst-mac", "vlan-id", "ethertype"]);
      const item: Record<string, unknown> = { name };
      const map: [string, string][] = [
        ["src-ip", "src_ip"], ["dst-ip", "dst_ip"], ["l4-src-port", "l4_src_port"], ["l4-dst-port", "l4_dst_port"],
        ["priority", "priority"], ["protocol", "protocol"], ["src-mac", "src_mac"], ["dst-mac", "dst_mac"], ["vlan-id", "vlan"], ["ethertype", "ethertype"],
      ];
      for (const [k, f] of map) if (p[k] !== undefined) item[f] = k === "protocol" ? p[k].toUpperCase() : p[k];
      cpUpsert(dev, ID, "flowgroups", item, "name");
      return { output: [] };
    }

    return null;
  },
});

// enable-view: `show tam {switch|collectors|samplers|flowgroups} [name]`.
registerModal({
  id: "telemetry-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "tam") return null; // not ours
    const sub = args[1]?.toLowerCase();
    const dev = ctx.device;

    if (sub === "switch") {
      const st = cpGet(dev, ID) ?? {};
      if (st.switch_id === undefined && st.enterprise_id === undefined) {
        return { output: [muted("No TAM switch identifiers configured")] };
      }
      const out = [line("TAM Device information"), line("----------------------")];
      if (st.switch_id !== undefined) out.push(line(`Switch ID      : ${st.switch_id}`));
      if (st.enterprise_id !== undefined) out.push(line(`Enterprise ID  : ${st.enterprise_id}`));
      return { output: out };
    }

    if (sub === "collectors") {
      const list = cpList(dev, ID, "collectors");
      const name = args[2];
      if (name) {
        const c = list.find((e) => e.name === name);
        if (!c) return { output: [muted(`Collector ${name} not found`)] };
        const out = [line(`Name          : ${c.name}`), line(`IP Address    : ${c.ip}`), line(`Port          : ${c.port}`), line(`Protocol      : ${c.protocol}`)];
        if (c.vrf) out.push(line(`Vrf           : ${c.vrf}`));
        return { output: out };
      }
      if (!list.length) return { output: [muted("No collectors configured")] };
      const hasVrf = list.some((c) => c.vrf);
      const header = `${"Name".padEnd(18)} ${"IP Address".padEnd(16)} ${"Port".padEnd(6)}  ${"Protocol".padEnd(8)}${hasVrf ? "   Vrf" : ""}`;
      const rule = `${"-".repeat(16).padEnd(18)} ${"-".repeat(14).padEnd(16)} ${"-".repeat(6)}  ${"-".repeat(8)}${hasVrf ? "   -------" : ""}`;
      const out = [line(header), line(rule)];
      for (const c of list) {
        out.push(line(`${String(c.name).padEnd(18)} ${String(c.ip).padEnd(16)} ${String(c.port).padEnd(6)}  ${String(c.protocol).padEnd(8)}${hasVrf ? `   ${c.vrf ?? "-"}` : ""}`));
      }
      return { output: out };
    }

    if (sub === "samplers") {
      const list = cpList(dev, ID, "samplers");
      const name = args[2];
      if (name) {
        const s = list.find((e) => e.name === name);
        if (!s) return { output: [muted(`Sampler ${name} not found`)] };
        return { output: [line(`Name          : ${s.name}`), line(`Sample Rate   : ${s.rate}`)] };
      }
      if (!list.length) return { output: [muted("No samplers configured")] };
      const out = [line(`${"Name".padEnd(12)} Sample Rate`), line(`${"-".repeat(11).padEnd(12)} -----------`)];
      for (const s of list) out.push(line(`${String(s.name).padEnd(12)} ${s.rate}`));
      return { output: out };
    }

    if (sub === "flowgroups") {
      let list = cpList(dev, ID, "flowgroups");
      const name = args[2];
      if (name) list = list.filter((e) => e.name === name);
      if (!list.length) return { output: [muted(name ? `Flow-group ${name} not found` : "No flow-groups configured")] };
      const fields: [string, string][] = [
        ["priority", "Priority"], ["src_ip", "SRC IP"], ["dst_ip", "DST IP"], ["l4_src_port", "L4 SRC Port"], ["l4_dst_port", "L4 DST Port"],
        ["protocol", "Protocol"], ["src_mac", "SRC MAC"], ["dst_mac", "DST MAC"], ["vlan", "VLAN"], ["ethertype", "Ethertype"],
      ];
      const out: OutputLine[] = [];
      for (let i = 0; i < list.length; i++) {
        if (i) out.push(line(""));
        const fg = list[i];
        out.push(line(`Flow Group Name    : ${fg.name}`));
        for (const [k, label] of fields) if (fg[k] !== undefined) out.push(line(`   ${label.padEnd(15)} : ${fg[k]}`));
      }
      return { output: out };
    }

    return null; // other `show tam ...` subcommands not modelled here
  },
});
