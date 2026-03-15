const fileInput = document.getElementById("fileInput");
const secretTextEl = document.getElementById("secretText");
const modeSelect = document.getElementById("modeSelect");
const colorPicker = document.getElementById("colorPicker");
const autoDetectBg = document.getElementById("autoDetectBg");
const embedBtn = document.getElementById("embedBtn");
const clearSelectionBtn = document.getElementById("clearSelectionBtn");
const downloadBtn = document.getElementById("downloadBtn");
const prevPageBtn = document.getElementById("prevPage");
const nextPageBtn = document.getElementById("nextPage");
const pageInfoEl = document.getElementById("pageInfo");
const statusEl = document.getElementById("status");
const canvas = document.getElementById("editorCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const state = {
  fileType: null,
  sourceFileName: "",
  workingImageData: null,
  selection: null,
  selecting: false,
  selectStart: null,
  pdfDoc: null,
  pdfPageCount: 0,
  currentPage: 1,
  pdfPageEdits: new Map(),
  // For PDF text-layer annotations: Map<pageNumber, Array<{text, rect, fontSize, color}>>
  pdfTextAnnotations: new Map(),
};

drawPlaceholder();

fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  resetTransientState();

  const isPdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

  try {
    if (isPdf) {
      await loadPdf(file);
    } else {
      await loadImage(file);
    }
  } catch (error) {
    setStatus(`Failed to load file: ${error.message}`, true);
  }
});

embedBtn.addEventListener("click", () => {
  if (!state.workingImageData) {
    setStatus("Load an image or PDF page before embedding.", true);
    return;
  }

  if (!state.selection) {
    setStatus("Drag on the canvas to select an area first.", true);
    return;
  }

  const secretText = secretTextEl.value;
  if (!secretText.trim()) {
    setStatus("Enter text to hide before embedding.", true);
    return;
  }

  const normalized = normalizeRect(state.selection);
  const selectedMode = (modeSelect?.value) || "text-layer";

  if (selectedMode === "lsb") {
    // legacy LSB embedding
    const bits = textToBits(secretText);
    const textMask = buildTextMask(secretText, normalized.width, normalized.height);
    let carriers = collectMaskedCarrierPixels(textMask, normalized);
    let mode = "text-shaped";

    if (bits.length > carriers.length) {
      carriers = collectAreaCarrierPixels(normalized);
      mode = "full-area";
    }

    if (bits.length > carriers.length) {
      const maxChars = Math.max(0, Math.floor(carriers.length / 8) - 4);
      setStatus(
        `Selection is too small. Max payload here is about ${maxChars} ASCII chars.`,
        true,
      );
      return;
    }

    const updated = cloneImageData(state.workingImageData);
    const data = updated.data;

    for (let i = 0; i < bits.length; i += 1) {
      const [x, y] = carriers[i];
      const index = (y * updated.width + x) * 4;
      data[index + 2] = (data[index + 2] & 0xfe) | bits[i];
    }

    state.workingImageData = updated;

    if (state.fileType === "pdf") {
      state.pdfPageEdits.set(state.currentPage, cloneImageData(updated));
    }

    redrawCanvas();
    setStatus(
      `Embedded ${secretText.length} chars using ${mode} camouflage (${carriers.length} pixels).`,
    );
    return;
  }

  // image-based modes: render visible pixels (OCR-oriented)
  const chosenColor = (autoDetectBg?.checked)
    ? detectBackgroundColor(normalized)
    : (colorPicker?.value || "#ffffff");

  if (selectedMode === "image-ocr") {
    drawTextOnCanvas(secretText, normalized, chosenColor);
    state.workingImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    if (state.fileType === "pdf") {
      state.pdfPageEdits.set(state.currentPage, cloneImageData(state.workingImageData));
    }

    redrawCanvas();
    setStatus(`Rendered ${secretText.length} chars into pixels for OCR.`);
    return;
  }

  // default: text-layer mode (preferred for PDFs)
  if (selectedMode === "text-layer") {
    if (state.fileType === "pdf") {
      const fontSize = Math.max(10, Math.floor(normalized.height * 0.6));
      const color = chosenColor;
      const annotations = state.pdfTextAnnotations.get(state.currentPage) || [];
      annotations.push({ text: secretText, rect: normalized, fontSize, color });
      state.pdfTextAnnotations.set(state.currentPage, annotations);

      // preview the annotation on the canvas
      drawTextAnnotationsOnCanvas(state.currentPage);
      state.workingImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      redrawCanvas();
      setStatus(`Added text-layer annotation for page ${state.currentPage}.`);
      return;
    }

    // fallback for images: draw into pixels
    drawTextOnCanvas(secretText, normalized, chosenColor);
    state.workingImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    redrawCanvas();
    setStatus(`Rendered ${secretText.length} chars into image pixels (fallback).`);
  }
});

