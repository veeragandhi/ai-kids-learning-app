/**
 * requireChild.ts — server-side trust boundary for per-child isolation.
 *
 * Every personalized route (documents, upload, upload/confirm, lesson, quiz,
 * ask) must call `verifyChildOwnership(req, childId)` BEFORE reading,
 * creating, updating, or deleting child-specific data.
 *
 * Rules (approved V1 plan, `docs/v1-per-child-security-plan.md`):
 * - `childId` is UNTRUSTED input. It is never authorization by itself.
 * - Parent identity is derived from the authenticated session (`Bearer` token
 *   → `auth.getUser()`), then the server checks the child belongs to that
 *   parent (`children.id + parent_id`).
 * - Missing/malformed `childId` → 400. Never fall back to "all documents".
 * - Supabase not configured / offline: only `demo-local` is allowed; any UUID
 *   → 403 (never downgrade a real child UUID to open access).
 * - Authenticated requests reject `demo-local` (403) — no mixing namespaces.
 * - Supabase configured but unreachable when verifying → 503 for UUID paths.
 * - Local device is the trust boundary for demo mode (see plan doc).
 */

import { getSupabaseServer } from "@/lib/supabase/server";

export const DEMO_CHILD_ID = "demo-local";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDemoChildId(value: unknown): value is "demo-local" {
  return value === DEMO_CHILD_ID;
}

export function isUuidLike(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export function classifyChildId(value: unknown):
  | { kind: "demo" }
  | { kind: "uuid"; value: string }
  | { kind: "invalid" } {
  if (isDemoChildId(value)) return { kind: "demo" };
  if (isUuidLike(value)) return { kind: "uuid", value: (value as string).trim() };
  return { kind: "invalid" };
}

function supabaseEnvConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

export function extractBearerToken(req: Request): string | null {
  try {
    const header =
      req.headers.get("authorization") ?? req.headers.get("Authorization");
    if (!header) return null;
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() || null : null;
  } catch {
    return null;
  }
}

export type VerifyChildOk = {
  ok: true;
  childId: string;
  parentId: string | typeof DEMO_CHILD_ID;
  mode: "authenticated" | "demo";
};

export type VerifyChildErr = {
  ok: false;
  status: 400 | 401 | 403 | 503;
  error: string;
};

export type VerifyChildResult = VerifyChildOk | VerifyChildErr;

export type VerifyOverrides = {
  /** Force the configured flag (used by tests). */
  configured?: boolean;
  /**
   * Injected ownership check (used by tests to avoid network).
   * Return true when `parentId` owns `childId`, false when not.
   * Throw to simulate a Supabase outage (mapped to 503).
   */
  ownsChild?: (parentId: string, childId: string) => Promise<boolean> | boolean;
  /**
   * Injected session resolver (used by tests).
   * Return the parent user id for a token, null when invalid.
   * Throw to simulate an outage (mapped to 503).
   */
  resolveParentId?: (token: string) => Promise<string | null> | string | null;
};

/**
 * Verify that `childId` may be accessed by this request. Call before any
 * child-scoped read/write. Fail-closed: every error path denies access.
 */
export async function verifyChildOwnership(
  req: Request,
  childId: unknown,
  overrides: VerifyOverrides = {}
): Promise<VerifyChildResult> {
  const classified = classifyChildId(childId);
  if (classified.kind === "invalid") {
    return {
      ok: false,
      status: 400,
      error: "A valid childId is required. Select a child profile first.",
    };
  }

  const configured = overrides.configured ?? supabaseEnvConfigured();

  // ── Local/demo mode: Supabase not configured ──────────────────────────
  if (!configured) {
    if (classified.kind === "demo") {
      return {
        ok: true,
        childId: DEMO_CHILD_ID,
        parentId: DEMO_CHILD_ID,
        mode: "demo",
      };
    }
    // Never downgrade a real child UUID to unauthenticated access.
    return {
      ok: false,
      status: 403,
      error: "Sign-in is required to access this child profile.",
    };
  }

  // ── Authenticated mode: Supabase configured ───────────────────────────
  if (classified.kind === "demo") {
    // Keep authenticated profiles and the shared demo namespace separate.
    return {
      ok: false,
      status: 403,
      error: "Select your authenticated child's profile to continue.",
    };
  }
  const uuid = classified.value;

  const token = extractBearerToken(req);
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "Parent sign-in is required.",
    };
  }

  let parentId: string | null = null;
  try {
    if (overrides.resolveParentId) {
      parentId = await overrides.resolveParentId(token);
    } else {
      const supabase = getSupabaseServer(token);
      if (!supabase) {
        return {
          ok: false,
          status: 503,
          error: "Profile service is unavailable. Try again later.",
        };
      }
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user) parentId = null;
      else parentId = data.user.id;
    }
  } catch {
    return {
      ok: false,
      status: 503,
      error: "Profile service is unavailable. Try again later.",
    };
  }

  if (!parentId) {
    return { ok: false, status: 401, error: "Parent sign-in is invalid or expired." };
  }

  try {
    let owned: boolean;
    if (overrides.ownsChild) {
      owned = await overrides.ownsChild(parentId, uuid);
    } else {
      const supabase = getSupabaseServer(token);
      if (!supabase) {
        return {
          ok: false,
          status: 503,
          error: "Profile service is unavailable. Try again later.",
        };
      }
      const { data, error } = await supabase
        .from("children")
        .select("id")
        .eq("id", uuid)
        .eq("parent_id", parentId)
        .maybeSingle();
      if (error) throw error;
      owned = Boolean(data);
    }
    if (!owned) {
      // Same response whether the child does not exist or belongs to
      // another parent — no oracle for guessing child IDs.
      return {
        ok: false,
        status: 403,
        error: "This child profile is not available to your account.",
      };
    }
  } catch {
    return {
      ok: false,
      status: 503,
      error: "Profile service is unavailable. Try again later.",
    };
  }

  return { ok: true, childId: uuid, parentId, mode: "authenticated" };
}

/** Read `childId` from a JSON body without trusting it (still needs verify). */
export function readChildIdFromBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return undefined;
  return (body as Record<string, unknown>).childId;
}
