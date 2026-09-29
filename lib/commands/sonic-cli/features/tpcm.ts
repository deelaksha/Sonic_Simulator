/**
 * TPCM (Third-Party Container Manager) — CONFIG-PLANE feature (no engine/packet
 * backend; store + show). Models the box's installed-container config honestly.
 *
 *   sonic# tpcm install name <c> image <img> [args <a>] [cargs <c>]
 *                                            [vrf-name <v>]
 *                                            [start-after-system-ready True|False]
 *   sonic# tpcm install name <c> url|pull|file <path> ...
 *   sonic# tpcm install name <c> scp|sftp <host> username <u> password <p>
 *                                            filename <f> ...
 *   sonic# tpcm upgrade name <c> <method> <src> [skip-data-migration yes|no] ...
 *   sonic# tpcm update disk-limit <val>                  (global disk limit)
 *   sonic# tpcm update name <c> [vrf-name <v>] [memory <m>]
 *                               [start-after-system-ready True|False]
 *   sonic# tpcm uninstall name <c> [clean_data yes|no]
 *   sonic# show tpcm [name <c>] | show tpcm list [vrf-name <v>]
 *
 * Real box: data/device-capture/klish-xml/tpcm.xml exposes these in enable-view
 * and each is a `clish_pyobj sonic_cli_tpcm ...` action that pulls/installs a
 * Docker image and records the container in CONFIG_DB. We store exactly the
 * install spec that was configured (name, method, source, args, vrf, memory,
 * start-after-system-ready) and render it back on `show tpcm`. We follow the
 * config-plane convention of the other templates (banner/logging/ssh) and accept
 * the write commands in configure-view, because the shared modal engine
 * (lib/commands/sonic-cli.ts) only routes `show` to handlers in enable-view.
 *
 * DATA-PLANE NOT SIMULATED: no Docker image is fetched or run, and no runtime
 * container state (running/stopped, image id/size, uptime) is modelled or
 * fabricated — only the configured install spec is stored and shown.
 */
import { OutputLine, line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpUpsert, cpRemove, cpGet, cpList } from "../config-plane";
import { Device } from "../../../models/device";

const METHODS = ["url", "image", "pull", "file", "scp", "sftp"];
const REMOTE = ["scp", "sftp"]; // methods that take host + username/password/filename

/** Normalise a TRUE_FALSE value; undefined if not True/False. */
function normBool(v: string | undefined): string | undefined {
  const s = (v ?? "").toLowerCase();
  return s === "true" ? "True" : s === "false" ? "False" : undefined;
}

/** Parse the method's source token(s); returns the source string + next index. */
function parseSource(method: string, args: string[], i: number): { source: string; next: number } {
  if (!REMOTE.includes(method)) return { source: args[i] ?? "", next: i + 1 };
  // scp/sftp: <host> [username <u>] [password <p>] [filename <f>]
  const host = args[i] ?? "";
  let user = "";
  let file = "";
  let j = i + 1;
  while (j < args.length) {
    const kw = args[j].toLowerCase();
    if (kw === "username") { user = args[j + 1] ?? ""; j += 2; }
    else if (kw === "password") { j += 2; } // secret — consumed, never stored/shown
    else if (kw === "filename") { file = args[j + 1] ?? ""; j += 2; }
    else break;
  }
  const source = `${user ? user + "@" : ""}${host}${file ? ":" + file : ""}`;
  return { source, next: j };
}

/** Parse trailing optional keyword/value pairs into `item`; error object on bad value. */
function parseOptions(args: string[], start: number, item: Record<string, unknown>): { error: string } | null {
  for (let i = start; i < args.length;) {
    const kw = (args[i] ?? "").toLowerCase();
    const val = args[i + 1];
    switch (kw) {
      case "args": item.args = val; i += 2; break;
      case "cargs": item.cargs = val; i += 2; break;
      case "vrf-name": item.vrf = val; i += 2; break;
      case "memory": item.memory = val; i += 2; break;
      case "skip-data-migration": i += 2; break; // install-time flag, not persistent config
      case "start-after-system-ready": {
        const b = normBool(val);
        if (!b) return { error: "% start-after-system-ready must be True|False" };
        item.dependency = b;
        i += 2;
        break;
      }
      default: i += 1; // ignore stray token
    }
  }
  return null;
}

/** The container name following a `name` keyword (install/upgrade/update/uninstall). */
function nameAfter(args: string[]): string | undefined {
  const i = args.findIndex((a) => a.toLowerCase() === "name");
  return i >= 0 ? args[i + 1] : undefined;
}

function findContainer(device: Device, name: string | undefined): Record<string, unknown> | undefined {
  return cpList(device, "tpcm", "containers").find((c) => c.name === name);
}

