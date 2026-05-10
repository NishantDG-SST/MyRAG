# MyRAG Studio

A simple web app that uploads a PDF or TXT file, chunks it, embeds it, stores the vectors in Qdrant, and answers questions grounded in the uploaded document.

## Features
- PDF, TXT, and CSV ingestion
- Recursive chunking strategy (1000 chars, 200 overlap)
- Jina AI embeddings + Qdrant vector store
- Groq Llama 70B chat completion
- Context-grounded answers with cited chunks

## Setup
1. Install dependencies:
   - `npm install`
2. Create your environment file:
   - Copy `.env.example` to `.env` and fill in values.
3. Start Qdrant (Docker example):
   - `docker run -p 6333:6333 qdrant/qdrant`
4. Run the app locally with Vercel:
   - `npx vercel dev`

Open `http://localhost:3000` in your browser.

## Usage
1. Upload a PDF or TXT document to create an index.
2. Ask questions, the response is grounded in retrieved chunks.
