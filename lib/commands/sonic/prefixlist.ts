/**
 * Prefix-list SONiC feature module. Config-plane only (simulated CONFIG_DB):
 * commands mutate per-device feature state and `show ip prefix-list ...` renders
 * SOLELY from that stored state. Source: prefixlist.txt (IPv4 scope only — the
 * model exposes IPv4 helpers; `ipv6 prefix-list` / route-map / bgp / ospf binds
 * in the cheatsheet are out of scope for this module).
 *
 * These are the FRR/klish `ip prefix-list ...` config-mode forms. The central
 * dispatcher (./index.ts) strips the leading `config`/`show` verb, so they arrive
 * here as the config paths ["ip","prefix-list", ...] (add) and
 * ["no","ip","prefix-list", ...] (delete), and the show path
 * ["ip","prefix-list", ...] — distinct from the reserved ["ip","route"],
 * ["ip","arp"], ["ip","interfaces"] paths (longest-prefix match keeps them apart):
 *
 *   ip prefix-list <name> seq <n> permit|deny <cidr> [ge <x>] [le <y>]     (prefixlist.txt L106)
 *   no ip prefix-list <name> seq <n> permit|deny <cidr> [ge <x>] [le <y>]  (prefixlist.txt L293)  delete one entry
 *   no ip prefix-list <name>                                               (prefixlist.txt L311)  delete whole list
 *   show ip prefix-list [<name>]                                           (prefixlist.txt L69/L133)
 *
 * Validation and quirks taken verbatim from prefixlist.txt:
 *   - the `seq` keyword is mandatory; omitting it -> "% Error: Invalid input detected at" (TC-13)
 *   - ge/le must be 0..32; out of range -> "% Error: Invalid input detected at" (TC-14/15)
 *   - the range must satisfy len <= ge <= le, else "%Error: Invalid prefix range" (TC-16/17)
 *   - re-using a seq with a DIFFERENT prefix -> "%Error: Same sequence-number ..." (TC-22); an
 *     identical re-add is an idempotent no-op (TC-23)
 *   - `no ... seq <n>` without the full key -> "% Error: The command is not completed." (TC-24)
 *   - deleting the last entry auto-removes the list (TC-26); empty view -> "No IP prefix-list configured" (TC-1)
 *
 * Display normalization (TC-7): `ge` is hidden when it equals the prefix length,
 * and specifying `ge` without `le` implies "le 32".
 *
 * IPv6 lists (KLISH ip_prefix.xml `ipv6 prefix-list`, used by BGP IPv6 unicast
 * policy) take the same forms with `ipv6` and ge/le 0..128 ("le 128" implied):
 *   ipv6 prefix-list <name> seq <n> permit|deny <cidr6> [ge <x>] [le <y>]
 *   no ipv6 prefix-list <name> [seq ...]    show ipv6 prefix-list [<name>]
 * The lists are read by the BGP policy engine (lib/protocols/bgp-policy.ts).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { isValidIpv4, isValidPrefix, networkAddress } from "../../models/ip";
import { isValidIpv6, networkAddress6 } from "../../models/ipv6";

type Fam = "ipv4" | "ipv6";

type Action = "permit" | "deny";

interface PrefixEntry {
  seq: number;
  action: Action;
  prefix: string; // normalized "network/len"
  ge?: number;
  le?: number;
}

interface PrefixListState {
  lists: Record<string, PrefixEntry[]>;
  /** IPv6 prefix-lists. */
  lists6?: Record<string, PrefixEntry[]>;
}

const INVALID_INPUT = "% Error: Invalid input detected at '^' marker.";
const INVALID_RANGE = "%Error: Invalid prefix range, make sure: len < ge-value <= le-value.";
const SAME_SEQ = "%Error: Same sequence-number already exists with different IP-prefix & masklength-range !";
const NOT_COMPLETED = "% Error: The command is not completed.";

function state(ctx: CommandContext): PrefixListState {
  return featureState<PrefixListState>(ctx.device, "prefixlist", () => ({ lists: {} }));
}

function listsOf(st: PrefixListState, fam: Fam): Record<string, PrefixEntry[]> {
  return fam === "ipv4" ? st.lists : (st.lists6 ??= {});
}

