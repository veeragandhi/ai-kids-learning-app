"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

export type SpeechRecognitionStatus =
  | "unsupported"
  | "idle"
  | "listening"
  | "error";

// AmigosNest has one speech language today: the lesson read-aloud helper pins
// every utterance to "en-US" (see applyEnglishVoice in ClientLesson). Voice
// input reuses the same default instead of introducing a second language
// source. Overridable if a per-child language preference is ever wired up.
export const SPEECH_RECOGNITION_LANG = "en-US";

type RecognitionConstructor = new () => SpeechRecognition;

// Feature detection only — never touch the constructor off the browser.
function getRecognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function isRecognitionSupported(): boolean {
  return getRecognitionConstructor() !== null;
}

// Support never changes at runtime, so a no-op subscription is enough. Using
// useSyncExternalStore keeps the server snapshot (false) and the client
// snapshot (real support) in one place without a hydration mismatch or a
// setState-in-effect.
const subscribeToSupport = () => () => {};
const getServerSupportedSnapshot = () => false;

function describeRecognitionError(
  code: SpeechRecognitionErrorCode,
  cancelledByUser: boolean
): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked. A grown-up can allow the microphone in this browser's settings, or you can type your question instead.";
    case "no-speech":
      return "I didn't hear anything. Tap the microphone and try again, or type your question.";
    case "audio-capture":
      return "I couldn't find a microphone. You can still type your question.";
    case "network":
      return "The speech service had a connection problem. Please try again, or type your question.";
    case "aborted":
      return cancelledByUser
        ? ""
        : "Listening stopped. You can tap the microphone again or type your question.";
    case "language-not-supported":
      return "This browser can't listen in English. Please type your question instead.";
    default:
      return "Sorry, I couldn't hear that. Please try again or type your question.";
  }
}

export interface UseSpeechRecognitionOptions {
  // Current text in the bound input (the child's draft).
  value: string;
  // Called with the merged text when new words are recognized. The hook never
  // submits anything — the caller decides what happens after editing.
  onChange: (next: string) => void;
  lang?: string;
  continuous?: boolean;
  interimResults?: boolean;
  onError?: (message: string) => void;
}

export interface UseSpeechRecognitionResult {
  supported: boolean;
  listening: boolean;
  status: SpeechRecognitionStatus;
  interimTranscript: string;
  error: string;
  start: () => void;
  stop: () => void;
  cancel: () => void;
}

/**
 * Web Speech API speech-to-text for a single controlled text input.
 *
 * Recognition may use an online service: on many browsers (Chrome, Safari)
 * audio is sent to the platform's speech service — it is NOT offline/local.
 * We only ever write the resulting transcript into the text box; nothing is
 * uploaded, stored, or auto-submitted by this hook.
 */
