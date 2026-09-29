/**
 * OSPFv2 SONiC feature module. Config-plane only (simulated CONFIG_DB): commands
 * mutate per-device feature state and `show ip ospf ...` renders SOLELY from that
 * stored state. Nothing touches a real FRR/ospfd — this is educational.
 *
 * The authoritative CLI forms are the KLISH `router ospf` config-mode grammar in
 * ospf.txt / ospfadvanced.txt. In sonic-cli you enter `router ospf` config mode
 * and issue lines; this stateless simulator carries each line on ONE command
 * under the central dispatcher, so the tokens arrive as ["router","ospf", ...]:
 *
 *   config router ospf router-id <id>           <- ospf router-id <id>           (ospf.txt:278, TC-130)
 *   config router ospf no router-id             <- no ospf router-id            (ospf.txt:807)
 *   config router ospf network <cidr> area <id> <- network <cidr> area <id>     (ospf.txt:279-281)
 *   config router ospf no network <cidr> area <id> <- no network <cidr> area <id> (ospf.txt:796-801)
 *   config router ospf area <id> [stub|nssa]    <- area <id> [stub|nssa]        (ospf.txt:294,315-316)
 *   config router ospf no area <id> [stub|nssa] <- no area <id> ...             (ospf.txt:800-801)
 *
 * Show (path ["ip","ospf", ...] — distinct from the reserved ["ip","route"],
 * ["ip","arp"], ["ip","interfaces"], ["ip","prefix-list"]; longest-prefix match
 * keeps them apart):
 *
 *   show ip ospf            <- router-id + areas summary   (ospfadvanced.txt TC-3, ospf.txt TC-140)
 *   show ip ospf neighbor   <- adjacency placeholder       (ospf.txt TC-145: "No OSPF neighbors found.")
 *   show ip ospf route      <- route-table placeholder     (ospfadvanced.txt TC-14 header)
 *
 * From ospf.txt: `ospf router-id 0.0.0.0` is rejected with "%Error: Router ID
 * must be a non-zero IPv4 address" (TC-128); area ids given as a plain integer
 * are stored in dotted form (`area 0` -> 0.0.0.0, `area 9` -> 0.0.0.9,
 * `area 19` -> 0.0.0.19; running-config TC-1). Area 0.0.0.0 is the Backbone.
 *
 * IMPORTANT: OSPF adjacency/LSA/SPF computation needs a packet engine that is
 * not present yet, so neighbors and learned routes are NOT fabricated here — the
 * neighbor/route views render a clear placeholder. Real adjacency + populated
 * routes are exercised in the dual-node suite (ospfadvanced.txt).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { findInterface } from "../../models/device";
import { isValidIpv4, isValidPrefix, intToIp } from "../../models/ip";

/** Well-known non-default area types accepted from the cheatsheet subset. */
type AreaType = "stub" | "nssa";

interface OspfNetwork {
  network: string; // normalized CIDR, e.g. "150.150.100.0/24"
  area: string; // dotted area id, e.g. "0.0.0.0"
}

interface OspfArea {
  id: string; // dotted area id
  type?: string; // "stub" | "nssa" when configured
}

interface OspfState {
  routerId: string | undefined;
  networks: OspfNetwork[];
  areas: OspfArea[];
}

function state(ctx: CommandContext): OspfState {
  return featureState<OspfState>(ctx.device, "ospf", () => ({
    routerId: undefined as string | undefined,
    networks: [] as OspfNetwork[],
    areas: [] as OspfArea[],
  }));
}

/**
 * Area ids may be typed dotted ("0.0.0.9") or as a plain integer ("9"); FRR /
 * sonic-cli stores/renders them dotted (ospf.txt:279 `area 9` -> TC-1
 * `area 0.0.0.9`). Returns the dotted form, or null when neither form is valid.
 */
function normalizeArea(tok: string | undefined): string | null {
  if (tok === undefined) return null;
  if (isValidIpv4(tok)) return tok;
  if (/^\d+$/.test(tok)) {
    const n = Number(tok);
    if (n >= 0 && n <= 0xffffffff) return intToIp(n);
  }
  return null;
}