/** Value token following `key`, or undefined when the key is absent. */
function tokenAfter(args: string[], key: string): string | undefined {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : undefined;
}

function sameEntry(a: PrefixEntry, b: PrefixEntry): boolean {
  return a.action === b.action && a.prefix === b.prefix && a.ge === b.ge && a.le === b.le;
}

type ParseResult = { entry: PrefixEntry; error?: undefined } | { error: string; entry?: undefined };

/** Parse the tokens after the list name: "seq <n> permit|deny <cidr> [ge <x>] [le <y>]". */
function parseEntry(rest: string[], fam: Fam = "ipv4"): ParseResult {
  const max = fam === "ipv4" ? 32 : 128;
  if (rest[0] !== "seq") return { error: INVALID_INPUT }; // seq keyword mandatory (TC-13)
  const seq = Number(rest[1]);
  if (!Number.isInteger(seq) || seq < 1) return { error: INVALID_INPUT };
  const action = rest[2];
  if (action !== "permit" && action !== "deny") return { error: INVALID_INPUT };
  const cidr = rest[3];
  if (!cidr || !cidr.includes("/")) return { error: INVALID_INPUT };
  const [addr, plen] = cidr.split("/");
  const len = Number(plen);
  if (fam === "ipv4" ? !isValidIpv4(addr) || !isValidPrefix(len) : !isValidIpv6(addr) || !/^\d+$/.test(plen) || len > 128) return { error: INVALID_INPUT };

  let ge: number | undefined;
  let le: number | undefined;
  const geTok = tokenAfter(rest, "ge");
  const leTok = tokenAfter(rest, "le");
  if (geTok !== undefined) {
    ge = Number(geTok);
    if (!Number.isInteger(ge) || ge < 0 || ge > max) return { error: INVALID_INPUT }; // range 0..32 (TC-14)
  }
  if (leTok !== undefined) {
    le = Number(leTok);
    if (!Number.isInteger(le) || le < 0 || le > max) return { error: INVALID_INPUT }; // range 0..32 (TC-15)
  }
  // len <= ge <= le (TC-16/17)
  const gev = ge ?? len;
  const lev = le ?? max;
  if (gev < len || gev > lev) return { error: INVALID_RANGE };

  return { entry: { seq, action, prefix: `${fam === "ipv4" ? networkAddress(addr, len) : networkAddress6(addr, len)}/${len}`, ge, le } };
}

