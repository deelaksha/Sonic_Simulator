/**
 * sFlow modal behaviour. Delegates to the tested `config sflow` click family so
 * no engine logic is duplicated. Two grammar views, taken from the real KLISH:
 *
 * configure-view (data/device-capture/klish-xml/sflow.xml):
 *   sflow enable                                 -> config sflow enable
 *   no sflow enable                              -> config sflow disable
 *   sflow collector <ip> [port <n>] [vrf <name>] -> config sflow collector add <ip> <ip> [--port <n>]
 *   no sflow collector <ip> [<port>] [vrf <name>]-> config sflow collector del <ip>
 *   sflow agent-id <intf>                        -> config sflow agent-id add <intf>
 *   no sflow agent-id                            -> config sflow agent-id del
 *   sflow polling-interval <n>                   -> config sflow polling-interval <n>
 *
 * configure-if-view (data/device-capture/klish-xml/interface.xml):
 *   sflow enable                                 -> config sflow interface enable <ifname>
 *   no sflow enable                              -> config sflow interface disable <ifname>
 *   sflow sampling-rate <n>                      -> config sflow interface sample-rate <ifname> <n>
 *
 * The collector name is not a KLISH field (the real box keys collectors by
 * ip/port/vrf); the click family keys by a <name>, so we use the IP as that name
 * and add/del round-trip. The VRF arg has no click equivalent and is dropped.
 * Commands with no click backing are NOT claimed (run returns null) so the core
 * grammar fallback handles them — see the module's "skipped" list.
 */
import { err } from "../../types";
import { registerModal } from "../registry";

/** Value following a literal keyword token (e.g. "port 4451"); undefined if absent. */
function keywordValue(args: string[], kw: string): string | undefined {
  const i = args.indexOf(kw);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

registerModal({
  id: "sflow",
  views: ["configure-view", "configure-if-view"],
  keywords: ["sflow"],
  run({ view, isNo, args, ifname, delegate }) {
    const sub = args[0]?.toLowerCase();

    // --- per-interface sFlow session (configure-if-view) ---
    if (view === "configure-if-view") {
      const name = ifname ?? "";
      if (sub === "enable") {
        return { output: delegate(`config sflow interface ${isNo ? "disable" : "enable"} ${name}`) };
      }
      if (sub === "sampling-rate" && !isNo) {
        const rate = args[1];
        if (!rate) return { output: [err("% Sampling rate required.")] };
        return { output: delegate(`config sflow interface sample-rate ${name} ${rate}`) };
      }
      // `no sflow sampling-rate` (reset to default) has no click equivalent.
      return null;
    }

    // --- global sFlow (configure-view) ---
    if (sub === "enable") {
      return { output: delegate(`config sflow ${isNo ? "disable" : "enable"}`) };
    }
    if (sub === "collector") {
      const ip = args[1];
      if (!ip) return { output: [err("% Collector IP required.")] };
      if (isNo) return { output: delegate(`config sflow collector del ${ip}`) };
      const port = keywordValue(args, "port");
      const cmd = `config sflow collector add ${ip} ${ip}${port ? ` --port ${port}` : ""}`;
      return { output: delegate(cmd) };
    }
    if (sub === "agent-id") {
      if (isNo) return { output: delegate("config sflow agent-id del") };
      const intf = args[1];
      if (!intf) return { output: [err("% Agent interface required.")] };
      return { output: delegate(`config sflow agent-id add ${intf}`) };
    }
    if (sub === "polling-interval" && !isNo) {
      const n = args[1];
      if (!n) return { output: [err("% Polling interval required.")] };
      return { output: delegate(`config sflow polling-interval ${n}`) };
    }

    // Not claimed (no click backing): bare `sflow`/`no sflow`,
    // `no sflow polling-interval`, `sflow max-header-size`, global `sflow sampling-rate`.
    return null;
  },
});
