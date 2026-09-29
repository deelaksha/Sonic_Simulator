import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/acl";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext } from "../lib/commands";
import { runSonicCli, cliPrompt, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";

interface AclRule {
  seq: number;
  action: string;
  match: string;
}
interface AclTable {
  name: string;
  type?: string;
  stage?: string;
  ports: string[];
}
interface AclState {
  tables: AclTable[];
  rules: Record<string, AclRule[]>;
}

function sw(): { state: NetworkState; device: Device } {
  resetMacCounter(1);
  resetIds();
  const device = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  return { state: { devices: { sw1: device }, connections: [] }, device };
}
function ctxFor(state: NetworkState, device: Device): CommandContext {
  const captures: CaptureRecord[] = [];
  return {
    device,
    network: state,
    captures,
    runSim<T>(fn: (s: Simulation) => T): { value: T; events: SimEvent[] } {
      const s = new Simulation(state);
      return { value: fn(s), events: s.events };
    },
  };
}
function session(state: NetworkState, device: Device, lines: string[]): { stack: CliStack; prompts: string[] } {
  let stack: CliStack = ["exec"];
  const prompts: string[] = [];
  for (const l of lines) {
    prompts.push(cliPrompt(stack, "sw1"));
    const r = runSonicCli(l, stack, ctxFor(state, device));
    stack = r.toBash ? [] : r.stack;
  }
  return { stack, prompts };
}
function acl(device: Device): AclState {
  return device.config.features?.acl as AclState;
}

describe("sonic-cli ACL sub-mode", () => {
  it("ip access-list <name> creates the table (type ip) and enters config-ipv4-acl", () => {
    const { state, device } = sw();
    const { prompts } = session(state, device, ["configure terminal", "ip access-list ipacl-example"]);
    expect(prompts).toContain("sw1(config)#");
    const table = acl(device).tables.find((t) => t.name === "ipacl-example");
    expect(table?.type).toBe("ip");
  });

  it("seq permit/deny apply inside the sub-view; exit returns to config then exec", () => {
    const { state, device } = sw();
    const { prompts, stack } = session(state, device, [
      "configure terminal",
      "ip access-list ipacl-example",
      "seq 10 permit ip host 10.1.1.1 host 20.1.1.1",
      "seq 20 deny ip host 10.1.1.2 host 20.1.1.2",
      "exit",
      "exit",
    ]);
    expect(prompts).toContain("sw1(config-ipv4-acl)#"); // sub-view prompt resolved from grammar
    expect(stack).toEqual(["exec"]); // sub-view -> config -> exec
    const rules = acl(device).rules["ipacl-example"];
    expect(rules).toContainEqual({ seq: 10, action: "permit", match: "ip host 10.1.1.1 host 20.1.1.1" });
    expect(rules).toContainEqual({ seq: 20, action: "deny", match: "ip host 10.1.1.2 host 20.1.1.2" });
  });

  it("no seq removes a rule inside the sub-view", () => {
    const { state, device } = sw();
    session(state, device, [
      "configure terminal",
      "ip access-list ipacl-example",
      "seq 10 permit ip host 10.1.1.1 host 20.1.1.1",
      "seq 20 deny ip host 10.1.1.2 host 20.1.1.2",
      "no seq 10",
      "exit",
      "exit",
    ]);
    expect(acl(device).rules["ipacl-example"].map((r) => r.seq)).toEqual([20]);
  });

  it("mac access-list enters config-mac-acl; no ip access-list deletes the table and its rules", () => {
    const { state, device } = sw();
    const { prompts } = session(state, device, [
      "configure terminal",
      "ip access-list ipacl-example",
      "seq 10 permit ip host 10.1.1.1 host 20.1.1.1",
      "exit",
      "mac access-list macacl-example",
      "seq 10 permit host 00:00:10:00:00:01 host 00:00:20:00:00:01",
      "exit",
      "no ip access-list ipacl-example",
      "exit",
    ]);
    expect(prompts).toContain("sw1(config-mac-acl)#");
    const st = acl(device);
    expect(st.tables.map((t) => t.name)).toEqual(["macacl-example"]);
    expect(st.tables.find((t) => t.name === "macacl-example")?.type).toBe("mac");
    expect(st.rules["ipacl-example"]).toBeUndefined(); // deleting the table cascades its rules away
    expect(st.rules["macacl-example"]).toContainEqual({ seq: 10, action: "permit", match: "host 00:00:10:00:00:01 host 00:00:20:00:00:01" });
  });
});
