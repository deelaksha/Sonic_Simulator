# sFlow / VLAN reference captures (live SONiC-VS)

Captured 2026-11-17 from the SONiC virtual switch at 192.168.200.204
(`SONiC-OS-4.5.0-Enterprise_Base`, `x86_64-kvm`, ASIC `vs`, HwSKU
`DellEMC-S5248f-P-25G-DPB`). Bench: Ethernet0 (`eth1`) and Ethernet1 (`eth2`)
as access ports in VLAN 100, two Linux network-namespace hosts attached to the
wire side of `eth1`/`eth2` with `tc mirred`, sFlow collector 192.168.200.16:6343
reached over `eth0`. The switch was restored to its baseline CONFIG_DB afterwards.

| File | Contents |
|------|----------|
| `klish-show.txt` | `sonic-cli` show sflow / sflow interface / Vlan / interface status / mac address-table / running-config |
| `configdb-and-click-show.txt` | CONFIG_DB rows (SFLOW, SFLOW_COLLECTOR, SFLOW_SESSION, VLAN, PORT), kernel ifindexes, Click `show sflow` / `show vlan brief` |
| `sflow-datagrams-tcpdump-vvv.txt` | sFlow datagrams captured on `eth0`, decoded with `tcpdump -vvv` |

Behaviour the simulator takes from these captures (lib/sflow/):

- Counter samples are **expanded** (format 4): a port-name record (1005) + generic
  interface counters (1); ifIndex = N+1 for EthernetN; ifSpeed in bps; agent
  sub-id 100000; datagrams ≤ 1400 bytes; host records 2000-2010 (not simulated).
- With sFlow enabled globally, **every** port has a session at its speed-based
  rate (25G → 25000, 100G → 100000); the global `sflow sampling-rate 256` is
  stored and shown but not applied to any port.
- Collectors are keyed `{ip}_{port}_{vrf}`; `sflow collector <ip> <port>` (bare port).
- VS sampling is a `tc … matchall action sample rate 1/N group 1` on the port tap's ingress.

The deployed image is older than the source tree in
`deelaksha/Vlan_Sflow/sonic-buildimage`. Where they differ the simulator follows
the source (the user's working codebase):

- KLISH `show sflow` on the switch prints a "Global sFlow Information" block with
  tab-indented fields, while the source's `show_sflow.j2` prints
  "sFlow Global Information:" with aligned labels.
- Click `show sflow` on the switch has an extra "sFlow sampling-rate:" line, and
  `show vlan brief` has an AutoState column. Neither is in the source's
  sonic-utilities.
- On the deployed image, a per-port `sflow sampling-rate` change makes orchagent
  call `sflowSessionGetSampleSize`. VS syncd never answers it, and after four
  6-minute timeouts orchagent exits and swss/syncd restart (syslog 11:21–11:39).
  The rate never reaches the `tc` filter. This function is not in the source tree.
