/**
 * `logger` (util-linux) — write a message to the system log.
 *
 *   logger [-i] [-s] [-t tag] [-p facility.level] message...
 *
 * util-linux semantics: priority default user.notice; tag default the login name
 * (`admin` on SONiC, the shell user on PCs/servers); -i adds the PID ("tag[pid]:");
 * -s also prints the message to stderr. The line lands in the device's syslog
 * (`show logging`) and is forwarded to remote servers like any other line.
 * Not modelled: reading stdin, -f file, -n/-P/-T/-d (logging directly to a remote server).
 */
import { CommandHandler, CommandResult, err, line } from "./types";
import { isSwitch } from "../models/device";
import { FACILITY, SEVERITIES, fakePid, logEvent, rfc3164 } from "../control/syslog";

// util-linux misc-utils/logger.c prioritynames / facilitynames (syslog.h)
const LEVELS: Record<string, number> = { emerg: 0, panic: 0, alert: 1, crit: 2, err: 3, error: 3, warning: 4, warn: 4, notice: 5, info: 6, debug: 7 };
const FACS: Record<string, number> = { ...FACILITY, security: FACILITY.auth };

function parsePriority(s: string): { facility: number; level: number } | string {
  const [f, l] = s.includes(".") ? [s.slice(0, s.lastIndexOf(".")), s.slice(s.lastIndexOf(".") + 1)] : [undefined, s];
  let facility: number = FACILITY.user;
  if (f !== undefined) {
    const n = /^\d+$/.test(f) ? Number(f) : FACS[f.toLowerCase()];
    if (n === undefined) return `unknown facility name: ${f}`;
    facility = n;
  }
  const level = /^\d+$/.test(l) ? Number(l) : LEVELS[l.toLowerCase()];
  if (level === undefined || level > 7) return `unknown priority name: ${l}`;
  return { facility, level };
}

export const loggerCommand: CommandHandler = {
  name: "logger",
  summary: "enter messages into the system log",
  usage: "logger [-i] [-s] [-t tag] [-p facility.level] message...",
  help: [
    "Usage:",
    " logger [options] [<message>]",
    "",
    "Enter messages into the system log.",
    "",
    "Options:",
    " -i                       log the logger command's PID",
    " -p, --priority <prio>    mark given message with this priority",
    " -s, --stderr             output message to standard error as well",
    " -t, --tag <tag>          mark every line with this tag",
  ],
  run(args, ctx): CommandResult {
    let tag: string | undefined;
    let prio = { facility: FACILITY.user as number, level: 5 };
    let withPid = false;
    let stderr = false;
    const words: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (words.length === 0 && (a === "-t" || a === "--tag")) tag = args[++i];
      else if (words.length === 0 && a.startsWith("--tag=")) tag = a.slice(6);
      else if (words.length === 0 && (a === "-p" || a === "--priority" || a.startsWith("--priority="))) {
        const v = a.startsWith("--priority=") ? a.slice(11) : args[++i];
        if (v === undefined) return { output: [err(`logger: option requires an argument -- 'p'`)] };
        const p = parsePriority(v);
        if (typeof p === "string") return { output: [err(`logger: ${p}`)] };
        prio = p;
      } else if (words.length === 0 && (a === "-i" || a === "--id")) withPid = true;
      else if (words.length === 0 && (a === "-s" || a === "--stderr")) stderr = true;
      else if (words.length === 0 && a === "--") continue;
      else if (words.length === 0 && /^-[a-zA-Z]/.test(a)) return { output: [err(`logger: invalid option -- '${a.replace(/^-+/, "")}'`), err("Try 'logger --help' for more information.")] };
      else words.push(a);
    }
    if (tag === undefined) tag = isSwitch(ctx.device.type) ? "admin" : ctx.device.config.hostname.toLowerCase().replace(/\s+/g, "-");
    if (!words.length) return { output: [err("logger: reading messages from standard input is not supported in this simulator")] };
    const message = words.join(" ");
    const pid = withPid ? fakePid(`logger|${message}`) : null;
    const now = Date.now();
    logEvent(ctx.device, now, SEVERITIES[prio.level], tag, message, { facility: prio.facility, pid });
    if (!stderr) return { output: [] };
    const t = pid === null ? `${tag}:` : `${tag}[${pid}]:`;
    return { output: [line(`<${prio.facility * 8 + prio.level}>${rfc3164(now)} ${t} ${message}`)] };
  },
};