/** Validate and normalize a CIDR "a.b.c.d/p"; null when malformed. */
function parseCidr(tok: string | undefined): string | null {
  if (tok === undefined) return null;
  const slash = tok.indexOf("/");
  if (slash < 0) return null;
  const addr = tok.slice(0, slash);
  const p = Number(tok.slice(slash + 1));
  if (!isValidIpv4(addr) || !isValidPrefix(p)) return null;
  return `${addr}/${p}`;
}

/** Parse the tail "<cidr> area <id>" shared by network add/del. */
function parseNetworkArea(args: string[]): { cidr: string; area: string } | string {
  const pos = positional(args);
  const cidr = parseCidr(pos[0]);
  if (!cidr) return `invalid network "${pos[0] ?? ""}" (expected a.b.c.d/len)`;
  if (pos[1] !== "area") return "expected keyword 'area'";
  const area = normalizeArea(pos[2]);
  if (!area) return `invalid area "${pos[2] ?? ""}"`;
  return { cidr, area };
}

const config: SonicCmd[] = [
  {
    path: ["router", "ospf", "router-id"],
    summary: "Set the OSPF router-id",
    run(args, ctx): CommandResult {
      const id = positional(args)[0];
      if (!id) return { output: [err("Usage: config router ospf router-id <ipv4>")] };
      if (!isValidIpv4(id)) return { output: [err(`config router ospf router-id: '${id}' is not a valid IPv4 address`)] };
      // ospf router-id 0.0.0.0 is rejected, nothing stored (ospf.txt TC-128).
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
    summary: "Advertise a network into an area (network <cidr> area <id>)",
    run(args, ctx): CommandResult {
      const parsed = parseNetworkArea(args);
      if (typeof parsed === "string") return { output: [err(`config router ospf network: ${parsed}`)] };
      const st = state(ctx);
      const exists = st.networks.some((n) => n.network === parsed.cidr && n.area === parsed.area);
      // Re-adding the same network/area is a silent no-op (idempotent, like FRR).
      if (!exists) st.networks.push({ network: parsed.cidr, area: parsed.area });
      return { output: [muted(`network ${parsed.cidr} area ${parsed.area}${exists ? " (already configured)" : " configured"}`)] };
    },
  },
  {
    path: ["router", "ospf", "no", "network"],
    summary: "Withdraw a network from an area (no network <cidr> area <id>)",
    run(args, ctx): CommandResult {
      const parsed = parseNetworkArea(args);
      if (typeof parsed === "string") return { output: [err(`config router ospf no network: ${parsed}`)] };
      const st = state(ctx);
      const before = st.networks.length;
      st.networks = st.networks.filter((n) => !(n.network === parsed.cidr && n.area === parsed.area));
      const removed = st.networks.length < before;
      return {
        output: [
          muted(
            removed
              ? `network ${parsed.cidr} area ${parsed.area} removed`
              : `network ${parsed.cidr} area ${parsed.area} not configured (no-op)`,
          ),
        ],
      };
    },
  },
  {
    path: ["router", "ospf", "area"],
    summary: "Configure an area (area <id> [stub|nssa])",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const area = normalizeArea(pos[0]);
      if (!area) return { output: [err(`config router ospf area: invalid area "${pos[0] ?? ""}"`)] };
      const typeTok = pos[1];
      if (typeTok !== undefined && typeTok !== "stub" && typeTok !== "nssa") {
        return { output: [err(`config router ospf area: type must be stub or nssa (got '${typeTok}')`)] };
      }
      const st = state(ctx);
      let entry = st.areas.find((a) => a.id === area);
      if (!entry) {
        entry = { id: area };
        st.areas.push(entry);
      }
      if (typeTok !== undefined) entry.type = typeTok as AreaType;
      return { output: [muted(`area ${area}${typeTok ? ` ${typeTok}` : ""} configured`)] };
    },
  },
  {
    path: ["router", "ospf", "no", "area"],
    summary: "Remove an area or clear its type (no area <id> [stub|nssa])",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const area = normalizeArea(pos[0]);
      if (!area) return { output: [err(`config router ospf no area: invalid area "${pos[0] ?? ""}"`)] };
      const st = state(ctx);
      const entry = st.areas.find((a) => a.id === area);
      if (!entry) return { output: [muted(`area ${area} not configured (no-op)`)] };
      if (pos[1] !== undefined) {
        // `no area <id> <type>` clears only the type, keeps the area entry.
        entry.type = undefined;
        return { output: [muted(`area ${area} ${pos[1]} cleared`)] };
      }
      st.areas = st.areas.filter((a) => a.id !== area);
      return { output: [muted(`area ${area} removed`)] };
    },
  },
];

