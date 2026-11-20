/**
 * OSPFv2 SONiC feature module (Click side). `config router ospf …` writes the
 * simulated CONFIG_DB (device.config.features.ospf); the OSPF daemon
 * (lib/protocols/ospf-daemon.ts) picks every change up on its next tick and the
 * protocol runs with real packets. `show ip ospf …` renders FRR 10.3 vtysh
 * layouts (lib/protocols/ospf-show.ts).
 *
 * The KLISH `router ospf` / interface `ip ospf …` grammar (sonic-cli,
 * data/device-capture/klish-xml/ospf.xml) is mapped onto these commands by
 * lib/commands/sonic-cli/features/ospf.ts:
 *
 *   config router ospf enable | disable          <- router ospf / no router ospf
 *   config router ospf router-id <id>            <- ospf router-id <id>        (ospf.txt:278, TC-130)
 *   config router ospf no router-id              <- no ospf router-id
 *   config router ospf network <cidr> area <id>  <- network <cidr> area <id>   (ospf.txt:279-281)
 *   config router ospf no network <cidr> area <id>
 *   config router ospf area <id> [stub|nssa] [no-summary]   <- area <id> stub|nssa [no-summary]
 *   config router ospf area <id> range <cidr> [not-advertise|advertise|cost <n>]
 *   config router ospf area <id> default-cost <n>
 *   config router ospf no area <id> [stub|nssa [no-summary]|range <cidr>|default-cost]
 *   config router ospf redistribute connected|static|bgp|kernel [metric <n>] [metric-type 1|2] [route-map <name>]
 *   config router ospf no redistribute <proto>
 *   config router ospf default-information originate [always] [metric <n>] [metric-type 1|2]
 *   config router ospf no default-information originate
 *   config router ospf log-adjacency-changes [detail]  /  no log-adjacency-changes [detail]
 *   config router ospf vrf <name> <any of the above>  <- `router ospf vrf <name>` (ospf.xml:15)
 *   config router ospf passive-interface <if>|default        <- passive-interface (ospf.xml:1001)
 *   config router ospf no passive-interface <if>|default
 *   config router ospf auto-cost reference-bandwidth <n>     <- auto-cost reference-bandwidth
 *   config router ospf interface <if> cost|hello-interval|dead-interval|priority <n>
 *   config router ospf interface <if> network point-to-point|broadcast
 *   config router ospf interface <if> bfd | area <id>        <- interface-view `ip ospf …` (ospf.xml:1306-1760)
 *   config router ospf no interface <if> [<param>]           <- `no ip ospf <param>` / `no ip ospf interface`
 *
 * From ospf.txt: `ospf router-id 0.0.0.0` is rejected with "%Error: Router ID
 * must be a non-zero IPv4 address" (TC-128); area ids given as an integer are
 * stored dotted (`area 9` -> 0.0.0.9).
 *
 * `show ip ospf vrf <name> <sub>` renders an instance with FRR's "VRF Name:"
 * header (ospf_vty.c:161 ospf_show_vrf_name).
 */
import { CommandContext, CommandResult, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional, matchSonic } from "./types";
import { featureState } from "../../models/feature-state";
import { isValidIpv4, isValidPrefix, intToIp, networkAddress } from "../../models/ip";
import { DEFAULT_VRF } from "../../models/vrf";
import { OspfConfig, OspfIfParams, OspfArea, RedistProto, ospfCfgKey } from "../../protocols/ospf-config";
import { renderOspfSummary, renderNeighbors, renderInterfaces, renderDatabase, renderRoutes } from "../../protocols/ospf-show";

type OspfState = OspfConfig;

/** Instance the current command applies to (set by `config router ospf vrf <name> …`). */
let curVrf = DEFAULT_VRF;

function state(ctx: CommandContext): OspfState {
  return featureState<OspfState>(ctx.device, ospfCfgKey(curVrf), () => ({
    routerId: undefined as string | undefined,
    networks: [],
    areas: [],
  }));
}

/** Area ids may be dotted ("0.0.0.9") or an integer ("9"); stored dotted. */
export function normalizeArea(tok: string | undefined): string | null {
  if (tok === undefined) return null;
  if (isValidIpv4(tok)) return tok;
  if (/^\d+$/.test(tok)) {
    const n = Number(tok);
    if (n >= 0 && n <= 0xffffffff) return intToIp(n);
  }
  return null;
}

