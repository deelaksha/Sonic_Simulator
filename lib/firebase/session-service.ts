/**
 * Session & Switch Configuration Service
 * Provides Firestore persistence for complete network sessions,
 * switch configurations, and standalone switch configuration snapshots.
 *
 * Includes an automatic local storage fallback so sessions are never lost
 * even before Firebase credentials are configured.
 */
import {
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  deleteDoc,
  query,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";
import { getFirestoreDb, isFirebaseConfigured } from "./config";
import { getAppStorage } from "./storage-fallback";
import {
  CloudSessionData,
  CloudSessionListItem,
  SwitchConfigDetail,
  SwitchSummary,
  SwitchSnapshot,
} from "./types";
import { NetworkState } from "../models/topology";
import { TerminalLine } from "../store/lab-store";
import { CliStack } from "../commands/sonic-cli";
import { isSwitch, Device } from "../models/device";
import { generateSonicRunningConfig } from "../sonic/config-export";

const SESSIONS_COLLECTION = "sonic_sessions";
const SWITCH_SNAPSHOTS_COLLECTION = "sonic_switch_configs";
const LOCAL_SESSIONS_KEY = "sonic_simulator_local_sessions";
const LOCAL_SWITCHES_KEY = "sonic_simulator_local_switch_snapshots";

// ---------------------------------------------------------------------------
// Helpers to build summaries and details for switches
// ---------------------------------------------------------------------------

export function extractSwitchesData(
  network: NetworkState,
  terminals: Record<string, TerminalLine[]>,
  terminalHistory: Record<string, string[]>,
  cliMode: Record<string, CliStack>,
): {
  summaries: SwitchSummary[];
  details: Record<string, SwitchConfigDetail>;
} {
  const summaries: SwitchSummary[] = [];
  const details: Record<string, SwitchConfigDetail> = {};

  const devices = Object.values(network.devices);
  for (const dev of devices) {
    if (!isSwitch(dev.type)) continue;

    const vlans = (dev.config.vlans || []).map((v) => v.id);
    const features = Object.keys(dev.config.features || {});
    const ipAddresses: string[] = [];
    for (const iface of dev.interfaces) {
      for (const ip of iface.ipv4) ipAddresses.push(`${ip.address}/${ip.prefix}`);
      for (const ip6 of iface.ipv6) ipAddresses.push(`${ip6.address}/${ip6.prefix}`);
    }

    const firstIfaceMac = dev.interfaces[0]?.mac || "00:00:00:00:00:00";
    const runningConfigText = generateSonicRunningConfig(dev);

    summaries.push({
      id: dev.id,
      name: dev.name,
      hostname: dev.config.hostname || dev.name,
      portCount: dev.interfaces.length,
      vlans,
      features,
      ipAddresses,
      macAddress: firstIfaceMac,
    });

    details[dev.id] = {
      deviceId: dev.id,
      name: dev.name,
      hostname: dev.config.hostname || dev.name,
      ports: dev.interfaces.length,
      interfaces: dev.interfaces,
      vlans: dev.config.vlans || [],
      features: dev.config.features || {},
      routingTable: dev.routingTable,
      routingTable6: dev.routingTable6,
      runningConfigText,
      terminalHistory: terminalHistory[dev.id] || [],
      terminalLines: terminals[dev.id] || [],
      cliMode: cliMode[dev.id] || [],
    };
  }

  return { summaries, details };
}

// ---------------------------------------------------------------------------
// LocalStorage Fallback Layer (used when Firebase is offline / unconfigured)
// ---------------------------------------------------------------------------

function getLocalSessions(): Record<string, CloudSessionData> {
  const storage = getAppStorage();
  try {
    const raw = storage.getItem(LOCAL_SESSIONS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveLocalSession(session: CloudSessionData): void {
  const storage = getAppStorage();
  try {
    const all = getLocalSessions();
    all[session.id] = session;
    storage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify(all));
  } catch (e) {
    console.error("Failed to save local session", e);
  }
}

function deleteLocalSession(id: string): void {
  const storage = getAppStorage();
  try {
    const all = getLocalSessions();
    delete all[id];
    storage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify(all));
  } catch (e) {
    console.error("Failed to delete local session", e);
  }
}

// ---------------------------------------------------------------------------
// Session CRUD Operations
// ---------------------------------------------------------------------------

export async function saveSession(params: {
  id?: string;
  name: string;
  description?: string;
  network: NetworkState;
  terminals: Record<string, TerminalLine[]>;
  terminalHistory: Record<string, string[]>;
  cliMode: Record<string, CliStack>;
  selectedDeviceId?: string;
}): Promise<CloudSessionData> {
  const sessionId = params.id || `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const now = Date.now();

  const { summaries, details } = extractSwitchesData(
    params.network,
    params.terminals,
    params.terminalHistory,
    params.cliMode,
  );

  const deviceCount = Object.keys(params.network.devices).length;
  const switchCount = summaries.length;

  const sessionData: CloudSessionData = {
    id: sessionId,
    name: params.name || "Untitled Lab Session",
    description: params.description || `Session with ${switchCount} switch(es)`,
    createdAt: now,
    updatedAt: now,
    deviceCount,
    switchCount,
    switchesSummary: summaries,
    network: params.network,
    terminals: params.terminals,
    terminalHistory: params.terminalHistory,
    cliMode: params.cliMode,
    selectedDeviceId: params.selectedDeviceId,
    switches: details,
  };

  // Always mirror to local storage
  saveLocalSession(sessionData);

  const db = getFirestoreDb();
  if (db && isFirebaseConfigured()) {
    try {
      const docRef = doc(db, SESSIONS_COLLECTION, sessionId);
      await setDoc(docRef, {
        ...sessionData,
        firebaseUpdatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn("Failed to write to Firestore, saved to local cache instead", err);
    }
  }

  return sessionData;
}

export async function listSessions(): Promise<CloudSessionListItem[]> {
  const db = getFirestoreDb();
  const list: CloudSessionListItem[] = [];
  const seenIds = new Set<string>();

  // Fetch from Firebase if configured
  if (db && isFirebaseConfigured()) {
    try {
      const colRef = collection(db, SESSIONS_COLLECTION);
      const q = query(colRef, orderBy("updatedAt", "desc"));
      const snapshot = await getDocs(q);

      snapshot.forEach((d) => {
        const data = d.data() as CloudSessionData;
        seenIds.add(data.id);
        list.push({
          id: data.id,
          name: data.name,
          description: data.description,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          deviceCount: data.deviceCount || Object.keys(data.network?.devices || {}).length,
          switchCount: data.switchCount || data.switchesSummary?.length || 0,
          switchesSummary: data.switchesSummary || [],
        });
      });
    } catch (err) {
      console.warn("Failed to list from Firestore, falling back to local storage", err);
    }
  }

  // Include any local sessions not in remote
  const local = getLocalSessions();
  for (const id of Object.keys(local)) {
    if (!seenIds.has(id)) {
      const data = local[id];
      list.push({
        id: data.id,
        name: data.name,
        description: data.description,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        deviceCount: data.deviceCount || Object.keys(data.network?.devices || {}).length,
        switchCount: data.switchCount || data.switchesSummary?.length || 0,
        switchesSummary: data.switchesSummary || [],
      });
    }
  }

  // Sort descending by updatedAt
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadSession(sessionId: string): Promise<CloudSessionData | null> {
  const db = getFirestoreDb();

  if (db && isFirebaseConfigured()) {
    try {
      const docRef = doc(db, SESSIONS_COLLECTION, sessionId);
      const snapshot = await getDoc(docRef);
      if (snapshot.exists()) {
        const data = snapshot.data() as CloudSessionData;
        saveLocalSession(data); // update local cache
        return data;
      }
    } catch (err) {
      console.warn("Failed to load from Firestore, checking local storage", err);
    }
  }

  // Fallback to local
  const local = getLocalSessions();
  return local[sessionId] || null;
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  deleteLocalSession(sessionId);

  const db = getFirestoreDb();
  if (db && isFirebaseConfigured()) {
    try {
      const docRef = doc(db, SESSIONS_COLLECTION, sessionId);
      await deleteDoc(docRef);
    } catch (err) {
      console.error("Failed to delete session from Firestore", err);
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Standalone Switch Snapshots / Templates
// ---------------------------------------------------------------------------

export async function saveSwitchSnapshot(
  device: Device,
  name?: string,
): Promise<SwitchSnapshot> {
  const id = `switch_snapshot_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const now = Date.now();
  const runningConfigText = generateSonicRunningConfig(device);

  const snapshot: SwitchSnapshot = {
    id,
    switchId: device.id,
    name: name || `${device.name} Configuration`,
    hostname: device.config.hostname || device.name,
    createdAt: now,
    updatedAt: now,
    config: device.config,
    interfaces: device.interfaces,
    vlans: device.config.vlans || [],
    runningConfigText,
    features: device.config.features || {},
  };

  // Local storage
  const storage = getAppStorage();
  try {
    const raw = storage.getItem(LOCAL_SWITCHES_KEY);
    const all: Record<string, SwitchSnapshot> = raw ? JSON.parse(raw) : {};
    all[id] = snapshot;
    storage.setItem(LOCAL_SWITCHES_KEY, JSON.stringify(all));
  } catch (e) {
    console.error(e);
  }

  const db = getFirestoreDb();
  if (db && isFirebaseConfigured()) {
    try {
      const docRef = doc(db, SWITCH_SNAPSHOTS_COLLECTION, id);
      await setDoc(docRef, snapshot);
    } catch (err) {
      console.warn("Failed to save switch snapshot to Firestore", err);
    }
  }

  return snapshot;
}

export async function listSwitchSnapshots(): Promise<SwitchSnapshot[]> {
  const list: SwitchSnapshot[] = [];
  const seenIds = new Set<string>();

  const db = getFirestoreDb();
  if (db && isFirebaseConfigured()) {
    try {
      const colRef = collection(db, SWITCH_SNAPSHOTS_COLLECTION);
      const snapshot = await getDocs(colRef);
      snapshot.forEach((d) => {
        const item = d.data() as SwitchSnapshot;
        seenIds.add(item.id);
        list.push(item);
      });
    } catch (err) {
      console.warn("Failed to list switch snapshots from Firestore", err);
    }
  }

  const storage = getAppStorage();
  try {
    const raw = storage.getItem(LOCAL_SWITCHES_KEY);
    const all: Record<string, SwitchSnapshot> = raw ? JSON.parse(raw) : {};
    for (const id of Object.keys(all)) {
      if (!seenIds.has(id)) list.push(all[id]);
    }
  } catch {}

  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}
