/**
 * Platform SONiC feature module. Source: platform.txt (20Augcheats).
 *
 * On real SONiC `show platform ...` reads the chassis inventory and sensors off
 * the hardware: system EEPROM, PSUs, fans, thermal probes, SSD SMART data and
 * firmware images. This is a SIMULATED environment (task §41): fabricating
 * realistic sensor readings would be dishonest, so hardware-only queries return
 * an explicit SIMULATION LIMITATION notice instead of invented PSU/fan/temp
 * values. The one query the simulator can answer truthfully is the platform
 * summary, rendered from simulated identity plus the live interface count.
 *
 * Commands (path ["platform", ...]) and the platform.txt forms they map to:
 *   show platform summary       simulated platform identity (task-canonical form)
 *   show platform syseeprom     system EEPROM        -> SIMULATION LIMITATION
 *   show platform psustatus     PSU status           -> SIMULATION LIMITATION
 *   show platform fanstatus     fan status           -> SIMULATION LIMITATION
 *   show platform temperature   thermal sensors      -> SIMULATION LIMITATION
 *   show platform ssdhealth     SSD SMART health     -> SIMULATION LIMITATION (platform.txt SM_ISCLI_26)
 *   show platform firmware version  BIOS/CPLD firmware -> SIMULATION LIMITATION (platform.txt SM_ISCLI_26)
 *
 * Further Click commands (sonic-utilities show/platform.py) print what their
 * helper prints on a SONiC VS, which has no platform sensors or PCIe config:
 *   show platform fan               fanshow: no STATE_DB FAN_INFO      -> "Fan Not detected"
 *   show platform voltage|current   sensorshow -t …: no VOLTAGE/CURRENT_INFO -> "Sensor not detected"
 *   show platform pcieinfo [-c]     pcieutil show|check: no pcie.yaml  -> title line only / PASSED
 *   show platform firmware          fwutil show (a group)              -> its Click usage
 *   show platform                   Click group usage
 *
 * platform.txt has no `config platform ...` forms, so config is empty.
 */
import { CommandContext, CommandResult, OutputLine, line, muted } from "../types";
import { SonicCmd, SonicFeatureModule, clickGroupUsage } from "./types";
import { clickGroup } from "./types";

/** Honest notice for a hardware-only query the simulator cannot model (task §41). */
function simLimit(what: string): OutputLine {
  return muted(`SIMULATION LIMITATION: ${what} is hardware-specific and not modeled in the simulator.`);
}

/** Truthful platform identity from simulated fields + the live interface count. */
function renderSummary(ctx: CommandContext): OutputLine[] {
  return [
    line("Platform: networklab-sim"),
    line("HwSKU: simulated"),
    line("ASIC: simulated"),
    line(`Ports: ${ctx.device.interfaces.filter((i) => !i.management && !i.logical).length}`),
    muted("Note: simulated environment (not a real device)."),
  ];
}

const config: SonicCmd[] = [];

const show: SonicCmd[] = [
  {
    path: ["platform", "summary"],
    summary: "Show simulated platform summary",
    run: (_a, ctx) => ({ output: renderSummary(ctx) }),
  },
  {
    path: ["platform", "syseeprom"],
    summary: "Show system EEPROM (hardware-specific)",
    run: () => ({ output: [simLimit("system EEPROM (syseeprom)")] }),
  },
  {
    path: ["platform", "psustatus"],
    summary: "Show PSU status (hardware-specific)",
    run: () => ({ output: [simLimit("PSU status")] }),
  },
  {
    path: ["platform", "fanstatus"],
    summary: "Show fan status (hardware-specific)",
    run: () => ({ output: [simLimit("fan status")] }),
  },
  {
    path: ["platform", "temperature"],
    summary: "Show thermal sensors (hardware-specific)",
    run: () => ({ output: [simLimit("temperature sensor data")] }),
  },
  {
    path: ["platform", "ssdhealth"],
    summary: "Show SSD health (hardware-specific)",
    run: () => ({ output: [simLimit("SSD health")] }),
  },
  {
    path: ["platform", "firmware", "version"],
    summary: "Show platform firmware version (hardware-specific)",
    run: () => ({ output: [simLimit("platform firmware version")] }),
  },
  { path: ["platform", "fan"], summary: "Show fan status information", run: () => ({ output: [line("Fan Not detected"), line("")] }) },
  { path: ["platform", "voltage"], summary: "Show device voltage information", run: () => ({ output: [line("Sensor not detected")] }) },
  { path: ["platform", "current"], summary: "Show device current information", run: () => ({ output: [line("Sensor not detected")] }) },
  {
    path: ["platform", "pcieinfo"],
    summary: "Show Device PCIe Info",
    run: (args) => {
      // pcieutil print_test_title: "{name:=^80s}"; no devices are listed in a (missing) pcie.yaml
      const title = (t: string) => line(t.padStart(t.length + Math.floor((80 - t.length) / 2), "=").padEnd(80, "="));
      if (args.includes("-c") || args.includes("--check")) {
        return { output: [title("PCIe Device Checking All Test"), line("PCIe Device Checking All Test ----------->>> PASSED")] };
      }
      return { output: [title("Display PCIe Device")] };
    },
  },
  {
    path: ["platform", "firmware"],
    summary: "Show firmware information",
    run: (args) => {
      // passes its arguments to `fwutil show`, a Click group with only the default --help option
      if (args[0] === undefined || args[0] === "--help") {
        return {
          output: clickGroupUsage("fwutil show", "Display platform info", [
            ["status", "Show platform components status"],
            ["update-all-status", "Show platform components update all status"],
            ["updates", "Show available updates"],
            ["version", "Show utility version"],
          ]).map((l) => (l.text.includes("-?, -h, --help") ? line("  --help  Show this message and exit.") : l)),
        };
      }
      if (["status", "updates", "update-all-status"].includes(args[0])) return { output: [simLimit("platform component firmware")] };
      return { output: [line("Usage: fwutil show [OPTIONS] COMMAND [ARGS]..."), line('Try "fwutil show --help" for help.'), line(""), line(`Error: No such command "${args[0]}".`)] };
    },
  },
  clickGroup(["platform"], "Show platform-specific hardware info", [
    ["current", "Show device current information"],
    ["fan", "Show fan status information"],
    ["firmware", "Show firmware information"],
    ["pcieinfo", "Show Device PCIe Info"],
    ["psustatus", "Show PSU status information"],
    ["ssdhealth", "Show SSD Health information"],
    ["summary", "Show hardware platform information"],
    ["syseeprom", "Show system EEPROM information"],
    ["temperature", "Show device temperature information"],
    ["voltage", "Show device voltage information"],
  ]),
];

export const platformModule: SonicFeatureModule = { id: "platform", config, show };