function parseCidr(tok: string | undefined): string | null {
  if (tok === undefined) return null;
  const slash = tok.indexOf("/");
  if (slash < 0) return null;
  const addr = tok.slice(0, slash);
  const p = Number(tok.slice(slash + 1));
  if (!isValidIpv4(addr) || !isValidPrefix(p)) return null;
  return `${addr}/${p}`;
}

function parseNetworkArea(args: string[]): { cidr: string; area: string } | string {
  const pos = positional(args);
  const cidr = parseCidr(pos[0]);
  if (!cidr) return `invalid network "${pos[0] ?? ""}" (expected a.b.c.d/len)`;
  if (pos[1] !== "area") return "expected keyword 'area'";
  const area = normalizeArea(pos[2]);
  if (!area) return `invalid area "${pos[2] ?? ""}"`;
  return { cidr, area };
}

/** "Ethernet 0" / "Ethernet0" / "Vlan 10" → the device's interface name, if it exists. */
function ifaceName(ctx: CommandContext, toks: string[]): { name: string; rest: string[] } | null {
  for (const n of [1, 2]) {
    const name = toks.slice(0, n).join("");
    if (ctx.device.interfaces.some((i) => i.name === name)) return { name, rest: toks.slice(n) };
  }
  return null;
}

const rangeNum = (tok: string | undefined, lo: number, hi: number) => {
  const n = Number(tok);
  return tok !== undefined && /^\d+$/.test(tok) && n >= lo && n <= hi ? n : null;
};

/** `[metric <0-16777214>] [metric-type 1|2] [route-map <name>]` (ospf.xml:1057 RANGE_0_16777214 / RANGE_1_2). */
function metricOpts(toks: string[], allowRouteMap = false): { metric?: number; metricType?: 1 | 2; routeMap?: string } | string {
  const out: { metric?: number; metricType?: 1 | 2; routeMap?: string } = {};
  for (let i = 0; i < toks.length; i += 2) {
    if (toks[i] === "metric") {
      const n = rangeNum(toks[i + 1], 0, 16777214);
      if (n === null) return "metric must be 0-16777214";
      out.metric = n;
    } else if (toks[i] === "metric-type") {
      if (toks[i + 1] !== "1" && toks[i + 1] !== "2") return "metric-type must be 1 or 2";
      out.metricType = Number(toks[i + 1]) as 1 | 2;
    } else if (allowRouteMap && toks[i] === "route-map" && toks[i + 1]) {
      out.routeMap = toks[i + 1];
    } else return `unknown option '${toks[i]}'`;
  }
  return out;
}

function setIfParam(ctx: CommandContext, args: string[]): CommandResult {
  const r = ifaceName(ctx, positional(args));
  if (!r) return { output: [err(`% Interface ${positional(args)[0] ?? ""} does not exist`)] };
  const [param, value] = r.rest;
  const st = state(ctx);
  const p: OspfIfParams = { ...(st.ifParams?.[r.name] ?? {}) };
  switch (param) {
    case "cost": {
      const n = rangeNum(value, 1, 65535);
      if (n === null) return { output: [err("% Invalid cost (1-65535)")] };
      p.cost = n;
      break;
    }
    case "hello-interval": {
      const n = rangeNum(value, 1, 65535);
      if (n === null) return { output: [err("% Invalid hello-interval (1-65535)")] };
      p.hello = n;
      break;
    }
    case "dead-interval": {
      const n = rangeNum(value, 1, 65535);
      if (n === null) return { output: [err("% Invalid dead-interval (1-65535)")] };
      p.dead = n;
      break;
    }
    case "priority": {
      const n = rangeNum(value, 0, 255);
      if (n === null) return { output: [err("% Invalid priority (0-255)")] };
      p.priority = n;
      break;
    }
    case "network":
      if (value !== "point-to-point" && value !== "broadcast") return { output: [err("% network type must be point-to-point or broadcast")] };
      p.network = value;
      break;
    case "bfd":
      p.bfd = true;
      break;
    case "area": {
      const a = normalizeArea(value);
      if (!a) return { output: [err(`% Invalid area "${value ?? ""}"`)] };
      p.area = a;
      break;
    }
    default:
      return { output: [err(`% Unknown OSPF interface parameter "${param ?? ""}"`)] };
  }
  st.ifParams = { ...(st.ifParams ?? {}), [r.name]: p };
  return { output: [] };
}

