"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useLearner } from "@/contexts/LearnerContext";
import { resolveActiveChildId, isDemoChild } from "@/lib/store/activeChild";
import { supabaseConfigured } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/supabase/authedFetch";

type DocumentItem = {
  name: string;
  approved: boolean;
  childId?: string | null;
  legacy?: boolean;
};

function displayName(name: string): string {
  const parts = name.split("/");
  return parts[parts.length - 1] || name;
}

export default function ParentPage() {
  return (
    <Suspense fallback={<div />}>
      <UploadInner />
    </Suspense>
  );
}

function UploadInner() {

  const [file, setFile] =
    useState<File | null>(null);

  const [message, setMessage] =
    useState("");

  const [documents, setDocuments] =
    useState<DocumentItem[]>([]);

  const [legacyDocs, setLegacyDocs] =
    useState<DocumentItem[]>([]);

  const [loading, setLoading] =
    useState(false);

  const { learner } = useLearner();
  const searchParams = useSearchParams();
  const urlChildId = searchParams.get("childId");
  const baseChildId = resolveActiveChildId(
    learner?.id,
    urlChildId
  );
  // Child mode (an active learner) is read-only: the child sees only their
  // own documents. Parent mode (no learner) manages one child's library at
  // a time via the picker below. The server re-verifies ownership on every
  // call, so a forged id yields 403, never foreign data.
  const [managedChildId, setManagedChildId] = useState<string | null>(null);
  const childId = !learner && managedChildId ? managedChildId : baseChildId;
  const isChildMode = Boolean(learner);

  type ChildOption = { id: string; nickname: string; avatar: string; age: number };
  const [allChildren, setAllChildren] = useState<ChildOption[]>([]);
  const [pickerReady, setPickerReady] = useState(false);

  // Parent's children for the library picker (best-effort: hidden when
  // unavailable). Defaults to the URL child when it belongs to this parent,
  // otherwise to the first child.
  useEffect(() => {
    // Only parent mode with sign-in needs the picker; otherwise the
    // library gate (loadDocuments) does not wait on pickerReady.
    if (learner || !supabaseConfigured()) {
      return;
    }
    void Promise.resolve().then(async () => {
      try {
        const res = await apiFetch("/api/children", { method: "GET" });
        if (!res.ok) return;
        const body: unknown = await res.json();
        const raw = typeof body === "object" && body !== null && "children" in body
          ? (body as { children?: unknown }).children
          : undefined;
        const list: ChildOption[] = (Array.isArray(raw) ? raw : [])
          .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
          .filter((c) => typeof c.id === "string" && typeof c.nickname === "string")
          .map((c) => ({
            id: c.id as string,
            nickname: c.nickname as string,
            avatar: typeof c.avatar === "string" && c.avatar ? c.avatar : "🦊",
            age: typeof c.age === "number" ? c.age : Number(c.age) || 0,
          }));
        setAllChildren(list);
        if (urlChildId && list.some((c) => c.id === urlChildId)) {
          setManagedChildId(urlChildId);
        } else if (list.length > 0) {
          setManagedChildId(list[0].id);
        }
      } catch {
        // picker is best-effort; the library still loads for the base child
      } finally {
        setPickerReady(true);
      }
    });
  }, [learner, urlChildId]);

  const loadDocuments = useCallback(async () => {
    // In parent mode wait for the picker to resolve so the first load does
    // not flash an error for the placeholder demo id.
    if (!learner && supabaseConfigured() && !pickerReady) return;
    try {
      const res = await apiFetch(`/api/documents?childId=${encodeURIComponent(childId)}`, {
        method: "GET",
      });
      if (!res.ok) {
        // Surface the server's message (e.g. which child profile to select)
        // instead of masking it behind the generic connectivity text.
        let serverError = "";
        try {
          const data = await res.json();
          if (data && typeof data.error === "string") serverError = data.error;
        } catch {
          // non-JSON error body: fall through to the generic message
        }
        throw new Error(serverError || "Unable to load documents");
      }

      const data = await res.json();
      // New shape { owned, legacy }; a bare array means a legacy server.
      if (Array.isArray(data)) {
        setDocuments([]);
        setLegacyDocs(data);
      } else {
        setDocuments(data.owned ?? []);
        setLegacyDocs(data.legacy ?? []);
      }
    } catch (e) {
      if (e instanceof TypeError) {
        setMessage("The learning library is unavailable. Please make sure the app is running and try again.");
      } else if (e instanceof Error && e.message && e.message !== "Unable to load documents") {
        setMessage(e.message);
      } else {
        setMessage("The learning library is unavailable. Please make sure the app is running and try again.");
      }
    }
  }, [childId, learner, pickerReady]);

  useEffect(() => {
    // Deferred by a microtask: loadDocuments settles into state from the
    // network, so it must not run synchronously in the effect body.
    void Promise.resolve().then(() => loadDocuments());
  }, [loadDocuments]);

  const [reviewJobId, setReviewJobId] =
    useState<string | null>(null);

  const [reviewText, setReviewText] =
    useState("");

  const [reviewSource, setReviewSource] =
    useState("");

  const uploadFile = async () => {
    if (!file) return;

    setLoading(true);
    setMessage("");
    setReviewJobId(null);
    setReviewText("");
    setReviewSource("");

    const formData = new FormData();

    formData.append("file", file);
    formData.append("childId", childId);

    try {
      const res = await apiFetch("/api/upload", {
        method: "POST",
        form: formData,
      });
      const data = await res.json();

      // 202 + needsReview: scanned worksheet staged for parent preview.
      // Nothing was embedded yet — parent must approve below.
      if (res.status === 202 && data.needsReview) {
        setReviewJobId(data.jobId || null);
        setReviewText(data.preview || "");
        setReviewSource(data.ocrSource || "ocr");
        setMessage(
          data.message ||
            "This looks like a scanned worksheet — please review the text, then approve."
        );
        return;
      }

      if (!res.ok) {
        throw new Error(data.error || "Upload failed");
      }

      setMessage(data.message || "Document uploaded successfully");
      await loadDocuments();
    } catch (error) {
      setMessage(
        error instanceof TypeError
          ? "Could not connect to the app. Please start the development server and try again."
          : error instanceof Error
            ? error.message
            : "Upload failed. Please try again."
      );
    } finally {
      setLoading(false);
    }
  };

  const approveReview =
    async () => {

    if (!reviewJobId) return;

    setLoading(true);

    try {
      const res = await apiFetch("/api/upload/confirm", {
        method: "POST",
        body: { jobId: reviewJobId, editedText: reviewText, childId },
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Approval failed");
      }

      setMessage(data.message || "Approved");
      setReviewJobId(null);
      setReviewText("");
      setReviewSource("");
      await loadDocuments();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Approval failed. Please try again."
      );
    } finally {
      setLoading(false);
    }
  };

  const toggleApproval =
    async (name: string) => {

    await apiFetch("/api/documents", {
      method: "PATCH",
      body: { name, childId },
    });

    loadDocuments();
  };

  const importLegacy =
    async (name: string) => {

    setLoading(true);
    setMessage("");

    try {
      const res = await apiFetch("/api/documents", {
        method: "POST",
        body: { name, childId },
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Import failed");
      }

      setMessage("Document added to this child's library.");
      await loadDocuments();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Import failed. Please try again."
      );
    } finally {
      setLoading(false);
    }
  };

  const deleteDocument =
    async (name: string) => {

    await apiFetch("/api/documents", {
      method: "DELETE",
      body: { name, childId },
    });

    loadDocuments();
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-purple-50 to-white p-6">

      {/* Header */}
      <div className="text-center mb-10">

        <h1 className="text-5xl font-extrabold text-gray-800">
          {isChildMode ? "📚 My Library" : "👩 Parent Dashboard"}
        </h1>

        <p className="text-gray-600 mt-4 text-lg">
          {isChildMode
            ? "Documents your parent added for your lessons"
            : "Manage your child’s safe AI learning library"}
        </p>

        {!isChildMode && allChildren.length > 0 && (
          <div className="max-w-2xl mx-auto mt-6 text-left">
            <label className="flex items-center gap-3 bg-white border border-slate-200 rounded-2xl px-4 py-3 shadow-sm">
              <span className="text-sm font-semibold text-slate-700">
                Managing library for
              </span>
              <select
                aria-label="Choose which child's library to manage"
                value={managedChildId ?? ""}
                onChange={(e) => setManagedChildId(e.target.value || null)}
                className="flex-1 cursor-pointer bg-transparent font-semibold text-slate-800 outline-none [color-scheme:light]"
              >
                {allChildren.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.avatar} {c.nickname} (age {c.age})
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {supabaseConfigured() && !isChildMode && pickerReady && isDemoChild(childId) && (
          <div className="max-w-2xl mx-auto mt-6 bg-amber-50 border border-amber-200 rounded-2xl p-4 text-left">
            <p className="text-gray-800 font-semibold">
              No child profile selected
            </p>
            <p className="text-gray-600 text-sm mt-1">
              Uploads are saved to the active child&apos;s library. Open{" "}
              <Link href="/profile" className="text-blue-600 underline">
                Child Profiles
              </Link>{" "}
              and click “Learn as …” for your child, then come back here.
            </p>
          </div>
        )}

        {learner && (
          <p className="text-green-700 mt-4 text-sm font-semibold">
            Showing {learner.avatar} {learner.nickname}’s documents for lessons
          </p>
        )}
      </div>

      {/* Upload Card (parents only — child mode is read-only) */}
      {!isChildMode && (
      <div className="bg-white max-w-2xl mx-auto p-8 rounded-3xl shadow-lg">

        <h2 className="text-2xl font-bold mb-4 text-gray-800">
          📄 Upload Learning Material
        </h2>

        <p className="text-gray-600 mb-6">
          Upload PDFs or TXT files
          for AI-powered lessons.
        </p>

        <input
          type="file"
          accept=".txt,.pdf"
          onChange={(e) =>
            setFile(
              e.target.files?.[0] || null
            )
          }
          className="mb-6 text-slate-700 [color-scheme:light]"
        />

        <button
          onClick={uploadFile}
          disabled={loading}
          className="bg-purple-500 text-white px-6 py-3 rounded-full shadow hover:bg-purple-600 transition"
        >
          {loading
            ? "✨ Preparing AI learning memory... (scanned pages can take a minute)"
            : "🚀 Upload Document"}
        </button>

        {reviewJobId && (
          <div className="mt-6 bg-amber-50 border border-amber-200 rounded-2xl p-4">
            <h3 className="text-lg font-bold text-gray-800">
              🔍 Review extracted text ({reviewSource})
            </h3>
            <p className="text-gray-600 text-sm mt-1">
              Nothing is saved yet. Fix mistakes below, then approve — or
              upload a clearer file instead.
            </p>
            <textarea
              value={reviewText}
              onChange={(e) => setReviewText(e.target.value)}
              rows={12}
              aria-label="Review extracted worksheet text"
              className="mt-3 w-full rounded-xl border border-amber-300 bg-white p-3 text-sm text-gray-900 [color-scheme:light]"
            />
            <button
              onClick={approveReview}
              disabled={loading || !reviewText.trim()}
              className="mt-3 bg-green-500 text-white px-6 py-2 rounded-full shadow hover:bg-green-600 transition disabled:opacity-50"
            >
              {loading ? "Saving..." : "✅ Looks correct — add to library"}
            </button>
          </div>
        )}
      </div>
      )}

      {message && (

        <div className="max-w-2xl mx-auto mt-6 bg-green-50 border border-green-200 rounded-2xl p-4">

          <p className="text-gray-700">
            {message}
          </p>
        </div>
      )}

      {/* Documents */}
      <div className="max-w-3xl mx-auto mt-12">

        <h2 className="text-3xl font-bold text-gray-800 mb-2">
          📚 Learning Library
        </h2>
        <p className="text-gray-600 mb-6 text-sm">
          Lessons stay on this device. Signing in elsewhere shows profiles,
          not lessons — sync is not built yet.
        </p>

        {documents.length === 0 ? (

          <div className="bg-white rounded-3xl shadow-lg p-10 text-center">

            <div className="text-6xl mb-4">
              📚
            </div>

            <h3 className="text-2xl font-bold text-gray-800">
              No documents yet
            </h3>

            <p className="text-gray-600 mt-2">
              Upload your first
              learning document
            </p>
          </div>

        ) : (

          <div className="space-y-4">

            {documents.map((doc) => (

              <div
                key={doc.name}
                className="bg-white p-6 rounded-3xl shadow-lg flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
              >

                <div>

                  <h3 className="text-xl font-bold text-gray-800">
                    📄 {displayName(doc.name)}
                  </h3>

                  <p className="text-gray-600 mt-1">
                    {doc.approved
                      ? "✅ Approved for learning"
                      : "❌ Not approved"}
                  </p>
                </div>

                {!isChildMode && (
                <div className="flex gap-3">

                  <button
                    onClick={() =>
                      toggleApproval(
                        doc.name
                      )
                    }
                    className="bg-yellow-400 px-4 py-2 rounded-full text-slate-900 shadow hover:bg-yellow-500"
                  >
                    Toggle
                  </button>

                  <button
                    onClick={() =>
                      deleteDocument(
                        doc.name
                      )
                    }
                    className="bg-red-500 text-white px-4 py-2 rounded-full shadow hover:bg-red-600"
                  >
                    Delete
                  </button>
                </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Legacy/shared documents: parent-only. Children see only their
            own library, never the unclaimed pool. */}
        {!isChildMode && legacyDocs.length > 0 && (

          <div className="mt-10">

            <h2 className="text-2xl font-bold text-gray-800 mb-2">
              🗂️ Created before profiles
            </h2>
            <p className="text-gray-600 mb-4 text-sm">
              These documents are read-only and are never used in this
              child&apos;s lessons until you add them below.
            </p>

            <div className="space-y-4">

              {legacyDocs.map((doc) => (

                <div
                  key={doc.name}
                  className="bg-amber-50 border border-amber-200 p-6 rounded-3xl shadow flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
                >

                  <div>

                    <h3 className="text-xl font-bold text-gray-800">
                      📄 {displayName(doc.name)}
                    </h3>

                    <p className="text-gray-600 mt-1 text-sm">
                      <span className="inline-block bg-amber-200 text-amber-900 text-xs font-bold px-2 py-1 rounded-full mr-2">
                        Created before profiles
                      </span>
                      Read-only
                    </p>
                  </div>

                  <div className="flex gap-3">

                    <button
                      onClick={() =>
                        importLegacy(
                          doc.name
                        )
                      }
                      disabled={loading}
                      className="bg-green-500 px-4 py-2 rounded-full text-white shadow hover:bg-green-600 disabled:opacity-50"
                    >
                      Add to this child&apos;s library
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}