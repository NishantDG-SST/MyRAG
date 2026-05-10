import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { PDFLoader } from "langchain/document_loaders/fs/pdf";
import { TextLoader } from "langchain/document_loaders/fs/text";
import { CSVLoader } from "@langchain/community/document_loaders/fs/csv";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { JinaEmbeddings } from "@langchain/community/embeddings/jina";
import { QdrantVectorStore } from "@langchain/qdrant";
import Groq from "groq-sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: path.join(__dirname, "..", "uploads") });

const qdrantUrl = process.env.QDRANT_URL || "http://localhost:6333";
const collectionName = process.env.QDRANT_COLLECTION || "notebooklm";
const embeddingModel = process.env.JINA_EMBEDDING_MODEL || "jina-embeddings-v2-base-en";
const chatModel = process.env.GROQ_CHAT_MODEL || "llama3-70b-8192";
const chunkSize = Number.parseInt(process.env.CHUNK_SIZE || "1500", 10);
const chunkOverlap = Number.parseInt(process.env.CHUNK_OVERLAP || "250", 10);

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

async function ensureUploadsDir() {
  const uploadsDir = path.join(__dirname, "..", "uploads");
  await fs.mkdir(uploadsDir, { recursive: true });
}

function getLoader(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  if (ext === ".pdf") {
    return new PDFLoader(filePath);
  }
  if (ext === ".txt") {
    return new TextLoader(filePath);
  }
  if (ext === ".csv") {
    return new CSVLoader(filePath);
  }
  return null;
}

function createSplitter() {
  return new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: ["\n\n", "\n", " ", ""]
  });
}

function createEmbeddings() {
  if (!process.env.JINA_API_KEY) {
    throw new Error("Missing JINA_API_KEY.");
  }
  return new JinaEmbeddings({
    apiKey: process.env.JINA_API_KEY,
    model: embeddingModel
  });
}

async function getVectorStore(embeddings) {
  return QdrantVectorStore.fromExistingCollection(embeddings, {
    url: qdrantUrl,
    collectionName,
    checkCompatibility: false
  });
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/ingest", upload.single("file"), async (req, res) => {
  try {
    await ensureUploadsDir();

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    const loader = getLoader(req.file.path, req.file.originalname);
    if (!loader) {
      await fs.unlink(req.file.path);
      return res.status(400).json({ error: "Only PDF, TXT, or CSV files are supported." });
    }

    const rawDocs = await loader.load();
    const splitter = createSplitter();
    const docs = await splitter.splitDocuments(rawDocs);
    const documentId = uuidv4();
    const filename = req.file.originalname;

    const docsWithMeta = docs.map((doc, index) => {
      const nextMeta = { ...doc.metadata, documentId, source: filename, chunk: index };
      doc.metadata = nextMeta;
      return doc;
    });

    const embeddings = createEmbeddings();

    try {
      const vectorStore = await getVectorStore(embeddings);
      await vectorStore.addDocuments(docsWithMeta);
    } catch (error) {
      await QdrantVectorStore.fromDocuments(docsWithMeta, embeddings, {
        url: qdrantUrl,
        collectionName,
        checkCompatibility: false
      });
    }

    await fs.unlink(req.file.path);

    res.json({
      documentId,
      filename,
      chunks: docsWithMeta.length
    });
  } catch (error) {
    console.error("Ingest failed:", error);
    res.status(500).json({ error: error?.message || "Failed to ingest the document." });
  }
});

app.post("/api/ask", async (req, res) => {
  try {
    const { question, documentId } = req.body || {};

    if (!question || !documentId) {
      return res.status(400).json({ error: "Question and documentId are required." });
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
      return res.json({
        answer: "I could not find relevant content in the uploaded document. Try re-uploading the file.",
        sources: []
      });
    }

    const context = chunks
      .map((chunk, index) => {
        const page = chunk.metadata?.loc?.pageNumber;
        const pageLabel = Number.isFinite(page) ? `page ${page}` : "page n/a";
        return `Chunk ${index + 1} (${pageLabel}): ${chunk.pageContent}`;
      })
      .join("\n\n");

    const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
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
    res.status(500).json({ error: "Failed to answer the question." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
