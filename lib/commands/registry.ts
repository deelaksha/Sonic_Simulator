/**
 * Allowed-command registry (spec §41, §44). ONLY commands registered here can
 * run — this is the security boundary that prevents arbitrary host execution.
 * `help` is defined here because it needs the full command list.
 */
import { CommandHandler, CommandResult, OutputLine, line, muted, err } from "./types";
import { pingCommand } from "./ping";
import { ipCommand } from "./ip";
import { arpCommand } from "./arp";
import { tcpdumpCommand } from "./tcpdump";
import { tracerouteCommand } from "./traceroute";
import { hostnameCommand, clearCommand, ifconfigCommand, routeCommand } from "./misc";
import { ntpdateCommand, dhclientCommand } from "./udpclients";
import { nslookupCommand } from "./nslookup";
import { vrrpCommand } from "./vrrp";
import { ping6Command } from "./ping6";
import { ospfCommand } from "./ospfctl";
import { bgpCommand } from "./bgpctl";
import { configCommand, showCommand } from "./sonic";

const sudoCommand: CommandHandler = {
  name: "sudo",
  cli: "sonic",
  summary: "Run a SONiC/click command with elevated privilege",
  usage: "sudo <command> ...",
  help: ["SUDO", "", "Usage:", "  sudo <command> ...", "", "Runs the given command (e.g. `sudo config vlan add 100`)."],
  run(args, ctx): CommandResult {
    if (args.length === 0) return { output: [err("usage: sudo <command> ...")] };
    const sub = resolveCommand(args[0]);
    if (!sub) return { output: [err(`sudo: ${args[0]}: command not found`)] };
    return sub.run(args.slice(1), ctx);
  },
};

const helpCommand: CommandHandler = {
  name: "help",
  aliases: ["?", "man"],
  summary: "List commands or show help for one command",
  usage: "help [command]",
  help: ["HELP", "", "Usage:", "  help            list all commands", "  help <command>  detailed help for a command"],
  run(args): CommandResult {
    const target = args[0];
    if (target) {
      const h = resolveCommand(target);
      if (!h) return { output: [err(`help: no such command: ${target}`)] };
      return { output: h.help.map((t) => line(t)) };
    }
    const out: OutputLine[] = [line("Available commands:", "heading")];
    for (const h of COMMANDS) {
      out.push(line(`  ${h.name.padEnd(12)} ${h.summary}`));
    }
    out.push(line(""));
    out.push(muted("Type `help <command>` for details. Commands run against the simulated network."));
    return { output: out };
  },
};

export const COMMANDS: CommandHandler[] = [
  pingCommand,
  ping6Command,
  tracerouteCommand,
  ipCommand,
  arpCommand,
  tcpdumpCommand,
  ntpdateCommand,
  dhclientCommand,
  nslookupCommand,
  vrrpCommand,
  ospfCommand,
  bgpCommand,
  routeCommand,
  ifconfigCommand,
  hostnameCommand,
  clearCommand,
  helpCommand,
  // SONiC CLI (task §12-§18)
  configCommand,
  showCommand,
  sudoCommand,
];

const byName = new Map<string, CommandHandler>();
for (const h of COMMANDS) {
  byName.set(h.name, h);
  for (const alias of h.aliases ?? []) byName.set(alias, h);
}

export function resolveCommand(name: string): CommandHandler | undefined {
  return byName.get(name);
}

/** Names + aliases, for tab completion in the terminal UI. */
export function commandNames(): string[] {
  return Array.from(byName.keys()).sort();
}
