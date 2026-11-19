/**
 * SONiC FEATURE table and the containers/processes it controls.
 *
 * Defaults: the image's init_cfg.json FEATURE table (sonic-buildimage
 * files/build_templates/init_cfg.json.j2:70-99, rendered for this build in
 * fsroot-vs/etc/sonic/init_cfg.json), with the Jinja conditions evaluated for a
 * front-panel-port switch that is not a ToRRouter/SpineRouter. Configured state
 * lives in the same store the KLISH `feature state` modal writes
 * (features["cp_feature"].features, lib/commands/sonic-cli/features/feature.ts),
 * so KLISH and Click `config feature state` agree.
 *
 * Process lists come from each container's supervisord.conf (dockers/<image>/
 * supervisord.conf[.j2], platform/vs/docker-syncd-vs/supervisord.conf).
 */
import { Device } from "../models/device";
import { peekFeatureState } from "../models/feature-state";

export interface FeatureDefault {
  name: string;
  state: "enabled" | "disabled" | "always_enabled" | "always_disabled";
  autoRestart: "enabled" | "disabled" | "always_enabled";
  image: string;
  processes: string[];
}

const F = (name: string, state: FeatureDefault["state"], image: string, processes: string[], autoRestart: FeatureDefault["autoRestart"] = "enabled"): FeatureDefault => ({
  name, state, autoRestart, image, processes,
});

export const DEFAULT_FEATURES: FeatureDefault[] = [
  F("bgp", "enabled", "docker-fpm-frr", ["supervisord", "mgmtd", "zebra", "staticd", "bfdd", "bgpd", "ospfd", "fpmsyncd", "bgpcfgd", "bgpmon"]),
  F("database", "always_enabled", "docker-database", ["supervisord", "redis-server"], "always_enabled"),
  F("dhcp_relay", "enabled", "docker-dhcp-relay", ["supervisord", "dhcrelay", "dhcp6relay", "dhcpmon"]),
  F("eventd", "enabled", "docker-eventd", ["supervisord", "eventd"]),
  F("gbsyncd", "enabled", "docker-gbsyncd-vs", ["supervisord", "gbsyncdmgrd"]),
  F("gnmi", "enabled", "docker-sonic-gnmi", ["supervisord", "gnmi-native", "dialout"]),
  F("iccpd", "enabled", "docker-iccpd", ["supervisord", "iccpd"]),
  F("lldp", "enabled", "docker-lldp", ["supervisord", "lldpd", "lldp-syncd", "lldpmgrd"]),
  F("macsec", "disabled", "docker-macsec", ["supervisord", "macsecmgrd"]),
  F("mgmt-framework", "enabled", "docker-sonic-mgmt-framework", ["supervisord", "rest-server"]),
  F("mux", "always_disabled", "docker-mux", ["supervisord", "linkmgrd"]),
  F("nat", "disabled", "docker-nat", ["supervisord", "natmgrd", "natsyncd"]),
  F("pmon", "enabled", "docker-platform-monitor", ["supervisord", "ledd", "xcvrd", "psud", "syseepromd", "thermalctld", "pcied"]),
  F("radv", "enabled", "docker-router-advertiser", ["supervisord", "radvd"]),
  F("sflow", "enabled", "docker-sflow", ["supervisord", "sflowmgrd", "port_index_mapper"]),
  F("snmp", "enabled", "docker-snmp", ["supervisord", "snmpd", "snmp-subagent"]),
  F("swss", "enabled", "docker-orchagent", ["supervisord", "orchagent", "portsyncd", "neighsyncd", "coppmgrd", "vlanmgrd", "intfmgrd", "portmgrd", "buffermgrd", "vrfmgrd", "nbrmgrd", "vxlanmgrd", "fdbsyncd"]),
  F("syncd", "enabled", "docker-syncd-vs", ["supervisord", "syncd"]),
  F("teamd", "enabled", "docker-teamd", ["supervisord", "teammgrd", "teamsyncd", "tlm_teamd"]),
];

export interface FeatureRow {
  name: string;
  state: string;
  autoRestart: string;
  image: string;
  processes: string[];
}

type CpFeature = { name: string; state?: string; autorestart?: string };

/** FEATURE table: image defaults merged with configured state. */
export function featureRows(device: Device): FeatureRow[] {
  const cfg = (peekFeatureState<{ features?: CpFeature[] }>(device, "cp_feature")?.features ?? []);
  return DEFAULT_FEATURES.map((f) => {
    const c = cfg.find((x) => x.name === f.name);
    return { name: f.name, state: c?.state ?? f.state, autoRestart: c?.autorestart ?? f.autoRestart, image: f.image, processes: f.processes };
  });
}

/** Is the feature's container running? (unknown feature names count as enabled). */
export function featureEnabled(device: Device, name: string): boolean {
  const r = featureRows(device).find((f) => f.name === name);
  return !r || r.state === "enabled" || r.state === "always_enabled";
}

// ---- containers (docker ps / show services) ----

export interface ContainerTimes {
  startedMs?: number;
  exitedMs?: number;
}

/** features["sonic-containers"]: when each container last started/exited (set by `config feature state`). */
export function containerTimes(device: Device): Record<string, ContainerTimes> {
  const cfg = (device.config.features ??= {});
  return ((cfg["sonic-containers"] ??= {}) as Record<string, ContainerTimes>);
}

/** Record a feature state change: the matching container stops or (re)starts now. */
export function setContainerRunning(device: Device, name: string, running: boolean, nowMs: number): void {
  const t = (containerTimes(device)[name] ??= {});
  if (running) {
    t.startedMs = nowMs;
    delete t.exitedMs;
  } else t.exitedMs = nowMs;
}

/** Deterministic 12-hex container id. */
export function containerId(device: Device, name: string): string {
  let h = 0x811c9dc5;
  for (const ch of `${device.id}/${name}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  let h2 = h ^ 0x9e3779b9;
  h2 = Math.imul(h2 ^ (h2 >>> 15), 0x2c1b3c6d) >>> 0;
  return (h.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 12);
}

/** `ps aux` inside a container: supervisord as PID 1, then its programs. */
export function containerPs(device: Device, row: FeatureRow): string[] {
  const out = ["USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND"];
  row.processes.forEach((p, i) => {
    const pid = i === 0 ? 1 : 10 + i * 7;
    const cmd = p === "supervisord" ? "/usr/bin/python3 /usr/local/bin/supervisord" : p === "redis-server" ? "/usr/bin/redis-server 127.0.0.1:6379" : `/usr/bin/${p}`;
    const vsz = 20000 + ((containerId(device, row.name + p).charCodeAt(0) * 997) % 200000);
    out.push(`root    ${String(pid).padStart(8)}  0.0  0.1 ${String(vsz).padStart(6)} ${String(Math.floor(vsz / 4)).padStart(5)} ?        Sl   00:00   0:00 ${cmd}`);
  });
  return out;
}