const PARAM_KEY: Record<string, keyof OspfIfParams> = {
  cost: "cost",
  "hello-interval": "hello",
  "dead-interval": "dead",
  priority: "priority",
  network: "network",
  bfd: "bfd",
  area: "area",
};

function clearIfParam(ctx: CommandContext, args: string[]): CommandResult {
  const r = ifaceName(ctx, positional(args));
  if (!r) return { output: [err(`% Interface ${positional(args)[0] ?? ""} does not exist`)] };
  const st = state(ctx);
  const cur = { ...(st.ifParams?.[r.name] ?? {}) };
  const param = r.rest[0];
  if (param === undefined) {
    if (st.ifParams) delete st.ifParams[r.name];
    return { output: [] };
  }
  const key = PARAM_KEY[param];
  if (!key) return { output: [err(`% Unknown OSPF interface parameter "${param}"`)] };
  delete cur[key];
  st.ifParams = { ...(st.ifParams ?? {}), [r.name]: cur };
  return { output: [] };
}

function passive(ctx: CommandContext, args: string[], on: boolean): CommandResult {
  const st = state(ctx);
  const toks = positional(args);
  if (toks[0] === "default") {
    st.passiveDefault = on || undefined;
    if (!on) st.nonPassive = undefined;
    return { output: [] };
  }
  const r = ifaceName(ctx, toks);
  if (!r) return { output: [err(`% Interface ${toks[0] ?? ""} does not exist`)] };
  if (st.passiveDefault) {
    // With `passive-interface default`, `no passive-interface X` makes X active.
    const np = new Set(st.nonPassive ?? []);
    if (on) np.delete(r.name);
    else np.add(r.name);
    st.nonPassive = [...np];
  } else {
    const ps = new Set(st.passive ?? []);
    if (on) ps.add(r.name);
    else ps.delete(r.name);
    st.passive = [...ps];
  }
  return { output: [] };
}

