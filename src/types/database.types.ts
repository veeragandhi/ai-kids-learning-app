/**
 * Database types for the AmigosNest Supabase schema
 * (supabase/migrations/0001_init.sql).
 *
 * Mirrors the shape produced by `supabase gen types typescript`, so it can be
 * regenerated later without call-site changes.
 *
 * Local-first boundary: only `children` (pseudonymous profiles), `documents`
 * (METADATA ONLY — name/ocr_status/approved/created_at; no file bytes or
 * extracted text), and `progress` (per-concept mastery rollup for the parent
 * dashboard) live in Supabase. Lesson content, embeddings, quiz attempts, and
 * Ask sessions are stored on-device (IndexedDB / localStorage / uploads/ +
 * embeddings/vectors.json) and are intentionally absent here. Uploaded file
 * bytes + extracted text live on-device in uploads/ (see lib/documents.ts).
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface ChildPreferences {
  sound?: boolean;
  theme?: string;
  default_hint_level?: number;
  [key: string]: Json | undefined;
}

export type OcrStatus = "pending" | "processing" | "completed" | "failed";

export interface Database {
  public: {
    Tables: {
      children: {
        Row: {
          id: string;
          parent_id: string;
          nickname: string;
          avatar: string;
          age: number;
          voice: string;
          language: string;
          preferences: ChildPreferences;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          parent_id: string;
          nickname: string;
          avatar?: string;
          age: number;
          voice?: string;
          language?: string;
          preferences?: ChildPreferences;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          parent_id?: string;
          nickname?: string;
          avatar?: string;
          age?: number;
          voice?: string;
          language?: string;
          preferences?: ChildPreferences;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      documents: {
        Row: {
          id: string;
          parent_id: string;
          child_id: string;
          name: string;
          ocr_status: OcrStatus;
          approved: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          parent_id: string;
          child_id: string;
          name: string;
          ocr_status?: OcrStatus;
          approved?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          parent_id?: string;
          child_id?: string;
          name?: string;
          ocr_status?: OcrStatus;
          approved?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      progress: {
        Row: {
          id: string;
          child_id: string;
          concept: string;
          subject: string;
          attempts: number;
          correct: number;
          mastery_score: number;
          last_seen: string;
          next_review_due: string;
        };
        Insert: {
          id?: string;
          child_id: string;
          concept: string;
          subject?: string;
          attempts?: number;
          correct?: number;
          mastery_score?: number;
          last_seen?: string;
          next_review_due?: string;
        };
        Update: {
          id?: string;
          child_id?: string;
          concept?: string;
          subject?: string;
          attempts?: number;
          correct?: number;
          mastery_score?: number;
          last_seen?: string;
          next_review_due?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}