clearSelectionBtn.addEventListener("click", () => {
  state.selection = null;
  redrawCanvas();
  setStatus("Selection cleared.");
});

downloadBtn.addEventListener("click", async () => {
  if (!state.workingImageData) {
    setStatus("Nothing to export yet.", true);
    return;
  }

  if (state.fileType === "pdf") {
    await exportPdf();
    return;
  }

  exportImage();
});

prevPageBtn.addEventListener("click", async () => {
  if (!state.pdfDoc || state.currentPage <= 1) {
    return;
  }
  await renderPdfPage(state.currentPage - 1);
});

nextPageBtn.addEventListener("click", async () => {
  if (!state.pdfDoc || state.currentPage >= state.pdfPageCount) {
    return;
  }
  await renderPdfPage(state.currentPage + 1);
});

canvas.addEventListener("mousedown", (event) => {
  if (!state.workingImageData) {
    return;
  }

  state.selecting = true;
  const point = getCanvasPoint(event);
  state.selectStart = point;
  state.selection = { x: point.x, y: point.y, width: 0, height: 0 };
  redrawCanvas();
});

window.addEventListener("mousemove", (event) => {
  if (!state.selecting || !state.selectStart) {
    return;
  }

  const point = getCanvasPoint(event);
  state.selection = {
    x: state.selectStart.x,
    y: state.selectStart.y,
    width: point.x - state.selectStart.x,
    height: point.y - state.selectStart.y,
  };
  redrawCanvas();
});

window.addEventListener("mouseup", () => {
  if (!state.selecting) {
    return;
  }

  state.selecting = false;
  if (!state.selection) {
    return;
  }

  const normalized = normalizeRect(state.selection);
  if (normalized.width < 4 || normalized.height < 4) {
    state.selection = null;
    setStatus("Selection too small. Drag a larger area.", true);
  } else {
    state.selection = normalized;
    setStatus(`Selection set: ${normalized.width} x ${normalized.height}px.`);
  }

  redrawCanvas();
});

function resetTransientState() {
  state.selection = null;
  state.selecting = false;
  state.selectStart = null;
  state.workingImageData = null;
  state.fileType = null;
  state.sourceFileName = "";
  state.pdfDoc = null;
  state.pdfPageCount = 0;
  state.currentPage = 1;
  state.pdfPageEdits = new Map();
  state.pdfTextAnnotations = new Map();
  updatePageControls();
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function drawPlaceholder() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#eaf0f7";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#5f6f83";
  ctx.font = "22px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Load an image or PDF to begin", canvas.width / 2, canvas.height / 2);
}

function updatePageControls() {
  const isPdf = Boolean(state.pdfDoc);
  prevPageBtn.disabled = !isPdf || state.currentPage <= 1;
  nextPageBtn.disabled = !isPdf || state.currentPage >= state.pdfPageCount;
  pageInfoEl.textContent = isPdf
    ? `Page ${state.currentPage}/${state.pdfPageCount}`
    : "Page -/-";
}

function cloneImageData(imageData) {
  return new ImageData(
    new Uint8ClampedArray(imageData.data),
    imageData.width,
    imageData.height,
  );
}

function redrawCanvas() {
  if (!state.workingImageData) {
    drawPlaceholder();
    return;
  }

  ctx.putImageData(state.workingImageData, 0, 0);

  if (!state.selection) {
    return;
  }

  const rect = normalizeRect(state.selection);
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = "#0b7fd4";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width, rect.height);
  ctx.restore();
}