const configFor = (fam: Fam, kw: string): SonicCmd[] => [
  {
    path: [kw, "prefix-list"],
    summary: `Add an ${fam === "ipv4" ? "IPv4" : "IPv6"} prefix-list entry (${kw} prefix-list <name> seq <n> permit|deny <cidr> [ge <x>] [le <y>])`,
    run(args, ctx): CommandResult {
      const rest = positional(args);
      const name = rest[0];
      if (!name) {
        return { output: [err(`Usage: config ${kw} prefix-list <name> seq <n> permit|deny <cidr> [ge <x>] [le <y>]`)] };
      }
      const parsed = parseEntry(rest.slice(1), fam);
      if (parsed.error !== undefined) return { output: [err(parsed.error)] };
      const entry = parsed.entry;
      const lists = listsOf(state(ctx), fam);
      const list = lists[name] ?? (lists[name] = []);
      const dup = list.find((e) => e.seq === entry.seq);
      if (dup) {
        // Identical re-add is an idempotent no-op (TC-23); a different prefix is rejected (TC-22).
        if (sameEntry(dup, entry)) return { output: [muted(`${kw} prefix-list ${name} seq ${entry.seq} unchanged`)] };
        return { output: [err(SAME_SEQ)] };
      }
      list.push(entry);
      return { output: [muted(`${kw} prefix-list ${name} seq ${entry.seq} ${entry.action} ${entry.prefix} configured`)] };
    },
  },
  {
    path: ["no", kw, "prefix-list"],
    summary: `Delete a prefix-list entry (full key) or the whole list (no ${kw} prefix-list <name> [seq <n> permit|deny <cidr> ...])`,
    run(args, ctx): CommandResult {
      const rest = positional(args);
      const name = rest[0];
      if (!name) {
        return { output: [err(`Usage: config no ${kw} prefix-list <name> [seq <n> permit|deny <cidr> [ge <x>] [le <y>]]`)] };
      }
      const lists = listsOf(state(ctx), fam);
      // `no ip prefix-list <name>` deletes the whole list.
      if (rest.length === 1) {
        if (lists[name]) {
          delete lists[name];
          return { output: [muted(`${kw} prefix-list ${name} removed`)] };
        }
        return { output: [muted(`${kw} prefix-list ${name} not configured (no-op)`)] };
      }
      if (rest[1] !== "seq") return { output: [err(INVALID_INPUT)] };
      // Delete needs the full key `seq <n> permit|deny <cidr>`; a partial key is rejected (TC-24).
      if (rest.length < 5) return { output: [err(NOT_COMPLETED)] };
      const parsed = parseEntry(rest.slice(1), fam);
      if (parsed.error !== undefined) return { output: [err(parsed.error)] };
      const entry = parsed.entry;
      const list = lists[name];
      if (!list) return { output: [muted(`${kw} prefix-list ${name} not configured (no-op)`)] };
      const idx = list.findIndex((e) => e.seq === entry.seq && sameEntry(e, entry));
      if (idx < 0) return { output: [muted(`${kw} prefix-list ${name} seq ${entry.seq} not found (no-op)`)] };
      list.splice(idx, 1);
      if (list.length === 0) delete lists[name]; // last entry gone -> list auto-removed (TC-26)
      return { output: [muted(`${kw} prefix-list ${name} seq ${entry.seq} removed`)] };
    },
  },
];

const config: SonicCmd[] = [...configFor("ipv4", "ip"), ...configFor("ipv6", "ipv6")];

/** Render the "ge/le" suffix for one entry, applying FRR display normalization (TC-7). */
function fmtRange(len: number, ge?: number, le?: number, max = 32): string {
  if (ge !== undefined) {
    const parts: string[] = [];
    if (ge > len) parts.push(`ge ${ge}`); // ge is hidden when it equals the prefix length
    parts.push(`le ${le ?? max}`); // ge without le implies "le 32"
    return parts.join(" ");
  }
  if (le !== undefined) return `le ${le}`;
  return "";
}

function renderList(name: string, entries: PrefixEntry[], fam: Fam = "ipv4"): OutputLine[] {
  const out: OutputLine[] = [line(`${fam === "ipv4" ? "IP" : "IPv6"} prefix list ${name}:`)];
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    const len = Number(e.prefix.split("/")[1]);
    const range = fmtRange(len, e.ge, e.le, fam === "ipv4" ? 32 : 128);
    out.push(line(`seq ${e.seq} ${e.action} ${e.prefix}${range ? ` ${range}` : ""}`));
  }
  return out;
}

const showFor = (fam: Fam, kw: string): SonicCmd => ({
  path: [kw, "prefix-list"],
  summary: `Show ${fam === "ipv4" ? "IPv4" : "IPv6"} prefix-lists (optionally one by name), entries sorted by seq`,
  run(args, ctx): CommandResult {
    const st = peekFeatureState<PrefixListState>(ctx.device, "prefixlist");
    const lists = (fam === "ipv4" ? st?.lists : st?.lists6) ?? {};
    const none = `No ${fam === "ipv4" ? "IP" : "IPv6"} prefix-list configured`;
    const name = positional(args)[0];
    if (name) {
      const entries = lists[name];
      if (!entries || entries.length === 0) return { output: [muted(none)] };
      return { output: renderList(name, entries, fam) };
    }
    const names = Object.keys(lists)
      .filter((n) => lists[n].length > 0)
      .sort();
    if (names.length === 0) return { output: [muted(none)] };
    const out: OutputLine[] = [];
    for (const n of names) out.push(...renderList(n, lists[n], fam));
    return { output: out };
  },
});

const show: SonicCmd[] = [showFor("ipv4", "ip"), showFor("ipv6", "ipv6")];

export const prefixListModule: SonicFeatureModule = { id: "prefixlist", config, show };
