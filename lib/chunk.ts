export function chunkText(
  text: string,
  chunkSize = 150,
  overlap = 30
) {
  const words = text.split(/\s+/);

  const chunks: string[] = [];

  let i = 0;

  while (i < words.length) {
    const chunk = words
      .slice(i, i + chunkSize)
      .join(" ");

    chunks.push(chunk);

    i += chunkSize - overlap;
  }

  return chunks;
}