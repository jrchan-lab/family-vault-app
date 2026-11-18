// 保险箱 · db.js — tiny IndexedDB key/value store on the phone.
// Keys used:
//   'vault' -> encrypted envelope (see crypto.js). Never plain text.
//   'meta'  -> { lastBackupAt, changedSinceBackup } — no personal data.

const DB_NAME = 'family-vault';
const STORE = 'kv';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
      req.onblocked = () => { dbPromise = null; reject(new Error('IndexedDB blocked')); };
    });
  }
  return dbPromise;
}

export async function get(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Write several keys in ONE transaction and resolve only after the
// transaction has committed, so "保存好了" really means saved.
export async function putMany(pairs) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE, 'readwrite', { durability: 'strict' });
    } catch {
      tx = db.transaction(STORE, 'readwrite');
    }
    const store = tx.objectStore(STORE);
    for (const [k, v] of Object.entries(pairs)) store.put(v, k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}

export async function askPersistent() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      return await navigator.storage.persist();
    }
  } catch { /* not supported */ }
  return false;
}
