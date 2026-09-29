/**
 * SSH-VRF — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# ssh-server                     enable the SSH server (global)
 *   sonic(config)# no ssh-server                  disable the SSH server (global)
 *   sonic(config)# ssh-server vrf <vrf-name>      enable the SSH server on a VRF
 *   sonic(config)# no ssh-server vrf <vrf-name>   disable the SSH server on a VRF
 *   sonic# show ssh-server                        render global server config
 *   sonic# show ssh-server vrf all                render per-VRF status table
 *   sonic# show ssh-server vrf <vrf-name>         render one VRF's status
 *
 * Real box: CONFIG_DB SSH_SERVER_VRF table (SSH_SERVER_VRF_LIST keyed by
 * vrf_name); see data/device-capture/klish-xml/ssh-vrf.xml. We store exactly the
 * VRFs on which the SSH server was enabled and render them back in the golden
 * `show ssh-server vrf` format — nothing is fabricated. The runtime effect (the
 * sshd daemon actually binding to / listening in the given VRF, and accepting
 * live SSH sessions there) is a data-plane behaviour the sim does not simulate.
 */
import { OutputLine, line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpUpsert, cpRemove, cpGet, cpList } from "../config-plane";

const COL = 32; // each column is 32 chars wide, matching the golden dash rule

/** Centre a value in a fixed-width column (the box centres these cells). */
function centre(s: string, w: number): string {
  if (s.length >= w) return s;
  const left = Math.floor((w - s.length) / 2);
  return " ".repeat(left) + s + " ".repeat(w - s.length - left);
}

// configure-view: `ssh-server` (global) and `ssh-server vrf <vrf-name>`.
registerModal({
  id: "ssh-vrf",
  views: ["configure-view"],
  keywords: ["ssh-server"],
  run({ isNo, args, ctx }) {
    const sub = (args[0] ?? "").toLowerCase();

    // Plain `ssh-server` / `no ssh-server` — global server enable/disable.
    if (!sub) {
      cpSet(ctx.device, "ssh-vrf", "enabled", !isNo);
      return { output: [] };
    }

    if (sub === "vrf") {
      const vrf = args[1];
      if (!vrf) return { output: [err("% VRF name required")] };
      if (isNo) {
        cpRemove(ctx.device, "ssh-vrf", "vrfs", "vrf_name", vrf);
        return { output: [] };
      }
      cpUpsert(ctx.device, "ssh-vrf", "vrfs", { vrf_name: vrf, status: "enable" }, "vrf_name");
      return { output: [] };
    }

    return { output: [err(`% ssh-server: unexpected argument "${args[0]}"`)] };
  },
});

// enable-view: `show ssh-server` and `show ssh-server vrf [all|<vrf-name>]`.
registerModal({
  id: "ssh-vrf-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "ssh-server") return null; // not ours

    // `show ssh-server vrf [all|<vrf-name>]`
    if (args[1]?.toLowerCase() === "vrf") {
      const target = args[2];
      let vrfs = cpList(ctx.device, "ssh-vrf", "vrfs");
      if (target && target.toLowerCase() !== "all") {
        vrfs = vrfs.filter((v) => v.vrf_name === target);
      }
      if (!vrfs.length) return { output: [muted("No SSH server VRFs configured")] };
      const dash = "-".repeat(COL);
      const out: OutputLine[] = [
        line(" " + centre("VRF Name", COL) + " " + centre("Status", COL)),
        line(" " + dash + " " + dash),
      ];
      for (const v of vrfs) {
        out.push(line(" " + centre(String(v.vrf_name), COL) + " " + centre(String(v.status), COL)));
      }
      return { output: out };
    }

    // `show ssh-server` — global server config (only what was configured).
    const st = cpGet(ctx.device, "ssh-vrf") ?? {};
    if (st.enabled === undefined) return { output: [muted("SSH server not configured")] };
    return { output: [line(`SSH server: ${st.enabled ? "Enabled" : "Disabled"}`)] };
  },
});