const config: SonicCmd[] = [
  {
    path: ["router", "ospf", "enable"],
    summary: "Start the OSPF instance (router ospf)",
    run(_args, ctx): CommandResult {
      state(ctx);
      return { output: [] };
    },
  },
  {
    path: ["router", "ospf", "disable"],
    summary: "Remove the OSPF instance and all its configuration (no router ospf)",
    run(_args, ctx): CommandResult {
      if (ctx.device.config.features) delete ctx.device.config.features[ospfCfgKey(curVrf)];
      return { output: [] };
    },
  },
  {
    path: ["router", "ospf", "router-id"],
    summary: "Set the OSPF router-id",
    run(args, ctx): CommandResult {
      const id = positional(args)[0];
      if (!id) return { output: [err("Usage: config router ospf router-id <ipv4>")] };
      if (!isValidIpv4(id)) return { output: [err(`config router ospf router-id: '${id}' is not a valid IPv4 address`)] };
      if (id === "0.0.0.0") return { output: [err("%Error: Router ID must be a non-zero IPv4 address")] };
      state(ctx).routerId = id;
      return { output: [muted(`OSPF router-id set to ${id}`)] };
    },
  },
  {
    path: ["router", "ospf", "no", "router-id"],
    summary: "Clear the OSPF router-id",
    run(_args, ctx): CommandResult {
      state(ctx).routerId = undefined;
      return { output: [muted("OSPF router-id cleared")] };
    },
  },
  {
    path: ["router", "ospf", "network"],
    summary: "Enable OSPF on interfaces in a prefix (network <cidr> area <id>)",
    run(args, ctx): CommandResult {
      const parsed = parseNetworkArea(args);
      if (typeof parsed === "string") return { output: [err(`config router ospf network: ${parsed}`)] };
      const st = state(ctx);
      const exists = st.networks.some((n) => n.network === parsed.cidr && n.area === parsed.area);
      if (!exists) st.networks.push({ network: parsed.cidr, area: parsed.area });
      return { output: [muted(`network ${parsed.cidr} area ${parsed.area}${exists ? " (already configured)" : " configured"}`)] };
    },
  },
  {
    path: ["router", "ospf", "no", "network"],
    summary: "Remove a network statement (no network <cidr> area <id>)",
    run(args, ctx): CommandResult {
      const parsed = parseNetworkArea(args);
      if (typeof parsed === "string") return { output: [err(`config router ospf no network: ${parsed}`)] };
      const st = state(ctx);
      const before = st.networks.length;
      st.networks = st.networks.filter((n) => !(n.network === parsed.cidr && n.area === parsed.area));
      const removed = st.networks.length < before;
      return { output: [muted(`network ${parsed.cidr} area ${parsed.area} ${removed ? "removed" : "not configured (no-op)"}`)] };
    },
  },
  {
    path: ["router", "ospf", "area"],
    summary: "Configure an area (area <id> [stub|nssa [no-summary]] | range <cidr> [...] | default-cost <n>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const area = normalizeArea(pos[0]);
      if (!area) return { output: [err(`config router ospf area: invalid area "${pos[0] ?? ""}"`)] };
      const typeTok = pos[1];
      const st = state(ctx);
      const entry = (): OspfArea => {
        let e = st.areas.find((a) => a.id === area);
        if (!e) {
          e = { id: area };
          st.areas.push(e);
        }
        return e;
      };
      if (typeTok === "range") {
        const cidr = parseCidr(pos[2]);
        if (!cidr) return { output: [err(`config router ospf area range: invalid prefix "${pos[2] ?? ""}"`)] };
        const [addr, len] = cidr.split("/");
        const prefix = `${networkAddress(addr, Number(len))}/${len}`;
        let notAdvertise: boolean | undefined;
        let cost: number | undefined;
        const opt = pos[3];
        if (opt === "not-advertise") notAdvertise = true;
        else if (opt === "cost") {
          const n = rangeNum(pos[4], 0, 16777215);
          if (n === null) return { output: [err("% Invalid range cost (0-16777215)")] };
          cost = n;
        } else if (opt !== undefined && opt !== "advertise") return { output: [err(`config router ospf area range: unknown option '${opt}'`)] };
        const e = entry();
        e.ranges = [...(e.ranges ?? []).filter((r) => r.prefix !== prefix), { prefix, ...(notAdvertise ? { notAdvertise } : {}), ...(cost !== undefined ? { cost } : {}) }];
        return { output: [muted(`area ${area} range ${prefix} configured`)] };
      }
      if (typeTok === "default-cost") {
        const n = rangeNum(pos[2], 0, 16777215);
        if (n === null) return { output: [err("% Invalid default-cost (0-16777215)")] };
        entry().defaultCost = n;
        return { output: [] };
      }
      if (typeTok !== undefined && typeTok !== "stub" && typeTok !== "nssa") {
        return { output: [err(`config router ospf area: type must be stub, nssa, range or default-cost (got '${typeTok}')`)] };
      }
      // VTY_GET_OSPF_AREA_ID_NO_BB (ospfd/ospf_vty.h:20).
      if (typeTok !== undefined && area === "0.0.0.0") return { output: [err(`% You can't configure ${typeTok} to backbone`)] };
      const extra = pos[2];
      if (extra !== undefined && extra !== "no-summary") return { output: [err(`config router ospf area: unknown option '${extra}'`)] };
      const e = entry();
      if (typeTok !== undefined) {
        e.type = typeTok;
        e.noSummary = extra === "no-summary" || undefined;
      }
      return { output: [muted(`area ${area}${typeTok ? ` ${typeTok}` : ""}${extra ? ` ${extra}` : ""} configured`)] };
    },
  },
  {
    path: ["router", "ospf", "no", "area"],
    summary: "Remove an area or one of its settings (no area <id> [stub|nssa [no-summary]|range <cidr>|default-cost])",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const area = normalizeArea(pos[0]);
      if (!area) return { output: [err(`config router ospf no area: invalid area "${pos[0] ?? ""}"`)] };
      const st = state(ctx);
      const entry = st.areas.find((a) => a.id === area);
      if (!entry) return { output: [muted(`area ${area} not configured (no-op)`)] };
      if (pos[1] === "range") {
        const cidr = parseCidr(pos[2]);
        if (!cidr) return { output: [err(`config router ospf no area range: invalid prefix "${pos[2] ?? ""}"`)] };
        const [addr, len] = cidr.split("/");
        const prefix = `${networkAddress(addr, Number(len))}/${len}`;
        entry.ranges = (entry.ranges ?? []).filter((r) => r.prefix !== prefix);
        if (!entry.ranges.length) entry.ranges = undefined;
        return { output: [muted(`area ${area} range ${prefix} removed`)] };
      }
      if (pos[1] === "default-cost") {
        entry.defaultCost = undefined;
        return { output: [] };
      }
      if (pos[1] !== undefined) {
        // `no area X stub no-summary` keeps the stub area and only re-enables summaries.
        if (pos[2] === "no-summary") entry.noSummary = undefined;
        else {
          entry.type = undefined;
          entry.noSummary = undefined;
        }
        return { output: [muted(`area ${area} ${pos.slice(1).join(" ")} cleared`)] };
      }
      st.areas = st.areas.filter((a) => a.id !== area);
      return { output: [muted(`area ${area} removed`)] };
    },
  },
  {
    path: ["router", "ospf", "redistribute"],
    summary: "Redistribute routes into OSPF as type-5 LSAs (connected|static|bgp|kernel [metric <n>] [metric-type 1|2] [route-map <name>])",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const proto = pos[0] as RedistProto;
      if (!["connected", "static", "bgp", "kernel"].includes(proto)) return { output: [err(`config router ospf redistribute: protocol must be connected, static, bgp or kernel (got '${pos[0] ?? ""}')`)] };
      const m = metricOpts(pos.slice(1), true);
      if (typeof m === "string") return { output: [err(`config router ospf redistribute: ${m}`)] };
      const st = state(ctx);
      st.redistribute = [...(st.redistribute ?? []).filter((r) => r.protocol !== proto), { protocol: proto, ...m }];
      return { output: [] };
    },
  },
  {
    path: ["router", "ospf", "no", "redistribute"],
    summary: "Stop redistributing a protocol",
    run(args, ctx): CommandResult {
      const st = state(ctx);
      const proto = positional(args)[0];
      st.redistribute = (st.redistribute ?? []).filter((r) => r.protocol !== proto);
      if (!st.redistribute.length) st.redistribute = undefined;
      return { output: [] };
    },
  },
  {
    path: ["router", "ospf", "default-information", "originate"],
    summary: "Originate a type-5 default route ([always] [metric <n>] [metric-type 1|2])",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const always = pos[0] === "always";
      const m = metricOpts(always ? pos.slice(1) : pos);
      if (typeof m === "string") return { output: [err(`config router ospf default-information originate: ${m}`)] };
      state(ctx).defaultInfo = { ...(always ? { always } : {}), ...m };
      return { output: [] };
    },
  },
  {
    path: ["router", "ospf", "no", "default-information", "originate"],
    summary: "Stop originating the default route",
    run(_args, ctx): CommandResult {
      state(ctx).defaultInfo = undefined;
      return { output: [] };
    },
  },
  {
    path: ["router", "ospf", "log-adjacency-changes"],
    summary: "Log neighbour adjacency changes ([detail]: every state change)",
    run(args, ctx): CommandResult {
      state(ctx).logAdjacencyChanges = positional(args)[0] === "detail" ? "detail" : true;
      return { output: [] };
    },
  },
  {
    path: ["router", "ospf", "no", "log-adjacency-changes"],
    summary: "Stop logging adjacency changes (no … detail: only the detail)",
    run(args, ctx): CommandResult {
      const st = state(ctx);
      // ospf_vty.c:2196-2206: `no log-adjacency-changes detail` keeps the basic logging.
      st.logAdjacencyChanges = positional(args)[0] === "detail" && st.logAdjacencyChanges ? true : undefined;
      return { output: [] };
    },
  },
  { path: ["router", "ospf", "passive-interface"], summary: "Suppress Hellos on an interface (or default)", run: (a, ctx) => passive(ctx, a, true) },
  { path: ["router", "ospf", "no", "passive-interface"], summary: "Re-enable Hellos on an interface", run: (a, ctx) => passive(ctx, a, false) },
  {
    path: ["router", "ospf", "auto-cost", "reference-bandwidth"],
    summary: "Reference bandwidth for interface cost (1-4294967)",
    run(args, ctx): CommandResult {
      const n = rangeNum(positional(args)[0], 1, 4294967);
      if (n === null) return { output: [err("reference-bandwidth value is invalid")] };
      state(ctx).refBandwidth = n;
      return { output: [] };
    },
  },
  {
    path: ["router", "ospf", "no", "auto-cost", "reference-bandwidth"],
    summary: "Restore the default reference bandwidth",
    run(_args, ctx): CommandResult {
      state(ctx).refBandwidth = undefined;
      return { output: [] };
    },
  },
  { path: ["router", "ospf", "interface"], summary: "Interface parameter (cost/hello-interval/dead-interval/priority/network/bfd/area)", run: (a, ctx) => setIfParam(ctx, a) },
  { path: ["router", "ospf", "no", "interface"], summary: "Clear an interface parameter (or all)", run: (a, ctx) => clearIfParam(ctx, a) },
];

