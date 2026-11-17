/**
 * sFlow KLISH (sonic-cli) behaviour, from sonic-mgmt-framework
 * (sonic-buildimage 202505-smci-dev-oc):
 *
 * configure-view (CLI/clitree/cli-xml/sflow.xml, actioner sonic_cli_sflow.py):
 *   [no] sflow enable
 *   sflow collector <ip> [<port>] [vrf default|mgmt]   — bare port (commit ccbe1d0)
 *   no sflow collector <ip> [<port>] [vrf <name>]
 *   [no] sflow agent-id <intf>            (Ethernet N | Vlan N | Management N …)
 *   [no] sflow polling-interval <0|5-300>
 *   [no] sflow sampling-rate <256-8388608> — stored in SFLOW|global, display only
 * configure-if-view (interface.xml):
 *   [no] sflow enable   /   [no] sflow sampling-rate <256-8388608>
 * enable-view:
 *   show running-configuration sflow → show_sflow_running_global/_interfaces
 *   show sflow                → templates/show_sflow.j2
 *   show sflow interface [if] → templates/show_sflow_intf.j2 (APPL_DB sessions)
 *
 * Collectors are keyed `{ip}_{port}_{vrf}` (xfmr_sflow.go); max 2 (YANG
 * max-elements). The shared state lives in lib/sflow/agent.ts.
 */
