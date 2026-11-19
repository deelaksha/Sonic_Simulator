/**
 * Entry point: project the live device model into each SONiC Redis DB.
 *
 *   CLI ──► CONFIG_DB ──► *mgrd ──► APPL_DB ──► orchagent ──► ASIC_DB ──► syncd
 *                                     ▲                          │
 *               fpmsyncd/neighsyncd ──┘        STATE_DB ◄── *mgrd/*syncd
 *                                                COUNTERS_DB ◄── syncd flex counters
 */
import { Device } from "../models/device";
import { DbName, Keyspace, Tables, flatten, dbByName } from "./schema";
import { projectConfigDb } from "./config-db";
import { projectApplDb, projectStateDb } from "./appl-state-db";
import { projectAsicDb, projectCountersDb, projectFlexCounterDb } from "./asic-db";

export function projectTables(d: Device, db: DbName): Tables {
  switch (db) {
    case "CONFIG_DB":
      return projectConfigDb(d);
    case "APPL_DB":
      return projectApplDb(d);
    case "STATE_DB":
      return projectStateDb(d);
    case "ASIC_DB":
      return projectAsicDb(d);
    case "COUNTERS_DB":
      return projectCountersDb(d);
    case "FLEX_COUNTER_DB":
      return projectFlexCounterDb(d);
  }
}

export function keyspace(d: Device, db: DbName): Keyspace {
  return flatten(projectTables(d, db), dbByName(db)!.separator);
}

/** Recursively sort object keys (config/main.py sort_dict before json.dump). */
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** CONFIG_DB as config_db.json / `sonic-cfggen -d --print-data` (indent 4, sorted keys). */
export function configDbJson(d: Device): string {
  return JSON.stringify(sortDeep(projectConfigDb(d)), null, 4);
}
