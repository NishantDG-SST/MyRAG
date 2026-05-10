import path from "path";
import { PDFLoader } from "langchain/document_loaders/fs/pdf";
import { TextLoader } from "langchain/document_loaders/fs/text";
import { CSVLoader } from "@langchain/community/document_loaders/fs/csv";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { JinaEmbeddings } from "@langchain/community/embeddings/jina";
import { QdrantVectorStore } from "@langchain/qdrant";

const qdrantUrl = process.env.QDRANT_URL || "http://localhost:6333";
const collectionName = process.env.QDRANT_COLLECTION || "notebooklm";
const qdrantApiKey = process.env.QDRANT_API_KEY || "";
const embeddingModel = process.env.JINA_EMBEDDING_MODEL || "jina-embeddings-v2-base-en";
const chunkSize = Number.parseInt(process.env.CHUNK_SIZE || "1500", 10);
const chunkOverlap = Number.parseInt(process.env.CHUNK_OVERLAP || "250", 10);

export function getLoader(filePath, originalName) {
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

export function createSplitter() {
  return new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: ["\n\n", "\n", " ", ""]
  });
}

export function createEmbeddings() {
  if (!process.env.JINA_API_KEY) {
    throw new Error("Missing JINA_API_KEY.");
  }
  return new JinaEmbeddings({
    apiKey: process.env.JINA_API_KEY,
    model: embeddingModel
  });
}

export async function getVectorStore(embeddings) {
  return QdrantVectorStore.fromExistingCollection(embeddings, {
    url: qdrantUrl,
    apiKey: qdrantApiKey || undefined,
    collectionName,
    checkCompatibility: false
  });
}

async function ensurePayloadIndex(fieldName) {
  const baseUrl = qdrantUrl.replace(/\/$/, "");
  const url = `${baseUrl}/collections/${collectionName}/index`;
  const headers = {
    "Content-Type": "application/json"
  };
  if (qdrantApiKey) {
    headers["api-key"] = qdrantApiKey;
  }

  const response = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      field_name: fieldName,
      field_schema: "keyword"
    })
  });

  if (response.ok || response.status === 409) {
    return;
  }

  const details = await response.text();
  throw new Error(`Qdrant index error: ${details}`);
}

export async function addDocumentsToVectorStore(embeddings, docs) {
  try {
    await ensurePayloadIndex("metadata.documentId");
    const vectorStore = await getVectorStore(embeddings);
    await vectorStore.addDocuments(docs);
  } catch (error) {
    await ensurePayloadIndex("metadata.documentId");
    await QdrantVectorStore.fromDocuments(docs, embeddings, {
      url: qdrantUrl,
      apiKey: qdrantApiKey || undefined,
      collectionName,
      checkCompatibility: false
    });
  }
}
