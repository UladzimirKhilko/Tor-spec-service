/*
 * diagramZones.js
 *
 * Определяет границы картинок теплообменника НЕ фиксированной рамкой в %
 * от страницы (это ломалось на разных моделях — см. историю чата: у
 * многоходовых моделей 2х/2хЦ/3х и т.п. под основной картинкой в бланке
 * есть ещё и схема "Компоновка пластин", а разные модели по-разному
 * используют высоту страницы), а по ТЕКСТОВЫМ МЕТКАМ на конкретном
 * загруженном PDF — тем же самым, что видны в самом бланке:
 *   - "Общий вид теплообменника" (заголовок) .. "ВНИМАНИЕ:" (текст под
 *     рамкой) — граница красной зоны (есть у ВСЕХ бланков этой линейки);
 *   - "Компоновка пластин" (заголовок) .. "Расчёт выполнил:" (подпись
 *     внизу бланка) — граница зелёной зоны (есть только у многоходовых
 *     моделей — 2х, 2хЦ, 3х и т.п.). Саму строку "Расчёт выполнил" из PDF
 *     не вырезаем вообще — она дублировала бы нашу же подпись в шаблоне.
 * Наличие "Компоновка" в тексте страницы автоматически говорит, что у
 * этой модели два хода и нужно вставлять обе картинки.
 */

async function findDiagramZones(pdfBytes) {
  const lines = await getPdfPageLinesWithPos(pdfBytes);
  if (!lines.length) return null;
  const pageHeight = lines[0].pageHeight || LETTERHEAD_PAGE.height;

  const find = (re) => lines.find((l) => re.test(l.text));
  // pdf.js даёт Y снизу страницы вверх (l.y — базовая линия текста, l.h —
  // приблизительная высота символов) — переводим в "расстояние от верха
  // страницы" (та же система координат, что и DIAGRAM_BOX/canvas).
  const topFromPageTop = (l) => pageHeight - (l.y + l.h);
  const bottomFromPageTop = (l) => pageHeight - l.y;

  const headingRed = find(/Общий\s+вид\s+теплообменника/i);
  const headingGreen = find(/Компоновка\s+пластин/i);
  let attention = find(/ВНИМАНИЕ/i);
  // Подстраховка: на некоторых бланках (например ТOР-41-2х БГВ, моноблок)
  // повёрнутая надпись "ВНИМАНИЕ: ..." под картинкой "Общий вид" закодирована
  // "битым" шрифтом и в текстовом слое PDF не читается вовсе (pdf.js её не
  // находит) — тогда нижней границей красной зоны берём верх заголовка
  // "Компоновка пластин" (если он есть — у моноблоков и других многоходовых
  // моделей он есть всегда) вместо отсутствующей метки.
  if (!attention && headingGreen) attention = headingGreen;
  if (!headingRed || !attention) return null; // не нашли меток — вызывающий код сам откатится на старую фиксированную рамку

  const pad = 2; // небольшой запас, чтобы не обрезать рамку/подписи впритык
  const red = {
    yFrac0: Math.max(0, (bottomFromPageTop(headingRed) + pad) / pageHeight),
    yFrac1: Math.min(1, (topFromPageTop(attention) - pad) / pageHeight),
  };
  if (red.yFrac1 <= red.yFrac0) return null; // защита от абсурдных координат

  let green = null;
  if (headingGreen) {
    const executorLine = find(/Расч[её]т\s+выполнил/i);
    // Если подпись "Расчёт выполнил" не нашлась (мало ли какой бланк) —
    // берём разумный запас по высоте вместо неё, лишь бы не вылезти за
    // страницу целиком.
    const bottomAnchorFromTop = executorLine
      ? topFromPageTop(executorLine) - pad
      : bottomFromPageTop(headingGreen) + 180;
    const g = {
      yFrac0: Math.max(0, (bottomFromPageTop(headingGreen) + pad) / pageHeight),
      yFrac1: Math.min(1, bottomAnchorFromTop / pageHeight),
    };
    if (g.yFrac1 > g.yFrac0) green = g;
  }

  return { red, green };
}
