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
  /**
   * Owner child id (Supabase UUID or `demo-local`). Missing/`null` = legacy
   * record written before per-child isolation — read-only, never used as
   * quiz/Ask grounding until explicitly imported to a child.
   */
  childId: string | null;
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
  /** Verified-active owner. Omitted = legacy (read flows exclude it). */
  childId?: string | null;
  sourceDocumentId?: string;
  sourceDocumentName?: string;
}

const DB_NAME = "amigosnest";
const STORE_NAME = "lessons";
const DB_VERSION = 2;
const ACTIVE_KEY = "amigosnest-active-lesson-id";
const LEGACY_LOCAL_KEY = "amigosnest-lessons-fallback";

/** Per-child active-lesson pointer (no cross-child restore on refresh). */
function activeKeyFor(childId?: string | null): string {
  return childId ? `${ACTIVE_KEY}:${childId}` : ACTIVE_KEY;
}

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
        } else {
          // v2: per-child isolation needs a childId index; backfills happen
          // at read time (missing → null legacy) so no data migration needed.
          try {
            const store = req.transaction?.objectStore(STORE_NAME);
            if (store && !store.indexNames.contains("childId")) {
              store.createIndex("childId", "childId", { unique: false });
            }
          } catch {
            // index creation is best-effort; ownership checks don't need it
          }
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
  // Ownership is sticky: an update without childId keeps the existing owner;
  // a missing owner on both sides stays legacy (null) — never inferred.
  const childId =
    input.childId !== undefined ? (input.childId ?? null) : (existing?.childId ?? null);
  return {
    id: input.id ?? existing?.id ?? newId(),
    title: (input.title ?? topic).trim() || existing?.title || "Untitled lesson",
    topic: topic || existing?.topic || "Untitled lesson",
    lesson: input.lesson,
    age: typeof input.age === "number" && Number.isFinite(input.age) ? input.age : (existing?.age ?? 8),
    childId,
    sourceDocumentId: input.sourceDocumentId ?? existing?.sourceDocumentId,
    sourceDocumentName: input.sourceDocumentName ?? existing?.sourceDocumentName,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

/** Backfill for pre-isolation records (no childId field → legacy null). */
function withOwner<T extends { childId?: string | null }>(record: T): T & { childId: string | null } {
  return { ...record, childId: record.childId ?? null };
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
      const found = readFallback().find((l) => l.id === id) ?? null;
      return found ? withOwner(found) : null;
    }
    try {
      const result = await tx<StoredLesson | undefined>("readonly", (store) => store.get(id));
      return result ? withOwner(result) : null;
    } catch {
      // Graceful: a missing/corrupt record must never crash the page.
      return null;
    }
  },

  /**
   * Ownership-checked load: returns the lesson only when it belongs to
   * `childId`. Legacy (`null`) and sibling records yield `null` — callers
   * render "not found for this child", never the foreign content.
   */
  async getOwned(id: string, childId: string): Promise<StoredLesson | null> {
    const found = await this.get(id);
    if (!found || found.childId !== childId) return null;
    return found;
  },

  async list(): Promise<StoredLesson[]> {
    if (!isBrowser()) return [];
    if (!hasIndexedDB()) {
      return readFallback().map(withOwner).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    }
    try {
      const all = await tx<StoredLesson[]>("readonly", (store) => store.getAll());
      return (all ?? []).map(withOwner).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    } catch {
      return [];
    }
  },

  /** Lessons owned by one child (legacy excluded — see getOwned/import). */
  async listFor(childId: string): Promise<StoredLesson[]> {
    return (await this.list()).filter((l) => l.childId === childId);
  },

  /** Legacy pre-isolation records (read-only badge material, never grounding). */
  async listLegacy(): Promise<StoredLesson[]> {
    return (await this.list()).filter((l) => l.childId === null);
  },

  /**
   * Ownership-checked delete: removes only when the record belongs to
   * `childId`. Foreign/legacy ids are a silent no-op (no oracle).
   */
  async deleteOwned(id: string, childId: string): Promise<void> {
    const found = await this.get(id);
    if (!found || found.childId !== childId) return;
    return this.delete(id);
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

  getActiveId(childId?: string | null): string | null {
    if (!isBrowser()) return null;
    try {
      // Per-child pointer first; fall back to the legacy global pointer once
      // (pre-isolation sessions) without migrating sibling data across children.
      return (
        (childId ? localStorage.getItem(activeKeyFor(childId)) : null) ??
        localStorage.getItem(ACTIVE_KEY)
      );
    } catch {
      return null;
    }
  },

  setActiveId(id: string | null, childId?: string | null): void {
    if (!isBrowser()) return;
    try {
      if (childId) {
        if (id) localStorage.setItem(activeKeyFor(childId), id);
        else localStorage.removeItem(activeKeyFor(childId));
      }
      if (id) localStorage.setItem(ACTIVE_KEY, id);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch {
      // storage may be unavailable
    }
  },
};
