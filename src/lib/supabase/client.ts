import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

export type Supabase = SupabaseClient<Database>;

let browserClient: Supabase | null | undefined;

function getEnvUrl(): string {
  return (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
}

function getEnvKey(): string {
  return (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
}

export function isValidSupabaseUrl(value?: string): boolean {
  const v = (value ?? getEnvUrl()).trim();
  if (!v) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function supabaseConfigured(): boolean {
  return Boolean(getEnvKey()) && isValidSupabaseUrl();
}

/**
 * Browser Supabase client. Returns `null` when the project is not configured
 * (fresh clone / local-only mode) — every caller must degrade to local-only
 * storage instead of failing.
 */
export function getSupabase(): Supabase | null {
  if (!supabaseConfigured()) return null;
  if (browserClient !== undefined) return browserClient;
  try {
    browserClient = createClient<Database>(getEnvUrl(), getEnvKey(), {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  } catch (err) {
    console.warn("[supabase] invalid URL — running local-only", err);
    browserClient = null;
  }
  return browserClient;
}

/** Drop the memoized client (used by tests). */
export function resetSupabaseClient(): void {
  browserClient = undefined;
}
