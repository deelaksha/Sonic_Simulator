/**
 * CONFIG_DB persistence Click commands (sonic-utilities config/main.py, show/main.py):
 *
 *   show runningconfiguration all       show/main.py:1747 — CONFIG_DB as JSON (indent 4, sorted)
 *   config save   [-y] [<file>]         main.py:1699 — sonic-cfggen -d --print-data > config_db.json
 *   config load   [-y] [<file>]         main.py:1757 — sonic-cfggen -j <file> --write-to-db (merge)
 *   config reload [-y] [-f] [<file>]    main.py:2026 — stop services, flush CONFIG_DB, load, restart
 *
 * `show runningconfiguration snmp` stays in ./snmp.ts (longer path wins there).
 * The "file" lives in the simulated device (lib/sonicdb/persist.ts); there is no
 * real filesystem, so only files written by `config save` can be loaded.
 */
import { CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { configDbJson } from "../../sonicdb/project";
import { isSonicDevice } from "../../sonicdb/config-db";
import { DEFAULT_CONFIG_FILE, restoreConfig, saveConfig, savedFile } from "../../sonicdb/persist";

const CFGGEN = "/usr/local/bin/sonic-cfggen";
const running = (cmd: string): OutputLine => line(`Running command: ${cmd}`);
const notSonic = (): CommandResult => ({ output: [err("Error: CONFIG_DB persistence is only available on SONiC switches")] });

function fileArg(args: string[]): string {
  const f = positional(args)[0];
  if (!f) return DEFAULT_CONFIG_FILE;
  return f.includes(",") ? f.split(",")[0] : f;
}

function missing(file: string): CommandResult {
  return {
    output: [
      err(`Error: '${file}' does not exist.`),
      muted("(simulator) Only files written by `config save [file]` exist on this device — run `config save -y` first."),
    ],
  };
}

const config: SonicCmd[] = [
  {
    path: ["save"],
    summary: "Export current config DB to a file on disk (config save [-y] [file])",
    run(args, ctx): CommandResult {
      if (!isSonicDevice(ctx.device)) return notSonic();
      const file = fileArg(args);
      const out: OutputLine[] = [];
      if (!args.includes("-y") && !args.includes("--yes")) out.push(line("Existing files will be overwritten, continue? [y/N]: y"));
      saveConfig(ctx.device, file);
      out.push(running(`${CFGGEN} -d --print-data > ${file}`));
      return { output: out };
    },
  },
  {
    path: ["load"],
    summary: "Import a previous saved config DB dump file (config load [-y] [file])",
    run(args, ctx): CommandResult {
      if (!isSonicDevice(ctx.device)) return notSonic();
      const file = fileArg(args);
      const out: OutputLine[] = [];
      if (!args.includes("-y") && !args.includes("--yes")) {
        out.push(line(file === DEFAULT_CONFIG_FILE ? "Load config from the default config file(s) ? [y/N]: y" : `Load config from the file(s) ${file} ? [y/N]: y`));
      }
      const snap = savedFile(ctx.device, file);
      if (!snap) return missing(file);
      restoreConfig(ctx.device, ctx.network, snap, "load");
      out.push(running(`${CFGGEN} -j ${file} --write-to-db`));
      return { output: out };
    },
  },
  {
    path: ["reload"],
    summary: "Clear current configuration and import a previous saved config DB dump file",
    run(args, ctx): CommandResult {
      if (!isSonicDevice(ctx.device)) return notSonic();
      const file = fileArg(args);
      const out: OutputLine[] = [];
      if (!args.includes("-y") && !args.includes("--yes")) {
        out.push(
          line(
            file === DEFAULT_CONFIG_FILE
              ? "Clear current config and reload config in config_db format from the default config file(s) ? [y/N]: y"
              : `Clear current config and reload config in config_db from the file(s) ${file} ? [y/N]: y`,
          ),
        );
      }
      const snap = savedFile(ctx.device, file);
      if (!snap) return missing(file);
      restoreConfig(ctx.device, ctx.network, snap, "reload");
      out.push(
        line("Acquired lock on /etc/sonic/reload.lock"),
        line("Disabling container monitoring ..."),
        line("Stopping SONiC target ..."),
        running(`${CFGGEN} -j /etc/sonic/init_cfg.json -j ${file} --write-to-db`),
        running("/usr/local/bin/db_migrator.py -o migrate"),
        line("Restarting SONiC target ..."),
        line("Enabling container monitoring ..."),
        line("Reloading Monit configuration ..."),
        line("Reinitializing monit daemon"),
        line("Released lock on /etc/sonic/reload.lock"),
        muted("(simulator) swss/bgp/teamd/lldp restarted: ARP/FDB flushed, protocol routes withdrawn — daemons re-converge on their timers."),
      );
      return { output: out };
    },
  },
];

const show: SonicCmd[] = [
  {
    path: ["runningconfiguration", "all"],
    summary: "Show full running configuration (CONFIG_DB as JSON)",
    run(_args, ctx): CommandResult {
      if (!isSonicDevice(ctx.device)) return notSonic();
      return { output: configDbJson(ctx.device).split("\n").map((t) => line(t)) };
    },
  },
];

export const sonicdbModule: SonicFeatureModule = { id: "sonicdb", config, show };
