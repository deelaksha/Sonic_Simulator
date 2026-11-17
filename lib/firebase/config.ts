/**
 * Firebase initialization and configuration manager
 * Supports both environment variables (.env.local) and in-browser settings.
 */
import { initializeApp, getApps, getApp, FirebaseApp } from "firebase/app";
import { getFirestore, Firestore, enableIndexedDbPersistence } from "firebase/firestore";
import { FirebaseConfigOptions } from "./types";
import { getAppStorage } from "./storage-fallback";

const LOCAL_STORAGE_KEY = "sonic_simulator_firebase_config";

export function getStoredFirebaseConfig(): FirebaseConfigOptions | null {
  const storage = getAppStorage();
  try {
    const raw = storage.getItem(LOCAL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.apiKey && parsed.projectId) {
        return parsed as FirebaseConfigOptions;
      }
    }
  } catch (err) {
    console.warn("Failed to read Firebase config from localStorage", err);
  }

  return getEnvFirebaseConfig();
}

export function getEnvFirebaseConfig(): FirebaseConfigOptions | null {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

  if (apiKey && projectId) {
    return {
      apiKey,
      authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      projectId,
      storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "",
    };
  }
  return null;
}

export function saveStoredFirebaseConfig(config: FirebaseConfigOptions | null): void {
  const storage = getAppStorage();
  if (!config) {
    storage.removeItem(LOCAL_STORAGE_KEY);
  } else {
    storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(config));
  }
}

let appInstance: FirebaseApp | null = null;
let dbInstance: Firestore | null = null;
let currentConfigString: string | null = null;

export function getFirebaseApp(): FirebaseApp | null {
  const config = getStoredFirebaseConfig();
  if (!config || !config.apiKey || !config.projectId) {
    return null;
  }

  const configKey = JSON.stringify(config);
  if (appInstance && currentConfigString === configKey) {
    return appInstance;
  }

  try {
    const apps = getApps();
    const app = apps.length > 0 && currentConfigString === configKey ? getApp() : initializeApp(config);
    appInstance = app;
    currentConfigString = configKey;
    dbInstance = getFirestore(app);
    return app;
  } catch (err) {
    console.error("Firebase app initialization failed:", err);
    return null;
  }
}

export function getFirestoreDb(): Firestore | null {
  const app = getFirebaseApp();
  if (!app) return null;
  if (!dbInstance) {
    dbInstance = getFirestore(app);
  }
  return dbInstance;
}

export function isFirebaseConfigured(): boolean {
  const config = getStoredFirebaseConfig();
  return Boolean(config && config.apiKey && config.projectId);
}
