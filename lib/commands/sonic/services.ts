/**
 * SONiC containers / FEATURE table — Click commands (sonic-utilities):
 *
 *   show services                                   show/main.py:2170-2184: for each `docker ps`
 *                                                   name, "<name>\tdocker", a rule, then
 *                                                   `docker exec <name> ps aux` minus its last line
 *   show feature status [<name>]                    show/feature.py:40-89 (Feature/State/AutoRestart)
 *   show feature autorestart [<name>]
 *   config feature state <name> enabled|disabled    config/feature.py:11-34,115-127
 *   config feature autorestart <name> enabled|disabled
 *
 * State is the FEATURE table (lib/protocols/cpu-features.ts), shared with the
 * KLISH `feature state` modal. Disabling a feature stops its container: it
 * leaves `docker ps`, and the CPU path (lib/protocols/cpu-daemon.ts) drops
 * trapped packets for processes in it (lldp → LLDPDUs, teamd → LACPDUs,
 * bgp → BGP/OSPF/BFD, snmp, dhcp_relay); coppmgr also uninstalls the
 * feature-gated trap (copp_cfg.j2:221-227). The daemons' own transmissions
 * are not stopped (they live in frozen files).
 */
import { CommandResult, OutputLine, err, line } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { cpUpsert } from "../sonic-cli/config-plane";
import { containerPs, featureRows, setContainerRunning } from "../../protocols/cpu-features";
import { dockerCommand } from "../docker";

/** tabulate default ("simple") with disable_numparse. */
function table(header: string[], rows: string[][]): OutputLine[] {
  const w = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (c: string[]) => c.map((v, i) => v.padEnd(w[i])).join("  ").replace(/\s+$/, "");
  return [line(fmt(header)), line(w.map((n) => "-".repeat(n)).join("  ")), ...rows.map((r) => line(fmt(r)))];
}

function featureShow(which: "status" | "autorestart"): SonicCmd["run"] {
  return (args, ctx): CommandResult => {
    const name = positional(args)[0];
    let rows = featureRows(ctx.device);
    if (name) {
      rows = rows.filter((r) => r.name === name);
      if (!rows.length) return { output: [err(`Can not find feature ${name}`)] };
    }
    if (which === "autorestart") return { output: table(["Feature", "AutoRestart"], rows.map((r) => [r.name, r.autoRestart])) };
    return { output: table(["Feature", "State", "AutoRestart"], rows.map((r) => [r.name, r.state, r.autoRestart])) };
  };
}

function featureSet(field: "state" | "autorestart"): SonicCmd["run"] {
  return (args, ctx): CommandResult => {
    const [name, value] = positional(args);
    if (!name || !value) return { output: [err(`Usage: config feature ${field} <feature-name> <${field}>`)] };
    if (value !== "enabled" && value !== "disabled") {
      return { output: [err(`Error: Invalid value for '<${field}>': '${value}' is not one of 'enabled', 'disabled'.`)] };
    }
    const row = featureRows(ctx.device).find((r) => r.name === name);
    if (!row) return { output: [err(`Feature '${name}' doesn't exist`)] };
    if (field === "state") {
      if (row.state === "always_enabled") return { output: [err(`Feature '${name}' state is always enabled and can not be modified`)] };
      cpUpsert(ctx.device, "feature", "features", { name, state: value }, "name");
      if (row.state !== value) setContainerRunning(ctx.device, name, value === "enabled", Date.now());
      return { output: [] };
    }
    if (row.autoRestart === "always_enabled") return { output: [line(`Feature '${name}' auto-restart is always enabled and can not be modified`)] };
    cpUpsert(ctx.device, "feature", "features", { name, autorestart: value }, "name");
    return { output: [] };
  };
}

function services(_args: string[], ctx: Parameters<SonicCmd["run"]>[1]): CommandResult {
  const names = dockerCommand.run(["ps", "--format", "{{.Names}}"], ctx).output.map((o) => o.text);
  const rows = featureRows(ctx.device);
  const out: OutputLine[] = [];
  for (const n of names) {
    const row = rows.find((r) => r.name === n)!;
    out.push(line(`${n}\tdocker`), line("---------------------------"), ...containerPs(ctx.device, row).map((t) => line(t)));
  }
  return { output: out };
}

const show: SonicCmd[] = [
  { path: ["services"], summary: "Show all daemon services (per container ps)", run: services },
  { path: ["feature", "status"], summary: "Show feature state", run: featureShow("status") },
  { path: ["feature", "autorestart"], summary: "Show auto-restart state for a feature", run: featureShow("autorestart") },
];

const config: SonicCmd[] = [
  { path: ["feature", "state"], summary: "Enable/disable a feature (starts/stops its container)", run: featureSet("state") },
  { path: ["feature", "autorestart"], summary: "Enable/disable autorestart of a feature", run: featureSet("autorestart") },
];

export const servicesModule: SonicFeatureModule = { id: "services", config, show };
