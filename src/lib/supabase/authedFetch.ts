/**
 * authedFetch.ts — client-side helper for personalized API calls (Stage 1).
 *
 * Attaches the parent's Supabase session token (`Authorization: Bearer`)
 * alongside the resolved `childId` so `verifyChildOwnership` can validate
 * the session server-side. When Supabase is unconfigured (local/demo mode)
 * no header is sent and the server allows `demo-local` only.
 *
 * Never silently falls back to `demo-local`: callers pass the resolved
 * active child through, and 401/403 responses surface to the UI instead of
 * degrading to another child's namespace.
 */

import { getSupabase, supabaseConfigured } from "@/lib/supabase/client";

/** Current parent access token, or null (local mode / signed out). */
export async function getParentToken(): Promise<string | null> {
  try {
    if (!supabaseConfigured()) return null;
    const supabase = getSupabase();
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/** Extra headers carrying the parent session (empty when unavailable). */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getParentToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type ApiFetchOptions = {
  method?: string;
  /** JSON body (stringified). Mutually exclusive with `form`. */
  body?: unknown;
  /** Multipart body (upload). `childId` must already be appended. */
  form?: FormData;
  timeoutMs?: number;
};

/**
 * Authenticated JSON/multipart fetch. Returns the raw Response so callers
 * keep their existing status/error handling (401/403 surfaced, never
 * retried as another child).
 */
export async function apiFetch(
  path: string,
  opts: ApiFetchOptions = {}
): Promise<Response> {
  const headers: Record<string, string> = { ...(await getAuthHeaders()) };
  let body: BodyInit | undefined;
  if (opts.form !== undefined) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  if (opts.timeoutMs !== undefined) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      return await fetch(path, {
        method: opts.method ?? (body === undefined ? "GET" : "POST"),
        headers,
        body,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return fetch(path, {
    method: opts.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
  });
}
