"use client";

import { Mic, MicOff } from "lucide-react";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";

type VoiceTextareaProps = {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onError?: (message: string) => void;
};

/**
 * A textarea with an optional Web Speech API dictation button.
 *
 * Speech is only ever inserted into the box as text — it is never submitted
 * automatically. The child can review, edit, clear, or discard the transcript
 * and must press the existing Send button to continue the Ask/Explore flow.
 */
export default function VoiceTextarea({
  value,
  onChange,
  rows = 4,
  placeholder,
  className,
  ariaLabel,
  disabled = false,
  onError,
}: VoiceTextareaProps) {
  const { supported, listening, interimTranscript, error, start, stop } =
    useSpeechRecognition({ value, onChange, onError });

  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        disabled={disabled}
        aria-label={ariaLabel}
        placeholder={placeholder}
        className={className}
      />

      {supported && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={listening ? stop : start}
            disabled={disabled}
            aria-pressed={listening}
            aria-label={listening ? "Stop listening" : "Speak instead of typing"}
            className={`inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 ${
              listening
                ? "bg-rose-100 text-rose-700 hover:bg-rose-200"
                : "bg-violet-100 text-violet-700 hover:bg-violet-200"
            }`}
          >
            {listening ? <MicOff size={18} /> : <Mic size={18} />}
            {listening ? "Stop" : "Speak"}
          </button>
          <span
            role="status"
            aria-live="polite"
            className="text-sm text-slate-500"
          >
            {listening
              ? "Listening… tap Stop when you're done."
              : "Tap the microphone to speak."}
          </span>
        </div>
      )}

      {interimTranscript && (
        <p className="mt-2 rounded-2xl bg-slate-100 px-4 py-2 text-sm italic text-slate-500">
          Hearing: {interimTranscript}
        </p>
      )}

      {error && (
        <p className="mt-2 rounded-2xl bg-amber-50 px-4 py-2 text-sm text-amber-800">
          {error}
        </p>
      )}

      {supported && (
        <p className="mt-2 text-xs text-slate-400">
          Voice uses your browser&apos;s speech service, which may send your
          audio to the internet to understand you. You can always type instead.
        </p>
      )}
    </div>
  );
}
