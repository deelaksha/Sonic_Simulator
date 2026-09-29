/**
 * Clock — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# clock timezone <tz>     store timezone in CONFIG_DB (CLOCK)
 *   sonic(config)# no clock timezone       reset timezone to default (UTC)
 *   sonic# show clock                      render current time in the stored tz
 *
 * Only the CONFIGURED value (the timezone) is persisted — matching the real
 * box's CLOCK|CLOCK_LIST table. `show clock` reflects that configured timezone
 * applied to the sim host's real wall clock; no device state is fabricated.
 *
 * `clock set <time> <date>` (enable-view exec) is intentionally NOT cloned: it
 * mutates the OS wall clock at runtime, which is not part of CONFIG_DB and is
 * not something this simulator models.
 */
import { line, err } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet } from "../config-plane";

const DEFAULT_TZ = "UTC";

/** Format a Date in the given IANA/backward-compat zone as "Mon 28 Sep 2026 10:27:34 AM <label>". */
function formatClock(now: Date, tz: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).formatToParts(now);
  } catch {
    // Unknown zone name: still show it as the label, computed against UTC.
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: DEFAULT_TZ,
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).formatToParts(now);
  }
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("weekday")} ${p("day")} ${p("month")} ${p("year")} ${p("hour")}:${p("minute")}:${p("second")} ${p("dayPeriod")} ${tz}`;
}

registerModal({
  id: "clock",
  views: ["configure-view"],
  keywords: ["clock"],
  run({ isNo, args, ctx }) {
    const sub = (args[0] ?? "").toLowerCase();
    // `no clock` (bare) or `no clock timezone` both clear the configured timezone.
    if (isNo && (sub === "" || sub === "timezone")) {
      cpUnset(ctx.device, "clock", "timezone");
      return { output: [] };
    }
    if (sub !== "timezone") return { output: [err("% Usage: clock timezone <timezone>")] };
    const tz = args[1];
    if (!tz) return { output: [err("% clock timezone requires a timezone name")] };
    cpSet(ctx.device, "clock", "timezone", tz);
    return { output: [] };
  },
});

registerModal({
  id: "clock-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "clock") return null; // not ours
    const tz = (cpGet(ctx.device, "clock")?.timezone as string | undefined) ?? DEFAULT_TZ;
    return { output: [line(formatClock(new Date(), tz))] };
  },
});
