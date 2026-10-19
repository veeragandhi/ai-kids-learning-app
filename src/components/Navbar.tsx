"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { getSupabase, supabaseConfigured } from "@/lib/supabase/client";
import { useLearner } from "@/contexts/LearnerContext";

export default function Navbar() {
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const { learner, setLearner } = useLearner();
  const router = useRouter();
  const configured = supabaseConfigured();

  useEffect(() => {
    if (!configured) return;
    const supabase = getSupabase();
    if (!supabase) {
      // Deferred: getSupabase() is synchronous, so settling state must not
      // run synchronously in the effect body (cascading renders).
      void Promise.resolve().then(() => setAuthChecked(true));
      return;
    }
    supabase
      .auth.getUser()
      .then(({ data }) => setUser(data.user ?? null))
      .finally(() => setAuthChecked(true));
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      setUser(session?.user ?? null);
      setAuthChecked(true);
    });
    return () => {
      sub.subscription.unsubscribe();
    };
  }, [configured]);

  const signOut = async () => {
    if (!configured) return;
    const supabase = getSupabase();
    if (!supabase) return;
    await supabase.auth.signOut();
    setUser(null);
    setLearner(null);
    router.push("/");
  };

  // Child mode: a learner is active ("Learn as Ira"). Keep navigation
  // kid-shaped — Home + their chip only. The chip is not a link (it used to
  // point at the parent dashboard), and the only way out is the subtle
  // parent exit, which clears the learner and opens the parent library.
  // Open mode is preserved: /upload stays directly visitable by URL.
  const exitChildMode = () => {
    setLearner(null);
    router.push("/upload");
  };

  if (learner) {
    return (
      <nav className="flex items-center justify-between gap-2 px-4 py-3 bg-white/80 backdrop-blur-md shadow-sm sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-lg font-bold text-gray-800">
            🌈 AmigosNest
          </Link>
          <span className="text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-1 rounded-full">
            {learner.avatar} {learner.nickname} · age {learner.age}
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Link href="/" className="px-3 py-2 rounded-full hover:bg-slate-100 text-slate-700">
            Home
          </Link>
          <Link href="/upload" className="px-3 py-2 rounded-full hover:bg-slate-100 text-slate-700">
            Library
          </Link>
          <button
            onClick={exitChildMode}
            title="Exit child mode and open the parent area"
            className="text-xs text-gray-400 underline px-2 py-1 hover:text-gray-600"
          >
            👩 Parent
          </button>
        </div>
      </nav>
    );
  }

  return (
    <nav className="flex items-center justify-between gap-2 px-4 py-3 bg-white/80 backdrop-blur-md shadow-sm sticky top-0 z-50">
      <div className="flex items-center gap-3">
        <Link href="/" className="text-lg font-bold text-gray-800">
          🌈 AmigosNest
        </Link>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <Link href="/" className="px-3 py-2 rounded-full hover:bg-slate-100 text-slate-700">
          Home
        </Link>
        <Link href="/upload" className="px-3 py-2 rounded-full hover:bg-slate-100 text-slate-700">
          Library
        </Link>
        {configured ? (
          user ? (
            <>
              <span
                title={user.email ?? "Signed in"}
                className="hidden sm:inline max-w-40 truncate text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-1 rounded-full"
              >
                👩 {user.email ?? "Parent"}
              </span>
              <Link href="/profile" className="px-3 py-2 rounded-full hover:bg-slate-100 text-slate-700">
                👩 Parent
              </Link>
              <button onClick={signOut} className="px-3 py-2 rounded-full bg-red-50 text-red-600 hover:bg-red-100">
                Sign Out
              </button>
            </>
          ) : authChecked ? (
            <>
              <span className="hidden sm:inline text-xs text-slate-500 bg-slate-100 border border-slate-200 px-2 py-1 rounded-full">
                Not signed in
              </span>
              <Link
                href="/auth"
                title="Sign in as a parent to manage child profiles"
                className="px-3 py-2 rounded-full bg-blue-500 text-white hover:bg-blue-600"
              >
                👩 Parent Sign In
              </Link>
            </>
          ) : (
            <span className="text-xs text-slate-400 px-2 py-1">Checking…</span>
          )
        ) : (
          <span
            title="Supabase not configured — running fully local, no accounts"
            className="text-xs text-slate-500 bg-slate-100 border border-slate-200 px-2 py-1 rounded-full"
          >
            Local mode · no sign-in
          </span>
        )}
      </div>
    </nav>
  );
}