/** Distinct areas attached to this router: from networks + explicit area entries. */
function attachedAreas(st: OspfState): OspfArea[] {
  const byId = new Map<string, OspfArea>();
  for (const n of st.networks) if (!byId.has(n.area)) byId.set(n.area, { id: n.area });
  for (const a of st.areas) byId.set(a.id, { id: a.id, type: a.type });
  return [...byId.values()].sort((x, y) => x.id.localeCompare(y.id));
}

function renderSummary(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<OspfState>(ctx.device, "ospf");
  if (!st || (st.routerId === undefined && st.networks.length === 0 && st.areas.length === 0)) {
    return [muted("OSPF is not configured")];
  }
  const areas = attachedAreas(st);
  const out: OutputLine[] = [
    line("VRF Name: default"),
    line(`OSPF Routing Process, Router ID: ${st.routerId ?? "0.0.0.0"}`),
    line("Supports only single TOS (TOS0) routes"),
    line("This implementation conforms to RFC2328"),
    line(`Number of areas attached to this router: ${areas.length}`),
  ];
  for (const a of areas) {
    const label = a.type ? ` [${a.type}]` : a.id === "0.0.0.0" ? " (Backbone)" : "";
    out.push(line(`Area ID: ${a.id}${label}`));
    out.push(line("  Area has no authentication"));
  }
  return out;
}

interface OspfNeighborView {
  routerId: string;
  ip: string;
  interfaceId: string;
  state: string;
}

function renderNeighbors(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<OspfState & { neighbors?: OspfNeighborView[] }>(ctx.device, "ospf");
  const nbrs = st?.neighbors ?? [];
  if (nbrs.length === 0) {
    return [
      line("No OSPF neighbors found."),
      muted("(run `ospf converge` after configuring `config router ospf network … area …`)"),
    ];
  }
  const out: OutputLine[] = [line("Neighbor ID     Pri   State           Address         Interface")];
  for (const n of nbrs) {
    const ifn = findInterface(ctx.device, n.interfaceId)?.name ?? n.interfaceId;
    const state = n.state === "full" ? "Full/DR" : n.state === "2way" ? "2-Way" : "Init";
    out.push(line(`${n.routerId.padEnd(15)} 1     ${state.padEnd(15)} ${n.ip.padEnd(15)} ${ifn}`));
  }
  return out;
}

function renderRoutes(ctx: CommandContext): OutputLine[] {
  const ospf = ctx.device.routingTable.filter((r) => r.type === "ospf");
  const out: OutputLine[] = [line("============ OSPF network routing table ============")];
  if (ospf.length === 0) {
    out.push(muted("(no OSPF routes — configure OSPF and run `ospf converge`)"));
    return out;
  }
  for (const r of ospf) {
    const ifn = findInterface(ctx.device, r.interfaceId)?.name ?? r.interfaceId;
    out.push(line(`N   ${r.destination}/${r.prefix}   [${r.metric}] via ${r.nextHop}, ${ifn}`));
  }
  return out;
}

const show: SonicCmd[] = [
  { path: ["ip", "ospf", "neighbor"], summary: "Show OSPF neighbors", run: (_a, ctx) => ({ output: renderNeighbors(ctx) }) },
  { path: ["ip", "ospf", "route"], summary: "Show the OSPF route table", run: (_a, ctx) => ({ output: renderRoutes(ctx) }) },
  {
    path: ["ip", "ospf"],
    summary: "Show the OSPF process (router-id + areas summary)",
    run: (_a, ctx) => ({ output: renderSummary(ctx) }),
  },
];

export const ospfModule: SonicFeatureModule = { id: "ospf", config, show };
