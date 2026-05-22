// Worker aislado para parsing de documentos.
// Recibe { type: 'pdf'|'docx-html'|'docx-text', buffer } por workerData.
// Devuelve por postMessage el resultado parseado o un error.
// Se ejecuta con resourceLimits (memoria) y timeout desde el padre — si tarda
// o consume demasiada memoria, el padre lo termina sin afectar al event loop principal.

const { parentPort, workerData } = require('worker_threads');
const mammoth = require('mammoth');
const { extractText, getDocumentProxy } = require('unpdf');

async function parsePdf(buffer) {
  const data = new Uint8Array(buffer);
  const pdf  = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: true });
  return { text: text || '', numpages: pdf.numPages || 0 };
}

async function parseDocxHtml(buffer) {
  const images = [];
  const result = await mammoth.convertToHtml(
    { buffer },
    { convertImage: mammoth.images.imgElement(async (image) => {
        const buf = await image.read();
        const idx = images.length;
        images.push({ data: buf, type: image.contentType });
        return { src: `__IMG_${idx}__` };
    }) }
  );
  // Devolvemos los buffers de imagen como Uint8Array para serialización eficiente
  const serializedImages = images.map(im => ({
    data: new Uint8Array(im.data),
    type: im.type
  }));
  return { html: result.value, images: serializedImages };
}

async function parseDocxText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return { text: (result.value || '').trim() };
}

(async () => {
  try {
    const { type, buffer } = workerData;
    let out;
    if (type === 'pdf')             out = await parsePdf(buffer);
    else if (type === 'docx-html')  out = await parseDocxHtml(buffer);
    else if (type === 'docx-text')  out = await parseDocxText(buffer);
    else throw new Error('Tipo de parser desconocido: ' + type);
    parentPort.postMessage({ ok: true, data: out });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err.message || String(err) });
  }
})();
