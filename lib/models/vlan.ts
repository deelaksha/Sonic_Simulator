/**
 * VLAN model. The forwarding plane (switch classify / tag / untag) is
 * implemented in the L2 engine; this file holds the shared types.
 */

export const DEFAULT_VLAN = 1;

export interface Vlan {
  id: number; // 1..4094
  name: string;
}

export type PortMode = "access" | "trunk";

export interface InterfaceVlanConfig {
  mode: PortMode;
  /** Access VLAN for an access port. */
  accessVlan: number;
  /** Native (untagged) VLAN for a trunk port. */
  nativeVlan: number;
  /** VLANs permitted on a trunk port. */
  allowedVlans: number[];
}

export function defaultVlanConfig(): InterfaceVlanConfig {
  return {
    mode: "access",
    accessVlan: DEFAULT_VLAN,
    nativeVlan: DEFAULT_VLAN,
    allowedVlans: [DEFAULT_VLAN],
  };
}
