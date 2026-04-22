import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  getDoc, 
  setDoc, 
  collection, 
  query, 
  orderBy, 
  limit, 
  getDocs,
  enableIndexedDbPersistence
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

import { onSnapshot } from 'firebase/firestore';

export function subscribeToLiveStatus(callback: (data: any) => void) {
  const docRef = doc(db, 'live_status', 'current');
  return onSnapshot(docRef, (doc) => {
    if (doc.exists()) {
      callback(doc.data());
    }
  });
}

export function subscribeToHitHistory(callback: (hits: SharedHit[]) => void) {
  const q = query(
    collection(db, 'hit_history'),
    orderBy('timestamp', 'desc'),
    limit(50)
  );
  return onSnapshot(q, (snapshot) => {
    const hits = snapshot.docs.map(d => d.data() as SharedHit).reverse();
    callback(hits);
  });
}

// Enable offline persistence
try {
  enableIndexedDbPersistence(db).catch((err) => {
    if (err.code === 'failed-precondition') {
      console.warn('Multiple tabs open, persistence can only be enabled in one tab at a time.');
    } else if (err.code === 'unimplemented') {
      console.warn('The current browser does not support all of the features required to enable persistence.');
    }
  });
} catch (e) {}

export async function ensureAuth() {
  if (!auth.currentUser) {
    try {
      // Try to sign in, but don't blow up if the provider is disabled in console
      await signInAnonymously(auth);
    } catch (e: any) {
      // Silently fail auth but allow the app to proceed in guest mode since rules are adjusted
      console.log("Firebase initialized in Guest Mode (Public Sync Active)");
    }
  }
}

export interface SharedHit {
  period: string;
  isHit: boolean;
  number: number;
  strategy: string;
  timestamp: string;
}

export async function syncHitHistoryToCloud(hits: SharedHit[]) {
  await ensureAuth();
  for (const hit of hits) {
    const docRef = doc(db, 'hit_history', hit.period);
    await setDoc(docRef, hit, { merge: true });
  }
}

export async function fetchHitHistoryFromCloud(): Promise<SharedHit[]> {
  await ensureAuth();
  const q = query(
    collection(db, 'hit_history'),
    orderBy('timestamp', 'desc'),
    limit(50)
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map(d => d.data() as SharedHit).reverse();
}

export async function updateLiveStatus(period: string, prediction: any, evolutionMetadata: any, resonanceData: any) {
  await ensureAuth();
  const docRef = doc(db, 'live_status', 'current');
  await setDoc(docRef, {
    period,
    prediction,
    evolutionMetadata,
    resonanceData,
    updatedAt: new Date().toISOString()
  });
}

export async function getLiveStatus() {
  await ensureAuth();
  const docRef = doc(db, 'live_status', 'current');
  const snap = await getDoc(docRef);
  return snap.exists() ? snap.data() : null;
}
