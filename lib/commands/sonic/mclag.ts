/**
 * MCLAG Click config (sonic-utilities config/mclag.py). Writes the same simulated
 * CONFIG_DB tables the KLISH `mclag domain` mode writes (cp_mclag.domains =
 * MCLAG_DOMAIN, cp_mclag.interfaces = MCLAG_INTERFACE, see
 * lib/commands/sonic-cli/features/mclag.ts), which iccpd
 * (lib/protocols/mclag-daemon.ts) reads.
 *
 *   config mclag add <domain_id> <source_ip> <peer_ip> [<peer_ifname>]   mclag.py:119-163
 *   config mclag del <domain_id>                                        mclag.py:167-200
 *   config mclag keepalive-interval <domain_id> <secs>                  mclag.py:204-236
 *   config mclag session-timeout <domain_id> <secs>                     mclag.py:238-268
 *   config mclag member add|del <domain_id> <PortChannelN[,PortChannelM]>  mclag.py:270-313
 *
 * ADHOC_VALIDATION is False in the tree (mclag.py:8), so the range checks are the
 * ones sonic-mclag.yang enforces through ValidatedConfigDBConnector; the
 * one-domain rule and the keepalive/session-timeout dependency are always checked.
 */
import { CommandResult, OutputLine, err, line } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { cpList, cpRemove, cpUpsert } from "../sonic-cli/config-plane";
import { isValidIpv4 } from "../../models/ip";

const fail = (msg: string): CommandResult => ({ output: [err(`Error: ${msg}`)] });
const domains = (d: Parameters<SonicCmd["run"]>[1]["device"]) => cpList(d, "mclag", "domains");
const DFLT_SESSION_TIMEOUT = 15; // mclag.py:223 (default assumed by the dependency check)
const DFLT_KEEPALIVE = 1;

function domainOf(ctx: Parameters<SonicCmd["run"]>[1], id: string): Record<string, unknown> | undefined {
  return domains(ctx.device).find((x) => String(x.domain_id) === id);
}

/** mclag_ka_session_dep_check (mclag.py:25-34). */
function kaSessionCheck(ka: number, st: number): string | undefined {
  if (!(st >= 3 * ka)) return `MCLAG Keepalive:${ka} Session_timeout:${st} values not satisfying session_timeout >= (3 * KA) `;
  if (st % ka) return `MCLAG keepalive:${ka} Session_timeout:${st} Values not satisfying session_timeout should be a multiple of KA`;
  return undefined;
}

const PO_RE = /^PortChannel(\d{1,4})$/; // is_portchannel_name_valid (mclag.py:52-63)

