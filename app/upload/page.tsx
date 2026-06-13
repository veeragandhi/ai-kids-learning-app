"use client";

import { useEffect, useState } from "react";

type DocumentItem = {
  name: string;
  approved: boolean;
};

export default function ParentPage() {

  const [file, setFile] =
    useState<File | null>(null);

  const [message, setMessage] =
    useState("");

  const [documents, setDocuments] =
    useState<DocumentItem[]>([]);

  const [loading, setLoading] =
    useState(false);

  const loadDocuments = async () => {

    const res =
      await fetch("/api/documents");

    const data = await res.json();

    setDocuments(data);
  };

  useEffect(() => {
    loadDocuments();
  }, []);

  const uploadFile = async () => {

    if (!file) return;

    setLoading(true);
    setMessage("");

    const formData = new FormData();

    formData.append("file", file);

    const res = await fetch(
      "/api/upload",
      {
        method: "POST",
        body: formData,
      }
    );

    const data = await res.json();

    setMessage(
      data.message || data.error
    );

    setLoading(false);

    loadDocuments();
  };

  const toggleApproval =
    async (name: string) => {

    await fetch("/api/documents", {
      method: "PATCH",
      headers: {
        "Content-Type":
          "application/json",
      },
      body: JSON.stringify({ name }),
    });

    loadDocuments();
  };

  const deleteDocument =
    async (name: string) => {

    await fetch("/api/documents", {
      method: "DELETE",
      headers: {
        "Content-Type":
          "application/json",
      },
      body: JSON.stringify({ name }),
    });

    loadDocuments();
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-purple-50 to-white p-6">

      {/* Header */}
      <div className="text-center mb-10">

        <h1 className="text-5xl font-extrabold text-gray-800">
          👩 Parent Dashboard
        </h1>

        <p className="text-gray-600 mt-4 text-lg">
          Manage your child’s safe
          AI learning library
        </p>
      </div>

      {/* Upload Card */}
      <div className="bg-white max-w-2xl mx-auto p-8 rounded-3xl shadow-lg">

        <h2 className="text-2xl font-bold mb-4">
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
          className="mb-6"
        />

        <button
          onClick={uploadFile}
          disabled={loading}
          className="bg-purple-500 text-white px-6 py-3 rounded-full shadow hover:bg-purple-600 transition"
        >
          {loading
            ? "✨ Preparing AI learning memory..."
            : "🚀 Upload Document"}
        </button>

        {message && (

          <div className="mt-6 bg-green-50 border border-green-200 rounded-2xl p-4">

            <p className="text-gray-700">
              {message}
            </p>
          </div>
        )}
      </div>

      {/* Documents */}
      <div className="max-w-3xl mx-auto mt-12">

        <h2 className="text-3xl font-bold text-gray-800 mb-6">
          📚 Learning Library
        </h2>

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
                    📄 {doc.name}
                  </h3>

                  <p className="text-gray-600 mt-1">
                    {doc.approved
                      ? "✅ Approved for learning"
                      : "❌ Not approved"}
                  </p>
                </div>

                <div className="flex gap-3">

                  <button
                    onClick={() =>
                      toggleApproval(
                        doc.name
                      )
                    }
                    className="bg-yellow-400 px-4 py-2 rounded-full shadow hover:bg-yellow-500"
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
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}