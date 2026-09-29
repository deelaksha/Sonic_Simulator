/**
 * Route-map SONiC feature module. Config-plane only (simulated CONFIG_DB):
 * commands mutate per-device feature state and `show route-map` renders SOLELY
 * from that stored state. Nothing touches a real FRR/vtysh — this is educational.
 *
 * The authoritative CLI forms are the KLISH route-map grammar in routemap.txt.
 * In FRR/klish you enter route-map config mode and issue clause lines; this
 * stateless simulator carries the statement selector + one clause on a single
 * line under the central dispatcher, so the tokens arrive as ["route-map", ...]:
 *
 *   config route-map <name> permit|deny <seq>          <- route-map <name> permit|deny <seq>   (TC-3/9/14)
 *   config route-map <name> permit|deny <seq> match <clause>   <- match ... (TC-6: match local-preference 40, match metric 12, ...)
 *   config route-map <name> permit|deny <seq> set <clause>     <- set ...   (TC-6: set ip next-hop 15.10.10.3, set metric 75, ...)
 *   config route-map <name> permit|deny <seq> no match <key>   <- no match ... (TC-7 delete block)
 *   config route-map <name> permit|deny <seq> no set <key>     <- no set ...   (TC-7 delete block)
 *   config route-map no <name>                          <- no route-map <name>              (whole map, line 227)
 *   config route-map no <name> permit|deny <seq>        <- no route-map <name> permit|deny <seq> (per-statement, TC-60)
 *   show route-map [<name>]                             <- show route-map [<name>]          (TC-1/15/61)
 *
 * From routemap.txt: sequence range is 1-65535 (TC-14 seq min, TC-49/TC-50
 * out-of-range rejected); action is permit|deny (TC-9/TC-17); re-entering a
 * statement and issuing `set <key> ...` replaces the prior value for that key
 * (TC-45 lp 250 -> TC-46 lp 999); `no route-map <name>` for an absent map is a
 * silent no-op (TC-59).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";

type RouteMapAction = "permit" | "deny";

interface RouteMapStatement {
  seq: number;
  action: RouteMapAction;
  match: string[];
  set: string[];
}

interface RouteMapState {
  maps: Record<string, RouteMapStatement[]>;
}

/** Sequence range per routemap.txt (RANGE_1_65535, TC-14/TC-49/TC-50). */
const SEQ = { min: 1, max: 65535 };

function state(ctx: CommandContext): RouteMapState {
  return featureState<RouteMapState>(ctx.device, "routemap", () => ({ maps: {} }));
}

/** First token of a stored clause — the key used to replace/remove it. */
function clauseKey(clause: string): string {
  return clause.split(" ")[0];
}