export function useSpeechRecognition(
  options: UseSpeechRecognitionOptions
): UseSpeechRecognitionResult {
  const {
    value,
    onChange,
    lang = SPEECH_RECOGNITION_LANG,
    continuous = true,
    interimResults = true,
    onError,
  } = options;

  // Server render has no window, so support starts false and the client
  // snapshot flips it on after hydration — no hydration mismatch.
  const supported = useSyncExternalStore(
    subscribeToSupport,
    isRecognitionSupported,
    getServerSupportedSnapshot
  );
  const [listening, setListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState("");

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onErrorRef = useRef(onError);
  // Full final transcript produced by the current session. Used to insert only
  // the newly-finalized suffix so a result is never appended twice.
  const finalRef = useRef("");
  const cancelledRef = useRef(false);
  // Bumped on every start/unmount to invalidate handlers from old sessions.
  const sessionRef = useRef(0);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // Bound once and reads refs only, so a live session never captures stale
  // state. Never calls anything that submits.
  const handleResult = useCallback((event: SpeechRecognitionEvent) => {
    let finalText = "";
    let interimText = "";
    for (let i = 0; i < event.results.length; i += 1) {
      const result = event.results[i];
      const alternative = result[0];
      if (!alternative) continue;
      if (result.isFinal) {
        finalText += alternative.transcript;
      } else {
        interimText += alternative.transcript;
      }
    }

    // In continuous mode the results list grows, so finalText grows with it.
    // Insert only the newly-finalized suffix (idempotent): re-firing onresult
    // for the same list cannot duplicate text.
    const previous = finalRef.current;
    const newlyFinal = finalText.startsWith(previous)
      ? finalText.slice(previous.length)
      : finalText;
    finalRef.current = finalText;

    const cleanNew = newlyFinal.trim();
    if (cleanNew) {
      const current = valueRef.current;
      // Never destroy the child's typed draft: append the new words after
      // whatever is already in the box, separated by a single space.
      const separator = current && !/\s$/.test(current) ? " " : "";
      const merged = `${current}${separator}${cleanNew}`;
      valueRef.current = merged;
      onChangeRef.current(merged);
    }
    setInterimTranscript(interimText.trim());
  }, []);

  const start = useCallback(() => {
    const Recognition = getRecognitionConstructor();
    if (!Recognition) {
      setError(
        "Voice input isn't available in this browser. Please type your question."
      );
      return;
    }
    // One session at a time: ignore extra taps while a recognizer is live.
    if (recognitionRef.current) return;

    setError("");
    setInterimTranscript("");
    finalRef.current = "";
    cancelledRef.current = false;
    sessionRef.current += 1;
    const sessionId = sessionRef.current;

    let recognition: SpeechRecognition;
    try {
      recognition = new Recognition();
    } catch {
      setError(
        "Voice input isn't available in this browser. Please type your question."
      );
      return;
    }

    recognition.lang = lang;
    recognition.continuous = continuous;
    recognition.interimResults = interimResults;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      if (sessionRef.current !== sessionId) return;
      setListening(true);
    };
    recognition.onresult = (event) => {
      if (sessionRef.current !== sessionId) return;
      handleResult(event);
    };
    recognition.onerror = (event) => {
      if (sessionRef.current !== sessionId) return;
      setListening(false);
      const message = describeRecognitionError(
        event.error,
        cancelledRef.current
      );
      if (message) {
        setError(message);
        onErrorRef.current?.(message);
      }
    };
    recognition.onend = () => {
      if (sessionRef.current !== sessionId) return;
      // Session finished — via Stop, a browser auto-stop, or an error. Never
      // submit here: the child reviews the text, then presses Send.
      recognitionRef.current = null;
      setListening(false);
      setInterimTranscript("");
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      // Optimistic: onstart confirms, but keep the button responsive.
      setListening(true);
    } catch {
      // start() throws if the recognizer is already running or blocked.
      recognitionRef.current = null;
      setListening(false);
    }
  }, [lang, continuous, interimResults, handleResult]);

  // Graceful stop: asks the service to finish and deliver final results.
  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    cancelledRef.current = false;
    setListening(false);
    setInterimTranscript("");
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      try {
        recognition.abort();
      } catch {
        // best effort — the session ends via onend either way
      }
    }
  }, []);

  // Hard cancel: discard pending audio/results (used when the child cancels).
  const cancel = useCallback(() => {
    const recognition = recognitionRef.current;
    cancelledRef.current = true;
    setListening(false);
    setInterimTranscript("");
    if (!recognition) return;
    try {
      recognition.abort();
    } catch {
      // best effort
    }
  }, []);

  useEffect(() => {
    return () => {
      const recognition = recognitionRef.current;
      if (!recognition) return;
      // Invalidate the session and detach handlers so no late event touches an
      // unmounted component.
      sessionRef.current += 1;
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        // best effort
      }
      recognitionRef.current = null;
    };
  }, []);

  const status: SpeechRecognitionStatus = !supported
    ? "unsupported"
    : error
      ? "error"
      : listening
        ? "listening"
        : "idle";

  return {
    supported,
    listening,
    status,
    interimTranscript,
    error,
    start,
    stop,
    cancel,
  };
}
