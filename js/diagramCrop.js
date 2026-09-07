/*
 * diagramCrop.js
 *
 * Автовырезка картинки теплообменника (общий вид + размеры + список
 * патрубков Т1/Т2/В1/Т3) прямо из загруженного PDF-бланка — сотруднику не
 * нужно готовить картинку отдельно под каждую новую модель: программа сама
 * рендерит область DIAGRAM_BOX (builtinPdfMapping.js — общая для всей
 * линейки бланков БСИ) через pdf.js в canvas и вырезает из неё PNG.
 */

// Высота области вырезки по умолчанию (как доля высоты страницы) — просто
// исходная высота DIAGRAM_BOX. Разным моделям (особенно многоходовым —
// 2х, 2хЦ, 3х и т.п.) в бланке иногда добавляется ещё и схема "Компоновка
// пластин" под основной картинкой — на странице она может оказаться прямо
// под DIAGRAM_BOX, и при том же самом окне вырезки частично попадает в
// кадр. Поле "Высота картинки" в форме (app.js) позволяет сотруднику
// подрезать вырезку под конкретный бланк, не трогая код.
const DIAGRAM_BOX_DEFAULT_HEIGHT_FRAC = DIAGRAM_BOX.yFrac1 - DIAGRAM_BOX.yFrac0;

/**
 * @param {ArrayBuffer} pdfBytes
 * @param {number} offsetXFrac - та же поправка смещения, что и для полей
 *   (см. buildLetterheadMapping/customTplOffsetXFrac в app.js) — на случай
 *   если у конкретного загруженного файла вёрстка на пару мм отличается.
 * @param {number} offsetYFrac
 * @param {number} [heightFrac] - высота окна вырезки (доля высоты страницы,
 *   считается от верхнего края DIAGRAM_BOX + offsetYFrac). По умолчанию —
 *   родная высота DIAGRAM_BOX; сотрудник может её уменьшить/увеличить в форме,
 *   если в кадр попадает лишнее снизу (или наоборот, картинка обрезана).
 * @returns {Promise<{bytes: Uint8Array, widthPx: number, heightPx: number}>}
 */
// Общая часть: рендерит первую страницу PDF в canvas один раз (используется
// и старой ручной вырезкой, и новой вырезкой по зонам — чтобы не рендерить
// страницу дважды, когда нужны обе зоны сразу, вызывающий код может
// переиспользовать уже отрисованный canvas через renderPdfPageToCanvas +
// cropCanvasZone напрямую).
async function renderPdfPageToCanvas(pdfBytes) {
  const pdf = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
  const page = await pdf.getPage(1);
  // scale 3 -> ~280 DPI на области картинки, с запасом для чёткости при
  // печати (итоговая ширина в документе фиксирована ~530pt, см. docxTemplate.js).
  const scale = 3;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

function cropCanvasZone(canvas, x0, x1, y0, y1) {
  const cropW = Math.max(1, Math.round(x1 - x0));
  const cropH = Math.max(1, Math.round(y1 - y0));
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropW;
  cropCanvas.height = cropH;
  const cropCtx = cropCanvas.getContext('2d');
  cropCtx.drawImage(canvas, x0, y0, cropW, cropH, 0, 0, cropW, cropH);
  return cropCanvas;
}

async function canvasToDiagramImage(cropCanvas) {
  const blob = await new Promise((resolve) => cropCanvas.toBlob(resolve, 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, widthPx: cropCanvas.width, heightPx: cropCanvas.height };
}

async function cropDiagramFromPdf(pdfBytes, offsetXFrac, offsetYFrac, heightFrac) {
  const dx = offsetXFrac || 0;
  const dy = offsetYFrac || 0;
  const hFrac = (heightFrac === undefined || heightFrac === null || heightFrac <= 0)
    ? DIAGRAM_BOX_DEFAULT_HEIGHT_FRAC
    : heightFrac;
  const canvas = await renderPdfPageToCanvas(pdfBytes);

  const box = DIAGRAM_BOX;
  const x0 = (box.xFrac0 + dx) * canvas.width;
  const x1 = (box.xFrac1 + dx) * canvas.width;
  const y0 = (box.yFrac0 + dy) * canvas.height;
  const y1 = y0 + hFrac * canvas.height;

  const cropCanvas = cropCanvasZone(canvas, x0, x1, y0, y1);
  return canvasToDiagramImage(cropCanvas);
}

/**
 * Вырезка ПО ЗОНЕ, найденной автоматически по текстовым меткам на
 * конкретном PDF (см. diagramZones.js: findDiagramZones) — в отличие от
 * cropDiagramFromPdf (фиксированный DIAGRAM_BOX + ручная высота), здесь
 * yFrac0/yFrac1 уже посчитаны под конкретный файл ("Общий вид" или
 * "Компоновка пластин"), горизонтальные границы берутся из DIAGRAM_BOX
 * (общая для всей линейки ширина области рисунка).
 * @param {ArrayBuffer} pdfBytes
 * @param {{yFrac0:number, yFrac1:number}} zone
 * @param {number} [offsetXFrac] - ручная поправка по X, как у cropDiagramFromPdf
 * @returns {Promise<{bytes: Uint8Array, widthPx: number, heightPx: number}>}
 */
async function cropZoneFromPdf(pdfBytes, zone, offsetXFrac) {
  const dx = offsetXFrac || 0;
  const canvas = await renderPdfPageToCanvas(pdfBytes);
  const box = DIAGRAM_BOX;
  const x0 = (box.xFrac0 + dx) * canvas.width;
  const x1 = (box.xFrac1 + dx) * canvas.width;
  const y0 = zone.yFrac0 * canvas.height;
  const y1 = zone.yFrac1 * canvas.height;
  const cropCanvas = cropCanvasZone(canvas, x0, x1, y0, y1);
  return canvasToDiagramImage(cropCanvas);
}
