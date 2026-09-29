/**
 * Config-plane store for SONiC features that have no packet/engine backend.
 *
 * Many device features (banner, logging, telemetry, stp, mclag, nat, vxlan, ...)
 * are pure CONFIG_DB on the real box: you set values and `show` reads them back.
 * We model that honestly — store exactly what was configured under
 * device.config.features["cp_<id>"] and render `show` from it. Nothing is faked;
 * for features whose DATA-plane the sim cannot model, the config is stored and
 * shown but the runtime effect is explicitly not simulated.
 */
import { Device } from "../../models/device";
import { featureState, peekFeatureState } from "../../models/feature-state";

export type CpState = Record<string, unknown>;

function state(device: Device, id: string): CpState {
  return featureState<CpState>(device, `cp_${id}`, () => ({}));
}

/** Read the stored config-plane state for a feature (undefined if never set). */
export function cpGet(device: Device, id: string): CpState | undefined {
  return peekFeatureState<CpState>(device, `cp_${id}`);
}

/** Set a scalar key (e.g. cpSet(dev,"banner","motd","Welcome")). */
export function cpSet(device: Device, id: string, key: string, value: unknown): void {
  state(device, id)[key] = value;
}

/** Clear a scalar key (the `no` form). */
export function cpUnset(device: Device, id: string, key: string): void {
  delete state(device, id)[key];
}

/** Append an item to a list key, keyed by `idField` for de-dup/replacement. */
export function cpUpsert(device: Device, id: string, key: string, item: Record<string, unknown>, idField: string): void {
  const st = state(device, id);
  const list = (st[key] as Record<string, unknown>[] | undefined) ?? [];
  const i = list.findIndex((e) => e[idField] === item[idField]);
  if (i >= 0) list[i] = { ...list[i], ...item };
  else list.push(item);
  st[key] = list;
}

/** Remove a list item by its id value (the `no` form). */
export function cpRemove(device: Device, id: string, key: string, idField: string, idValue: unknown): void {
  const st = state(device, id);
  const list = (st[key] as Record<string, unknown>[] | undefined) ?? [];
  st[key] = list.filter((e) => e[idField] !== idValue);
}

/** A list value (never undefined). */
export function cpList(device: Device, id: string, key: string): Record<string, unknown>[] {
  return (cpGet(device, id)?.[key] as Record<string, unknown>[] | undefined) ?? [];
}

/** A stored running-config line with its mode context (view + interface). */
export interface CpLine { ctx: string; line: string }

/**
 * Generic config-plane store: accept any recognized config command that no
 * specific handler claims, and persist it (the device applies config silently
 * and reflects it in running-config). `no <cmd>` removes the matching line.
 */
export function cpStoreLine(device: Device, ctx: string, line: string, isNo: boolean): void {
  const st = featureState<{ lines: CpLine[] }>(device, "cp_running", () => ({ lines: [] }));
  const target = line.replace(/^no\s+/i, "").trim();
  // `no <cmd>` removes matching lines by prefix (the negation often omits values,
  // e.g. `no timers bgp` clears `timers bgp 10 30`). Adding dedupes the exact line.
  const matches = (stored: string) => stored === target || stored.startsWith(target + " ");
  st.lines = st.lines.filter((l) => !(l.ctx === ctx && matches(l.line.trim())));
  if (!isNo) st.lines.push({ ctx, line: line.trim() });
}

/** All stored running-config lines (config-plane commands with no engine backend). */
export function cpRunningLines(device: Device): CpLine[] {
  return peekFeatureState<{ lines: CpLine[] }>(device, "cp_running")?.lines ?? [];
}
