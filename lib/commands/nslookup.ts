/**
 * nslookup — resolve a hostname via DNS (UDP/53), the same "reach a configured
 * server over the network" model as NTP. Sends a real DNS query to the device's
 * configured nameserver (or a given server), routed like any packet, so the
 * topology animation / timeline / inspector all light up.
 */
import { CommandHandler, CommandResult, OutputLine, line, err, muted } from "./types";

export const nslookupCommand: CommandHandler = {
  name: "nslookup",
  summary: "Resolve a hostname via DNS (UDP/53)",
  usage: "nslookup <hostname> [server-ip]",
  help: [
    "NSLOOKUP",
    "",
    "Usage:",
    "  nslookup <hostname> [server-ip]",
    "",
    "Sends a real DNS query over UDP/53 to a configured nameserver (config dns",
    "nameserver add <ip>) or the server given as the 2nd argument — reached by",
    "routing, exactly like the real resolver.",
  ],
  run(args, ctx): CommandResult {
    const pos = args.filter((a) => !a.startsWith("-"));
    const name = pos[0];
    const server = pos[1];
    if (!name) return { output: [err("nslookup: usage: nslookup <hostname> [server-ip]")] };

    const { value: r, events } = ctx.runSim((sim) => sim.runDnsResolve(ctx.device.id, name, server));
    if (!r.ok || !r.address) {
      const why =
        r.reason === "no-nameserver"
          ? "no nameserver configured — add one with `config dns nameserver add <ip>`"
          : r.reason === "no-route"
            ? `no route to nameserver ${r.server}`
            : r.reason === "timeout"
              ? `no response from ${r.server}`
              : r.reason ?? "resolution failed";
      return { output: [err(`nslookup: can't resolve '${name}': ${why}`)], events };
    }
    const out: OutputLine[] = [
      muted(`Server:\t\t${r.server}`),
      muted(`Address:\t${r.server}#53`),
      line(""),
      line(`Name:\t${name}`),
      line(`Address: ${r.address}`, "success"),
    ];
    return { output: out, events };
  },
};
