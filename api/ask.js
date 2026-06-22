import Groq from "groq-sdk";
import { createEmbeddings, getVectorStore } from "./_lib/rag.js";

// Technique (a) — Query rewriting.
// A raw user question ("wht is attenshun") embeds far from the relevant chunks.
// Before retrieval we ask the LLM to fix typos and turn it into a clean,
// standalone search query so it lands closer to the right chunks in Qdrant.
// On ANY failure we return the original question, so retrieval can never be
// worse than the baseline.
async function rewriteQuery(client, model, question) {
  try {
    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 120,
      messages: [
        {
          role: "system",
          content: [
            "You rewrite a user's question into a clean search query for a vector database.",
            "Fix typos and grammar, expand obvious abbreviations, and make it a clear standalone question.",
            "Do NOT answer the question and do NOT add facts that are not implied.",
            "Return ONLY the rewritten query as plain text, with no quotes or preamble."
          ].join(" ")
        },
        { role: "user", content: question }
      ]
    });

    const rewritten = response.choices[0]?.message?.content?.trim();
    // Guard against empty or runaway output; fall back to the original.
    if (rewritten && rewritten.length <= 500) {
      return rewritten;
    }
  } catch (error) {
    console.error("Query rewrite failed, using original question:", error?.message);
  }
  return question;
}

// Technique (c) — Multi-query.
// One phrasing of a question only finds chunks worded like it. We ask the LLM
// for a few alternative phrasings / sub-topics so retrieval casts a wider net.
// On failure we return [] and fall back to single-query retrieval.
async function generateSubQueries(client, model, question, count = 3) {
  try {
    const response = await client.chat.completions.create({
      model,
      temperature: 0.4,
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content: [
            `Generate ${count} alternative search queries that capture different angles of the user's question.`,
            "Each query must be standalone and use varied wording or related sub-topics.",
            "Return ONLY the queries, one per line, with no numbering, quotes, or preamble."
          ].join(" ")
        },
        { role: "user", content: question }
      ]
    });

    const text = response.choices[0]?.message?.content || "";
    return text
      .split("\n")
      .map((line) => line.replace(/^\s*[-*\d.)]+\s*/, "").trim()) // strip bullets/numbering
      .filter((line) => line.length > 0)
      .slice(0, count);
  } catch (error) {
    console.error("Sub-query generation failed:", error?.message);
    return [];
  }
}

// Technique (d) — Reciprocal Rank Fusion (RRF).
// Each query returns its own ranked list of chunks. A chunk's fused score is the
// sum over every list of 1 / (rrfK + rank). Chunks that surface near the top
// across many queries rise above ones that appear in only a single list. The
// rrfK constant (60, the standard value) damps how much any one ranking counts.
function reciprocalRankFusion(rankedLists, topK = 4, rrfK = 60) {
  const scores = new Map(); // key -> fused score
  const byKey = new Map(); // key -> the original chunk

  for (const list of rankedLists) {
    list.forEach((chunk, rank) => {
      // A chunk's stable identity is its document + chunk index; fall back to
      // a content prefix if the index is missing.
      const key =
        chunk.metadata?.chunk !== undefined
          ? `${chunk.metadata.documentId}:${chunk.metadata.chunk}`
          : chunk.pageContent.slice(0, 100);

      scores.set(key, (scores.get(key) || 0) + 1 / (rrfK + rank));
      if (!byKey.has(key)) {
        byKey.set(key, chunk);
      }
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([key]) => byKey.get(key));
}

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

    const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const chatModel = process.env.GROQ_CHAT_MODEL || "llama3-70b-8192";

    // Clean up the raw question before we search (technique a).
    const searchQuery = await rewriteQuery(client, chatModel, question);

    const embeddings = createEmbeddings();
    const vectorStore = await getVectorStore(embeddings);
    const retriever = vectorStore.asRetriever({
      k: 4,
      filter: {
        must: [{ key: "metadata.documentId", match: { value: documentId } }]
      }
    });

    // Multi-query (c): widen retrieval with several phrasings of the question.
    const subQueries = await generateSubQueries(client, chatModel, searchQuery);
    const allQueries = [searchQuery, ...subQueries];

    // Retrieve a ranked list for every query. We go sequentially (not in
    // parallel) because the Jina free tier caps concurrent requests at 2 —
    // firing every query's embedding at once trips "concurrency limit exceeded".
    const rankedLists = [];
    for (const q of allQueries) {
      rankedLists.push(await retriever.invoke(q));
    }

    // Re-rank (d): fuse the lists with RRF and keep the best chunks overall.
    const chunks = reciprocalRankFusion(rankedLists, 4);

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
      rewrittenQuery: searchQuery,
      searchQueries: allQueries,
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
