import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase";
import type { ChildPreferences, Database } from "@/types/database.types";

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
