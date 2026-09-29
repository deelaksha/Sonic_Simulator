/**
 * RADIUS modal behaviour. Real KLISH grammar lives in configure-view
 * (data/device-capture/klish-xml/radius.xml). All config commands share the
 * first keyword "radius-server"; the subcommand selects the action. Each maps
 * onto the existing, tested Click `config radius ...` set (lib/commands/sonic/radius.ts)
 * so no engine logic is duplicated.
 *
 *   radius-server nas-ip <ip>              -> config radius nasip <ip>
 *   radius-server statistics <en|dis>      -> config radius statistics <v>
 *   radius-server timeout <1-60>           -> config radius timeout <n>
 *   radius-server retransmit <0-10>        -> config radius retransmit <n>
 *   radius-server key <secret> [encrypted] -> config radius passkey <secret>
 *   radius-server auth-type <pap|chap|mschapv2> -> config radius authtype <t>
 *   radius-server host <ip> [auth-port N] [auth-type T] [key K [encrypted]]
 *        [priority P] [retransmit R] [timeout T] [source-interface <type> <if>]
 *        [vrf <mgmt|name>]                 -> config radius add <ip> [-o -a -k -p -r -t -s --vrf/-m]
 *   no radius-server host <ip>             -> config radius delete <ip>
 *
 * Skipped (no Click equivalent — see structured "skipped"):
 *   - global unconfigure: no radius-server nas-ip|key|auth-type|timeout|retransmit
 *   - per-attribute host unconfigure: no radius-server host <ip> <attribute>
 *   - host protocol <udp|tls> / security-profile <name> options
 */
import { err, muted } from "../../types";
import { registerModal } from "../registry";

/** Build a `config radius add <ip> ...` string from the KLISH host subcommands. */
function buildHostAdd(args: string[]): string {
  const ip = args[1];
  const rest = args.slice(2);
  const flags: string[] = [];
  const push = (flag: string, val: string | undefined) => {
    if (val !== undefined) flags.push(flag, val);
  };
  for (let i = 0; i < rest.length; i++) {
    switch (rest[i].toLowerCase()) {
      case "auth-port":
        push("-o", rest[++i]);
        break;
      case "auth-type":
        push("-a", rest[++i]?.toLowerCase());
        break;
      case "priority":
        push("-p", rest[++i]);
        break;
      case "retransmit":
        push("-r", rest[++i]);
        break;
      case "timeout":
        push("-t", rest[++i]);
        break;
      case "key":
        push("-k", rest[++i]);
        if (rest[i + 1]?.toLowerCase() === "encrypted") i++; // hidden marker: no Click flag
        break;
      case "source-interface": {
        // grammar: source-interface <iftype> <ifvalue>; Click stores one string.
        const iftype = rest[++i];
        const val = rest[++i];
        push("-s", val ?? iftype);
        break;
      }
      case "vrf": {
        const v = rest[++i];
        if (v?.toLowerCase() === "mgmt") flags.push("-m");
        else push("--vrf", v);
        break;
      }
      case "protocol":
      case "security-profile":
        i++; // consume value; Click `add` has no equivalent option
        break;
      default:
        break;
    }
  }
  return `config radius add ${ip} ${flags.join(" ")}`.trim();
}

registerModal({
  id: "radius",
  views: ["configure-view"],
  keywords: ["radius-server"],
  run({ isNo, args, delegate }) {
    const sub = args[0]?.toLowerCase();
    if (!sub) return null; // bare "radius-server" is a no-op container in the grammar

    if (isNo) {
      if (sub === "host") {
        const ip = args[1];
        if (!ip) return { output: [err("% Error: RADIUS server host IP required")] };
        if (args[2]) {
          // per-attribute unconfigure — the Click layer only deletes whole hosts
          return { output: [muted(`(no radius-server host ${ip} ${args[2]}: per-attribute unconfigure not modelled)`)] };
        }
        return { output: delegate(`config radius delete ${ip}`) };
      }
      // global unconfigure has no Click equivalent (globals can be set, not cleared)
      return { output: [muted(`(no radius-server ${sub}: global unconfigure not modelled)`)] };
    }

    switch (sub) {
      case "nas-ip": {
        const ip = args[1];
        if (!ip) return { output: [err("% Error: nas-ip address required")] };
        return { output: delegate(`config radius nasip ${ip}`) };
      }
      case "statistics": {
        const v = args[1]?.toLowerCase();
        if (v !== "enable" && v !== "disable") return { output: [err("% Error: statistics <enable|disable>")] };
        return { output: delegate(`config radius statistics ${v}`) };
      }
      case "timeout": {
        const t = args[1];
        if (!t) return { output: [err("% Error: timeout <1-60> required")] };
        return { output: delegate(`config radius timeout ${t}`) };
      }
      case "retransmit": {
        const r = args[1];
        if (!r) return { output: [err("% Error: retransmit <0-10> required")] };
        return { output: delegate(`config radius retransmit ${r}`) };
      }
      case "key": {
        const key = args[1];
        if (!key) return { output: [err("% Error: shared secret required")] };
        return { output: delegate(`config radius passkey ${key}`) };
      }
      case "auth-type": {
        const t = args[1]?.toLowerCase();
        if (!t) return { output: [err("% Error: auth-type <pap|chap|mschapv2> required")] };
        return { output: delegate(`config radius authtype ${t}`) };
      }
      case "host": {
        if (!args[1]) return { output: [err("% Error: RADIUS server host IP required")] };
        return { output: delegate(buildHostAdd(args)) };
      }
      default:
        return null;
    }
  },
});
