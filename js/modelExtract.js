/*
 * modelExtract.js
 *
 * Извлекает "базовую" марку теплообменника (например "ТОР-15" или
 * "ТОР-15М/13") и код исполнения (например "1х", "2х", "2хЦ", "3хБГВ")
 * прямо из текстового слоя PDF-бланка — из строки вида:
 *   "Марка теплообменника ТОР-15М/13-1х(LL+НН) ..."
 *   "Марка теплообменника ТОР-15-1х(НН)"
 * Раскладка каналов (в скобках) и количество пластин по-прежнему берутся
 * из спецификации BelTO (beltoParser.js) — здесь не нужны и игнорируются.
 *
 * Работает и для готового бланка из списка, и для "своего бланка"
 * (загруженный PDF другой модели) — оба читаются через pdf.js
 * (page.getTextContent()), без привязки к конкретным координатам,
 * потому что строка "Марка теплообменника" ищется по тексту, а не по
 * позиции на странице.
 */

// Группирует текстовые фрагменты pdf.js в строки (по Y с допуском) и
// внутри строки — слева направо по X, добавляя пробел только если между
// соседними фрагментами есть заметный зазор (иначе слипшиеся слова вида
// "Марка теплообменника" превратились бы в один "слипшийся" кусок, а
// разорванные посреди слова числа/буквы — наоборот, обрастали бы лишними
// пробелами).
// Возвращает строки страницы вместе с их Y-позицией в родных координатах
// PDF (низ страницы = 0, единицы — pt) и приблизительной высотой символов
// (по font-matrix масштабу элемента) — используется и для поиска марки
// (нужен только текст), и для поиска Y-меток зон вырезки картинок в
// diagramCrop.js (нужна ещё и позиция, чтобы найти верх/низ конкретного
// заголовка на конкретном файле, а не гадать процентом от страницы).
async function getPdfPageLinesWithPos(pdfBytes) {
  const pdf = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });

  const items = content.items
    .filter((it) => it.str && it.str.trim() !== '')
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      h: Math.abs(it.transform[3]) || 10,
      w: it.width || 0,
    }));

  const yTol = 2;
  const lines = [];
  items.forEach((it) => {
    let line = lines.find((l) => Math.abs(l.y - it.y) < yTol);
    if (!line) { line = { y: it.y, h: it.h, items: [] }; lines.push(line); }
    line.items.push(it);
  });
  lines.sort((a, b) => b.y - a.y);
  lines.forEach((l) => l.items.sort((a, b) => a.x - b.x));

  return lines.map((l) => {
    let s = '';
    let prevEnd = null;
    l.items.forEach((it) => {
      if (prevEnd !== null && it.x - prevEnd > 1.5) s += ' ';
      s += it.str;
      prevEnd = it.x + it.w;
    });
    return { text: s.trim(), y: l.y, h: l.h, pageHeight: viewport.height };
  });
}

// Обратная совместимость: только текст строк (для extractModelPartsFromPdf).
async function getPdfPageLines(pdfBytes) {
  const lines = await getPdfPageLinesWithPos(pdfBytes);
  return lines.map((l) => l.text);
}

