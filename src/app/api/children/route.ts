import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase";
import { extractBearerToken, verifyChildOwnership } from "@/lib/supabase/requireChild";
import type { ChildPreferences, Database } from "@/types/database.types";
import { deleteDocumentsForChild } from "@/lib/documents";
import { deleteChunksForChild } from "@/lib/vectorStore";

type ChildInsert = Database["public"]["Tables"]["children"]["Insert"];

function asText(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ children: [] });
  const supabase = getSupabaseServer(token);
  if (!supabase) return NextResponse.json({ children: [] });

  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return NextResponse.json({ children: [] });

  const { data, error } = await supabase
    .from("children")
    .select("*")
    .eq("parent_id", user.id)
    .order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ children: data });
}

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const supabase = getSupabaseServer(token);
  if (!supabase) return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });

  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = (await req.json()) as {
    nickname?: unknown;
    avatar?: unknown;
    age?: unknown;
    voice?: unknown;
    language?: unknown;
    preferences?: unknown;
  };
  const nickname = typeof body.nickname === "string" ? body.nickname : "";
  const age = Number(body.age);
  if (!nickname || !age) return NextResponse.json({ error: "nickname and age required" }, { status: 400 });

  const insertData: ChildInsert = {
    parent_id: user.id,
    nickname,
    avatar: asText(body.avatar, "🦊"),
    age,
    voice: asText(body.voice, "neutral"),
    language: asText(body.language, "en"),
    preferences: (body.preferences ?? { sound: true, theme: "default", default_hint_level: 1 }) as ChildPreferences,
  };
  const { data, error } = await supabase
    .from("children")
    .insert(insertData)
    .select()
    .single();
  if (error) {
    console.error("[children] insert failed:", { code: error.code, message: error.message, details: error.details, hint: error.hint, userId: user.id });
    return NextResponse.json({ error: error.message, code: error.code, details: error.details, hint: error.hint }, { status: 500 });
  }
  return NextResponse.json({ child: data });
}

export async function DELETE(req: Request) {
  let body: { childId?: unknown };
  try {
    body = (await req.json()) as { childId?: unknown };
  } catch {
    return NextResponse.json({ error: "A valid childId is required." }, { status: 400 });
  }

  const verified = await verifyChildOwnership(req, body.childId);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: verified.status });
  }

  const token = extractBearerToken(req);
  if (!token) {
    return NextResponse.json({ error: "Parent sign-in is required." }, { status: 401 });
  }
  const supabase = getSupabaseServer(token);
  if (!supabase) {
    return NextResponse.json({ error: "Profile service is unavailable. Try again later." }, { status: 503 });
  }

  const { data, error } = await supabase
    .from("children")
    .delete()
    .eq("id", verified.childId)
    .eq("parent_id", verified.parentId)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[children] delete failed:", {
      code: error.code,
      message: error.message,
      childId: verified.childId,
      parentId: verified.parentId,
    });
    return NextResponse.json({ error: "Unable to delete this child profile. Please try again." }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "This child profile is not available to your account." }, { status: 404 });
  }

  try {
    const documentNames = deleteDocumentsForChild(verified.childId);
    const deletedChunks = deleteChunksForChild(verified.childId);
    console.log("[children] deleted child learning materials:", {
      childId: verified.childId,
      documents: documentNames.length,
      chunks: deletedChunks,
    });
  } catch (cleanupError) {
    console.error("[children] child profile deleted but local document cleanup failed:", {
      childId: verified.childId,
      error: cleanupError,
    });
    return NextResponse.json(
      {
        error: "The child profile was deleted, but some local learning materials could not be removed.",
        profileDeleted: true,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