const config: SonicCmd[] = [
  {
    path: ["mclag", "add"],
    summary: "Add MCLAG Domain: <domain_id> <source_ip_addr> <peer_ip_addr> [<peer_ifname>]",
    run(args, ctx): CommandResult {
      const [idTok, src, peer, peerIf] = positional(args);
      if (!idTok || !src || !peer) return { output: [err("Usage: config mclag add [OPTIONS] <domain_id> <source_ip_addr> <peer_ip_addr> [<peer_ifname>]")] };
      const id = Number(idTok);
      if (!Number.isInteger(id)) return fail(`Invalid value for '<domain_id>': '${idTok}' is not a valid integer.`);
      if (id < 1 || id > 4095) return fail(`${id} invalid domain ID, valid range is 1 to 4095`);
      if (!isValidIpv4(src)) return fail(`${src} invalid local ip address`);
      if (!isValidIpv4(peer)) return fail(`${peer} invalid peer ip address`);
      if (peerIf !== undefined && !peerIf.startsWith("Ethernet") && !peerIf.startsWith("PortChannel")) {
        return fail("peer interface is invalid, should be Ethernet interface or portChannel !!");
      }
      const existing = domains(ctx.device);
      if (existing.length && !existing.some((x) => String(x.domain_id) === String(id))) {
        return fail(`only one mclag Domain can be configured. Already one domain ${existing[0].domain_id} configured `);
      }
      cpUpsert(ctx.device, "mclag", "domains", { domain_id: String(id), source_ip: src, peer_ip: peer, ...(peerIf ? { peer_link: peerIf } : {}) }, "domain_id");
      return { output: [] };
    },
  },
  {
    path: ["mclag", "del"],
    summary: "Delete MCLAG Domain (and its MCLAG interfaces)",
    run(args, ctx): CommandResult {
      const id = positional(args)[0];
      if (!id) return { output: [err("Usage: config mclag del [OPTIONS] <domain_id>")] };
      const n = Number(id);
      if (!Number.isInteger(n) || n < 1 || n > 4095) return fail(`${id} invalid domain ID, valid range is 1 to 4095`);
      if (!domainOf(ctx, String(n))) return fail(`MCLAG Domain ${n} not configured `);
      const out: OutputLine[] = [line("MCLAG Domain delete takes care of deleting all associated MCLAG Interfaces")];
      for (const i of cpList(ctx.device, "mclag", "interfaces").filter((x) => String(x.domain_id) === String(n))) {
        cpRemove(ctx.device, "mclag", "interfaces", "key", i.key);
      }
      cpRemove(ctx.device, "mclag", "domains", "domain_id", String(n));
      cpRemove(ctx.device, "mclag", "domains", "domain_id", n);
      return { output: out };
    },
  },
  {
    path: ["mclag", "keepalive-interval"],
    summary: "Configure MCLAG Keepalive timer value in secs",
    run(args, ctx): CommandResult {
      const [id, secs] = positional(args);
      if (!id || secs === undefined) return { output: [err("Usage: config mclag keepalive-interval [OPTIONS] <domain_id> <time_in_secs>")] };
      const dom = domainOf(ctx, id);
      if (!dom) return fail(`MCLAG Domain ${id} not configured, configure mclag domain first`);
      const ka = Number(secs);
      if (!Number.isInteger(ka) || ka < 1 || ka > 60) return fail(`Keepalive ${secs} not in valid range[1-60]`);
      const e = kaSessionCheck(ka, dom.session_timeout !== undefined ? Number(dom.session_timeout) : DFLT_SESSION_TIMEOUT);
      if (e) return fail(e);
      cpUpsert(ctx.device, "mclag", "domains", { domain_id: dom.domain_id, keepalive_interval: ka }, "domain_id");
      return { output: [] };
    },
  },
  {
    path: ["mclag", "session-timeout"],
    summary: "Configure MCLAG Session timeout value in secs",
    run(args, ctx): CommandResult {
      const [id, secs] = positional(args);
      if (!id || secs === undefined) return { output: [err("Usage: config mclag session-timeout [OPTIONS] <domain_id> <time_in_secs>")] };
      const dom = domainOf(ctx, id);
      if (!dom) return fail(`MCLAG Domain ${id} not configured, configure mclag domain first`);
      const st = Number(secs);
      if (!Number.isInteger(st) || st < 3 || st > 3600) return fail(`Session timeout ${secs} not in valid range[3-3600]`);
      const e = kaSessionCheck(dom.keepalive_interval !== undefined ? Number(dom.keepalive_interval) : DFLT_KEEPALIVE, st);
      if (e) return fail(e);
      cpUpsert(ctx.device, "mclag", "domains", { domain_id: dom.domain_id, session_timeout: st }, "domain_id");
      return { output: [] };
    },
  },
  {
    path: ["mclag", "member", "add"],
    summary: "Add member MCLAG interfaces to an MCLAG Domain",
    run: (args, ctx) => member(args, ctx, true),
  },
  {
    path: ["mclag", "member", "del"],
    summary: "Delete member MCLAG interfaces from an MCLAG Domain",
    run: (args, ctx) => member(args, ctx, false),
  },
];

function member(args: string[], ctx: Parameters<SonicCmd["run"]>[1], add: boolean): CommandResult {
  const [id, names] = positional(args);
  if (!id || !names) return { output: [err(`Usage: config mclag member ${add ? "add" : "del"} [OPTIONS] <domain_id> <portchannel_names>`)] };
  if (add && !domainOf(ctx, id)) return fail(`MCLAG Domain ${id} not configured, configure mclag domain first`);
  for (const po of names.split(",")) {
    if (!PO_RE.test(po)) return fail(`${po} is invalid!, name should have prefix 'PortChannel' and suffix '<0-9999>'`);
    // MCLAG_INTERFACE key domain|ifname, {'if_type': "PortChannel"} (mclag.py:293); same rows as KLISH.
    const key = `${id}|${po}`;
    if (add) cpUpsert(ctx.device, "mclag", "interfaces", { key, domain_id: id, if_name: po, if_type: "PortChannel" }, "key");
    else cpRemove(ctx.device, "mclag", "interfaces", "key", key);
  }
  return { output: [] };
}

export const mclagModule: SonicFeatureModule = { id: "mclag", config, show: [] };
