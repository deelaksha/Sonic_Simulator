/**
 * VRF SONiC feature module. Config-plane only (simulated CONFIG_DB): commands
 * mutate per-device feature state and `show vrf` renders SOLELY from that stored
 * state. There is NO per-VRF forwarding/routing isolation here — real VRF
 * separation needs packet-engine work that is not present yet, so this module
 * deliberately models the config surface (create VRFs, bind interfaces) only and
 * does not fabricate per-VRF forwarding.
 *
 * Commands map to the SONiC/KLISH forms in vrf.txt. They are namespaced under
 * ["vrf", ...] so interface binding does not touch the interface module:
 *
 *   config vrf add <name>              <- ip vrf <name>            (SONiC click: config vrf add)
 *   config vrf del <name>              <- no ip vrf <name>         (SONiC click: config vrf del)
 *   config vrf member add <name> <if>  <- interface <if> ; ip vrf forwarding <name>
 *   config vrf member del <name> <if>  <- interface <if> ; no ip vrf forwarding <name>
 *   show vrf [<name>]                  <- show ip vrf [<name>]
 *
 * Validation (per task, config-plane): duplicate `vrf add` is rejected; binding
 * to a non-existent interface is rejected (interfaceByName); binding also
 * requires the target VRF to exist. An interface lives in exactly one VRF, so a
 * re-bind moves it (matching vrf.txt TC-35/TC-36 move semantics).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { interfaceByName } from "../../models/device";

interface Vrf {
  name: string;
  interfaces: string[];
}

interface VrfState {
  vrfs: Vrf[];
}

function state(ctx: CommandContext): VrfState {
  return featureState<VrfState>(ctx.device, "vrf", () => ({ vrfs: [] }));
}

const config: SonicCmd[] = [
  {
    path: ["vrf", "add"],
    summary: "Create a VRF",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config vrf add <vrf-name>")] };
      const st = state(ctx);
      if (st.vrfs.some((v) => v.name === name)) {
        return { output: [err(`config vrf add: VRF ${name} already exists`)] };
      }
      st.vrfs.push({ name, interfaces: [] });
      return { output: [muted(`VRF ${name} added`)] };
    },
  },
  {
    path: ["vrf", "del"],
    summary: "Delete a VRF",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config vrf del <vrf-name>")] };
      const st = state(ctx);
      const before = st.vrfs.length;
      st.vrfs = st.vrfs.filter((v) => v.name !== name);
      return {
        output: [muted(st.vrfs.length < before ? `VRF ${name} deleted` : `VRF ${name} not configured (no-op)`)],
      };
    },
  },
  {
    path: ["vrf", "member", "add"],
    summary: "Bind an interface to a VRF",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const name = pos[0];
      const iface = pos[1];
      if (!name || !iface) return { output: [err("Usage: config vrf member add <vrf-name> <interface>")] };
      const st = state(ctx);
      const vrf = st.vrfs.find((v) => v.name === name);
      if (!vrf) return { output: [err(`config vrf member add: VRF ${name} does not exist`)] };
      if (!interfaceByName(ctx.device, iface)) {
        return { output: [err(`config vrf member add: interface ${iface} not found`)] };
      }
      // An interface belongs to exactly one VRF: detach from any other VRF first.
      for (const v of st.vrfs) v.interfaces = v.interfaces.filter((i) => i !== iface);
      vrf.interfaces.push(iface);
      return { output: [muted(`${iface} bound to VRF ${name}`)] };
    },
  },
  {
    path: ["vrf", "member", "del"],
    summary: "Unbind an interface from a VRF",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const name = pos[0];
      const iface = pos[1];
      if (!name || !iface) return { output: [err("Usage: config vrf member del <vrf-name> <interface>")] };
      const st = state(ctx);
      const vrf = st.vrfs.find((v) => v.name === name);
      if (!vrf) return { output: [err(`config vrf member del: VRF ${name} does not exist`)] };
      const before = vrf.interfaces.length;
      vrf.interfaces = vrf.interfaces.filter((i) => i !== iface);
      return {
        output: [
          muted(vrf.interfaces.length < before ? `${iface} unbound from VRF ${name}` : `${iface} not bound to VRF ${name} (no-op)`),
        ],
      };
    },
  },
];

function renderVrfs(ctx: CommandContext, filter?: string): OutputLine[] {
  const stored = peekFeatureState<VrfState>(ctx.device, "vrf")?.vrfs ?? [];
  const vrfs = filter ? stored.filter((v) => v.name === filter) : stored;
  if (vrfs.length === 0) return [muted(filter ? `VRF ${filter} not configured` : "No VRFs configured")];
  const out: OutputLine[] = [line(`${"VRF".padEnd(13)}Interfaces`)];
  for (const v of vrfs) {
    if (v.interfaces.length === 0) {
      out.push(line(v.name));
    } else {
      v.interfaces.forEach((iface, i) => {
        out.push(line(`${(i === 0 ? v.name : "").padEnd(13)}${iface}`));
      });
    }
  }
  return out;
}

const show: SonicCmd[] = [
  {
    path: ["vrf"],
    summary: "Show VRFs and their bound interfaces (optionally one VRF)",
    run: (args, ctx) => ({ output: renderVrfs(ctx, positional(args)[0]) }),
  },
];

export const vrfModule: SonicFeatureModule = { id: "vrf", config, show };
