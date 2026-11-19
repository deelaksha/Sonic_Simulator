/**
 * Registers every control-plane daemon. Imported once by the simulation engine,
 * so a protocol is enabled by adding its module here — nothing else changes.
 */
import "../protocols/arp-daemon";
import "../protocols/lldp-daemon";
import "../protocols/bfd-daemon";
import "../protocols/ospf-daemon";
import "../protocols/bgp-daemon";
import "../protocols/snmp-daemon";
import "../protocols/stp-daemon";
import "../protocols/lacp-daemon";
import "../protocols/mclag-daemon";
import "../protocols/acl-daemon";
import "../protocols/vxlan-daemon";
import "../protocols/sag";
import "../protocols/evpn-mh";
import "../protocols/vrrp-daemon";
import "../protocols/macaging-daemon";
import "../protocols/counters-daemon";
import "../protocols/syslog-daemon";
import "../protocols/cpu-daemon";
import "../protocols/qos-daemon";
import "../protocols/mirror";
import "../protocols/storm-control";
import "../protocols/dhcp-snooping";
import "../protocols/errdisable";
import "../protocols/udld-daemon";
import "../protocols/link-track";
import "../protocols/radv-daemon";
import "../protocols/ospf6-daemon";
import "../protocols/nat-daemon";
import "../protocols/ipsla-daemon";
import "../protocols/mcast-host";
import "../protocols/igmp-snooping";
import "../protocols/pim-daemon";

export * from "./daemon";
export * from "./hooks";
