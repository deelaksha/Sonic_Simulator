/**
 * Reproducible SONiC command extraction pipeline (task §51).
 *
 * Reads the READ-ONLY cheat sheets in /home/sonic-claude2/deelaksha/20Augcheats/
 * and produces a normalized command catalog + analysis report inside this project.
 * It never writes to the cheat-sheet directory.
 *
 * Run: npx tsx scripts/extract-sonic-catalog.ts
 *
 * Cheat-sheet format (observed): a TC index of `#  TC-n  <desc>` comment lines,
 * `#AGENT:`/`#ENV-EXCLUDE:` annotations, CLI command lines, and
 * `[TC-n/VERIFY_OUTPUT/START] ... [TC-n/VERIFY_OUTPUT/END]` blocks holding the
 * expected output (with <CONTAINS>/<NOT_CONTAINS>/<BLANK_OUTPUT>/<UINT>/... markers).
 */
import * as fs from "fs";
import * as path from "path";

const CHEATS_DIR = "/home/sonic-claude2/deelaksha/20Augcheats";
const PROJECT = "/home/sonic-claude2/deelaksha/Neworking";
const OUT_DIR = path.join(PROJECT, "data/sonic-command-catalog");
const DOCS = path.join(PROJECT, "docs");

// filename (without _DUT2 / .txt) -> canonical feature id
const FEATURE_MAP: Record<string, string> = {
  aaa: "aaa",
  acl: "acl",
  arpnd: "arpnd",
  bfd: "bfd",
  bgp: "bgp",
  copp: "copp",
  dhcp_udaykum: "dhcp",
  dns_udaykum: "dns",
  fbs: "fbs",
  interface: "interface",
  ipvX: "ipvx",
  lacp: "lacp",
  lldp: "lldp",
  ntp: "ntp",
  ospf: "ospf",
  ospfadvanced: "ospf-advanced",
  pbo: "pbo",
  platform: "platform",
  prefixlist: "prefixlist",
  qos: "qos",
  qos_click_cli: "qos",
  qos_counterpoll: "qos-counterpoll",
  qos_pfc_pfcwd: "qos-pfc-pfcwd",
  radius: "radius",
  routemap: "routemap",
  sflow: "sflow",
  snmp: "snmp",
  staticroute: "staticroute",
  tacacs: "tacacs",
  vlan: "vlan",
  vrf: "vrf",
  vrrp: "vrrp",
};

type Category =
  | "show"
  | "config"
  | "config-remove"
  | "config-enter"
  | "config-nav"
  | "clear"
  | "debug"
  | "click-config"
  | "click-show"
  | "db"
  | "exec";

type CliFamily = "klish" | "click" | "shell" | "linux";

interface Instance {
  command: string;
  file: string;
  feature: string;
  category: Category;
  cli: CliFamily;
  mode: string;
  tc?: number;
  tcDesc?: string;
  negative: boolean;
  envExcluded: boolean;
  envReason?: string;
  sample?: string;
}

function featureOf(fileBase: string): string {
  const key = fileBase.replace(/_DUT2$/, "");
  return FEATURE_MAP[key] ?? key.toLowerCase();
}

function classify(cmd: string): Category {
  const c = cmd.toLowerCase();
  if (c.startsWith("sudo config") || c.startsWith("sudo sonic-clear")) return "click-config";
  if (c.startsWith("sudo show")) return "click-show";
  if (c.startsWith("redis-cli") || c.startsWith("sudo sonic-db-cli") || c.startsWith("sudo redis")) return "db";
  if (c.startsWith("show ") || c === "show") return "show";
  if (c.startsWith("no ")) return "config-remove";
  if (c.startsWith("clear ")) return "clear";
  if (c.startsWith("debug ")) return "debug";
  if (c === "configure terminal" || c === "config" || c === "conf t") return "config-enter";
  if (["exit", "end", "quit", "!"].includes(c)) return "config-nav";
  if (c.startsWith("ping") || c.startsWith("traceroute") || c.startsWith("tracepath")) return "exec";
  return "config";
}

function cliFamily(cmd: string, cat: Category): CliFamily {
  const c = cmd.toLowerCase();
  if (cat === "click-config" || cat === "click-show") return "click";
  if (cat === "db") return "shell";
  if (c.startsWith("sudo ")) return "shell";
  if (/^(ip |ifconfig\b|tcpdump\b|ss |netstat\b|bridge \b|cat |echo |grep |sonic-cfggen)/.test(c)) return "linux";
  return "klish";
}

