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
import "../protocols/vrrp-daemon";

export * from "./daemon";
export * from "./hooks";
