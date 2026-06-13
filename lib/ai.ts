export async function generateAnswer(prompt: string) {
  const startTime = Date.now();
  console.log("[ai] Calling Ollama LLM...");
  
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gemma3:1b",
        prompt,
        stream: false,
        temperature: 0.2,
        num_predict: 300
      })
    });

    if (!res.ok) {
      throw new Error(`Ollama responded with status ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    
    if (!data.response) {
      throw new Error("Ollama returned no response");
    }

    const elapsedTime = Date.now() - startTime;
    console.log(`[ai] LLM response received in ${elapsedTime}ms (${data.response.length} chars)`);
    return data.response;
  } catch (error) {
    console.error("[ai] Error calling Ollama:", error);
    throw error;
  }
}

export async function* generateAnswerStream(prompt: string) {
  const startTime = Date.now();
  console.log("[ai] Calling Ollama LLM (streaming)...");
  
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gemma3:1b",
        prompt,
        stream: true,
        temperature: 0.2,
        num_predict: 300
      })
    });

    if (!res.ok) {
      throw new Error(`Ollama responded with status ${res.status}: ${res.statusText}`);
    }

    if (!res.body) throw new Error("No response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");

        // Process all complete lines
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (line) {
            try {
              const json = JSON.parse(line);
              if (json.response) {
                yield json.response;
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
        // Keep incomplete line in buffer
        buffer = lines[lines.length - 1];
      }

      // Process final buffer
      if (buffer.trim()) {
        try {
          const json = JSON.parse(buffer);
          if (json.response) {
            yield json.response;
          }
        } catch (e) {
          // Ignore parse errors
        }
      }

      const elapsedTime = Date.now() - startTime;
      console.log(`[ai] LLM streaming completed in ${elapsedTime}ms`);
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    console.error("[ai] Error in streaming:", error);
    throw error;
  }
}