function nextMode(current: string, cmd: string): string {
  const c = cmd.toLowerCase();
  if (c === "configure terminal" || c === "config" || c === "conf t") return "config";
  if (c === "end") return "exec";
  if (c === "exit" || c === "quit") return current.startsWith("config-") ? "config" : "exec";
  if (/^interface\s+/i.test(cmd)) return "config-if";
  if (/^router\s+(bgp|ospf|ospf6)/i.test(cmd)) return "config-router";
  if (/^(vlan|route-map|ip prefix-list|ip access-list|line )/i.test(cmd) && current === "config") return "config-sub";
  return current;
}

/** Parameterize a command so equivalent commands collapse to one template. */
function templateOf(cmd: string): string {
  return cmd
    .replace(/\b(Ethernet|Vlan|PortChannel|Loopback|Management|eth)\s?\d+([-,]\d+)*/gi, "$1<N>")
    .replace(/\b\d+\.\d+\.\d+\.\d+(\/\d+)?/g, "<IP>")
    .replace(/\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]*(\/\d+)?/gi, "<IPV6>")
    .replace(/\b\d+\b/g, "<N>")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------

function parseFile(file: string): { instances: Instance[]; lines: number } {
  const full = path.join(CHEATS_DIR, file);
  const raw = fs.readFileSync(full, "utf8");
  const lines = raw.split(/\r?\n/);
  const feature = featureOf(path.basename(file, ".txt"));

  // First pass: TC index (tcNum -> description).
  const tcDesc = new Map<number, string>();
  for (const line of lines) {
    const m = /^#\s*TC-(\d+)\s+(.*)$/.exec(line.trim());
    if (m) tcDesc.set(Number(m[1]), m[2].trim());
  }

  const instances: Instance[] = [];
  let mode = "exec";
  let pendingEnv: string | undefined;
  let pendingAgent: string | undefined;
  let lastCmdIdx = -1; // index into instances of the most recent command
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    // VERIFY block: attach expected output + TC to the last command.
    const startM = /^\[TC-(\d+)\/VERIFY_OUTPUT\/START\]$/.exec(line);
    if (startM) {
      const tc = Number(startM[1]);
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\[TC-\d+\/VERIFY_OUTPUT\/END\]$/.test(lines[i].trim())) {
        body.push(lines[i]);
        i++;
      }
      i++; // skip END
      if (lastCmdIdx >= 0) {
        const inst = instances[lastCmdIdx];
        inst.tc = tc;
        const desc = tcDesc.get(tc);
        if (desc) {
          inst.tcDesc = desc;
          if (/\bNEGATIVE\b/.test(desc)) inst.negative = true;
        }
        if (!inst.sample) inst.sample = body.join("\n").slice(0, 500);
      }
      continue;
    }

    // comments / annotations
    if (line.startsWith("#")) {
      const env = /#\s*ENV-EXCLUDE:\s*(.*)$/i.exec(line);
      if (env) pendingEnv = env[1].trim();
      const agent = /#\s*AGENT:\s*(.*)$/i.exec(line);
      if (agent) pendingAgent = agent[1].trim();
      i++;
      continue;
    }

    // blank or stray output markers outside blocks
    if (line === "" || /^<\/?[A-Z_]+>$/.test(line)) {
      i++;
      continue;
    }

    // otherwise: a command line
    const cat = classify(line);
    const inst: Instance = {
      command: line,
      file,
      feature,
      category: cat,
      cli: cliFamily(line, cat),
      mode,
      negative: false,
      envExcluded: !!pendingEnv,
      envReason: pendingEnv,
      sample: undefined,
    };
    if (pendingAgent) inst.tcDesc = pendingAgent; // provisional; overwritten if a TC attaches
    instances.push(inst);
    lastCmdIdx = instances.length - 1;
    mode = nextMode(mode, line);
    pendingEnv = undefined;
    pendingAgent = undefined;
    i++;
  }

  return { instances, lines: lines.length };
}

// ---------------------------------------------------------------------------

interface CatalogEntry {
  command: string;
  template: string;
  features: string[];
  categories: Category[];
  cli: CliFamily[];
  modes: string[];
  status: "documented" | "environment_excluded";
  reason?: string;
  negative: boolean;
  hasVerify: boolean;
  sources: string[];
  intent?: string;
  sample?: string;
}

