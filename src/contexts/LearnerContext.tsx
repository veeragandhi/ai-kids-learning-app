"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

export interface LearnerProfile {
  id: string;
  nickname: string;
  avatar: string;
  age: number;
  preferences?: {
    sound?: boolean;
    theme?: string;
    default_hint_level?: number;
  };
}

interface LearnerContextType {
  learner: LearnerProfile | null;
  setLearner: (learner: LearnerProfile | null) => void;
  /**
   * True once the persisted learner has been restored on mount. Record-loading
   * effects must wait for this: otherwise the first pass runs with
   * learner=null (demo-local) and can flash — or stick, via stale guards —
   * another profile's content before the real learner arrives.
   */
  hydrated: boolean;
}

const LearnerContext = createContext<LearnerContextType>({
  learner: null,
  setLearner: () => {},
  hydrated: false,
});

export function LearnerProvider({ children }: { children: React.ReactNode }) {
  const [learner, setLearnerState] = useState<LearnerProfile | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Restore persisted learner on mount (local-first: no network block).
  // Deferred by a microtask so the first render still matches the server
  // prerender (signed-out defaults) and hydrates from storage right after,
  // exactly as a synchronous effect body would — without the cascading
  // render the lint rule guards against.
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const raw = localStorage.getItem("amigosnest-active-learner");
        if (raw) setLearnerState(JSON.parse(raw));
      } catch {
        // storage unavailable: stay signed-out of learner
      } finally {
        setHydrated(true);
      }
    });
  }, []);

  const setLearner = (next: LearnerProfile | null) => {
    setLearnerState(next);
    try {
      if (next) localStorage.setItem("amigosnest-active-learner", JSON.stringify(next));
      else localStorage.removeItem("amigosnest-active-learner");
    } catch {
      // best-effort persistence
    }
  };

  return (
    <LearnerContext.Provider value={{ learner, setLearner, hydrated }}>
      {children}
    </LearnerContext.Provider>
  );
}

export function useLearner() {
  return useContext(LearnerContext);
}