// `config router ospf vrf <name> <sub-command…>`: the same commands on the VRF's instance.
config.push({
  path: ["router", "ospf", "vrf"],
  summary: "Configure the OSPF instance of a VRF (router ospf vrf <name>)",
  run(args, ctx): CommandResult {
    const [name, ...rest] = args;
    if (!name) return { output: [err("Usage: config router ospf vrf <name> [enable|disable|<sub-command>]")] };
    const m = matchSonic(config.filter((c) => c.path[2] !== "vrf"), ["router", "ospf", ...(rest.length ? rest : ["enable"])]);
    if (!m) return { output: [err(`config router ospf vrf ${name}: unknown sub-command '${rest.join(" ")}'`)] };
    curVrf = name;
    try {
      return m.cmd.run(m.rest, ctx);
    } finally {
      curVrf = DEFAULT_VRF;
    }
  },
});

const now = () => Date.now();
const lines = (l: string[]) => ({ output: l.map((t) => line(t)) });

const show: SonicCmd[] = [
  { path: ["ip", "ospf", "neighbor"], summary: "Show OSPF neighbors", run: (a, ctx) => lines(renderNeighbors(ctx.device, now(), positional(a).join("") || undefined, curShowVrf)) },
  { path: ["ip", "ospf", "interface"], summary: "Show OSPF interfaces", run: (a, ctx) => lines(renderInterfaces(ctx.device, now(), positional(a).join("") || undefined, curShowVrf)) },
  { path: ["ip", "ospf", "database"], summary: "Show the OSPF link-state database", run: (a, ctx) => lines(renderDatabase(ctx.device, now(), positional(a), curShowVrf)) },
  { path: ["ip", "ospf", "route"], summary: "Show the OSPF routing table", run: (_a, ctx) => lines(renderRoutes(ctx.device, curShowVrf)) },
  { path: ["ip", "ospf"], summary: "Show the OSPF process", run: (_a, ctx) => lines(renderOspfSummary(ctx.device, now(), curShowVrf)) },
];

/** VRF named by `show ip ospf vrf <name> …` (undefined: the default instance, no "VRF Name:" header). */
let curShowVrf: string | undefined;

show.push({
  path: ["ip", "ospf", "vrf"],
  summary: "Show an OSPF instance of a VRF (show ip ospf vrf <name> [neighbor|interface|database|route])",
  run(args, ctx): CommandResult {
    const [name, ...rest] = args;
    if (!name) return { output: [err("Usage: show ip ospf vrf <name> [neighbor|interface|database|route]")] };
    const m = matchSonic(show.filter((c) => c.path[2] !== "vrf"), ["ip", "ospf", ...rest]);
    if (!m) return { output: [err(`show ip ospf vrf ${name}: unknown sub-command '${rest.join(" ")}'`)] };
    curShowVrf = name;
    try {
      return m.cmd.run(m.rest, ctx);
    } finally {
      curShowVrf = undefined;
    }
  },
});

export const ospfModule: SonicFeatureModule = { id: "ospf", config, show };