import { err, line, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { interfaceByName } from "../../../models/device";
import { DEFAULT_COLLECTOR_PORT, peekSflowState, sflowSessions, sflowState } from "../../../sflow/agent";
import { MAX_COLLECTORS, SAMPLE_RATE_RANGE, isCollectorIp, isValidPolling, natCompare } from "../../sonic/sflow";

const INVALID = '% Error: Invalid input detected at "^" marker.';

/** KLISH interface tokens: "Ethernet 0" / "Ethernet0" / "Vlan 10" / "Management 0". */
function joinIfName(tokens: string[]): string | undefined {
  if (!tokens.length) return undefined;
  if (/^[A-Za-z]+$/.test(tokens[0]) && tokens[1] !== undefined && /^\d+$/.test(tokens[1])) return tokens[0] + tokens[1];
  return tokens[0];
}

function intTok(tok: string | undefined): number | null {
  return tok !== undefined && /^\d+$/.test(tok) ? Number(tok) : null;
}

registerModal({
  id: "sflow",
  views: ["configure-view", "configure-if-view"],
  keywords: ["sflow"],
  run({ view, isNo, args, ifname, ctx }) {
    const sub = args[0]?.toLowerCase();
    const st = sflowState(ctx.device);

    // --- per-interface session (configure-if-view) ---
    if (view === "configure-if-view") {
      const name = ifname ?? "";
      if (!interfaceByName(ctx.device, name)) return null;
      const entry = (st.interfaces[name] ??= {});
      if (sub === "enable") {
        entry.enabled = !isNo;
        return { output: [] };
      }
      if (sub === "sampling-rate") {
        if (isNo) {
          delete entry.sampleRate; // back to the port-speed default
          return { output: [] };
        }
        const rate = intTok(args[1]);
        if (rate === null || rate < SAMPLE_RATE_RANGE.min || rate > SAMPLE_RATE_RANGE.max) return { output: [err(INVALID)] };
        entry.sampleRate = rate;
        return { output: [] };
      }
      return null;
    }

    // --- global (configure-view) ---
    if (sub === "enable") {
      st.enabled = !isNo;
      return { output: [] };
    }
    if (sub === "collector") {
      const ip = args[1];
      if (!ip || !isCollectorIp(ip)) return { output: [err(INVALID)] };
      let i = 2;
      let port = DEFAULT_COLLECTOR_PORT;
      if (args[i] !== undefined && args[i].toLowerCase() !== "vrf") {
        const p = intTok(args[i]);
        if (p === null || p < 1 || p > 65535) return { output: [err(INVALID)] };
        port = p;
        i += 1;
      }
      let vrf = "default";
      if (args[i]?.toLowerCase() === "vrf") {
        vrf = args[i + 1] ?? "";
        if (vrf !== "default" && vrf !== "mgmt") return { output: [err(INVALID)] };
        i += 2;
      }
      if (args.length > i) return { output: [err(INVALID)] };
      const name = `${ip}_${port}_${vrf}`;
      const existing = st.collectors.find((c) => c.name === name);
      if (isNo) {
        if (!existing) return { output: [err("Error: Collector entry not found")] };
        st.collectors = st.collectors.filter((c) => c !== existing);
        return { output: [] };
      }
      if (!existing) {
        if (st.collectors.length >= MAX_COLLECTORS) return { output: [err(`%Error: Max elements limit ${MAX_COLLECTORS} reached`)] };
        st.collectors.push({ name, ip, port, vrf });
      }
      return { output: [] };
    }
    if (sub === "agent-id") {
      if (isNo) {
        st.agentId = undefined;
        return { output: [] };
      }
      const intf = joinIfName(args.slice(1));
      if (!intf) return { output: [err(INVALID)] };
      st.agentId = intf;
      return { output: [] };
    }
    if (sub === "polling-interval") {
      if (isNo) {
        st.pollingInterval = undefined;
        return { output: [] };
      }
      const n = intTok(args[1]);
      if (n === null || !isValidPolling(n)) return { output: [err(INVALID)] };
      st.pollingInterval = n;
      return { output: [] };
    }
    if (sub === "sampling-rate") {
      if (isNo) {
        st.sampleRate = undefined;
        return { output: [] };
      }
      const n = intTok(args[1]);
      if (n === null || n < SAMPLE_RATE_RANGE.min || n > SAMPLE_RATE_RANGE.max) {
        return { output: [err("Error: Sampling rate must be between 256 and 8388608")] };
      }
      st.sampleRate = n;
      return { output: [] };
    }
    return null;
  },
});

// enable-view: `show sflow` / `show sflow interface [<if>]` (source j2 templates).
registerModal({
  id: "sflow-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a0 = args[0]?.toLowerCase();
    // show running-configuration sflow (sonic_cli_sflow.py show_sflow_running_*)
    if ((a0 === "running-configuration" || a0 === "running-config") && args[1]?.toLowerCase() === "sflow") {
      const st = peekSflowState(ctx.device);
      const out: OutputLine[] = [];
      if (st?.enabled) out.push(line("sflow enable"));
      if (st?.pollingInterval !== undefined) out.push(line(`sflow polling-interval ${st.pollingInterval}`));
      if (st?.agentId) out.push(line(`sflow agent-id ${st.agentId}`));
      if (st?.sampleRate !== undefined) out.push(line(`sflow sampling-rate ${st.sampleRate}`));
      for (const c of st?.collectors ?? []) {
        out.push(line(`sflow collector ${c.ip}${c.port !== DEFAULT_COLLECTOR_PORT ? ` ${c.port}` : ""} vrf ${c.vrf}`));
      }
      // Interfaces with a CONFIG_DB row that is not admin down.
      for (const [name, cfg] of Object.entries(st?.interfaces ?? {}).sort(([a], [b]) => natCompare(a, b))) {
        if (cfg.enabled === false || (cfg.enabled === undefined && cfg.sampleRate === undefined)) continue;
        out.push(line(`interface ${name}`), line(" sflow enable"));
        if (cfg.sampleRate !== undefined) out.push(line(` sflow sampling-rate ${cfg.sampleRate}`));
        out.push(line("!"));
      }
      return { output: out };
    }
    if (a0 !== "sflow") return null;
    if (args[1]?.toLowerCase() === "interface") {
      const only = joinIfName(args.slice(2));
      const sessions = sflowSessions(ctx.device)
        .filter((s) => !only || s.port === only)
        .sort((a, b) => natCompare(a.port, b.port));
      const out: OutputLine[] = [line("sFlow interface configurations")];
      if (!sessions.length) return { output: [...out, line("No sFlow interfaces configured")] };
      const sep = "+-------------+---------------+-----------------+";
      out.push(line(sep), line("| Interface   | Admin State   |   Sampling Rate |"), line("+=============+===============+=================+"));
      for (const s of sessions) {
        out.push(line(`| ${s.port.padEnd(11)} | ${s.adminState.padEnd(13)} | ${String(s.sampleRate).padStart(15)} |`), line(sep));
      }
      return { output: out };
    }
    if (args.length > 1) return null;
    const st = peekSflowState(ctx.device);
    const collectors = st?.collectors ?? [];
    const out: OutputLine[] = [
      line("sFlow Global Information:"),
      line(`  sFlow Admin State:          ${st?.enabled ? "up" : "down"}`),
      line(`  sFlow Polling Interval:     ${st?.pollingInterval ?? "default"}`),
    ];
    if (st?.sampleRate !== undefined) out.push(line(`  sFlow Sampling Rate:        ${st.sampleRate}`));
    out.push(line(`  sFlow AgentID:              ${st?.agentId ?? "default"}`), line(""));
    out.push(line(`  ${collectors.length} Collector${collectors.length !== 1 ? "s" : ""} configured:`));
    for (const c of collectors) {
      out.push(line(`    Name: ${c.ip}_${c.port}_${c.vrf}    IP addr: ${c.ip}    UDP port: ${c.port}   VRF: ${c.vrf}`));
    }
    return { output: out };
  },
});
