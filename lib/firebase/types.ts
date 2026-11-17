/**
 * Firebase Session & Switch Configuration types
 */
import { NetworkState } from "../models/topology";
import { TerminalLine } from "../store/lab-store";
import { CliStack } from "../commands/sonic-cli";
import { Device, DeviceConfig } from "../models/device";
import { NetInterface } from "../models/interface";
import { Route } from "../models/route";
import { Vlan } from "../models/vlan";

export interface FirebaseConfigOptions {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId: string;
  measurementId?: string;
}

export interface SwitchConfigDetail {
  deviceId: string;
  name: string;
  hostname: string;
  ports: number;
  interfaces: NetInterface[];
  vlans: Vlan[];
  features: Record<string, unknown>;
  routingTable: Route[];
  routingTable6: Route[];
  runningConfigText: string;
  terminalHistory?: string[];
  terminalLines?: TerminalLine[];
  cliMode?: CliStack;
}

export interface SwitchSummary {
  id: string;
  name: string;
  hostname: string;
  portCount: number;
  vlans: number[];
  features: string[];
  ipAddresses: string[];
  macAddress: string;
}

export interface CloudSessionListItem {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  deviceCount: number;
  switchCount: number;
  switchesSummary: SwitchSummary[];
}

export interface CloudSessionData {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  deviceCount: number;
  switchCount: number;
  switchesSummary: SwitchSummary[];
  network: NetworkState;
  terminals: Record<string, TerminalLine[]>;
  terminalHistory: Record<string, string[]>;
  cliMode: Record<string, CliStack>;
  selectedDeviceId?: string;
  switches: Record<string, SwitchConfigDetail>;
}

export interface SwitchSnapshot {
  id: string;
  switchId: string;
  name: string;
  hostname: string;
  createdAt: number;
  updatedAt: number;
  config: DeviceConfig;
  interfaces: NetInterface[];
  vlans: Vlan[];
  runningConfigText: string;
  features: Record<string, unknown>;
}

export type CloudSyncStatus = "synced" | "saving" | "error" | "offline" | "not-configured" | "idle";
