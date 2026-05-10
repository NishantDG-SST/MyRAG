import Groq from "groq-sdk";
import { createEmbeddings, getVectorStore } from "./_lib/rag.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { question, documentId } = req.body || {};

    if (!question || !documentId) {
      res.status(400).json({ error: "Question and documentId are required." });
      return;
    }

    const embeddings = createEmbeddings();
    const vectorStore = await getVectorStore(embeddings);
    const retriever = vectorStore.asRetriever({
      k: 4,
      filter: {
        must: [{ key: "metadata.documentId", match: { value: documentId } }]
      }
    });

    const chunks = await retriever.invoke(question);

    if (!chunks.length) {
      res.json({
        answer: "I could not find relevant content in the uploaded document. Try re-uploading the file.",
        sources: []
      });
      return;
    }

    const context = chunks
      .map((chunk, index) => {
        const page = chunk.metadata?.loc?.pageNumber;
        const pageLabel = Number.isFinite(page) ? `page ${page}` : "page n/a";
        return `Chunk ${index + 1} (${pageLabel}): ${chunk.pageContent}`;
      })
      .join("\n\n");

    const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const chatModel = process.env.GROQ_CHAT_MODEL || "llama3-70b-8192";
    const systemPrompt = [
      "You answer using only the provided context.",
      "If the answer is not in the context, say you do not know.",
      "If the user asks what the document is about, summarize the overall topic based on the chunks.",
      "Keep the answer concise and cite chunks by number when possible.",
      "Context:",
      context
    ].join("\n");

    const response = await client.chat.completions.create({
      model: chatModel,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: question }
      ]
    });

    res.json({
      answer: response.choices[0]?.message?.content || "No answer produced.",
      sources: chunks.map((chunk, index) => ({
        chunk: index + 1,
        source: chunk.metadata?.source || "unknown",
        page: chunk.metadata?.loc?.pageNumber ?? null,
        preview: chunk.pageContent.slice(0, 180)
      }))
    });
  } catch (error) {
    console.error("Ask failed:", error);
    res.status(500).json({ error: error?.message || "Failed to answer the question." });
  }
}
