/**
 * Spanning Tree (STP) Click CLI commands.
 */
import { SonicFeatureModule } from "./types";
import { line, err, muted, OutputLine } from "../types";
import { Device, isSwitch } from "../../models/device";
import { cpSet, cpGet } from "../sonic-cli/config-plane";
import { getStpBridgeOper } from "../../protocols/stp-daemon";

export const stpModule: SonicFeatureModule = {
  id: "stp",
  config: [
    {
      path: ["spanning-tree", "priority"],
      summary: "Set spanning-tree bridge priority (0-61440)",
      run(args, ctx) {
        if (!isSwitch(ctx.device.type)) return { output: [err("% Spanning tree is only supported on switches")] };
        const p = Number(args[0]);
        if (!Number.isInteger(p) || p < 0 || p > 61440) {
          return { output: [err("% Priority must be an integer between 0 and 61440")] };
        }
        cpSet(ctx.device, "stp", "priority", p);
        return { output: [line(`Set spanning-tree priority to ${p}`)] };
      },
    },
    {
      path: ["spanning-tree", "mode"],
      summary: "Set spanning-tree mode (pvst|rapid-pvst|mst)",
      run(args, ctx) {
        if (!isSwitch(ctx.device.type)) return { output: [err("% Spanning tree is only supported on switches")] };
        const m = (args[0] ?? "").toLowerCase();
        if (!["pvst", "rapid-pvst", "mst"].includes(m)) {
          return { output: [err("% Mode must be one of pvst|rapid-pvst|mst")] };
        }
        cpSet(ctx.device, "stp", "mode", m);
        return { output: [line(`Set spanning-tree mode to ${m}`)] };
      },
    },
  ],
  show: [
    {
      path: ["spanning-tree"],
      summary: "Show operational spanning-tree status",
      run(_args, ctx) {
        if (!isSwitch(ctx.device.type)) {
          return { output: [muted("% Spanning tree is only supported on switches.")] };
        }
        const st = cpGet(ctx.device, "stp");
        const mode = (st?.mode as string | undefined) ?? "rpvst";
        const oper = ctx.network ? getStpBridgeOper(ctx.network, ctx.device) : undefined;
        const out: OutputLine[] = [line(`Spanning-tree Mode: ${mode.toUpperCase()}`)];

        if (oper) {
          out.push(line(`Root Bridge ID: ${oper.rootBridgeId}`));
          if (oper.isRoot) {
            out.push(line("  This bridge is the root"));
          } else {
            const rpName = oper.rootPortId
              ? ctx.device.interfaces.find((i) => i.id === oper.rootPortId)?.name ?? oper.rootPortId
              : "None";
            out.push(line(`  Root Path Cost: ${oper.rootPathCost}, Root Port: ${rpName}`));
          }
          out.push(line(`Bridge ID: ${oper.bridgeId}`));
          out.push(line(`  Hello Time: ${oper.helloTime} sec, Max Age: ${oper.maxAge} sec, Forward Delay: ${oper.forwardDelay} sec`));
          out.push(line(""));

          const dash = "-".repeat(60);
          out.push(line("Interface    Role    Status    Cost      Prio.Nbr  Type"));
          out.push(line(dash));

          const roleMap: Record<string, string> = { Root: "Root", Designated: "Desg", Alternate: "Altn", Disabled: "Disb" };
          const stateMap: Record<string, string> = { FORWARDING: "FWD", BLOCKING: "BLK", LEARNING: "LRN" };

          const sortedPorts = Object.values(oper.ports).sort((a, b) => a.portNumber - b.portNumber);
          for (const p of sortedPorts) {
            const r = (roleMap[p.role] ?? p.role).padEnd(8);
            const s = (stateMap[p.state] ?? p.state).padEnd(10);
            const c = String(p.cost).padEnd(10);
            const pn = `${p.priority}.${p.portNumber}`.padEnd(10);
            out.push(line(`${p.interfaceName.padEnd(13)}${r}${s}${c}${pn}P2p`));
          }
        }
        return { output: out };
      },
    },
    {
      path: ["stp"],
      summary: "Show operational spanning-tree status (alias)",
      run(args, ctx) {
        return stpModule.show[0].run(args, ctx);
      },
    },
  ],
};