// configure-view: tpcm install / upgrade / update / uninstall (writes config-plane).
registerModal({
  id: "tpcm",
  views: ["configure-view"],
  keywords: ["tpcm"],
  run({ isNo, args, ctx }) {
    const sub = (args[0] ?? "").toLowerCase();

    // `no ...` — remove the named container, or clear the global disk-limit.
    if (isNo) {
      if (sub === "update" && (args[1] ?? "").toLowerCase() === "disk-limit") {
        cpUnset(ctx.device, "tpcm", "disk_limit");
        return { output: [] };
      }
      const name = nameAfter(args);
      if (!name) return { output: [err("% expected `name <container-name>`")] };
      cpRemove(ctx.device, "tpcm", "containers", "name", name);
      return { output: [] };
    }

    if (!sub) return { output: [] }; // bare `tpcm` (parent) — no-op

    // tpcm install name <c> <method> <src> [opts]
    if (sub === "install" || sub === "upgrade") {
      if ((args[1] ?? "").toLowerCase() !== "name") return { output: [err("% expected `name <container-name>`")] };
      const name = args[2];
      if (!name) return { output: [err("% container name required")] };
      const method = (args[3] ?? "").toLowerCase();
      if (!METHODS.includes(method)) return { output: [err(`% install method must be one of ${METHODS.join("|")}`)] };
      const { source, next } = parseSource(method, args, 4);
      if (!source) return { output: [err("% install source required")] };
      if (sub === "upgrade" && !findContainer(ctx.device, name))
        return { output: [err(`% no such TPC container: ${name}`)] };
      const item: Record<string, unknown> = { name, method, source };
      const e = parseOptions(args, next, item);
      if (e) return { output: [err(e.error)] };
      cpUpsert(ctx.device, "tpcm", "containers", item, "name");
      return { output: [] };
    }

    // tpcm update disk-limit <v>  |  tpcm update name <c> [opts]
    if (sub === "update") {
      const what = (args[1] ?? "").toLowerCase();
      if (what === "disk-limit") {
        const val = args[2];
        if (!val) return { output: [err("% disk-limit value required")] };
        cpSet(ctx.device, "tpcm", "disk_limit", val);
        return { output: [] };
      }
      if (what === "name") {
        const name = args[2];
        if (!findContainer(ctx.device, name)) return { output: [err(`% no such TPC container: ${name ?? ""}`)] };
        const item: Record<string, unknown> = { name };
        const e = parseOptions(args, 3, item);
        if (e) return { output: [err(e.error)] };
        cpUpsert(ctx.device, "tpcm", "containers", item, "name");
        return { output: [] };
      }
      return { output: [err("% tpcm update: expected `disk-limit` or `name`")] };
    }

    // tpcm uninstall name <c> [clean_data yes|no]
    if (sub === "uninstall") {
      const name = nameAfter(args);
      if (!name) return { output: [err("% expected `name <container-name>`")] };
      cpRemove(ctx.device, "tpcm", "containers", "name", name);
      return { output: [] };
    }

    return { output: [err("% tpcm: expected install|upgrade|update|uninstall")] };
  },
});

const cell = (v: unknown) => (v === undefined || v === "" ? "-" : String(v));

function renderList(containers: Record<string, unknown>[], diskLimit: string | undefined): OutputLine[] {
  const head: OutputLine[] = diskLimit !== undefined ? [line(`Overall disk-limit: ${diskLimit}`), line("")] : [];
  if (!containers.length) return [...head, muted("No TPC containers installed")];
  const row = (a: string, b: string, c: string, d: string) =>
    a.padEnd(20) + b.padEnd(34) + c.padEnd(12) + d;
  const dash = "-".repeat(90);
  const out: OutputLine[] = [
    ...head,
    line(dash),
    line(row("NAME", "IMAGE-SOURCE", "VRF", "START-AFTER-SYSTEM-READY")),
    line(dash),
  ];
  for (const c of containers) {
    out.push(line(row(cell(c.name), `${cell(c.method)}:${cell(c.source)}`, cell(c.vrf), cell(c.dependency))));
  }
  return out;
}

function renderDetail(c: Record<string, unknown>): OutputLine[] {
  const rows: [string, unknown][] = [
    ["Container", c.name],
    ["Install-method", c.method],
    ["Source", c.source],
    ["Startup-args", c.args],
    ["Container-command", c.cargs],
    ["VRF", c.vrf],
    ["Memory-limit", c.memory],
    ["Start-after-system-ready", c.dependency],
  ];
  return rows.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => line(`${k.padEnd(26)}: ${String(v)}`));
}

// enable-view: show tpcm [name <c>] | show tpcm list [vrf-name <v>].
registerModal({
  id: "tpcm-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "tpcm") return null; // not ours
    const containers = cpList(ctx.device, "tpcm", "containers");
    const diskLimit = cpGet(ctx.device, "tpcm")?.disk_limit as string | undefined;
    const sub = (args[1] ?? "").toLowerCase();

    if (sub === "name") {
      const name = args[2];
      const c = containers.find((x) => x.name === name);
      if (!c) return { output: [muted(`No TPC container named "${name ?? ""}"`)] };
      return { output: renderDetail(c) };
    }

    // `show tpcm list [vrf-name <v>]` / bare `show tpcm` -> the installed-container table.
    let list = containers;
    if (sub === "list" && (args[2] ?? "").toLowerCase() === "vrf-name") {
      const vrf = args[3];
      list = containers.filter((c) => c.vrf === vrf);
    }
    return { output: renderList(list, diskLimit) };
  },
});
