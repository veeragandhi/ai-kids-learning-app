import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

export type ServerSupabase = SupabaseClient<Database>;

/**
 * Server-side Supabase client for route handlers. Uses the anon key (RLS
 * applies); when the client forwards its access token the request runs as the
 * signed-in parent. Returns `null` when Supabase is not configured so routes
 * can no-op instead of failing.
 */
export function getSupabaseServer(accessToken?: string): ServerSupabase | null {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  const key = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
  if (!url || !key) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  } catch {
    console.warn("[supabase] invalid server URL — skipping Supabase");
    return null;
  }
  try {
    return createClient<Database>(url, key, {
      global: {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch (err) {
    console.warn("[supabase] createClient failed — skipping Supabase", err);
    return null;
  }
}
