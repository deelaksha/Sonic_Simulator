/**
 * FDB (MAC) aging. SONiC programs SAI_SWITCH_ATTR_FDB_AGING_TIME from
 * CONFIG_DB SWITCH|switch fdb_aging_time (default 600 s, carried into APPL_DB
 * SWITCH_TABLE:switch; KLISH ptype MAC_AGE_TIMER 0..1000000, "Enter 0 to
 * disable MAC aging", device-capture klish-xml/mac.xml:274-276 and
 * sonic_types.xml:688). The ASIC ages a dynamic entry that has not been hit
 * for the aging time; static entries never age.
 *
 * Here: dynamic entries on LOCAL ports whose lastSeenMs is older than the
 * aging time are removed. Remote entries (EVPN "vtep:<ip>", owned by the VXLAN
 * daemon), static entries and entries without a timestamp (`config mac add`)
 * are left alone. `sonic-clear fdb all` (fdbclear → FLUSHFDBREQUEST "ALL")
 * flushes the same set of entries immediately.
 */
import { Device, MacEntry, findInterface, isSwitch } from "../models/device";
import { featureState, peekFeatureState } from "../models/feature-state";
import { registerDaemon } from "../control/daemon";

export const DEFAULT_FDB_AGING_SEC = 600;
export const FDB_AGING_MAX = 1000000;

interface FdbCfg {
  agingTime: number;
}

export function fdbAgingTime(device: Device): number {
  return peekFeatureState<FdbCfg>(device, "fdb")?.agingTime ?? DEFAULT_FDB_AGING_SEC;
}

export function setFdbAgingTime(device: Device, sec: number): void {
  featureState<FdbCfg>(device, "fdb", () => ({ agingTime: DEFAULT_FDB_AGING_SEC })).agingTime = sec;
}

/** Dynamic, locally learned entry (what the ASIC ages / FLUSHFDBREQUEST removes). */
export function isLocalDynamic(device: Device, e: MacEntry): boolean {
  return !e.static && !e.interfaceId.startsWith("vtep:") && !!findInterface(device, e.interfaceId);
}

function agable(device: Device, e: MacEntry): boolean {
  return isLocalDynamic(device, e) && e.lastSeenMs !== undefined;
}

/** Flush every dynamic local entry; returns how many were removed. */
export function flushDynamicFdb(device: Device): number {
  const before = device.macTable.length;
  device.macTable = device.macTable.filter((e) => !isLocalDynamic(device, e));
  return before - device.macTable.length;
}

registerDaemon({
  id: "macaging",
  nextDue(device) {
    if (!isSwitch(device.type)) return undefined;
    const age = fdbAgingTime(device);
    if (age <= 0) return undefined;
    let due: number | undefined;
    for (const e of device.macTable) {
      if (!agable(device, e)) continue;
      const t = e.lastSeenMs! + age * 1000;
      if (due === undefined || t < due) due = t;
    }
    return due;
  },
  tick(_ctx, device, now) {
    const age = fdbAgingTime(device) * 1000;
    const before = device.macTable.length;
    device.macTable = device.macTable.filter((e) => !agable(device, e) || now - e.lastSeenMs! < age);
    return device.macTable.length !== before;
  },
});
