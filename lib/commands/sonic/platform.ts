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
 * platform.txt has no `config platform ...` forms, so config is empty.
 */
import { CommandContext, CommandResult, OutputLine, line, muted } from "../types";
import { SonicCmd, SonicFeatureModule } from "./types";

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
  {
    path: ["platform"],
    summary: "Show platform information (see subcommands)",
    run: () => ({
      output: [
        muted(
          "Usage: show platform <summary|syseeprom|psustatus|fanstatus|temperature|ssdhealth|firmware version>",
        ),
      ],
    }),
  },
];

export const platformModule: SonicFeatureModule = { id: "platform", config, show };
