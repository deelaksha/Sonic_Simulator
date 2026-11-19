/**
 * SONiC Redis database layout (the subset the simulator projects).
 *
 * Sources (sonic-buildimage/src):
 *   sonic-swss-common/common/schema.h:10-17        DB ids (APPL 0, ASIC 1, COUNTERS 2, CONFIG 4, FLEX_COUNTER 5, STATE 6)
 *   dockers/docker-database/database_config.json.j2:39-77  separators (APPL/ASIC/COUNTERS ":", CONFIG/STATE "|")
 *
 * The simulator does not run Redis: every DB is a read-only projection of the
 * live device model, rebuilt on each query (see ./project.ts).
 */

export type DbName = "APPL_DB" | "ASIC_DB" | "COUNTERS_DB" | "CONFIG_DB" | "FLEX_COUNTER_DB" | "STATE_DB";

export const DBS: { name: DbName; id: number; separator: string }[] = [
  { name: "APPL_DB", id: 0, separator: ":" },
  { name: "ASIC_DB", id: 1, separator: ":" },
  { name: "COUNTERS_DB", id: 2, separator: ":" },
  { name: "CONFIG_DB", id: 4, separator: "|" },
  { name: "FLEX_COUNTER_DB", id: 5, separator: ":" },
  { name: "STATE_DB", id: 6, separator: "|" },
];

export function dbByName(name: string): (typeof DBS)[number] | undefined {
  return DBS.find((d) => d.name === name.toUpperCase());
}

export function dbById(id: number): (typeof DBS)[number] | undefined {
  return DBS.find((d) => d.id === id);
}

/** A hash row. Array values are CONFIG_DB leaf-lists (stored in Redis as "field@" = "a,b"). */
export type Row = Record<string, string | string[]>;

/** A flat Redis keyspace: full key ("TABLE|k1|k2") → hash. */
export type Keyspace = Map<string, Record<string, string>>;

/** Table-structured view (sonic-cfggen --print-data shape): TABLE → key → row. */
export type Tables = Record<string, Record<string, Row>>;

/** Flatten a table view into Redis keys/hashes (key "" = a bare hash named like the table, e.g. COUNTERS_PORT_NAME_MAP). Empty rows become {"NULL":"NULL"} as ConfigDBConnector writes them. */
export function flatten(tables: Tables, sep: string): Keyspace {
  const ks: Keyspace = new Map();
  for (const [table, rows] of Object.entries(tables)) {
    for (const [key, row] of Object.entries(rows)) {
      const h: Record<string, string> = {};
      for (const [f, v] of Object.entries(row)) {
        if (Array.isArray(v)) h[`${f}@`] = v.join(",");
        else h[f] = v;
      }
      if (Object.keys(h).length === 0) h.NULL = "NULL";
      ks.set(key === "" ? table : `${table}${sep}${key}`, h);
    }
  }
  return ks;
}

/** Add a row to a table view. */
export function put(t: Tables, table: string, key: string, row: Row = {}): void {
  (t[table] ??= {})[key] = row;
}
