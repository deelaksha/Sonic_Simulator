# Terminal Commands

Every command is **parsed** (not string-matched) and runs against the simulated
network state. Only commands in the registry (`lib/commands/registry.ts`) can run
— there is no path to host execution (see SECURITY.md). Type `help` in any device
terminal, or `help <command>` for details.

| Command | Examples | Notes |
|---------|----------|-------|
| `ping` | `ping 192.168.1.20`, `ping -c 5 10.0.0.1` | ICMP echo; output + timing from the real journey; failures explained (spec §37) |
| `traceroute` | `traceroute 192.168.2.10`, `traceroute -m 10 X` | TTL-based hop discovery; alias `tracepath` |
| `ip addr` | `ip addr`, `ip addr add 192.168.1.10/24 dev eth0`, `ip addr del ...` | show + configure addresses |
| `ip link` | `ip link`, `ip link set eth0 up`, `ip link set eth0 down` | show + admin state |
| `ip route` | `ip route`, `ip route add default via 192.168.1.1`, `ip route add 10.0.0.0/8 via X`, `ip route del ...` | show + static/default routes |
| `ip neigh` | `ip neigh` | neighbour (ARP) cache |
| `arp` | `arp`, `arp -a` | ARP cache (Linux + BSD styles) |
| `tcpdump` | `tcpdump -i eth0`, `tcpdump -i eth0 icmp`, `tcpdump -i eth0 host 192.168.1.20`, `-c N`, `-e` | reads the capture buffer |
| `route` | `route`, `route -n` | legacy routing table |
| `ifconfig` | `ifconfig` | legacy interface view (incl. RX/TX counters) |
| `hostname` | `hostname` | device hostname |
| `help` | `help`, `help ping` | list / detail |
| `clear` | `clear` | clear scrollback (alias `cls`) |

## Single source of truth in action (spec §61)

```
pc1$ ip addr add 192.168.1.10/24 dev eth0   # via terminal
pc1$ ip route                                # connected route now present
# ...open the Device panel: the same IP + route are shown there.
# Change the IP in the GUI, run `ip addr` again — it reflects the change.
```

## tcpdump is a real consumer (spec §19, §60)

The capture buffer is populated by the engine as frames cross each interface.
Because the simulation is turn-based, the workflow is: run traffic (e.g. `ping`),
then `tcpdump -i eth0 icmp` to inspect what was captured.

```
pc1$ tcpdump -i eth0 icmp
12:00:00.004 IP 192.168.1.10 > 192.168.1.20: ICMP echo request, id 1000, seq 1, length 64
12:00:00.008 IP 192.168.1.20 > 192.168.1.10: ICMP echo reply,   id 1000, seq 1, length 64
```
