"use client";

import { useCallback, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { getSupabase, supabaseConfigured } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLearner } from "@/contexts/LearnerContext";
import type { ChildPreferences } from "@/types/database.types";
import { deleteChildLearningData } from "@/lib/store";

interface Child {
  id: string;
  nickname: string;
  avatar: string;
  age: number;
  preferences?: ChildPreferences;
}

export default function ProfilePage() {
  const [children, setChildren] = useState<Child[]>([]);
  const [nickname, setNickname] = useState("");
  const [age, setAge] = useState(8);
  const [avatar, setAvatar] = useState("🦊");
  const [loading, setLoading] = useState(false);
  const [deletingChildId, setDeletingChildId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const router = useRouter();
  const { learner, setLearner } = useLearner();

  const startAs = (c: Child) => {
    setLearner({ id: c.id, nickname: c.nickname, avatar: c.avatar, age: c.age });
    router.push(`/?age=${c.age}&childId=${encodeURIComponent(c.id)}`);
  };

  const loadChildren = useCallback(async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    const res = await fetch("/api/children", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const data = await res.json();
    if (data.children) setChildren(data.children);
  }, []);

  const loadUser = useCallback(async () => {
    if (!supabaseConfigured()) return;
    const supabase = getSupabase();
    if (!supabase) return;
    const { data: { user } } = await supabase.auth.getUser();
    setUser(user);
    if (user) loadChildren();
  }, [loadChildren]);

  useEffect(() => {
    // Deferred by a microtask: loadUser settles into state from the network,
    // so it must not run synchronously in the effect body.
    void Promise.resolve().then(() => loadUser());
  }, [loadUser]);

  const addChild = async () => {
    if (!supabaseConfigured() || !user) return;
    setLoading(true);
    const supabase = getSupabase();
    if (!supabase) {
      setMessage("Supabase not configured.");
      setLoading(false);
      return;
    }
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    try {
      const res = await fetch("/api/children", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ nickname, age, avatar }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setMessage("Child added successfully!");
      setNickname("");
      loadChildren();
    } catch (e: unknown) {
      setMessage(e instanceof Error ? e.message : "Failed to add child.");
    } finally {
      setLoading(false);
    }
  };

  const deleteChild = async (child: Child) => {
    const confirmed = window.confirm(
      `Permanently delete ${child.nickname}'s profile, uploaded documents, generated lessons, and learning history? This cannot be undone.`
    );
    if (!confirmed) return;

    setDeletingChildId(child.id);
    setMessage("");
    try {
      const supabase = getSupabase();
      if (!supabase) throw new Error("Supabase not configured.");
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      if (!token) throw new Error("Parent sign-in is required.");
      const res = await fetch("/api/children", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ childId: child.id }),
      });
      const data = await res.json();
      if (data.profileDeleted) {
        setChildren((current) => current.filter((item) => item.id !== child.id));
        if (learner?.id === child.id) {
          setLearner(null);
          router.push("/");
        }
        try {
          await deleteChildLearningData(child.id);
        } catch (cleanupError) {
          console.error("[profile] local child learning data cleanup failed:", cleanupError);
          setMessage(`${data.error} Some learning history could not be cleared from this browser.`);
          return;
        }
        setMessage(data.error);
        return;
      }
      if (!res.ok) throw new Error(data.error || "Failed to delete child profile.");

      setChildren((current) => current.filter((item) => item.id !== child.id));
      if (learner?.id === child.id) {
        setLearner(null);
        router.push("/");
      }
      try {
        await deleteChildLearningData(child.id);
        setMessage(`${child.nickname}'s profile and learning data were deleted.`);
      } catch (cleanupError) {
        console.error("[profile] local child learning data cleanup failed:", cleanupError);
        setMessage(
          `${child.nickname}'s profile and uploaded documents were deleted, but some learning history could not be cleared from this browser.`
        );
      }
    } catch (e: unknown) {
      setMessage(e instanceof Error ? e.message : "Failed to delete child profile.");
    } finally {
      setDeletingChildId(null);
    }
  };

  const signOut = async () => {
    if (!supabaseConfigured()) return;
    const supabase = getSupabase();
    if (!supabase) return;
    await supabase.auth.signOut();
    setUser(null);
    setChildren([]);
    router.push("/");
  };

  if (!supabaseConfigured()) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="bg-white rounded-3xl shadow-lg p-8">
          <h1 className="text-2xl font-bold mb-4">Child Profiles</h1>
          <p>Supabase not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6">
      <div className="max-w-2xl mx-auto">
        <div className="flex justify-between items-center mb-2">
          <Link href="/" className="text-sm text-blue-600">← Home</Link>
          {user && (
            <button onClick={signOut} className="text-sm text-red-600">Sign Out</button>
          )}
        </div>
        <h1 className="text-3xl font-bold">Parent Dashboard</h1>
        {learner && (
          <p className="mt-2 text-sm text-green-700">
            Learning as {learner.avatar} {learner.nickname} (age {learner.age}) — <Link href="/" className="underline">Continue to Home →</Link>
          </p>
        )}
        <p className="text-gray-600 mb-6">Add your child profiles (pseudonymous - nickname + avatar only)</p>
        {!user && (
          <a href="/auth" className="bg-blue-500 text-white px-4 py-2 rounded-xl">Sign In as Parent</a>
        )}
        {user && (
          <div className="space-y-6">
            <div className="bg-white rounded-3xl shadow p-6">
              <h2 className="text-xl font-bold mb-4">Add Child</h2>
              <div className="space-y-3">
                <input
                  type="text"
                  placeholder="Child nickname"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  className="w-full p-3 border rounded-xl"
                />
                <input
                  type="number"
                  min="3"
                  max="18"
                  placeholder="Age (3-18)"
                  value={age}
                  onChange={(e) => setAge(parseInt(e.target.value))}
                  className="w-full p-3 border rounded-xl"
                />
                <input
                  type="text"
                  placeholder="Avatar emoji (e.g., 🦊)"
                  value={avatar}
                  onChange={(e) => setAvatar(e.target.value)}
                  className="w-full p-3 border rounded-xl"
                />
                <button
                  onClick={addChild}
                  disabled={loading || deletingChildId !== null}
                  className="bg-green-500 text-white px-4 py-2 rounded-xl"
                >
                  {loading ? "Adding..." : "Add Child"}
                </button>
              </div>
              {message && <p className="mt-2 text-sm">{message}</p>}
            </div>
            <div className="bg-white rounded-3xl shadow p-6">
              <h2 className="text-xl font-bold mb-4">Children ({children.length})</h2>
              {children.length === 0 ? (
                <p className="text-gray-600">No children added yet.</p>
              ) : (
                <div className="space-y-2">
                  {children.map((c) => (
                    <div key={c.id} className="flex items-center gap-3 p-3 border rounded-xl">
                      <span className="text-2xl">{c.avatar}</span>
                      <div className="flex-1">
                        <p className="font-bold">{c.nickname}</p>
                        <p className="text-sm text-gray-600">Age {c.age}</p>
                      </div>
                      <button
                        onClick={() => startAs(c)}
                        disabled={loading || deletingChildId !== null}
                        className="bg-blue-500 text-white text-sm px-3 py-2 rounded-xl hover:bg-blue-600"
                      >
                        Learn as {c.nickname} →
                      </button>
                      <button
                        onClick={() => deleteChild(c)}
                        disabled={loading || deletingChildId !== null}
                        aria-label={`Delete ${c.nickname} profile and data`}
                        className="rounded-xl border border-red-200 px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {deletingChildId === c.id ? "Deleting..." : "Delete"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex gap-3">
              <Link href="/" className="flex-1 text-center bg-slate-800 text-white px-4 py-3 rounded-xl">
                Continue to Home →
              </Link>
              <Link href="/upload" className="flex-1 text-center bg-white border px-4 py-3 rounded-xl">
                Learning Library
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
