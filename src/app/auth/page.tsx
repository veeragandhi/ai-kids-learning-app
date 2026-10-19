"use client";

import { useState } from "react";
import { getSupabase, supabaseConfigured } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export default function AuthPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleAuth = async () => {
    if (!supabaseConfigured()) {
      setMessage("Supabase not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
      return;
    }
    setLoading(true);
    setMessage("");
    const supabase = getSupabase();
    if (!supabase) {
      setMessage("Supabase not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
      setLoading(false);
      return;
    }
    try {
      if (isSignUp) {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMessage("Check your email to confirm your account. Then sign in.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        setMessage("Signed in successfully!");
        setTimeout(() => router.push("/profile"), 1000);
      }
    } catch (e: unknown) {
      setMessage(e instanceof Error ? e.message : "Authentication failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="bg-white rounded-3xl shadow-lg p-8 w-full max-w-md">
        <h1 className="text-3xl font-bold mb-2 text-center">AmigosNest</h1>
        <p className="text-gray-600 text-center mb-6">Parent sign in / sign up</p>
        <div className="space-y-4">
          <input
            type="email"
            placeholder="Parent email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full p-3 border rounded-xl"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full p-3 border rounded-xl"
          />
          <button
            onClick={handleAuth}
            disabled={loading}
            className="w-full bg-blue-500 text-white p-3 rounded-xl hover:bg-blue-600"
          >
            {loading ? "Loading..." : (isSignUp ? "Create Parent Account" : "Sign In as Parent")}
          </button>
          <button
            onClick={() => setIsSignUp(!isSignUp)}
            className="w-full text-sm text-blue-600"
          >
            {isSignUp ? "Have an account? Sign In" : "Need an account? Sign Up"}
          </button>
        </div>
        {message && <p className="mt-4 text-center text-sm">{message}</p>}
      </div>
    </div>
  );
}
