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

/**
 * Убирает собственную чёрную рамку картинки (она нарисована прямо в
 * артворке PDF-бланка) из вырезанного кадра — вместе с любым белым полем
 * ЗА рамкой, которое иногда попадает в кадр вырезки. Причина: у нас уже
 * есть СВОЯ рамка — линии таблицы Word-шаблона вокруг блока с картинкой.
 * Если оставить обе рамки, получаются две БЛИЗКИЕ, но не совпадающие линии
 * разной толщины (растровая линия картинки и векторная линия таблицы) — и
 * так как одна картинка (например "Компоновка пластин") часто у́же ячейки,
 * это расхождение хорошо заметно, плюс из-за сглаживания при масштабировании
 * растровая линия иногда пропадает то с одного края, то с другого. Отрезая
 * рамку картинки целиком, оставляем только сам чертёж — единственной
 * рамкой вокруг него становится линия таблицы, всегда одной толщины и без
 * пропусков (см. обсуждение в чате про "разной толщины" и "справа линии нет").
 *
 * Ищет у каждого края сплошную (>=85% тёмных пикселей по всей длине) линию
 * в пределах searchPx от края и обрезает картинку сразу за ней. Если с
 * какой-то стороны рамки не нашлось (нестандартный бланк, другой стиль
 * артворка) — с этой стороны кадр не трогаем, чтобы не отрезать нужный
 * контент по ошибке.
 */
function trimBorderFromCanvas(cropCanvas, opts) {
  // ВАЖНО: было 25 — рамка в артворке PDF-бланка (особенно "Компоновка
  // пластин") иногда лежит глубже (двойная линия/сглаживание), и с окном в
  // 25px обрезка попадала РОВНО на внешний край рамки, оставляя 1-2px
  // самой рамки видимыми узкой полоской у нового края картинки (жаловался
  // пользователь: "осталась нижняя полоса на картинке"). Окно увеличено, и
  // после него ещё добавлено "дотягивание" — если на границе окна строка
  // всё ещё тёмная, значит рамка не поместилась целиком, и обрезка
  // продолжается вглубь картинки, пока не найдётся светлая строка.
  const searchPx = (opts && opts.searchPx) || 45;
  const darkThreshold = (opts && opts.darkThreshold) || 110;
  const lineDarkFrac = (opts && opts.lineDarkFrac) || 0.85;
  const extendMaxPx = (opts && opts.extendMaxPx) || 25;
  const w = cropCanvas.width;
  const h = cropCanvas.height;
  if (w < 20 || h < 20) return cropCanvas;

  const ctx = cropCanvas.getContext('2d');
  const data = ctx.getImageData(0, 0, w, h).data;

  function grayAt(x, y) {
    const i = (y * w + x) * 4;
    return (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  function rowDarkFraction(y) {
    let dark = 0;
    for (let x = 0; x < w; x++) if (grayAt(x, y) < darkThreshold) dark++;
    return dark / w;
  }
  function colDarkFraction(x) {
    let dark = 0;
    for (let y = 0; y < h; y++) if (grayAt(x, y) < darkThreshold) dark++;
    return dark / h;
  }

  let top = 0;
  for (let y = 0; y < Math.min(searchPx, h); y++) {
    if (rowDarkFraction(y) >= lineDarkFrac) top = y + 1;
  }
  for (let y = top, extra = 0; y < h && extra < extendMaxPx && rowDarkFraction(y) >= lineDarkFrac; y++, extra++) {
    top = y + 1;
  }
  let bottom = h;
  for (let y = h - 1; y >= Math.max(0, h - searchPx); y--) {
    if (rowDarkFraction(y) >= lineDarkFrac) bottom = y;
  }
  for (let y = bottom - 1, extra = 0; y >= 0 && extra < extendMaxPx && rowDarkFraction(y) >= lineDarkFrac; y--, extra++) {
    bottom = y;
  }
  let left = 0;
  for (let x = 0; x < Math.min(searchPx, w); x++) {
    if (colDarkFraction(x) >= lineDarkFrac) left = x + 1;
  }
  for (let x = left, extra = 0; x < w && extra < extendMaxPx && colDarkFraction(x) >= lineDarkFrac; x++, extra++) {
    left = x + 1;
  }
  let right = w;
  for (let x = w - 1; x >= Math.max(0, w - searchPx); x--) {
    if (colDarkFraction(x) >= lineDarkFrac) right = x;
  }
  for (let x = right - 1, extra = 0; x >= 0 && extra < extendMaxPx && colDarkFraction(x) >= lineDarkFrac; x--, extra++) {
    right = x;
  }

  // Защита от ложного срабатывания (например, если сама картинка почти
  // целиком тёмная) — рамка не должна "съедать" больше трети кадра.
  const trimmedW = right - left;
  const trimmedH = bottom - top;
  if (trimmedW < w * 0.6 || trimmedH < h * 0.6) return cropCanvas;
  if (top === 0 && bottom === h && left === 0 && right === w) return cropCanvas;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = trimmedW;
  outCanvas.height = trimmedH;
  const outCtx = outCanvas.getContext('2d');
  outCtx.drawImage(cropCanvas, left, top, trimmedW, trimmedH, 0, 0, trimmedW, trimmedH);
  return outCanvas;
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

  const cropCanvas = trimBorderFromCanvas(cropCanvasZone(canvas, x0, x1, y0, y1));
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
  const cropCanvas = trimBorderFromCanvas(cropCanvasZone(canvas, x0, x1, y0, y1));
  return canvasToDiagramImage(cropCanvas);
}