// Из строки вида "Марка теплообменника ТОР-15М/13-1х(LL+НН) ..." достаёт
// { base: "ТОР-15М/13", execution: "1х" }. Раскладка в скобках и всё
// после неё игнорируются — они берутся из спецификации.
function parseModelLine(line) {
  const m = line.match(/(ТОР[^()]*?)\(/i);
  if (!m) return null;
  const core = m[1].replace(/\s+/g, '');
  // Последний "-сегмент" перед скобкой, начинающийся с цифры и х/Х —
  // это исполнение (1х, 2х, 2хЦ, 3х, 3хБГВ и т.п.); всё что до него —
  // базовая марка (может сама содержать дефисы: "ТОР-15", "ТОР-15М/13").
  const exec = core.match(/^(.*)-(\d+[xXхХ][A-Za-zА-Яа-яЁё]*)$/);
  if (!exec) return null;
  const base = exec[1].trim();
  const execution = exec[2].trim();
  if (!base || !execution) return null;
  return { base, execution };
}

/**
 * @param {ArrayBuffer} pdfBytes - байты PDF-бланка (готовый или свой)
 * @returns {Promise<{base: string, execution: string} | null>}
 */
async function extractModelPartsFromPdf(pdfBytes) {
  try {
    const lines = await getPdfPageLines(pdfBytes);
    const markaLine = lines.find((l) => /марка\s+теплообменника/i.test(l));
    if (!markaLine) return null;
    return parseModelLine(markaLine);
  } catch (e) {
    console.warn('Не удалось извлечь марку теплообменника из PDF-бланка', e);
    return null;
  }
}

// На реальных бланках температура часто напечатана с приподнятой буквой
// "о" перед "С" (типографская имитация значка градуса — "150 оС"), а не
// настоящим символом "°" — из-за меньшей высоты и смещённой вверх базовой
// линии pdf.js нередко выносит эту "о" в отдельную "строку" при разборе по
// координатам. Склеиваем такие места обратно в нормальный "°C" — та же
// проблема и то же решение, что и для верхних меток в самих
// Word-шаблонах (см. gen_docx3.py/gen_docx_monoblock.py).
function fixDegreeArtifacts(text) {
  let t = text;
  // 1) "о" на отдельной строке прямо перед строкой вида "...<число> С".
  t = t.replace(/(^|\n)[оО]\n([^\n]*\d)\s*[СC](?=\W|$)/g, (full, lead, before) => lead + before.replace(/\s+$/, '') + ' °C');
  // 2) "о" и "С"/"C" уже в одной строке рядом с числом ("150 оС", "150 о С").
  t = t.replace(/(\d)\s*[оО]\s*[СC](?=\W|$)/g, '$1 °C');
  // 3) Общий узор "о С" без числа рядом (на всякий случай).
  t = t.replace(/\bо\s+С\b/g, '°C');
  return t;
}

/*
 * Извлекает текст, реально напечатанный в области блока "Примечание"
 * (сертификаты, ТР ТС, материал пластин, рабочие параметры) на КОНКРЕТНОМ
 * загруженном PDF-бланке — вместо того, чтобы всегда подставлять один и тот
 * же текст-образец (DEFAULT_CERTIFICATES_TEXT, builtinPdfMapping.js) для
 * любого файла. По просьбе пользователя: этот текст должен каждый раз
 * забираться из самого бланка — в поле формы для проверки и, при
 * необходимости, редактирования — а не быть "зашитым" один раз.
 *
 * Область — та же рамка, что и LETTERHEAD_FIELDS.certificates_note.redact
 * (builtinPdfMapping.js), с небольшим запасом по краям (на случай, если
 * верстка конкретного файла на долю миллиметра отличается от эталона).
 * Берём координаты текстовых фрагментов через pdf.js (page.getTextContent)
 * и оставляем только те, что попадают в эту область; группируем их в строки
 * по Y (как getPdfPageLinesWithPos), а увеличенный вертикальный разрыв
 * между соседними строками (по сравнению с обычным межстрочным шагом на
 * этом же бланке) превращаем обратно в пустую строку-разделитель — иначе
 * абзацы образца ("Сертификат...", "ТР ТС...", "Материал пластин...")
 * слились бы в один сплошной блок без отступов.
 *
 * @param {ArrayBuffer} pdfBytes - байты загруженного PDF-бланка
 * @returns {Promise<string | null>} - текст (с переводами строк) или null,
 *   если в этой области на бланке текста не нашлось (тогда вызывающий код
 *   в app.js откатывается на DEFAULT_CERTIFICATES_TEXT).
 */
async function extractCertificatesTextFromPdf(pdfBytes) {
  try {
    const box = LETTERHEAD_FIELDS.certificates_note.redact;
    const pdf = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    const pageWidth = viewport.width;
    const pageHeight = viewport.height;

    const marginFrac = 0.01;
    const xFrac0 = box.xFrac - marginFrac;
    const xFrac1 = box.xFrac + box.wFrac + marginFrac;
    const yFrac0 = box.yFrac - marginFrac;
    const yFrac1 = box.yFrac + box.hFrac + marginFrac;

    const items = content.items
      .filter((it) => it.str && it.str.trim() !== '')
      .map((it) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        h: Math.abs(it.transform[3]) || 10,
        w: it.width || 0,
      }))
      .filter((it) => {
        const xf = it.x / pageWidth;
        const topFrac = (pageHeight - (it.y + it.h)) / pageHeight;
        return xf >= xFrac0 && xf <= xFrac1 && topFrac >= yFrac0 && topFrac <= yFrac1;
      });
    if (!items.length) return null;

    const yTol = 2;
    const lines = [];
    items.forEach((it) => {
      let line = lines.find((l) => Math.abs(l.y - it.y) < yTol);
      if (!line) { line = { y: it.y, items: [] }; lines.push(line); }
      line.items.push(it);
    });
    lines.sort((a, b) => b.y - a.y);
    lines.forEach((l) => l.items.sort((a, b) => a.x - b.x));

    const rawLines = lines.map((l) => {
      let s = '';
      let prevEnd = null;
      l.items.forEach((it) => {
        if (prevEnd !== null && it.x - prevEnd > 1.5) s += ' ';
        s += it.str;
        prevEnd = it.x + it.w;
      });
      return s.trim();
    });

    // Обычный межстрочный шаг на этом бланке — медиана расстояний между
    // соседними строками; заметно больший разрыв (абзацный отступ в
    // образце) восстанавливаем как одну пустую строку.
    const deltas = [];
    for (let i = 1; i < lines.length; i++) deltas.push(lines[i - 1].y - lines[i].y);
    deltas.sort((a, b) => a - b);
    const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0;

    const out = [];
    rawLines.forEach((text, i) => {
      if (i > 0 && median > 0) {
        const delta = lines[i - 1].y - lines[i].y;
        if (delta > median * 1.6) out.push('');
      }
      out.push(text);
    });

    // Заголовок "Примечание" на некоторых бланках напечатан чуть внутри
    // рамки (а не строго над ней, как в эталоне) и попадает в вырезку —
    // сам по себе он не часть текста сертификатов, убираем его отдельной
    // строкой, если он есть.
    const withoutHeading = out.filter((line) => !/^примечание\s*:?$/i.test(line.trim()));

    const result = fixDegreeArtifacts(withoutHeading.join('\n')).trim();
    return result || null;
  } catch (e) {
    console.warn('Не удалось извлечь текст блока "Примечание" из PDF-бланка', e);
    return null;
  }
}
