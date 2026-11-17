/**
 * Feature-lab registry. A protocol registers a ready-made lab here (topology +
 * config) instead of editing the store; `loadFeatureLab(id)` checks this first.
 */
export interface LabApi {
  newLab(): void;
  addDevice(type: "pc" | "server" | "switch" | "router", pos: { x: number; y: number }, ports?: number): string;
  setInterfaceIp(deviceId: string, ifaceId: string, address: string, prefix: number): void;
  setDefaultGateway(deviceId: string, gateway: string | undefined): void;
  connect(aDev: string, aIf: string, bDev: string, bIf: string): void;
  setAccessVlan(deviceId: string, ifaceId: string, vlan: number): void;
  /** Rename a device (also its hostname). */
  rename(deviceId: string, name: string): void;
  /** Set the speed (Mbps) of every front-panel port of a switch. */
  setPortSpeed(deviceId: string, mbps: number): void;
  /** Apply KLISH lines on a switch from a fresh exec stack (echoed to its terminal). */
  runCliScript(deviceId: string, lines: string[]): void;
  /** Run a bash/Click command on a device as if typed at its shell. */
  exec(deviceId: string, command: string): void;
  /** Print a heading + muted hint lines into a device's terminal. */
  hint(deviceId: string, lines: string[]): void;
  finish(labName: string, selectedDeviceId?: string): void;
}

export type LabBuilder = (api: LabApi) => void;

const LABS = new Map<string, LabBuilder>();

export function registerLab(id: string, build: LabBuilder): void {
  LABS.set(id, build);
}

export function getLab(id: string): LabBuilder | undefined {
  return LABS.get(id);
}
