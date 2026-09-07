/*
 * docxTemplate.js
 *
 * Заполнение бланка через мастер-шаблон Word (templates/BSI-letterhead-
 * template.docx) — пришло на смену пиксельному оверлею на PDF
 * (js/pdfTemplate.js, js/builtinPdfMapping.js): тот подход держался на
 * допущении, что заводской плейсхолдер в исходном PDF всегда стоит
 * пиксель-в-пиксель на одном месте — на практике разные экспорты/сканы
 * бланка чуть-чуть отличались, и redact-прямоугольник либо промахивался,
 * либо старый текст проступал из-под нового (см. обсуждение в чате).
 *
 * Здесь вместо оверлея — свой собственный Word-документ (templates/BSI-
 * letterhead-template.docx, тот же шрифт/разметка таблицы, что и у
 * настоящего бланка, см. историю чата), с плейсхолдерами {tag} — их
 * заполняет docxtemplater (vendor/docxtemplater.min.js + vendor/pizzip.min.js).
 * Картинка теплообменника ({%diagram_image}) подставляется отдельным
 * образом (docxtemplater-image-module-free) — байты картинки вырезаются
 * на лету из загруженного PDF-бланка через pdf.js (см. cropDiagramFromPdf
 * в app.js), без готовых картинок под каждую модель.
 *
 * Блок "Примечание" ({@certificates_note}) — это RAW XML тег (встроенный
 * в docxtemplater rawxml-модуль, префикс "@", отдельный пакет не нужен):
 * подставляем не обычный текст, а несколько <w:r>...</w:r> с <w:br/> между
 * ними — по одной строке пользовательского текста на разрыв, иначе перевод
 * строки внутри обычного {tag} потерялся бы.
 */

