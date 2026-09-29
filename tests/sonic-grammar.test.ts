import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar, isGrammarLoaded, helpFor, completeFor, candidatesFor, viewForStackTop } from "../lib/sonic/grammar";

beforeAll(() => {
  const g = JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8"));
  setGrammar(g);
});

describe("data-driven KLISH grammar (from live device)", () => {
  it("loads the real grammar", () => {
    expect(isGrammarLoaded()).toBe(true);
  });

  it("maps mode-stack tops to real device views", () => {
    expect(viewForStackTop("exec")).toBe("enable-view");
    expect(viewForStackTop("config")).toBe("configure-view");
    expect(viewForStackTop("if-Ethernet0")).toBe("configure-if-view");
    expect(viewForStackTop("if-Vlan10")).toBe("configure-vlan-view");
    expect(viewForStackTop("if-PortChannel1")).toBe("configure-lag-view");
  });

  it("? at exec lists real top-level commands (show, configure, ...)", () => {
    const tokens = candidatesFor("enable-view", []).map((c) => c.token);
    expect(tokens).toContain("show");
    expect(tokens).toContain("configure");
    // it's the real device surface — lots of commands
    expect(tokens.length).toBeGreaterThan(20);
  });

  it("? after `show ` lists real show sub-commands from the device", () => {
    const toks = helpFor("enable-view", "show ").map((c) => c.token);
    expect(toks).toContain("interface");
    expect(toks.length).toBeGreaterThan(15);
  });

  it("Tab completes a unique prefix", () => {
    // "configure" is the only enable-view command starting with "configu"
    expect(completeFor("enable-view", "configu").completed).toBe("configure");
  });

  it("Tab on an empty line offers many candidates, none auto-completed", () => {
    const r = completeFor("enable-view", "");
    expect(r.completed).toBeUndefined();
    expect(r.candidates.length).toBeGreaterThan(1);
  });

  it("config mode exposes interface + vlan-style commands", () => {
    const toks = candidatesFor("configure-view", []).map((c) => c.token);
    expect(toks).toContain("interface");
  });

  it("suggests an argument placeholder after a complete keyword path", () => {
    // e.g. after `interface ` the next token is an interface-name argument
    const cands = helpFor("configure-view", "interface ");
    expect(cands.length).toBeGreaterThan(0);
  });

  it("interface-taking commands offer the type keywords (Ethernet/Vlan/Loopback/PortChannel/Management)", () => {
    const types = ["Ethernet", "Vlan", "Loopback", "PortChannel", "Management"];
    const intf = helpFor("configure-view", "interface ").map((c) => c.token);
    for (const t of types) expect(intf).toContain(t);
    // generalizes to other interface-taking commands
    expect(helpFor("enable-view", "show interface ").map((c) => c.token)).toContain("Ethernet");
    expect(helpFor("configure-view", "interface range ").map((c) => c.token)).toContain("Ethernet");
  });

  it("completion is case-insensitive and completes to the canonical case", () => {
    expect(completeFor("configure-view", "interface eth").completed).toBe("Ethernet");
    expect(completeFor("configure-view", "interface ETH").completed).toBe("Ethernet");
    expect(completeFor("configure-view", "interface vl").completed).toBe("Vlan");
    expect(completeFor("configure-view", "interface LOOP").completed).toBe("Loopback");
    expect(completeFor("configure-view", "interface po").completed).toBe("PortChannel");
  });

  it("does NOT auto-pick when several similar commands match (lists instead)", () => {
    const r = completeFor("enable-view", "show i"); // ip, ipv6, interface, image, ...
    expect(r.completed).toBeUndefined();
    expect(r.candidates.length).toBeGreaterThan(1);
  });

  it("plain-number ptypes (VLAN_ID) are NOT treated as interface selectors", () => {
    // `vlan <id>` must not offer Ethernet/Vlan/... as if it were an interface
    expect(helpFor("configure-view", "vlan ").map((c) => c.token)).not.toContain("Ethernet");
  });
});