function main(): void {
  const files = fs
    .readdirSync(CHEATS_DIR)
    .filter((f) => f.endsWith(".txt"))
    .sort();

  const allInstances: Instance[] = [];
  let totalLines = 0;
  for (const f of files) {
    const { instances, lines } = parseFile(f);
    allInstances.push(...instances);
    totalLines += lines;
  }

  // Dedup into a catalog keyed by exact command string.
  const byCmd = new Map<string, CatalogEntry>();
  for (const inst of allInstances) {
    const existing = byCmd.get(inst.command);
    if (!existing) {
      byCmd.set(inst.command, {
        command: inst.command,
        template: templateOf(inst.command),
        features: [inst.feature],
        categories: [inst.category],
        cli: [inst.cli],
        modes: [inst.mode],
        status: inst.envExcluded ? "environment_excluded" : "documented",
        reason: inst.envReason,
        negative: inst.negative,
        hasVerify: inst.tc !== undefined,
        sources: [inst.file],
        intent: inst.tcDesc,
        sample: inst.sample,
      });
    } else {
      if (!existing.sources.includes(inst.file)) existing.sources.push(inst.file);
      if (!existing.features.includes(inst.feature)) existing.features.push(inst.feature);
      if (!existing.categories.includes(inst.category)) existing.categories.push(inst.category);
      if (!existing.cli.includes(inst.cli)) existing.cli.push(inst.cli);
      if (!existing.modes.includes(inst.mode)) existing.modes.push(inst.mode);
      if (inst.envExcluded) {
        existing.status = "environment_excluded";
        existing.reason = existing.reason ?? inst.envReason;
      }
      existing.negative = existing.negative || inst.negative;
      existing.hasVerify = existing.hasVerify || inst.tc !== undefined;
      if (!existing.intent && inst.tcDesc) existing.intent = inst.tcDesc;
      if (!existing.sample && inst.sample) existing.sample = inst.sample;
    }
  }

  const catalog = Array.from(byCmd.values()).sort(
    (a, b) => a.features[0].localeCompare(b.features[0]) || a.command.localeCompare(b.command),
  );

  // Per-feature aggregation.
  const features = new Map<
    string,
    {
      feature: string;
      files: Set<string>;
      total: number;
      show: number;
      config: number;
      clear: number;
      debug: number;
      db: number;
      envExcluded: number;
      negative: number;
      verified: number;
    }
  >();
  for (const e of catalog) {
    for (const feat of e.features) {
      const f = features.get(feat) ?? {
        feature: feat,
        files: new Set<string>(),
        total: 0,
        show: 0,
        config: 0,
        clear: 0,
        debug: 0,
        db: 0,
        envExcluded: 0,
        negative: 0,
        verified: 0,
      };
      e.sources
        .filter((s) => featureOf(path.basename(s, ".txt")) === feat)
        .forEach((s) => f.files.add(s));
      f.total++;
      if (e.categories.includes("show") || e.categories.includes("click-show")) f.show++;
      if (e.categories.some((c) => c.startsWith("config") || c === "click-config")) f.config++;
      if (e.categories.includes("clear")) f.clear++;
      if (e.categories.includes("debug")) f.debug++;
      if (e.categories.includes("db")) f.db++;
      if (e.status === "environment_excluded") f.envExcluded++;
      if (e.negative) f.negative++;
      if (e.hasVerify) f.verified++;
      features.set(feat, f);
    }
  }

  const featureSummary = Array.from(features.values())
    .map((f) => ({ ...f, files: Array.from(f.files).sort() }))
    .sort((a, b) => a.feature.localeCompare(b.feature));

  // Templates (normalized) — the "normalized catalog" grouping.
  const templates = new Map<string, { template: string; count: number; features: Set<string>; example: string }>();
  for (const e of catalog) {
    const t = templates.get(e.template) ?? { template: e.template, count: 0, features: new Set<string>(), example: e.command };
    t.count++;
    e.features.forEach((f) => t.features.add(f));
    templates.set(e.template, t);
  }
  const templateList = Array.from(templates.values())
    .map((t) => ({ template: t.template, count: t.count, features: Array.from(t.features).sort(), example: t.example }))
    .sort((a, b) => b.count - a.count);

  // duplicates across files
  const duplicates = catalog.filter((e) => e.sources.length > 1);
  const envExcluded = catalog.filter((e) => e.status === "environment_excluded");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "catalog.json"), JSON.stringify(catalog, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "features.json"), JSON.stringify(featureSummary, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "templates.json"), JSON.stringify(templateList, null, 2));
  fs.writeFileSync(
    path.join(OUT_DIR, "env-excluded.json"),
    JSON.stringify(
      envExcluded.map((e) => ({ command: e.command, features: e.features, reason: e.reason, sources: e.sources })),
      null,
      2,
    ),
  );

  writeReport({
    files,
    totalLines,
    totalInstances: allInstances.length,
    catalog,
    featureSummary,
    templateList,
    duplicates,
    envExcluded,
  });

  console.log(`Files analyzed:        ${files.length}`);
  console.log(`Total lines:           ${totalLines}`);
  console.log(`Command instances:     ${allInstances.length}`);
  console.log(`Unique commands:       ${catalog.length}`);
  console.log(`Unique templates:      ${templateList.length}`);
  console.log(`Verify-backed cmds:    ${catalog.filter((e) => e.hasVerify).length}`);
  console.log(`Environment-excluded:  ${envExcluded.length}`);
  console.log(`Cross-file duplicates: ${duplicates.length}`);
  console.log(`Features:              ${featureSummary.length}`);
  console.log(`\nWrote catalog + report under ${path.relative(PROJECT, OUT_DIR)} and docs/SONIC_ANALYSIS.md`);
}

