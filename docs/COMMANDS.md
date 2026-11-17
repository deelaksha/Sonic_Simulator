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
| `tcpdump` | `tcpdump -i eth0 -nn`, `-i any`, `-c N`, `-e`, `-v`, `-X`, pcap filters (`udp port 6343`, `src host …`, `net …`, `and/or/not`) | live capture until `-c N` or Ctrl+C (`sudo` required on SONiC switches) |
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

## tcpdump is a live capture (spec §19, §60)

`tcpdump` prints its banner and keeps running. Every frame the engine records on
the interface from then on (from any terminal, the Traffic tab or the sFlow
agent) is printed as it happens; packets from before tcpdump started are not
shown. It ends after `-c N` matches or on Ctrl+C with the usual summary.

```
admin@sw1:~$ sudo tcpdump -i any -nn port 6343
tcpdump: verbose output suppressed, use -v[v]... for full protocol decode
listening on any, link-type LINUX_SLL2 (Linux cooked v2), snapshot length 262144 bytes
17:23:57.436000 eth0  Out IP 192.168.200.204.43737 > 192.168.200.16.6343: sFlowv5, IPv4 agent 192.168.200.204, agent-id 100000, length 1252
^C
1 packet captured
1 packet received by filter
0 packets dropped by kernel
```
