import os from "os";
import fs from "fs/promises";
import formidable from "formidable";
import { v4 as uuidv4 } from "uuid";
import { addDocumentsToVectorStore, createEmbeddings, createSplitter, getLoader } from "./_lib/rag.js";

export const config = {
  api: {
    bodyParser: false
  }
};

function parseForm(req) {
  const form = formidable({
    multiples: false,
    uploadDir: os.tmpdir(),
    keepExtensions: true
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ fields, files });
    });
  });
}

async function safeUnlink(filePath) {
  if (!filePath) {
    return;
  }
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { files } = await parseForm(req);
    const uploadedFile = Array.isArray(files?.file) ? files.file[0] : files?.file;

    if (!uploadedFile) {
      res.status(400).json({ error: "No file uploaded." });
      return;
    }

    const filePath = uploadedFile.filepath || uploadedFile.path;
    const originalName = uploadedFile.originalFilename || uploadedFile.name || "";

    const loader = getLoader(filePath, originalName);
    if (!loader) {
      await safeUnlink(filePath);
      res.status(400).json({ error: "Only PDF, TXT, or CSV files are supported." });
      return;
    }

    const rawDocs = await loader.load();
    const splitter = createSplitter();
    const docs = await splitter.splitDocuments(rawDocs);
    const documentId = uuidv4();

    const docsWithMeta = docs.map((doc, index) => {
      const nextMeta = { ...doc.metadata, documentId, source: originalName, chunk: index };
      doc.metadata = nextMeta;
      return doc;
    });

    const embeddings = createEmbeddings();
    await addDocumentsToVectorStore(embeddings, docsWithMeta);
    await safeUnlink(filePath);

    res.json({
      documentId,
      filename: originalName,
      chunks: docsWithMeta.length
    });
  } catch (error) {
    console.error("Ingest failed:", error);
    res.status(500).json({ error: error?.message || "Failed to ingest the document." });
  }
}
