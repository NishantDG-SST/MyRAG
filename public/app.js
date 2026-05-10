const uploadForm = document.getElementById("upload-form");
const fileInput = document.getElementById("file-input");
const uploadStatus = document.getElementById("upload-status");
const documentIdLabel = document.getElementById("document-id");
const uploadDrop = document.querySelector(".upload-drop");
const uploadTitle = document.getElementById("upload-title");
const uploadMeta = document.getElementById("upload-meta");

const questionForm = document.getElementById("question-form");
const questionInput = document.getElementById("question-input");
const answerStatus = document.getElementById("answer-status");
const answerBox = document.getElementById("answer-box");
const sourcesBox = document.getElementById("sources-box");

const storedDocumentId = localStorage.getItem("documentId");
if (storedDocumentId) {
  documentIdLabel.textContent = storedDocumentId;
}

function updateUploadUI(file) {
  if (!file) {
    uploadDrop.classList.remove("has-file");
    uploadTitle.textContent = "Drop a PDF/TXT here";
    uploadMeta.textContent = "or click to browse";
    return;
  }

  uploadDrop.classList.add("has-file");
  uploadTitle.textContent = file.name;
  uploadMeta.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB ready`;
}

uploadDrop.addEventListener("dragover", (event) => {
  event.preventDefault();
  uploadDrop.classList.add("is-dragover");
});

uploadDrop.addEventListener("dragleave", () => {
  uploadDrop.classList.remove("is-dragover");
});

uploadDrop.addEventListener("drop", (event) => {
  event.preventDefault();
  uploadDrop.classList.remove("is-dragover");
  const [file] = event.dataTransfer.files;
  if (!file) {
    return;
  }
  fileInput.files = event.dataTransfer.files;
  updateUploadUI(file);
});

fileInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  updateUploadUI(file);
});

function setStatus(element, message, tone = "info") {
  element.textContent = message;
  element.dataset.tone = tone;
}

function renderSources(sources) {
  if (!sources.length) {
    sourcesBox.innerHTML = "";
    return;
  }

  const list = sources
    .map(
      (source) =>
        `<li>Chunk ${source.chunk} · ${source.source} · ${
          source.page ? `page ${source.page}` : "page n/a"
        }<br/><span>${source.preview}</span></li>`
    )
    .join("");

  sourcesBox.innerHTML = `<h3>Sources</h3><ul>${list}</ul>`;
}

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];

  if (!file) {
    setStatus(uploadStatus, "Please choose a file.", "error");
    return;
  }

  setStatus(uploadStatus, "Indexing document...", "info");
  answerBox.textContent = "";
  sourcesBox.innerHTML = "";

  const formData = new FormData();
  formData.append("file", file);

  try {
    const response = await fetch("/api/ingest", {
      method: "POST",
      body: formData
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Upload failed");
    }

    localStorage.setItem("documentId", data.documentId);
    documentIdLabel.textContent = data.documentId;
    setStatus(
      uploadStatus,
      `Indexed ${data.filename} with ${data.chunks} chunks.`,
      "success"
    );
    updateUploadUI(file);
  } catch (error) {
    setStatus(uploadStatus, error.message, "error");
  }
});

questionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  const documentId = localStorage.getItem("documentId");

  if (!documentId) {
    setStatus(answerStatus, "Upload a document first.", "error");
    return;
  }

  if (!question) {
    setStatus(answerStatus, "Please enter a question.", "error");
    return;
  }

  setStatus(answerStatus, "Searching...", "info");
  answerBox.textContent = "";
  sourcesBox.innerHTML = "";

  try {
    const response = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, documentId })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Request failed");
    }

    answerBox.textContent = data.answer;
    renderSources(data.sources || []);
    setStatus(answerStatus, "Answer ready.", "success");
  } catch (error) {
    setStatus(answerStatus, error.message, "error");
  }
});