function drawTextAnnotationsOnCanvas(pageNumber) {
  const annotations = state.pdfTextAnnotations.get(pageNumber) || [];
  if (!annotations.length) return;
  ctx.save();
  for (const ann of annotations) {
    const rect = ann.rect;
    const fontSize = ann.fontSize || Math.max(10, Math.floor(rect.height * 0.6));
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textBaseline = "top";
    // preview: outline and faint fill so user can see placement during editing
    ctx.strokeStyle = "rgba(11,127,212,0.9)";
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width, rect.height);
    ctx.fillStyle = "rgba(11,127,212,0.12)";
    // simple line splitting
    const lines = ann.text.split("\n");
    let y = rect.y;
    for (const line of lines) {
      ctx.fillText(line, rect.x, y);
      y += fontSize * 1.15;
    }
  }
  ctx.restore();
}

function normalizeRect(rect) {
  const x1 = Math.min(rect.x, rect.x + rect.width);
  const y1 = Math.min(rect.y, rect.y + rect.height);
  const x2 = Math.max(rect.x, rect.x + rect.width);
  const y2 = Math.max(rect.y, rect.y + rect.height);
  return {
    x: clamp(Math.round(x1), 0, canvas.width),
    y: clamp(Math.round(y1), 0, canvas.height),
    width: clamp(Math.round(x2 - x1), 0, canvas.width),
    height: clamp(Math.round(y2 - y1), 0, canvas.height),
  };
}

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = Math.floor((event.clientX - rect.left) * scaleX);
  const y = Math.floor((event.clientY - rect.top) * scaleY);
  return {
    x: clamp(x, 0, canvas.width - 1),
    y: clamp(y, 0, canvas.height - 1),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function loadImage(file) {
  const imageDataUrl = await readFileAsDataUrl(file);
  const image = await loadHtmlImage(imageDataUrl);

  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  ctx.drawImage(image, 0, 0);

  state.fileType = "image";
  state.sourceFileName = file.name;
  state.workingImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  state.selection = null;
  updatePageControls();
  redrawCanvas();
  setStatus("Image loaded. Drag to select a region and embed text.");
}

async function loadPdf(file) {
  if (!window.pdfjsLib) {
    throw new Error("PDF.js failed to load from CDN.");
  }

  const bytes = await file.arrayBuffer();
  const loadingTask = window.pdfjsLib.getDocument({ data: bytes });
  const pdfDoc = await loadingTask.promise;

  state.fileType = "pdf";
  state.sourceFileName = file.name;
  state.pdfDoc = pdfDoc;
  state.pdfPageCount = pdfDoc.numPages;
  state.currentPage = 1;
  state.pdfPageEdits = new Map();
  state.pdfTextAnnotations = new Map();

  await renderPdfPage(1);
  setStatus(`PDF loaded (${state.pdfPageCount} pages). Edit page by page, then export.`);
}

async function renderPdfPage(pageNumber) {
  if (!state.pdfDoc) {
    return;
  }

  const page = await state.pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1.6 });

  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  if (state.pdfPageEdits.has(pageNumber)) {
    ctx.putImageData(cloneImageData(state.pdfPageEdits.get(pageNumber)), 0, 0);
  }

  if (state.pdfTextAnnotations.has(pageNumber)) {
    drawTextAnnotationsOnCanvas(pageNumber);
  }

  state.workingImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  state.selection = null;
  state.currentPage = pageNumber;
  updatePageControls();
  redrawCanvas();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

function loadHtmlImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not decode image."));
    image.src = source;
  });
}

function textToBits(text) {
  const payload = new TextEncoder().encode(text);
  const packaged = new Uint8Array(payload.length + 4);
  const view = new DataView(packaged.buffer);
  view.setUint32(0, payload.length, false);
  packaged.set(payload, 4);

  const bits = new Uint8Array(packaged.length * 8);
  let bitIndex = 0;

  for (const byte of packaged) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      bits[bitIndex] = (byte >> bit) & 1;
      bitIndex += 1;
    }
  }

  return bits;
}

