<script setup>
import { computed, onBeforeUnmount, ref } from "vue";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const prompt = ref("");
const effectivePrompt = ref("");
const reply = ref("");
const loading = ref(false);
const error = ref("");
const files = ref([]);
const fullscreenFile = ref(null);
const sharing = ref(false);

const promptPrefix = (import.meta.env.VITE_SONJA_PROMPT_PREFIX || "sonja file").trim();

const hasResults = computed(() => files.value.length > 0);
function isImageType(contentType = "", filename = "") {
  const loweredType = String(contentType).toLowerCase();
  const loweredName = String(filename).toLowerCase();
  return (
    loweredType.startsWith("image/") ||
    [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].some((ext) => loweredName.endsWith(ext))
  );
}

function isPdfType(contentType = "", filename = "") {
  const loweredType = String(contentType).toLowerCase();
  const loweredName = String(filename).toLowerCase();
  return loweredType.includes("pdf") || loweredName.endsWith(".pdf");
}

function buildDownloadUrl(fileId) {
  return `/api/file/file/download?owner=sonja&id=${encodeURIComponent(String(fileId))}`;
}

function toPrefixedPrompt(rawPrompt) {
  const value = String(rawPrompt || "").trim();
  if (!value) {
    return promptPrefix;
  }
  const loweredValue = value.toLowerCase();
  const loweredPrefix = promptPrefix.toLowerCase();
  if (loweredValue.startsWith(loweredPrefix)) {
    return value;
  }
  return `${promptPrefix} ${value}`;
}

async function renderPdfThumbnail(pdfUrl) {
  const loadingTask = pdfjsLib.getDocument({
    url: pdfUrl,
    withCredentials: false,
  });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = 260 / Math.max(baseViewport.width, 1);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return "";
  }
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  context.fillStyle = "#f6f6f2";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.86);
}

async function queryFiles() {
  const trimmedPrompt = String(prompt.value || "").trim();
  if (!trimmedPrompt) {
    error.value = "Enter a file retrieval prompt.";
    return;
  }
  loading.value = true;
  error.value = "";
  reply.value = "";
  files.value = [];
  effectivePrompt.value = toPrefixedPrompt(trimmedPrompt);

  try {
    const response = await fetch("/api/file/llm-query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner: "sonja",
        query_owner: "sonja",
        prompt: effectivePrompt.value,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success) {
      throw new Error(payload.message || `Query failed (${response.status})`);
    }

    reply.value = typeof payload.message === "string" ? payload.message : "No reply text.";
    const rawRows = Array.isArray(payload.rows) ? payload.rows : [];
    const prepared = rawRows
      .filter((row) => Number.isFinite(Number(row?.id)))
      .map((row) => {
        const id = Number(row.id);
        const contentType = String(row?.content_type || "");
        const filename = String(row?.filename || `file-${id}`);
        const pdf = isPdfType(contentType, filename);
        const image = isImageType(contentType, filename);
        const downloadUrl = buildDownloadUrl(id);
        return {
          id,
          filename,
          contentType,
          summary: String(row?.summary || ""),
          summaryStatus: String(row?.summary_status || ""),
          downloadUrl,
          kind: pdf ? "pdf" : image ? "image" : "other",
          thumbUrl: image ? downloadUrl : "",
        };
      });

    files.value = prepared;
    const pdfRows = prepared.filter((item) => item.kind === "pdf");
    await Promise.all(
      pdfRows.map(async (item) => {
        try {
          item.thumbUrl = await renderPdfThumbnail(item.downloadUrl);
        } catch {
          item.thumbUrl = "";
        }
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error.value = message || "Query failed.";
  } finally {
    loading.value = false;
  }
}

function openFullscreen(item) {
  fullscreenFile.value = item;
}

function closeFullscreen() {
  fullscreenFile.value = null;
}

async function shareCurrentFile() {
  if (!fullscreenFile.value || sharing.value) {
    return;
  }
  sharing.value = true;
  try {
    const target = fullscreenFile.value;
    const response = await fetch(target.downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to download file (${response.status})`);
    }
    const blob = await response.blob();
    const filename = target.filename || `file-${target.id}`;
    const shareFile = new File([blob], filename, { type: blob.type || target.contentType || "application/octet-stream" });
    if (navigator.canShare && navigator.canShare({ files: [shareFile] })) {
      await navigator.share({
        title: filename,
        text: filename,
        files: [shareFile],
      });
      return;
    }
    const directUrl = URL.createObjectURL(shareFile);
    const link = document.createElement("a");
    link.href = directUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(directUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error.value = message || "Share failed.";
  } finally {
    sharing.value = false;
  }
}

function onKeyDown(event) {
  if (event.key === "Escape" && fullscreenFile.value) {
    closeFullscreen();
  }
}

window.addEventListener("keydown", onKeyDown);
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
});
</script>

<template>
  <main class="page">
    <section class="panel">
      <h1>Sonja Files</h1>
      <p class="hint">File retrieval only. Prompt is auto-prefixed with <code>{{ promptPrefix }}</code>.</p>
      <div class="prompt-row">
        <textarea
          v-model="prompt"
          rows="3"
          placeholder="Example: show latest invoices from this month"
          :disabled="loading"
        />
        <button type="button" @click="queryFiles" :disabled="loading">
          {{ loading ? "Searching..." : "Search Files" }}
        </button>
      </div>
      <div class="effective" v-if="effectivePrompt">Sent: {{ effectivePrompt }}</div>
      <pre class="reply">{{ reply || "Reply will appear here." }}</pre>
      <div class="error" v-if="error">{{ error }}</div>
    </section>

    <section class="results" v-if="hasResults">
      <article class="card" v-for="item in files" :key="item.id" @click="openFullscreen(item)">
        <div class="thumb-wrap">
          <img v-if="item.thumbUrl" :src="item.thumbUrl" :alt="item.filename" />
          <div v-else class="thumb-fallback">
            <span>{{ item.kind === "pdf" ? "PDF" : "FILE" }}</span>
          </div>
        </div>
        <div class="meta">
          <div class="name">{{ item.filename }}</div>
          <div class="summary">{{ item.summary || `Summary: ${item.summaryStatus || "unavailable"}` }}</div>
        </div>
      </article>
    </section>

    <section class="viewer" v-if="fullscreenFile" @click.self="closeFullscreen">
      <button class="close" type="button" @click="closeFullscreen">Close</button>
      <button class="share" type="button" @click="shareCurrentFile" :disabled="sharing">
        {{ sharing ? "Sharing..." : "Share" }}
      </button>
      <div class="viewer-content">
        <img
          v-if="fullscreenFile.kind === 'image'"
          :src="fullscreenFile.downloadUrl"
          :alt="fullscreenFile.filename"
        />
        <iframe
          v-else-if="fullscreenFile.kind === 'pdf'"
          :src="fullscreenFile.downloadUrl"
          title="PDF view"
        />
        <div v-else class="other-file">Preview unavailable for this file type.</div>
      </div>
    </section>
  </main>
</template>
