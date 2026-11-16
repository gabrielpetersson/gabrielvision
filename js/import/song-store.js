// @ts-check
// Uploaded songs live in this browser's IndexedDB: tracks, chart and artwork stay on the device.

const DB = 'gabrielvision';
const STORE = 'songs';

/** @returns {Promise<IDBDatabase>} */
function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @template T @param {IDBTransactionMode} mode @param {(s: IDBObjectStore) => IDBRequest<T>} fn @returns {Promise<T>} */
async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error || new Error('Saving the song was cancelled')); };
  });
}

/** @returns {Promise<SongRecord[]>} */
export const listUserSongs = () => tx('readonly', (s) => s.getAll()).then((all) => all.sort((a, b) => a.createdAt - b.createdAt));
/** @param {string} id @returns {Promise<SongRecord | undefined>} */
export const getUserSong = (id) => tx('readonly', (s) => s.get(id));
/** @param {SongRecord} song */
export const saveUserSong = (song) => tx('readwrite', (s) => s.put(song));
/** @param {string} id */
export const deleteUserSong = (id) => tx('readwrite', (s) => s.delete(id)); // devweb/tests/variants.html
