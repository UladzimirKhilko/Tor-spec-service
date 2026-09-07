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
async function cropDiagramFromPdf(pdfBytes, offsetXFrac, offsetYFrac, heightFrac) {
  const dx = offsetXFrac || 0;
  const dy = offsetYFrac || 0;
  const hFrac = (heightFrac === undefined || heightFrac === null || heightFrac <= 0)
    ? DIAGRAM_BOX_DEFAULT_HEIGHT_FRAC
    : heightFrac;
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

  const box = DIAGRAM_BOX;
  const x0 = (box.xFrac0 + dx) * canvas.width;
  const x1 = (box.xFrac1 + dx) * canvas.width;
  const y0 = (box.yFrac0 + dy) * canvas.height;
  const y1 = y0 + hFrac * canvas.height;
  const cropW = Math.max(1, Math.round(x1 - x0));
  const cropH = Math.max(1, Math.round(y1 - y0));

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropW;
  cropCanvas.height = cropH;
  const cropCtx = cropCanvas.getContext('2d');
  cropCtx.drawImage(canvas, x0, y0, cropW, cropH, 0, 0, cropW, cropH);

  const blob = await new Promise((resolve) => cropCanvas.toBlob(resolve, 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, widthPx: cropW, heightPx: cropH };
}