const config: SonicCmd[] = [
  {
    path: ["route-map"],
    summary: "Configure a route-map statement / match / set clause (or delete with 'no')",
    run(args, ctx): CommandResult {
      const st = state(ctx);

      // Deletion: `no route-map <name> [permit|deny <seq>]`.
      if (args[0] === "no") {
        const name = args[1];
        if (name === undefined) {
          return { output: [err("Usage: config route-map no <name> [permit|deny <seq>]")] };
        }
        const stmts = st.maps[name];
        const action = args[2];
        if (action === "permit" || action === "deny") {
          const seq = Number(args[3]);
          if (!stmts) return { output: [muted(`route-map ${name} not configured (no-op)`)] };
          const before = stmts.length;
          const kept = stmts.filter((s) => !(s.seq === seq && s.action === action));
          if (kept.length === 0) delete st.maps[name];
          else st.maps[name] = kept;
          return {
            output: [
              muted(
                kept.length < before
                  ? `route-map ${name} ${action} ${seq} deleted`
                  : `route-map ${name} ${action} ${seq} not configured (no-op)`,
              ),
            ],
          };
        }
        // Whole-map delete; absent map is a silent no-op (TC-59).
        if (stmts) delete st.maps[name];
        return { output: [muted(stmts ? `route-map ${name} deleted` : `route-map ${name} not configured (no-op)`)] };
      }

      // Create / clause: `<name> permit|deny <seq> [ [no] match|set <clause...> ]`.
      const name = args[0];
      const action = args[1];
      const seqTok = args[2];
      if (name === undefined || (action !== "permit" && action !== "deny") || seqTok === undefined) {
        return { output: [err("Usage: config route-map <name> permit|deny <seq> [match <clause> | set <clause>]")] };
      }
      const seq = Number(seqTok);
      if (!Number.isInteger(seq) || seq < SEQ.min || seq > SEQ.max) {
        return { output: [err(`config route-map: sequence must be ${SEQ.min}-${SEQ.max} (got '${seqTok}')`)] };
      }

      let stmts = st.maps[name];
      if (!stmts) {
        stmts = [];
        st.maps[name] = stmts;
      }
      let stmt = stmts.find((s) => s.seq === seq);
      if (!stmt) {
        stmt = { seq, action, match: [], set: [] };
        stmts.push(stmt);
      } else {
        stmt.action = action; // re-entering the statement can change the action
      }

      const rest = args.slice(3);
      if (rest.length === 0) {
        return { output: [muted(`route-map ${name} ${action} ${seq} configured`)] };
      }

      const remove = rest[0] === "no";
      const kind = rest[remove ? 1 : 0];
      if (kind !== "match" && kind !== "set") {
        return { output: [err("config route-map: expected 'match' or 'set' clause")] };
      }
      const clauseToks = rest.slice(remove ? 2 : 1);
      const clause = clauseToks.join(" ").trim();
      const key = clauseToks[0];

      if (remove) {
        if (!key) return { output: [err(`config route-map: 'no ${kind}' needs a clause key`)] };
        if (kind === "match") stmt.match = stmt.match.filter((c) => clauseKey(c) !== key);
        else stmt.set = stmt.set.filter((c) => clauseKey(c) !== key);
        return { output: [muted(`route-map ${name} ${action} ${seq}: no ${kind} ${clause}`)] };
      }

      if (!clause) return { output: [err(`config route-map: '${kind}' needs a clause`)] };
      // Re-setting the same key replaces the prior value (TC-45 -> TC-46).
      if (kind === "match") stmt.match = [...stmt.match.filter((c) => clauseKey(c) !== key), clause];
      else stmt.set = [...stmt.set.filter((c) => clauseKey(c) !== key), clause];
      return { output: [muted(`route-map ${name} ${action} ${seq}: ${kind} ${clause}`)] };
    },
  },
];

function renderMap(name: string, stmts: RouteMapStatement[]): OutputLine[] {
  const out: OutputLine[] = [line(`Route map ${name}:`)];
  for (const s of [...stmts].sort((a, b) => a.seq - b.seq)) {
    out.push(line(`   ${s.action}, sequence ${s.seq}`));
    out.push(line("    Match clauses:"));
    for (const m of s.match) out.push(line(`      ${m}`));
    out.push(line("    Set clauses:"));
    for (const c of s.set) out.push(line(`      ${c}`));
  }
  return out;
}

const show: SonicCmd[] = [
  {
    path: ["route-map"],
    summary: "Show route-maps (optionally one by name)",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      const maps = peekFeatureState<RouteMapState>(ctx.device, "routemap")?.maps ?? {};
      if (name !== undefined) {
        const stmts = maps[name];
        if (!stmts || stmts.length === 0) return { output: [muted(`route-map ${name} not configured`)] };
        return { output: renderMap(name, stmts) };
      }
      const names = Object.keys(maps);
      if (names.length === 0) return { output: [muted("No route-maps configured")] };
      const out: OutputLine[] = [];
      for (const n of names) out.push(...renderMap(n, maps[n]));
      return { output: out };
    },
  },
];

export const routeMapModule: SonicFeatureModule = { id: "routemap", config, show };
