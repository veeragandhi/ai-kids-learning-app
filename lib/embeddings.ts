//import OpenAI from "openai";

// const client = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY,
// });

// export async function createEmbedding(
//   text: string
// ): Promise<number[]> {
//   const response =
//     await client.embeddings.create({
//       model: "text-embedding-3-small",
//       input: text,
//     });

//   return response.data[0].embedding;
// }

export async function createEmbedding(
  text: string
): Promise<number[]> {
  const startTime = Date.now();
  console.log("[embeddings] Creating embedding for:", text.substring(0, 50) + "...");

  const response = await fetch(
    "http://localhost:11434/api/embeddings",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "nomic-embed-text",
        prompt: text,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to create embedding: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();
  
  if (!data.embedding || !Array.isArray(data.embedding)) {
    console.error("Invalid embedding response:", data);
    throw new Error(
      "Invalid embedding response: missing or invalid embedding array"
    );
  }

  const elapsedTime = Date.now() - startTime;
  console.log(`[embeddings] Embedding created in ${elapsedTime}ms`);
  return data.embedding;
}