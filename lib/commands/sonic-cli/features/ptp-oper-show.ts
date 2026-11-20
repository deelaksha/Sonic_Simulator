/**
 * Operational `show ptp parent | time-property | servo` (ptp.xml:39-41, 124-126, 174-176),
 * rendered with the 4.5 templates ptp_parent_show.j2 (labels ljust(30)), ptp_tp_show.j2
 * (ljust(20)) and ptp_servo.j2 (ljust(21), values capitalized). Called from ptp.ts.
 *
 * With PTP disabled (no `ptp mode`, or `ptp mode disable`) there is no PTP instance and
 * the templates iterate an empty response: nothing is printed. With a mode configured,
 * the lab has no PTP grandmaster on any link, so the clock is free-running and is its own
 * parent: parentDS mirrors this clock's defaultDS (clock identity = EUI-64 of the system
 * MAC, class 248, accuracy 0xFE/254, variance 65535, the configured priority1/2 or 128),
 * timePropertiesDS carries the free-run defaults (PTP timescale, internal oscillator 0xA0),
 * and the servo is unlocked.
 */
import { Device } from "../../../models/device";
import { CpState } from "../config-plane";
import { systemMac } from "../../../protocols/lacp-daemon";

const L = (k: string, w: number, v: string | number) => `${k.padEnd(w)} ${v}`;

function clockIdentity(device: Device): string {
  const m = systemMac(device).toLowerCase().split(":");
  return [...m.slice(0, 3), "ff", "fe", ...m.slice(3)].join(":");
}

/** Lines for an operational view, or undefined when `view` is not one of them. */
export function ptpOperShow(device: Device, st: CpState, view: string): string[] | undefined {
  if (!["parent", "time-property", "servo"].includes(view)) return undefined;
  if (st.mode === undefined || st.mode === "disable") return [];
  if (view === "parent") {
    const id = clockIdentity(device);
    return [
      L("Parent Clock Identity", 30, id),
      L("Port Number", 30, 0),
      L("Grandmaster Clock Class", 30, 248),
      L("Grandmaster Clock Accuracy", 30, 254),
      L("Grandmaster Off Scaled Log Var", 30, 65535),
      L("Grandmaster Identity", 30, id),
      L("Grandmaster Priority1", 30, String(st.priority1 ?? 128)),
      L("Grandmaster Priority2", 30, String(st.priority2 ?? 128)),
      L("Stats Valid", 30, "False"),
      L("Observed Off Scaled Log Var", 30, 65535),
      L("Observed Clock Phase Chg Rate", 30, 2147483647),
    ];
  }
  if (view === "time-property") {
    return [
      L("Curr UTC Offset Vld", 20, "False"),
      L("Curr UTC Offset", 20, 37),
      L("Leap59", 20, "False"),
      L("Leap61", 20, "False"),
      L("Time Traceable", 20, "False"),
      L("Freq Traceable", 20, "False"),
      L("PTP Timescale", 20, "True"),
      L("Time Source", 20, 160),
    ];
  }
  return [L("Servo State", 21, "Unlocked"), L("Lock Status", 21, "Free-run")];
}
