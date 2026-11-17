/**
 * Firebase initialization and configuration manager
 * Supports both environment variables (.env.local) and in-browser settings.
 */
import { initializeApp, getApps, getApp, FirebaseApp } from "firebase/app";
import { getFirestore, Firestore } from "firebase/firestore";
import type { Analytics } from "firebase/analytics";
import { FirebaseConfigOptions } from "./types";
import { getAppStorage } from "./storage-fallback";

const LOCAL_STORAGE_KEY = "sonic_simulator_firebase_config";

/** Default project configuration provided by the user */
export const DEFAULT_FIREBASE_CONFIG: FirebaseConfigOptions = {
  apiKey: "AIzaSyCxne-6ZiUy9xzNsNYoDVs3IgfkVWDjILk",
  authDomain: "switch-1c596.firebaseapp.com",
  projectId: "switch-1c596",
  storageBucket: "switch-1c596.firebasestorage.app",
  messagingSenderId: "350577881833",
  appId: "1:350577881833:web:cfb435763da186aeb9f678",
  measurementId: "G-KJVQCWBFNS",
};

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

  return getEnvFirebaseConfig() || DEFAULT_FIREBASE_CONFIG;
}

export function getEnvFirebaseConfig(): FirebaseConfigOptions | null {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

  if (apiKey && projectId) {
    return {
      apiKey,
      authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || DEFAULT_FIREBASE_CONFIG.authDomain,
      projectId,
      storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || DEFAULT_FIREBASE_CONFIG.storageBucket,
      messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || DEFAULT_FIREBASE_CONFIG.messagingSenderId,
      appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || DEFAULT_FIREBASE_CONFIG.appId,
      measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID || DEFAULT_FIREBASE_CONFIG.measurementId,
    };
  }
  return DEFAULT_FIREBASE_CONFIG;
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
    if (typeof window !== "undefined") {
      getFirebaseAnalytics().catch(() => {});
    }
    return app;
  } catch (err) {
    console.error("Firebase app initialization failed:", err);
    return null;
  }
}

let analyticsInstance: Analytics | null = null;

export async function getFirebaseAnalytics(): Promise<Analytics | null> {
  if (typeof window === "undefined") return null;
  const app = getFirebaseApp();
  if (!app) return null;
  try {
    const { getAnalytics, isSupported } = await import("firebase/analytics");
    if (await isSupported()) {
      if (!analyticsInstance) {
        analyticsInstance = getAnalytics(app);
      }
      return analyticsInstance;
    }
  } catch (err) {
    console.debug("Firebase analytics not supported in current environment", err);
  }
  return null;
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
