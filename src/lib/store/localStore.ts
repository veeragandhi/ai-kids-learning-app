/**
 * store/localStore.ts — tiny IndexedDB + localStorage-fallback helper for
 * per-child learning history (quiz attempts, Ask sessions, progress).
 *
 * Separate databases per domain (not shared object stores) so version bumps
 * never couple unrelated modules. Same graceful-degradation contract as
 * `lessonStorage`: missing/corrupt records yield empty state, never crashes.
 */

export interface OwnedRecord {
  id: string;
  childId: string;
  at: number;
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function hasIndexedDB(): boolean {
  return isBrowser() && typeof indexedDB !== "undefined";
}

function readFallback<T extends OwnedRecord>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function writeFallback<T extends OwnedRecord>(key: string, all: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(all));
  } catch {
    // best-effort persistence
  }
}

function openDb(dbName: string, storeName: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(dbName, version);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) {
          const store = db.createObjectStore(storeName, { keyPath: "id" });
          store.createIndex("childId", "childId", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    } catch (err) {
      reject(err instanceof Error ? err : new Error("IndexedDB unavailable"));
    }
  });
}

export function createChildScopedStore<T extends OwnedRecord>(
  dbName: string,
  storeName: string,
  fallbackKey: string
) {
  async function getAll(): Promise<T[]> {
    if (!isBrowser()) return [];
    if (!hasIndexedDB()) return readFallback<T>(fallbackKey);
    try {
      const db = await openDb(dbName, storeName, 1);
      const out = await new Promise<T[]>((resolve, reject) => {
        try {
          const tx = db.transaction(storeName, "readonly");
          const req = tx.objectStore(storeName).getAll();
          req.onsuccess = () => resolve((req.result as T[]) ?? []);
          req.onerror = () => reject(req.error ?? new Error("read failed"));
        } catch (e) {
          reject(e);
        } finally {
          try {
            db.close();
          } catch {
            // ignore
          }
        }
      });
      return out;
    } catch {
      return [];
    }
  }

  return {
    async save(record: T): Promise<T> {
      if (!isBrowser()) throw new Error("store.save() requires a browser");
      if (!record || !record.id || !record.childId) {
        throw new Error("store.save() requires id + childId");
      }
      if (!hasIndexedDB()) {
        const all = readFallback<T>(fallbackKey).filter((r) => r.id !== record.id);
        all.push(record);
        writeFallback(fallbackKey, all);
        return record;
      }
      const db = await openDb(dbName, storeName, 1);
      try {
        await new Promise<void>((resolve, reject) => {
          try {
            const tx = db.transaction(storeName, "readwrite");
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("write failed"));
            tx.objectStore(storeName).put(record);
          } catch (e) {
            reject(e);
          }
        });
      } finally {
        try {
          db.close();
        } catch {
          // ignore
        }
      }
      return record;
    },

    async getOwned(id: string, childId: string): Promise<T | null> {
      if (!isBrowser() || !id || !childId) return null;
      const all = await getAll();
      const found = all.find((r) => r.id === id) ?? null;
      if (!found || found.childId !== childId) return null;
      return found;
    },

    async listFor(childId: string): Promise<T[]> {
      if (!isBrowser() || !childId) return [];
      return (await getAll())
        .filter((r) => r.childId === childId)
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    },

    /** Ownership-checked delete (foreign ids are a silent no-op). */
    async deleteOwned(id: string, childId: string): Promise<void> {
      if (!isBrowser() || !id || !childId) return;
      if (!hasIndexedDB()) {
        const all = readFallback<T>(fallbackKey);
        const target = all.find((r) => r.id === id);
        if (!target || target.childId !== childId) return;
        writeFallback(
          fallbackKey,
          all.filter((r) => r.id !== id)
        );
        return;
      }
      const all = await getAll();
      const target = all.find((r) => r.id === id);
      if (!target || target.childId !== childId) return;
      const db = await openDb(dbName, storeName, 1);
      try {
        await new Promise<void>((resolve, reject) => {
          try {
            const tx = db.transaction(storeName, "readwrite");
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("delete failed"));
            tx.objectStore(storeName).delete(id);
          } catch (e) {
            reject(e);
          }
        });
      } catch {
        // missing = no-op
      } finally {
        try {
          db.close();
        } catch {
          // ignore
        }
      }
    },
  };
}