function buildTextMask(text, width, height) {
  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;
  const offCtx = offscreen.getContext("2d", { willReadFrequently: true });

  offCtx.clearRect(0, 0, width, height);
  offCtx.fillStyle = "#ffffff";
  offCtx.textBaseline = "top";

  let fontSize = Math.max(10, Math.floor(height * 0.35));
  let lines = [];
  let lineHeight = 0;

  while (fontSize >= 8) {
    offCtx.font = `${fontSize}px sans-serif`;
    lines = wrapLines(offCtx, text, width);
    lineHeight = Math.ceil(fontSize * 1.2);

    if (lines.length * lineHeight <= height) {
      break;
    }

    fontSize -= 1;
  }

  if (lines.length === 0) {
    lines = [text];
    offCtx.font = `${fontSize}px sans-serif`;
    lineHeight = Math.ceil(fontSize * 1.2);
  }

  const totalHeight = lines.length * lineHeight;
  let y = Math.max(0, Math.floor((height - totalHeight) / 2));

  for (const line of lines) {
    if (!line) {
      y += lineHeight;
      continue;
    }

    const measured = offCtx.measureText(line).width;
    const x = Math.max(0, Math.floor((width - measured) / 2));
    offCtx.fillText(line, x, y);
    y += lineHeight;

    if (y > height) {
      break;
    }
  }

  return offCtx.getImageData(0, 0, width, height);
}

function wrapLines(drawCtx, text, maxWidth) {
  const paragraphs = text.replace(/\r/g, "").split("\n");
  const lines = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);

    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (drawCtx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }

      if (line) {
        lines.push(line);
      }

      if (drawCtx.measureText(word).width <= maxWidth) {
        line = word;
      } else {
        const chunks = breakWord(drawCtx, word, maxWidth);
        lines.push(...chunks.slice(0, -1));
        line = chunks[chunks.length - 1] ?? "";
      }
    }

    if (line) {
      lines.push(line);
    }
  }

  return lines;
}

