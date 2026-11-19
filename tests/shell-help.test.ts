/** `?` help: Linux/Click shell (lib/commands/shell-help.ts) and KLISH prefix filtering (lib/sonic/grammar.ts). */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { shellHelp } from "../lib/commands/shell-help";
import { commandNames } from "../lib/commands/registry";
import { setGrammar, helpFor } from "../lib/sonic/grammar";

const toks = (line: string) => shellHelp(line).map((i) => i.token);

describe("shell ? help", () => {
  it("lists commands starting with the typed word (and all of them on an empty line)", () => {
    expect(toks("")).toEqual(commandNames());
    expect(toks("sh")).toEqual(["show"]);
    const p = toks("p");
    expect(p).toContain("ping");
    expect(p).toContain("ping6");
    expect(p.every((t) => t.startsWith("p"))).toBe(true);
    expect(shellHelp("sh")[0].help).toMatch(/SONiC show commands/);
  });

  it("walks the Click show/config trees, filtered by prefix, with <cr> where the command is complete", () => {
    expect(toks("show ip ")).toEqual(expect.arrayContaining(["route", "ospf", "bgp", "interfaces"]));
    expect(toks("show ip o")).toEqual(["ospf"]);
    expect(toks("show ip ospf ")).toEqual(expect.arrayContaining(["neighbor", "database", "<cr>"]));
    expect(toks("config vlan ")).toEqual(expect.arrayContaining(["add", "del", "member"]));
    expect(toks("sudo config vlan m")).toEqual(["member"]); // sudo is transparent
  });

  it("other commands: options, arguments and values from the usage string", () => {
    expect(toks("ping ")).toEqual(expect.arrayContaining(["<destination>", "-c", "-s"]));
    expect(toks("ping -c 3 ")).not.toContain("-c"); // already given
    expect(toks("ping -c 3 10.0.0.1 ")).toContain("<cr>");
    expect(toks("tcpdump -i ")).toEqual(["<iface|any>"]); // the option's value is due
    expect(toks("ip ")).toEqual(["addr", "link", "route", "neigh"]);
    expect(toks("iperf3 -c ")).toEqual(["<host>"]);
    expect(toks("simctl dataplane ")).toEqual(["hardware", "vs", "<cr>"]);
  });

  it("never throws, and offers something for every command and its first argument", () => {
    for (const n of commandNames()) {
      expect(shellHelp(`${n} `).length, n).toBeGreaterThan(0);
      expect(() => shellHelp(`${n} x `)).not.toThrow();
    }
  });

  it("unknown command: nothing to list", () => {
    expect(shellHelp("frobnicate ")).toEqual([]);
  });
});

describe("KLISH ? help filters by the typed prefix", () => {
  beforeAll(() => setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8"))));
  it("`sh?` lists only commands starting with sh; `show i?` only show sub-commands starting with i", () => {
    expect(helpFor("enable-view", "sh").find((c) => c.token === "show")?.help).toBe("Display running system information");
    const sh = helpFor("enable-view", "sh").map((c) => c.token);
    expect(sh).toContain("show");
    expect(sh.every((t) => t.toLowerCase().startsWith("sh"))).toBe(true);
    const si = helpFor("enable-view", "show i").map((c) => c.token);
    expect(si.length).toBeGreaterThan(1);
    expect(si.every((t) => t.toLowerCase().startsWith("i"))).toBe(true);
  });
});
