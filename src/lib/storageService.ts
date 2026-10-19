import { lessonStorage, type StoredLesson } from "./lessonStorage";

// NOTE (V1 isolation): UI code must use `@/lib/store` (child-scoped) instead
// of this service. Kept for backward compatibility; it is owner-unaware.

export interface SyncStatus {
  lastSync?: number;
  pending: number;
  online: boolean;
}

export interface StorageService {
  saveLesson(lesson: StoredLesson): Promise<void>;
  getLesson(id: string): Promise<StoredLesson | null>;
  listLessons(): Promise<StoredLesson[]>;
  deleteLesson(id: string): Promise<void>;
  sync(): Promise<void>;
  getSyncStatus(): SyncStatus;
}

class LocalFirstStorageService implements StorageService {
  async saveLesson(lesson: StoredLesson): Promise<void> {
    await lessonStorage.save(lesson);
  }

  async getLesson(id: string): Promise<StoredLesson | null> {
    return await lessonStorage.get(id);
  }

  async listLessons(): Promise<StoredLesson[]> {
    return await lessonStorage.list();
  }

  async deleteLesson(id: string): Promise<void> {
    await lessonStorage.delete(id);
  }

  async sync(): Promise<void> {
    // Opportunistic sync - no-op locally if offline
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      return;
    }
    // TODO: sync to Supabase when available
  }

  getSyncStatus(): SyncStatus {
    return {
      pending: 0,
      online: typeof navigator !== "undefined" ? navigator.onLine : true,
    };
  }
}

export const storageService = new LocalFirstStorageService();
