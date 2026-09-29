/**
 * kdump — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# kdump enable            store enabled=true
 *   sonic(config)# no kdump                store enabled=false
 *   sonic(config)# kdump memory 512M       store reserved memory
 *   sonic(config)# no kdump memory         reset memory to default (clear)
 *   sonic(config)# kdump num-dumps 5       store max local core files (1..9)
 *   sonic(config)# no kdump num-dumps      reset num-dumps to default (clear)
 *   sonic# show kdump [status|memory|num-dumps]   render from stored state
 *
 * Mirrors CONFIG_DB KDUMP|config (enabled / memory / num_dumps). Only configured
 * values are rendered. Runtime aspects — operational state, allocated memory,
 * the actual kernel core dump files (`show kdump files` / `show kdump log`) — are
 * NOT simulated; they are never fabricated.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet } from "../config-plane";

// KDUMP_MEMORY ptype from the real klish grammar (kdump.xml).
const MEMORY_RE = /^(((([0-9]+[MG])?(-([0-9]+[MG])?):)?[0-9]+[MG],?)+)$/;

const REBOOT_NOTE = "Kdump configuration changes will be applied after the system reboots.";
const SAVE_NOTE = "Save SONiC configuration using 'write memory' before issuing the reboot command.";

// configure-view: kdump enable / memory / num-dumps (+ their `no` forms).
registerModal({
  id: "kdump",
  views: ["configure-view"],
  keywords: ["kdump"],
  run({ isNo, args, ctx }) {
    const sub = (args[0] ?? "").toLowerCase();

    // `no kdump`  -> disable ;  `kdump enable` -> enable
    if (isNo && sub === "") {
      cpSet(ctx.device, "kdump", "enabled", false);
      return { output: [muted(REBOOT_NOTE), muted(SAVE_NOTE)] };
    }
    if (!isNo && sub === "enable") {
      cpSet(ctx.device, "kdump", "enabled", true);
      return { output: [muted(REBOOT_NOTE), muted(SAVE_NOTE)] };
    }

    // memory
    if (sub === "memory") {
      if (isNo) {
        cpUnset(ctx.device, "kdump", "memory");
        return { output: [] };
      }
      const mem = args[1] ?? "";
      if (!MEMORY_RE.test(mem)) return { output: [err("% Invalid kdump memory value (e.g. 512M).")] };
      cpSet(ctx.device, "kdump", "memory", mem);
      return { output: [muted("Kdump updated memory will be only operational after the system reboots."), muted(SAVE_NOTE)] };
    }

    // num-dumps
    if (sub === "num-dumps") {
      if (isNo) {
        cpUnset(ctx.device, "kdump", "num_dumps");
        return { output: [] };
      }
      const n = Number(args[1]);
      if (!Number.isInteger(n) || n < 1 || n > 9) return { output: [err("% kdump num-dumps must be an integer 1..9.")] };
      cpSet(ctx.device, "kdump", "num_dumps", n);
      return { output: [] };
    }

    return { output: [err("% Usage: kdump {enable | memory <mem> | num-dumps <1-9>}")] };
  },
});

// enable-view: show kdump [status|memory|num-dumps|files|log]. Renders from store.
registerModal({
  id: "kdump-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "kdump") return null; // not ours
    const st = cpGet(ctx.device, "kdump") ?? {};
    const sub = (args[1] ?? "status").toLowerCase();

    if (sub === "memory") {
      return { output: st.memory ? [line(`Memory Reserved: ${st.memory}`)] : [muted("Memory Reserved: not configured")] };
    }
    if (sub === "num-dumps") {
      return {
        output: st.num_dumps !== undefined
          ? [line(`Maximum number of Kernel Core files Stored: ${st.num_dumps}`)]
          : [muted("Maximum number of Kernel Core files Stored: not configured")],
      };
    }
    if (sub === "files" || sub === "log") {
      return { output: [muted(`% show kdump ${sub}: kernel core dump files are runtime data, not simulated`)] };
    }

    // status (default): reflect configured admin mode + configured values only.
    const out = [line(`Kdump Administrative Mode:  ${st.enabled === true ? "Enabled" : "Disabled"}`)];
    if (st.memory) out.push(line(`Memory Reserved: ${st.memory}`));
    if (st.num_dumps !== undefined) out.push(line(`Maximum number of Kernel Core files Stored: ${st.num_dumps}`));
    return { output: out };
  },
});