function writeReport(d: {
  files: string[];
  totalLines: number;
  totalInstances: number;
  catalog: CatalogEntry[];
  featureSummary: { feature: string; files: string[]; total: number; show: number; config: number; clear: number; debug: number; db: number; envExcluded: number; negative: number; verified: number }[];
  templateList: { template: string; count: number; features: string[]; example: string }[];
  duplicates: CatalogEntry[];
  envExcluded: CatalogEntry[];
}): void {
  const L: string[] = [];
  L.push("# SONiC Cheat-Sheet Analysis Report");
  L.push("");
  L.push("_Generated by `scripts/extract-sonic-catalog.ts` — reproducible; do not edit by hand._");
  L.push("");
  L.push("Source (read-only): `/home/sonic-claude2/deelaksha/20Augcheats/`");
  L.push("Catalog data: `data/sonic-command-catalog/{catalog,features,templates,env-excluded}.json`");
  L.push("");
  L.push("## Totals");
  L.push("");
  L.push(`| Metric | Value |`);
  L.push(`|---|---|`);
  L.push(`| Cheat sheets analyzed | ${d.files.length} |`);
  L.push(`| Total lines | ${d.totalLines} |`);
  L.push(`| Command instances | ${d.totalInstances} |`);
  L.push(`| Unique commands | ${d.catalog.length} |`);
  L.push(`| Unique templates (normalized) | ${d.templateList.length} |`);
  L.push(`| Verify-backed commands | ${d.catalog.filter((e) => e.hasVerify).length} |`);
  L.push(`| Environment-excluded | ${d.envExcluded.length} |`);
  L.push(`| Cross-file duplicate commands | ${d.duplicates.length} |`);
  L.push("");
  L.push("## Commands by feature");
  L.push("");
  L.push(`| Feature | Files | Unique | Show/Verify | Config | Clear | Debug | DB | Env-excl | Negative |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const f of d.featureSummary) {
    L.push(
      `| ${f.feature} | ${f.files.length} | ${f.total} | ${f.show} | ${f.config} | ${f.clear} | ${f.debug} | ${f.db} | ${f.envExcluded} | ${f.negative} |`,
    );
  }
  L.push("");
  L.push("## Environment-excluded commands (task §5)");
  L.push("");
  L.push("These are documented but require environment features (e.g. `frrcfgd` / `frr_mgmt_framework_config`). They must be surfaced with their reason — never as `% Invalid command`.");
  L.push("");
  if (d.envExcluded.length === 0) L.push("_None detected._");
  else {
    L.push(`| Command | Feature | Reason |`);
    L.push(`|---|---|---|`);
    for (const e of d.envExcluded.slice(0, 60)) {
      L.push(`| \`${e.command.replace(/\|/g, "\\|")}\` | ${e.features.join(", ")} | ${(e.reason ?? "").replace(/\|/g, "\\|")} |`);
    }
  }
  L.push("");
  L.push("## Most common command templates");
  L.push("");
  L.push(`| Count | Features | Template (example) |`);
  L.push(`|---|---|---|`);
  for (const t of d.templateList.slice(0, 30)) {
    L.push(`| ${t.count} | ${t.features.length} | \`${t.example.replace(/\|/g, "\\|")}\` |`);
  }
  L.push("");
  L.push("## Simulation vs real-device suitability");
  L.push("");
  L.push("- **Config commands** change device/packet behavior → primarily **simulation** targets (must drive the engine).");
  L.push("- **Show/verification commands** map cleanly to **both** simulation (rendered from state) and **real-device** mode (parse device output).");
  L.push("- **DB / redis-cli / env-setup** commands are environment plumbing → **real-device / setup only**, not simulated behavior.");
  L.push("");
  L.push("## Implementation order (task §53)");
  L.push("");
  L.push("1. **Phase 1** — Interface, VLAN, ARP/ND, IPv4, IPv6, Static Route");
  L.push("2. **Phase 2** — DHCP, DNS, NTP, LLDP, LACP");
  L.push("3. **Phase 3** — VRF, VRRP, OSPF, BFD");
  L.push("4. **Phase 4** — Prefix List, Route Map, BGP");
  L.push("5. **Phase 5** — ACL, CoPP, QoS, PFC/PFCWD, sFlow");
  L.push("6. **Phase 6** — SNMP, AAA, TACACS, RADIUS");
  L.push("7. **Phase 7** — Platform, PBO, FBS");
  L.push("");
  L.push("First feature to fully implement end-to-end: **VLAN** (task §54), then **NTP** (task §55).");
  L.push("");
  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, "SONIC_ANALYSIS.md"), L.join("\n"));
}

main();
