/** Mission registry (content files in lib/missions/content register here). */
import { Mission } from "./types";

const MISSIONS = new Map<string, Mission>();

export function registerMission(m: Mission): void {
  MISSIONS.set(m.id, m);
}

export function getMission(id: string): Mission | undefined {
  return MISSIONS.get(id);
}

export function allMissions(): Mission[] {
  return [...MISSIONS.values()];
}

export function missionsForLab(labId: string): Mission[] {
  return allMissions().filter((m) => m.labId === labId);
}