let cachedDocxTemplateBytes = null;
async function getDocxTemplateBytes(file) {
  const key = file || 'templates/BSI-letterhead-template.docx';
  if (!cachedDocxTemplateBytes || cachedDocxTemplateBytes.file !== key) {
    const resp = await fetch(key);
    if (!resp.ok) throw new Error(`Не удалось загрузить Word-шаблон ${key}`);
    cachedDocxTemplateBytes = { file: key, bytes: await resp.arrayBuffer() };
  }
  return cachedDocxTemplateBytes.bytes;
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Собирает RAW XML для блока "Примечание": одна строка текста -> один
// <w:r> с текстом, между строками — <w:br/> (перенос строки БЕЗ начала
// нового абзаца — абзац в шаблоне уже один, только он должен остаться
// единственным содержимым, как того требует rawxml-модуль докстемплейтера).
//
// ВАЖНО: rawxml-модуль докстемплейтера подставляет эту строку ВМЕСТО всего
// абзаца {@tag} целиком (включая сам <w:p>), а не только вместо текста
// внутри него — если не обернуть содержимое в свой <w:p>, получившиеся
// <w:r> окажутся прямыми детьми <w:tc> (вне какого-либо абзаца), что
// невалидно по схеме OOXML: Word/LibreOffice такие "осиротевшие" runs
// молча отбрасывают при рендере (именно так пропадал текст блока
// "Примечание" — сырой XML в document.xml был, а в PDF ничего не было).
function buildCertificatesRawXml(text, { fontSize = 7.5, colorHex = '00008C', font = 'Times New Roman' } = {}) {
  const lines = String(text || '').split('\n');
  const szHalfPoints = Math.round(fontSize * 2); // OOXML w:sz — в половинах пункта
  const rPr = `<w:rPr><w:rFonts w:ascii="${font}" w:eastAsia="${font}" w:hAnsi="${font}"/><w:color w:val="${colorHex}"/><w:sz w:val="${szHalfPoints}"/><w:szCs w:val="${szHalfPoints}"/></w:rPr>`;
  const runs = lines
    .map((line) => `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r>`)
    .join('<w:br/>');
  return `<w:p><w:pPr><w:spacing w:after="0"/><w:jc w:val="left"/></w:pPr>${runs}</w:p>`;
}

/**
 * @param {ArrayBuffer} templateBytes - байты мастер-шаблона (.docx)
 * @param {object} values - { tag: string } - обычные текстовые поля
 * @param {string} certificatesNoteText - сырой текст блока "Примечание" (с \n)
 * @param {{bytes: Uint8Array, widthPx: number, heightPx: number}|null} diagramImage -
 *   картинка "Общий вид теплообменника" (уже вырезанная в PNG) + её
 *   пиксельные размеры; null — если картинки нет
 * @param {{bytes: Uint8Array, widthPx: number, heightPx: number}|null} [diagram2Image] -
 *   картинка "Компоновка пластин в теплообменнике" — только у многоходовых
 *   моделей (2х, 2хЦ, 3х и т.п.); null/undefined — блок в документе не
 *   появится вовсе (заголовок + место под картинку не занимают места).
 * @returns {Promise<Uint8Array>}
 */
async function fillDocxTemplate(templateBytes, values, certificatesNoteText, diagramImage, diagram2Image) {
  if (!diagramImage || !diagramImage.bytes || !diagramImage.bytes.length) {
    throw new Error('Нет картинки теплообменника — сначала загрузите бланк с картинкой (см. шаг 1) или дождитесь автовырезки.');
  }
  const zip = new PizZip(templateBytes);

  // Целевая ширина картинки — вровень с шириной ячейки в шаблоне (538.58pt,
  // см. builtinPdfMapping.js LETTERHEAD_PAGE/константы верстки) переведённая
  // в пиксели при 96 dpi (стандарт OOXML: 1px = 9525 EMU = 1/96 дюйма).
  //
  // ВАЖНО: картинка всегда вписывается В ОБЕ стороны (по ширине И по
  // высоте, с сохранением пропорций), в отведённый под неё бюджет по
  // высоте — это гарантирует, что документ остаётся на одном листе A4 при
  // любой картинке. Бюджет картинки "Общий вид" (r23 в шаблоне) — 248pt,
  // бюджет "Компоновка пластин" (r23b, появляется только при наличии
  // diagram2Image) — 70pt; оба уже с запасом проверены в реальном Word
  // (см. историю чата — LibreOffice прощает то, что настоящий Word не
  // прощает, поэтому запас всегда берётся заметно больше нуля).
  const TARGET_WIDTH_PT = 530;
  const TARGET_HEIGHT_PT = 240;
  const TARGET_WIDTH_PT_2 = 530;
  const TARGET_HEIGHT_PT_2 = 32;
  const TARGET_WIDTH_PX = Math.round((TARGET_WIDTH_PT / 72) * 96);
  const TARGET_HEIGHT_PX = Math.round((TARGET_HEIGHT_PT / 72) * 96);
  const TARGET_WIDTH_PX_2 = Math.round((TARGET_WIDTH_PT_2 / 72) * 96);
  const TARGET_HEIGHT_PX_2 = Math.round((TARGET_HEIGHT_PT_2 / 72) * 96);

  function fitSize(img, boxWpx, boxHpx) {
    if (!img.widthPx || !img.heightPx) return [boxWpx, Math.round(boxWpx * 0.46)];
    const scale = Math.min(boxWpx / img.widthPx, boxHpx / img.heightPx);
    return [Math.round(img.widthPx * scale), Math.round(img.heightPx * scale)];
  }

  // ВАЖНО: значение тега {%diagram_image}/{%diagram2_image} должно быть
  // чем-то отличным от "object" (docxtemplater-image-module-free трактует
  // объект/массив в значении тега как уже готовый {rId, sizePixel} — то
  // есть считает, что картинка уже вставлена, и падает на sizePixel[0]).
  // Поэтому в данные кладём просто маркер-строку, а сами байты картинки
  // достаём из замыкания внутри getImage — второй параметр (part.value,
  // имя тега) говорит, какую из двух картинок сейчас подставляет модуль.
  const imageModule = new ImageModule({
    centered: true,
    fileType: 'docx',
    getImage(tagValue, tagName) {
      if (tagName === 'diagram2_image') return diagram2Image.bytes;
      return diagramImage.bytes;
    },
    getSize(imgBuffer, tagValue, tagName) {
      if (tagName === 'diagram2_image') return fitSize(diagram2Image, TARGET_WIDTH_PX_2, TARGET_HEIGHT_PX_2);
      return fitSize(diagramImage, TARGET_WIDTH_PX, TARGET_HEIGHT_PX);
    },
  });

  // ВАЖНО: без своего nullGetter докстемплейтер по умолчанию подставляет
  // ЛИТЕРАЛЬНУЮ строку "undefined" вместо пустого поля (см.
  // vendor/docxtemplater.min.js: nullGetter:function(e){return e.module?"":"undefined"})
  // — если сотрудник не заполнил необязательное поле (адрес, цену, габариты
  // и т.п.), в готовом документе вместо пустой ячейки печаталось бы слово
  // "undefined". Отдаём пустую строку для любого отсутствующего/пустого тега.
  const doc = new docxtemplater(zip, {
    modules: [imageModule],
    paragraphLoop: true,
    linebreaks: false,
    nullGetter: () => '',
  });

  const hasDiagram2 = !!(diagram2Image && diagram2Image.bytes && diagram2Image.bytes.length);

  const data = { ...values };
  data.certificates_note = buildCertificatesRawXml(certificatesNoteText);
  data.diagram_image = 'diagram';
  data.has_diagram2 = hasDiagram2;
  if (hasDiagram2) data.diagram2_image = 'diagram2';

  doc.render(data);

  return doc.getZip().generate({ type: 'uint8array', compression: 'DEFLATE',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

function downloadDocxBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