function breakWord(drawCtx, word, maxWidth) {
  const chunks = [];
  let current = "";

  for (const char of word) {
    const candidate = current + char;
    if (drawCtx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
      continue;
    }

    chunks.push(current);
    current = char;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function collectMaskedCarrierPixels(maskData, areaRect) {
  const carriers = [];
  const { data, width } = maskData;

  for (let y = 0; y < areaRect.height; y += 1) {
    for (let x = 0; x < areaRect.width; x += 1) {
      const index = (y * width + x) * 4;
      if (data[index + 3] > 96) {
        carriers.push([areaRect.x + x, areaRect.y + y]);
      }
    }
  }

  return carriers;
}

function collectAreaCarrierPixels(areaRect) {
  const carriers = [];

  for (let y = 0; y < areaRect.height; y += 1) {
    for (let x = 0; x < areaRect.width; x += 1) {
      carriers.push([areaRect.x + x, areaRect.y + y]);
    }
  }

  return carriers;
}

function hexToRgb(hex) {
  if (!hex) return [255, 255, 255];
  const cleaned = hex.replace(/^#/, "");
  if (cleaned.length === 3) {
    const r = parseInt(cleaned[0] + cleaned[0], 16);
    const g = parseInt(cleaned[1] + cleaned[1], 16);
    const b = parseInt(cleaned[2] + cleaned[2], 16);
    return [r, g, b];
  }
  if (cleaned.length === 6) {
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    return [r, g, b];
  }
  return [255, 255, 255];
}

function detectBackgroundColor(rect) {
  // sample a small grid near the center of the selection and average the colors
  try {
    const data = state.workingImageData?.data;
    if (!data) return "#ffffff";
    const sample = 7;
    const cx = rect.x + Math.floor(rect.width / 2);
    const cy = rect.y + Math.floor(rect.height / 2);
    const startX = Math.max(rect.x, cx - Math.floor(sample / 2));
    const startY = Math.max(rect.y, cy - Math.floor(sample / 2));
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;

    for (let y = startY; y < Math.min(rect.y + rect.height, startY + sample); y += 1) {
      for (let x = startX; x < Math.min(rect.x + rect.width, startX + sample); x += 1) {
        const idx = (y * state.workingImageData.width + x) * 4;
        r += data[idx];
        g += data[idx + 1];
        b += data[idx + 2];
        count += 1;
      }
    }

    if (count === 0) return "#ffffff";
    r = Math.round(r / count);
    g = Math.round(g / count);
    b = Math.round(b / count);
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  } catch (e) {
    return "#ffffff";
  }
}

function drawTextOnCanvas(text, rect, colorHex) {
  const fontSize = Math.max(10, Math.floor(rect.height * 0.6));
  ctx.save();
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = colorHex || "#ffffff";
  ctx.textBaseline = "top";
  const words = wrapLines(ctx, text, rect.width - 4);
  // vertically center
  const lineHeight = Math.ceil(fontSize * 1.15);
  const totalHeight = words.length * lineHeight;
  let y = rect.y + Math.max(0, Math.floor((rect.height - totalHeight) / 2));
  for (const line of words) {
    ctx.fillText(line, rect.x + 2, y);
    y += lineHeight;
  }
  ctx.restore();
}

function exportImage() {
  const filename = `${stripExtension(state.sourceFileName || "image")}-embedded.png`;
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = state.workingImageData.width;
  tempCanvas.height = state.workingImageData.height;
  tempCanvas.getContext("2d").putImageData(state.workingImageData, 0, 0);

  tempCanvas.toBlob(
    (blob) => {
      if (!blob) {
        setStatus("Image export failed.", true);
        return;
      }

      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
      setStatus(`Downloaded ${filename}.`);
    },
    "image/png",
    1,
  );
}

async function exportPdf() {
  if (!state.pdfDoc) {
    setStatus("No PDF loaded.", true);
    return;
  }

  if (!window.jspdf?.jsPDF) {
    setStatus("jsPDF failed to load from CDN.", true);
    return;
  }

  const { jsPDF } = window.jspdf;
  let pdfWriter = null;

  setStatus("Exporting PDF pages. This can take a moment...");

  for (let pageNumber = 1; pageNumber <= state.pdfPageCount; pageNumber += 1) {
    const rendered = await renderPdfPageToCanvas(pageNumber);
    const renderedCtx = rendered.getContext("2d", { willReadFrequently: true });

    if (state.pdfPageEdits.has(pageNumber)) {
      renderedCtx.putImageData(cloneImageData(state.pdfPageEdits.get(pageNumber)), 0, 0);
    }

    const pageWidth = rendered.width;
    const pageHeight = rendered.height;
    const orientation = pageWidth >= pageHeight ? "landscape" : "portrait";

    if (!pdfWriter) {
      pdfWriter = new jsPDF({
        orientation,
        unit: "px",
        format: [pageWidth, pageHeight],
      });
    } else {
      pdfWriter.addPage([pageWidth, pageHeight], orientation);
    }

    const pngData = rendered.toDataURL("image/png");
    pdfWriter.addImage(pngData, "PNG", 0, 0, pageWidth, pageHeight, undefined, "FAST");

    // Add any text-layer annotations as real PDF text objects on top of the raster page
    if (state.pdfTextAnnotations.has(pageNumber)) {
      const annotations = state.pdfTextAnnotations.get(pageNumber) || [];
      for (const ann of annotations) {
        const rect = ann.rect;
        const fontSize = ann.fontSize || Math.max(10, Math.floor(rect.height * 0.6));
        pdfWriter.setFont("helvetica", "normal");
        pdfWriter.setFontSize(fontSize);
        const [r, g, b] = hexToRgb(ann.color || "#ffffff");
        pdfWriter.setTextColor(r, g, b);

        // split text to fit within the annotation width
        const lines = pdfWriter.splitTextToSize(ann.text, Math.max(1, rect.width - 4));
        let y = rect.y + fontSize; // start at top + fontSize to approximate baseline
        for (const line of lines) {
          pdfWriter.text(String(line), rect.x + 2, y);
          y += Math.ceil(fontSize * 1.15);
        }
      }
    }
  }

  const outputName = `${stripExtension(state.sourceFileName || "document")}-embedded.pdf`;
  pdfWriter.save(outputName);
  setStatus(`Downloaded ${outputName}.`);
}

async function renderPdfPageToCanvas(pageNumber) {
  const page = await state.pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1.6 });
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = Math.floor(viewport.width);
  tempCanvas.height = Math.floor(viewport.height);
  const tempCtx = tempCanvas.getContext("2d");
  await page.render({ canvasContext: tempCtx, viewport }).promise;
  return tempCanvas;
}

function stripExtension(filename) {
  return filename.replace(/\.[^/.]+$/, "") || "output";
}

// BEGIN: Test API (appended by automated refactor)
window.invisibleTextAPI = {
  importPdfBytes: async function(bytes) {
    if (!window.pdfjsLib) throw new Error('PDF.js not loaded');
    const loadingTask = window.pdfjsLib.getDocument({ data: bytes });
    const pdfDoc = await loadingTask.promise;
    state.fileType = 'pdf';
    state.sourceFileName = 'imported.pdf';
    state.pdfDoc = pdfDoc;
    state.pdfPageCount = pdfDoc.numPages;
    state.currentPage = 1;
    state.pdfPageEdits = new Map();
    state.pdfTextAnnotations = new Map();
    await renderPdfPage(1);
    return { pageCount: state.pdfPageCount };
  },

  exportPdfToBlob: async function() {
    if (!state.pdfDoc) throw new Error('No PDF loaded');
    if (!window.jspdf?.jsPDF) throw new Error('jsPDF not loaded');
    const { jsPDF } = window.jspdf;
    let pdfWriter = null;

    for (let pageNumber = 1; pageNumber <= state.pdfPageCount; pageNumber += 1) {
      const rendered = await renderPdfPageToCanvas(pageNumber);
      const renderedCtx = rendered.getContext('2d', { willReadFrequently: true });

      if (state.pdfPageEdits.has(pageNumber)) {
        renderedCtx.putImageData(cloneImageData(state.pdfPageEdits.get(pageNumber)), 0, 0);
      }

      const pageWidth = rendered.width;
      const pageHeight = rendered.height;
      const orientation = pageWidth >= pageHeight ? 'landscape' : 'portrait';

      if (!pdfWriter) {
        pdfWriter = new jsPDF({ orientation, unit: 'px', format: [pageWidth, pageHeight] });
      } else {
        pdfWriter.addPage([pageWidth, pageHeight], orientation);
      }

      const pngData = rendered.toDataURL('image/png');
      pdfWriter.addImage(pngData, 'PNG', 0, 0, pageWidth, pageHeight, undefined, 'FAST');

      if (state.pdfTextAnnotations.has(pageNumber)) {
        const annotations = state.pdfTextAnnotations.get(pageNumber) || [];
        for (const ann of annotations) {
          const rect = ann.rect;
          const fontSize = ann.fontSize || Math.max(10, Math.floor(rect.height * 0.6));
          pdfWriter.setFont('helvetica', 'normal');
          pdfWriter.setFontSize(fontSize);
          const [r, g, b] = hexToRgb(ann.color || '#ffffff');
          pdfWriter.setTextColor(r, g, b);
          const lines = pdfWriter.splitTextToSize(ann.text, Math.max(1, rect.width - 4));
          let y = rect.y + fontSize;
          for (const line of lines) {
            pdfWriter.text(String(line), rect.x + 2, y);
            y += Math.ceil(fontSize * 1.15);
          }
        }
      }
    }

    if (!pdfWriter) throw new Error('No pages to export');
    const blob = pdfWriter.output('blob');
    return blob;
  },

  setSecretText: function(s) { secretTextEl.value = s; },
  setMode: function(m) { if (modeSelect) modeSelect.value = m; },
  setColor: function(c) { if (colorPicker) colorPicker.value = c; },
  setAutoDetect: function(b) { if (autoDetectBg) autoDetectBg.checked = !!b; },
  setSelection: function(rect) {
    state.selection = normalizeRect(rect);
    // preview
    drawTextAnnotationsOnCanvas(state.currentPage);
    state.workingImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    redrawCanvas();
  },
  embedNow: function() { embedBtn.click(); },
};

// END: Test API
