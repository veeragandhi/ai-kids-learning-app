// AmigosNest persistent lesson storage (local-first prototype).
//
// IndexedDB-backed so generated lessons survive page refresh, navigation,
// and browser restarts. No cloud, no backend DB, no auth.
//
// Small repository abstraction so the implementation can later be swapped
// for Supabase (web) or SQLite (desktop) without touching pages:
//
//   lessonStorage.save()   -> upsert a lesson, returns the stored record
//   lessonStorage.get(id)  -> load one lesson or null (missing/deleted)
//   lessonStorage.list()   -> all lessons, newest first
//   lessonStorage.delete() -> remove one lesson (missing id = no-op)
//
// Plus active-lesson pointer helpers (localStorage) so a refresh with no
// ?lessonId= in the URL can still restore the last-viewed lesson.

export interface StoredLesson {
  /** Unique lesson ID (crypto.randomUUID). */
  id: string;
  /** Lesson title = the topic the child asked about. */
  title: string;
  /** Duplicate of title kept for callers that use `topic`. */
  topic: string;
  /** Generated lesson content, stored verbatim (existing format preserved). */
  lesson: string;
  /** Child age the lesson was generated for. */
  age: number;
  /** Source document, when the generator provides one (currently not returned). */
  sourceDocumentId?: string;
  sourceDocumentName?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SaveLessonInput {
  id?: string;
  topic?: string;
  title?: string;
  lesson: string;
  age?: number;
  sourceDocumentId?: string;
  sourceDocumentName?: string;
}

const DB_NAME = "amigosnest";
const STORE_NAME = "lessons";
const DB_VERSION = 1;
const ACTIVE_KEY = "amigosnest-active-lesson-id";
const LEGACY_LOCAL_KEY = "amigosnest-lessons-fallback";

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function hasIndexedDB(): boolean {
  return isBrowser() && typeof indexedDB !== "undefined";
}

function newId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to manual id
  }
  return `lesson-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    } catch (err) {
      reject(err instanceof Error ? err : new Error("IndexedDB unavailable"));
    }
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let settled = false;
        const done = (fn: () => void) => {
          if (!settled) {
            settled = true;
            try {
              db.close();
            } catch {
              // ignore close errors
            }
            fn();
          }
        };
        try {
          const transaction = db.transaction(STORE_NAME, mode);
          transaction.oncomplete = () => done(() => {});
          transaction.onerror = () =>
            done(() => reject(transaction.error ?? new Error("IndexedDB transaction failed")));
          transaction.onabort = () =>
            done(() => reject(transaction.error ?? new Error("IndexedDB transaction aborted")));
          const store = transaction.objectStore(STORE_NAME);
          const req = run(store);
          req.onsuccess = () => done(() => resolve(req.result));
          req.onerror = () => done(() => reject(req.error ?? new Error("IndexedDB request failed")));
        } catch (err) {
          done(() => reject(err instanceof Error ? err : new Error("IndexedDB failed")));
        }
      })
  );
}

// ── localStorage fallback (private browsing / no IndexedDB) ────────────────
// Same API surface; keeps the app crash-free where IndexedDB is blocked.

function readFallback(): StoredLesson[] {
  try {
    const raw = localStorage.getItem(LEGACY_LOCAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredLesson[]) : [];
  } catch {
    return [];
  }
}

function writeFallback(all: StoredLesson[]): void {
  try {
    localStorage.setItem(LEGACY_LOCAL_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable: persistence is best-effort
  }
}

function normalizeInput(input: SaveLessonInput, existing: StoredLesson | null): StoredLesson {
  const now = Date.now();
  const topic = (input.topic ?? input.title ?? existing?.topic ?? "").trim();
  return {
    id: input.id ?? existing?.id ?? newId(),
    title: (input.title ?? topic).trim() || existing?.title || "Untitled lesson",
    topic: topic || existing?.topic || "Untitled lesson",
    lesson: input.lesson,
    age: typeof input.age === "number" && Number.isFinite(input.age) ? input.age : (existing?.age ?? 8),
    sourceDocumentId: input.sourceDocumentId ?? existing?.sourceDocumentId,
    sourceDocumentName: input.sourceDocumentName ?? existing?.sourceDocumentName,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export const lessonStorage = {
  async save(input: SaveLessonInput): Promise<StoredLesson> {
    if (!isBrowser()) throw new Error("lessonStorage.save() requires a browser");
    if (!input || typeof input.lesson !== "string" || !input.lesson) {
      throw new Error("lessonStorage.save() requires lesson content");
    }
    const existing = input.id ? await this.get(input.id) : null;
    const record = normalizeInput(input, existing);
    if (!hasIndexedDB()) {
      const all = readFallback().filter((l) => l.id !== record.id);
      all.push(record);
      writeFallback(all);
      return record;
    }
    await tx("readwrite", (store) => store.put(record));
    return record;
  },

  async get(id: string): Promise<StoredLesson | null> {
    if (!isBrowser() || !id) return null;
    if (!hasIndexedDB()) {
      return readFallback().find((l) => l.id === id) ?? null;
    }
    try {
      const result = await tx<StoredLesson | undefined>("readonly", (store) => store.get(id));
      return result ?? null;
    } catch {
      // Graceful: a missing/corrupt record must never crash the page.
      return null;
    }
  },

  async list(): Promise<StoredLesson[]> {
    if (!isBrowser()) return [];
    if (!hasIndexedDB()) {
      return readFallback().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    }
    try {
      const all = await tx<StoredLesson[]>("readonly", (store) => store.getAll());
      return (all ?? []).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    } catch {
      return [];
    }
  },

  async delete(id: string): Promise<void> {
    if (!isBrowser() || !id) return;
    if (!hasIndexedDB()) {
      writeFallback(readFallback().filter((l) => l.id !== id));
      return;
    }
    try {
      await tx("readwrite", (store) => store.delete(id));
    } catch {
      // Missing record = no-op; never throw for deletes.
    }
  },

  getActiveId(): string | null {
    if (!isBrowser()) return null;
    try {
      return localStorage.getItem(ACTIVE_KEY);
    } catch {
      return null;
    }
  },

  setActiveId(id: string | null): void {
    if (!isBrowser()) return;
    try {
      if (id) localStorage.setItem(ACTIVE_KEY, id);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch {
      // storage may be unavailable
    }
  },
};
