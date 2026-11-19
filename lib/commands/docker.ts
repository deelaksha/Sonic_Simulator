/**
 * `docker` on a SONiC switch — the subset SONiC operators (and sonic-utilities'
 * `show services`, show/main.py:2170-2184) use:
 *
 *   docker ps [-a] [--format '{{.Names}}']   running SONiC containers (one per enabled FEATURE)
 *   docker exec <container> ps [aux]         processes inside a container (its supervisord programs)
 *
 * Containers and their state come from the FEATURE table
 * (lib/protocols/cpu-features.ts): enabled features run, disabled ones are
 * stopped (`docker ps -a` shows them Exited). Docker-daemon details (image ids,
 * ports, real uptimes) are not modelled; uptime counts from when the simulator
 * first saw the container or from the last `config feature state` change.
 */
import { CommandHandler, CommandResult, err, line } from "./types";
import { isSwitch } from "../models/device";
import { containerId, containerPs, containerTimes, featureRows, FeatureRow } from "../protocols/cpu-features";

/** docker/go-units HumanDuration. */
export function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 1) return "Less than a second";
  if (s === 1) return "1 second";
  if (s < 60) return `${s} seconds`;
  const m = Math.floor(s / 60);
  if (m === 1) return "About a minute";
  if (m < 60) return `${m} minutes`;
  const h = Math.round(m / 60);
  if (h === 1) return "About an hour";
  if (h < 48) return `${h} hours`;
  return `${Math.floor(h / 24)} days`;
}

const running = (r: FeatureRow) => r.state === "enabled" || r.state === "always_enabled";

function ps(args: string[], ctx: Parameters<CommandHandler["run"]>[1]): CommandResult {
  const all = args.includes("-a") || args.includes("--all");
  const fi = args.indexOf("--format");
  const format = fi >= 0 ? (args[fi + 1] ?? "").replace(/^['"]|['"]$/g, "") : undefined;
  const now = Date.now();
  const times = containerTimes(ctx.device);
  const rows = featureRows(ctx.device)
    .filter((r) => r.state !== "always_disabled" && (all || running(r)))
    .map((r) => {
      const t = (times[r.name] ??= {});
      t.startedMs ??= now;
      const up = running(r);
      const status = up ? `Up ${humanDuration(now - t.startedMs)}` : `Exited (0) ${humanDuration(now - (t.exitedMs ?? now))} ago`;
      return [containerId(ctx.device, r.name), `${r.image}:latest`, '"/usr/local/bin/supe…"', `${humanDuration(now - t.startedMs)} ago`, status, "", r.name];
    });
  if (format !== undefined) {
    if (format !== "{{.Names}}") return { output: [err(`docker ps: only --format '{{.Names}}' is supported in the simulator`)] };
    return { output: rows.map((r) => line(r[6])) };
  }
  const header = ["CONTAINER ID", "IMAGE", "COMMAND", "CREATED", "STATUS", "PORTS", "NAMES"];
  const w = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (c: string[]) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(w[i]))).join("   ");
  return { output: [line(fmt(header)), ...rows.map((r) => line(fmt(r)))] };
}

function exec(args: string[], ctx: Parameters<CommandHandler["run"]>[1]): CommandResult {
  const rest = args.filter((a) => a !== "-it" && a !== "-i" && a !== "-t");
  const name = rest[0];
  const cmd = rest.slice(1);
  if (!name || cmd.length === 0) return { output: [err('"docker exec" requires at least 2 arguments.')] };
  const row = featureRows(ctx.device).find((r) => r.name === name);
  if (!row) return { output: [err(`Error response from daemon: No such container: ${name}`)] };
  if (!running(row)) return { output: [err(`Error response from daemon: Container ${containerId(ctx.device, name)} is not running`)] };
  if (cmd[0] !== "ps") return { output: [err(`docker exec: only 'ps [aux]' is simulated inside containers`)] };
  return { output: [...containerPs(ctx.device, row), `root    ${String(999).padStart(8)}  0.0  0.0   8000  3000 ?        Rs   00:00   0:00 ps aux`].map((t) => line(t)) };
}

export const dockerCommand: CommandHandler = {
  name: "docker",
  cli: "sonic",
  summary: "List SONiC containers / run ps inside one",
  usage: "docker ps [-a] [--format '{{.Names}}'] | docker exec <container> ps aux",
  help: [
    "DOCKER",
    "",
    "Usage:",
    "  docker ps [-a]                    list SONiC containers (one per enabled FEATURE)",
    "  docker ps --format '{{.Names}}'   container names only",
    "  docker exec <container> ps aux    processes inside a container",
    "",
    "Containers follow `show feature status`; `config feature state <f> disabled` stops one.",
  ],
  run(args, ctx): CommandResult {
    if (!isSwitch(ctx.device.type)) return { output: [err("bash: docker: command not found")] };
    if (args[0] === "ps") return ps(args.slice(1), ctx);
    if (args[0] === "exec") return exec(args.slice(1), ctx);
    return { output: [err(`docker: '${args[0] ?? ""}' is not supported in the simulator (try: docker ps, docker exec <c> ps aux)`)] };
  },
};
