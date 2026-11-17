/**
 * HTTP client command (`curl`) — tests web connectivity across the network.
 *
 * Resolves hostnames via DNS (if configured), checks IP routing, verifies reachability,
 * and renders realistic HTTP/1.1 request/response flows.
 */
import { CommandHandler, CommandResult, OutputLine, line, err, muted } from "./types";
import { isValidIpv4 } from "../models/ip";
import { longestPrefixMatch } from "../models/route";

export const curlCommand: CommandHandler = {
  name: "curl",
  summary: "Transfer data from or to a server (HTTP client)",
  usage: "curl [-I|--head] [-v|--verbose] <url>",
  help: [
    "CURL",
    "",
    "Usage:",
    "  curl [-I] [-v] <url>",
    "",
    "Options:",
    "  -I, --head      Show response headers only",
    "  -v, --verbose   Make the operation talkative (show request and response headers)",
    "  -s, --silent    Silent mode",
  ],
  run(args, ctx): CommandResult {
    if (args.length === 0) {
      return { output: [err("curl: try 'curl --help' for more information")] };
    }

    let headOnly = false;
    let verbose = false;
    let url = "";

    for (const a of args) {
      if (a === "-I" || a === "--head") headOnly = true;
      else if (a === "-v" || a === "--verbose") verbose = true;
      else if (a === "-s" || a === "--silent") {
        /* silent */
      } else if (!a.startsWith("-")) {
        url = a;
      }
    }

    if (!url) {
      return { output: [err("curl: no URL specified")] };
    }

    // Parse host from URL
    let host = url.replace(/^https?:\/\//i, "").split("/")[0].split(":")[0];
    let path = "/" + (url.replace(/^https?:\/\//i, "").split("/").slice(1).join("/") || "");

    let targetIp = host;

    // If host is a hostname, resolve via DNS
    if (!isValidIpv4(host)) {
      const { value: dnsRes } = ctx.runSim((sim) => sim.runDnsResolve(ctx.device.id, host));
      if (dnsRes.ok && dnsRes.address) {
        targetIp = dnsRes.address;
      } else {
        // Check if there is a device with this name
        const matchDev = Object.values(ctx.network.devices).find(
          (d) => d.name.toLowerCase() === host.toLowerCase() || d.config.hostname.toLowerCase() === host.toLowerCase(),
        );
        const ifaceWithIp = matchDev?.interfaces.find((i) => i.ipv4.length > 0);
        if (ifaceWithIp && ifaceWithIp.ipv4[0]) {
          targetIp = ifaceWithIp.ipv4[0].address;
        } else {
          return { output: [err(`curl: (6) Could not resolve host: ${host}`)] };
        }
      }
    }

    // Check routing table
    const routeMatch = longestPrefixMatch(ctx.device.routingTable, targetIp);
    if (!routeMatch) {
      return { output: [err(`curl: (7) Failed to connect to ${host}: Network is unreachable`)] };
    }

    // Verify reachability via ping probe
    const { value: pingRes, events } = ctx.runSim((sim) => {
      const p = sim.runPing(ctx.device.id, targetIp, { count: 1 });
      if (p.received > 0) {
        sim.emit({
          type: "HTTP_REQUEST",
          deviceId: ctx.device.id,
          deviceName: ctx.device.name,
          message: `${ctx.device.name}: HTTP GET http://${host}${path} (TCP/80)`,
          osiLayers: [7],
        });
        sim.emit({
          type: "HTTP_RESPONSE",
          deviceId: ctx.device.id,
          deviceName: ctx.device.name,
          message: `${ctx.device.name}: HTTP/1.1 200 OK from ${host} (${targetIp})`,
          osiLayers: [7],
        });
      }
      return p;
    });

    if (pingRes.received === 0) {
      return { output: [err(`curl: (7) Failed to connect to ${host} port 80: Connection refused`)], events };
    }

    const out: OutputLine[] = [];
    const dateStr = new Date().toUTCString();
    const serverName = `nginx/1.24.0 (SONiC Lab)`;
    const contentLength = 186;

    if (verbose) {
      out.push(muted(`* Connected to ${host} (${targetIp}) port 80`));
      out.push(muted(`> GET ${path} HTTP/1.1`));
      out.push(muted(`> Host: ${host}`));
      out.push(muted(`> User-Agent: curl/8.5.0`));
      out.push(muted(`> Accept: */*`));
      out.push(muted(`>`));
      out.push(muted(`< HTTP/1.1 200 OK`));
      out.push(muted(`< Server: ${serverName}`));
      out.push(muted(`< Date: ${dateStr}`));
      out.push(muted(`< Content-Type: text/html; charset=UTF-8`));
      out.push(muted(`< Content-Length: ${contentLength}`));
      out.push(muted(`< Connection: keep-alive`));
      out.push(muted(`<`));
    }

    if (headOnly) {
      if (!verbose) {
        out.push(line("HTTP/1.1 200 OK"));
        out.push(line(`Server: ${serverName}`));
        out.push(line(`Date: ${dateStr}`));
        out.push(line(`Content-Type: text/html; charset=UTF-8`));
        out.push(line(`Content-Length: ${contentLength}`));
        out.push(line(`Connection: keep-alive`));
      }
      return { output: out, events };
    }

    out.push(line("<!DOCTYPE html>"));
    out.push(line("<html>"));
    out.push(line("<head><title>Welcome to SONiC Lab</title></head>"));
    out.push(line("<body>"));
    out.push(line(`<h1>Welcome to SONiC Simulator Web Server!</h1>`));
    out.push(line(`<p>Host: ${host} (${targetIp})</p>`));
    out.push(line("<p>Networking Lab simulation active.</p>"));
    out.push(line("</body>"));
    out.push(line("</html>"));

    return { output: out, events };
  },
};
