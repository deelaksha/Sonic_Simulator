# SONiC Feature Layer

The SONiC layer adds SONiC-style CLI (`config …`, `show …`, `sudo …`) on top of the
existing simulation engine. It is **additive**: the Linux CLI, packet engine,
topology, timeline, and inspector are unchanged. Both CLIs operate on the ONE
network state (task §61), so a `config` command produces a real state transition
and `show` renders live state (task §17).

## Architecture

```
terminal input ("config vlan add 10" / "show vlan brief" / "sudo config ...")
      ↓  (execute → registry; a leading `sudo` is a passthrough handler)
config / show  handlers               lib/commands/sonic/index.ts
      ↓  longest-prefix match on the sub-command path
feature module (SonicCmd.run)         lib/commands/sonic/<feature>.ts
      ↓  mutates ctx.device / ctx.network  (or reads it for `show`)
existing network state + packet engine   →  timeline / animation / inspector
```

- **Contract:** `lib/commands/sonic/types.ts` — `SonicFeatureModule { id, config: SonicCmd[], show: SonicCmd[] }`. Each `SonicCmd` has a `path` (tokens after `config`/`show`) and a `run(argsAfterPath, ctx)`.
- **Dispatcher:** `lib/commands/sonic/index.ts` composes all modules into the `config` and `show` `CommandHandler`s (registered in `lib/commands/registry.ts`, tagged `cli: "sonic"` for the §59 Linux-vs-SONiC distinction).
- **Feature registry (UI/metadata):** `lib/sonic/feature-registry.ts` — grouping, phases, status, `simReady`. Does not embed commands.
- **Command catalog (source of truth):** `data/sonic-command-catalog/` generated from the read-only cheat sheets by `scripts/extract-sonic-catalog.ts` (see `docs/SONIC_ANALYSIS.md`).

## Adding a feature (one file)

1. Create `lib/commands/sonic/<feature>.ts` exporting `export const <feature>Module: SonicFeatureModule = { id, config, show }` (copy `vlan.ts`).
2. Base every command on the real forms in `20Augcheats/<feature>.txt` — do not invent commands or output (task §50). Render `show` from live state.
3. Add the module to `MODULES` in `lib/commands/sonic/index.ts` (one line).
4. Add `tests/sonic-<feature>.test.ts` proving config → state → behavior.

## Implemented this phase

- **common** — `show interfaces status`, `show ip interfaces`, `show mac[/address-table]`, `show running-config[uration]`, `show version`, `config save`.
- **vlan** — `config vlan add/del`, `config vlan member add/del [-u]`, `show vlan[/brief/<id>]`. VLAN membership drives real 802.1Q forwarding/isolation in the switch engine (task §54). Lab: toolbox → **Load VLAN lab**.
- **staticroute**, **interface**, **arpnd** — data/forwarding-plane modules (routes, IP/admin, neighbour cache) that change real behavior.
- **ntp**, **dns**, **snmp**, **aaa**, **tacacs**, **radius** — config-plane modules: `config …` writes to the per-device feature store (`lib/models/feature-state.ts`), `show …` renders it back. Real config→state→show transitions; packet-level protocol behavior (e.g. NTP UDP/123) is a separate future step and is NOT faked (NTP `show ntp associations` shows a placeholder, never invented offsets).

## Two implementation tiers

- **Forwarding-plane features** drive the packet engine (vlan isolation, static-route forwarding, interface up/down, arp cache). Verified with pings.
- **Config-plane features** model the SONiC CONFIG_DB (feature-state store) + `show`. This is the bulk of the cheat-sheet surface (mostly `config`/`show`). Where a feature also has on-the-wire behavior, that is added later on the packet engine, and limitations are flagged rather than fabricated (task §32/§41/§47).

Next per `docs/SONIC_ANALYSIS.md` phases: LLDP/LACP, VRF/VRRP, OSPF/BGP, ACL/QoS/sFlow, then packet-plane behavior for NTP/DHCP/DNS.

## Reference / real-device mode

The unified-device-model + real-SONiC-over-SSH mode (task §42-§47) is future work.
Today everything runs in the safe simulation; only registered SONiC commands can
execute (no host shell), matching the security model in `docs/SECURITY.md`.
