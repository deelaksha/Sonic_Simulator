/**
 * VLAN SONiC feature module (task §22, §54). Reference implementation other
 * feature modules follow. Commands are traceable to vlan.txt in the catalog.
 *
 *   config vlan add <id>              show vlan brief
 *   config vlan del <id>             show vlan
 *   config vlan member add [-u] <id> <port>
 *   config vlan member del <id> <port>
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { isSwitch } from "../../models/device";
import { addVlan, delVlan, addMember, delMember, listVlans, vlanMembers } from "../../models/vlan-ops";

function needSwitch(ctx: CommandContext, what: string): OutputLine | null {
  return isSwitch(ctx.device.type) ? null : err(`${what}: ${ctx.device.name} is not a switch`);
}

function parseId(tok: string | undefined): number {
  return Number(tok);
}

const config: SonicCmd[] = [
  {
    path: ["vlan", "add"],
    summary: "Create a VLAN",
    run(args, ctx): CommandResult {
      const guard = needSwitch(ctx, "config vlan add");
      if (guard) return { output: [guard] };
      const id = parseId(positional(args)[0]);
      if (!id) return { output: [err("Usage: config vlan add <vlan-id>")] };
      const r = addVlan(ctx.device, id);
      return { output: r.ok ? [muted(`VLAN ${id} added`)] : [err(r.error!)] };
    },
  },
  {
    path: ["vlan", "del"],
    summary: "Delete a VLAN",
    run(args, ctx): CommandResult {
      const guard = needSwitch(ctx, "config vlan del");
      if (guard) return { output: [guard] };
      const id = parseId(positional(args)[0]);
      if (!id) return { output: [err("Usage: config vlan del <vlan-id>")] };
      const r = delVlan(ctx.device, id);
      return { output: r.ok ? [muted(`VLAN ${id} deleted`)] : [err(r.error!)] };
    },
  },
  {
    path: ["vlan", "member", "add"],
    summary: "Add a port to a VLAN (tagged by default, -u for untagged/access)",
    run(args, ctx): CommandResult {
      const guard = needSwitch(ctx, "config vlan member add");
      if (guard) return { output: [guard] };
      const untagged = args.includes("-u") || args.includes("--untagged");
      const pos = positional(args);
      const id = parseId(pos[0]);
      const port = pos[1];
      if (!id || !port) return { output: [err("Usage: config vlan member add [-u] <vlan-id> <port>")] };
      const r = addMember(ctx.device, id, port, !untagged);
      return {
        output: r.ok
          ? [muted(`${port} ${untagged ? "untagged (access)" : "tagged (trunk)"} in VLAN ${id}`)]
          : [err(r.error!)],
      };
    },
  },
  {
    path: ["vlan", "member", "del"],
    summary: "Remove a port from a VLAN",
    run(args, ctx): CommandResult {
      const guard = needSwitch(ctx, "config vlan member del");
      if (guard) return { output: [guard] };
      const pos = positional(args);
      const id = parseId(pos[0]);
      const port = pos[1];
      if (!id || !port) return { output: [err("Usage: config vlan member del <vlan-id> <port>")] };
      const r = delMember(ctx.device, id, port);
      return { output: r.ok ? [muted(`${port} removed from VLAN ${id}`)] : [err(r.error!)] };
    },
  },
];

function renderVlanBrief(ctx: CommandContext): OutputLine[] {
  const vlans = [...listVlans(ctx.device)].sort((a, b) => a.id - b.id);
  if (vlans.length === 0) return [muted("No VLANs configured")];
  const out: OutputLine[] = [
    line("+-----------+-----------------+-----------------+----------------+"),
    line("| VLAN ID   | IP Address      | Ports           | Port Tagging   |"),
    line("+-----------+-----------------+-----------------+----------------+"),
  ];
  for (const v of vlans) {
    const members = vlanMembers(ctx.device, v.id);
    if (members.length === 0) {
      out.push(line(`| ${String(v.id).padEnd(9)} | ${"".padEnd(15)} | ${"".padEnd(15)} | ${"".padEnd(14)} |`));
    } else {
      members.forEach((m, i) => {
        out.push(
          line(
            `| ${(i === 0 ? String(v.id) : "").padEnd(9)} | ${"".padEnd(15)} | ${m.port.padEnd(15)} | ${(m.tagged ? "tagged" : "untagged").padEnd(14)} |`,
          ),
        );
      });
    }
  }
  out.push(line("+-----------+-----------------+-----------------+----------------+"));
  return out;
}

const show: SonicCmd[] = [
  { path: ["vlan", "brief"], summary: "Show VLAN membership table", run: (_a, ctx) => ({ output: renderVlanBrief(ctx) }) },
  {
    path: ["vlan"],
    summary: "Show VLANs (optionally one VLAN id)",
    run(args, ctx): CommandResult {
      const guard = needSwitch(ctx, "show vlan");
      if (guard) return { output: [guard] };
      const id = parseId(positional(args)[0]);
      if (id) {
        if (!listVlans(ctx.device).some((v) => v.id === id)) return { output: [muted(`Vlan${id} absent`)] };
        const members = vlanMembers(ctx.device, id);
        const out = [line(`VLAN ${id} (Vlan${id})`)];
        if (members.length === 0) out.push(muted("  no members"));
        for (const m of members) out.push(line(`  ${m.port}  ${m.tagged ? "tagged" : "untagged"}`));
        return { output: out };
      }
      return { output: renderVlanBrief(ctx) };
    },
  },
];

export const vlanModule: SonicFeatureModule = { id: "vlan", config, show };
