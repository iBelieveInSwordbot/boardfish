/**
 * Tiny IndexedDB key/value wrapper for Boardfish autosave.
 *
 * Why not localStorage: localStorage caps at ~5 MB per origin. Boardfish
 * generates panels with base64 data URLs for images and videos — a single
 * modest storyboard blows the quota and the autosave silently fails, which
 * is why hitting the back button turned all panels black (fresh render
 * loaded an old / empty state).
 *
 * IndexedDB gives us practically unbounded storage on the same origin and
 * doesn't require JSON-stringifying binary payloads. We keep the API
 * intentionally simple (get / set / del) and store the entire Boardfish
 * state under a single key, just like the localStorage version, so the
 * migration is a drop-in.
 *
 * Cross-tab / back-button behavior: IndexedDB persists across page loads
 * in exactly the way we want. Data written by the previous page navigation
 * is available immediately when the tab returns.
 */

const DB_NAME = 'boardfish';
const STORE_NAME = 'kv';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  return dbPromise;
}

export async function idbGet<T = unknown>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function idbDel(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Ask the browser for persistent storage. If granted, IndexedDB data isn't
 * evicted by the browser under storage pressure. This is a hint — the browser
 * may still say no. Boardfish still works either way.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!('storage' in navigator) || !navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
