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
  // w:line="240" w:lineRule="auto" = "одинарный" межстрочный интервал —
  // без этого абзац наследует докдефолт документа (line="276", то есть
  // +15% межстрочного интервала сверху обычного) и текст сертификатов
  // реально занимает заметно больше строк по высоте, чем кажется по
  // номинальному расчёту (см. estimateCertificatesNoteHeightPt в этом же
  // файле — там межстрочный интервал теперь тоже посчитан с поправкой).
  return `<w:p><w:pPr><w:spacing w:after="0" w:before="0" w:line="240" w:lineRule="auto"/><w:jc w:val="left"/></w:pPr>${runs}</w:p>`;
}

// Ширина блока "Примечание" в шаблоне (колонки 4-8 таблицы, минус отступы
// ячейки) — см. build_template.py/gen_docx3.py, XS[-1]-XS[4]=184.25pt,
// margin l=40 r=30 твипов (2pt+1.5pt). Нужна, чтобы ЗАРАНЕЕ (до рендера)
// прикинуть, сколько строк займёт текст сертификатов в этой колонке —
// длинный текст "съедает" часть запаса, который иначе достался бы
// картинке "Компоновка пластин" (см. fillDocxTemplate ниже).
const CERT_NOTE_BOX_WIDTH_PT = 180.75;
const CERT_NOTE_FONT_SIZE_PT = 7.5;
// Номинальный бюджет высоты для текста сертификатов (без заголовка
// "Примечание" и его отступа) — строки r11..r21 шаблона (11×12.6=138.6pt)
// минус место под сам заголовок; с небольшим запасом на неточность оценки.
const CERT_NOTE_BODY_BUDGET_PT = 118;

// Меряет, во сколько строк реально развернётся текст блока "Примечание" в
// его колонке — через canvas (тот же принцип word-wrap, что использует
// Word/LibreOffice), а не через фиксированное число строк, потому что
// длина этого текста разная от расчёта к расчёту (разное число
// сертификатов у заказчика).
function estimateCertificatesNoteHeightPt(text) {
  if (!text) return 0;
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fontPx = (CERT_NOTE_FONT_SIZE_PT * 96) / 72;
    ctx.font = `${fontPx}px "Times New Roman", serif`;
    const boxWidthPx = (CERT_NOTE_BOX_WIDTH_PT * 96) / 72;
    const rawLines = String(text).split('\n');
    let totalLines = 0;
    for (const rawLine of rawLines) {
      if (rawLine.trim() === '') { totalLines += 1; continue; }
      const words = rawLine.split(/\s+/).filter(Boolean);
      let cur = '';
      let linesForThis = 0;
      for (const w of words) {
        const test = cur ? `${cur} ${w}` : w;
        if (cur && ctx.measureText(test).width > boxWidthPx) {
          linesForThis += 1;
          cur = w;
        } else {
          cur = test;
        }
      }
      if (cur) linesForThis += 1;
      totalLines += Math.max(1, linesForThis);
    }
    const lineHeightPt = CERT_NOTE_FONT_SIZE_PT * 1.15;
    return totalLines * lineHeightPt;
  } catch (e) {
    console.warn('Не удалось измерить длину блока "Примечание" — картинка 2 останется на потолке по умолчанию', e);
    return 0;
  }
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
  // уже с запасом проверен в реальном Word (см. историю чата — LibreOffice
  // прощает то, что настоящий Word не прощает, поэтому запас всегда
  // берётся заметно больше нуля).
  //
  // Бюджет картинки "Компоновка пластин" (r23b, появляется только при
  // наличии diagram2Image) — ПЕРЕМЕННЫЙ, не фиксированное число: потолок
  // строки в шаблоне — 125pt (как в оригинале PDF-бланка, та же ширина,
  // что у "Общего вида"), но реально доступное место зависит от того,
  // сколько строк займёт текст блока "Примечание" в ЭТОМ конкретном
  // расчёте (сертификаты — список переменной длины). Раньше здесь стояло
  // фиксированное маленькое число (с большим запасом на случай длинного
  // текста) — из-за этого картинка выходила заметно уже "Общего вида" даже
  // тогда, когда места было полно (пожаловался пользователь: непропорционально,
  // не как в оригинале). Теперь длина текста меряется заранее
  // (estimateCertificatesNoteHeightPt) и картинка ужимается только на
  // столько, на сколько текст реально "съел" запас.
  const TARGET_WIDTH_PT = 530;
  const TARGET_HEIGHT_PT = 240;
  // Целевая высота для картинки 2 больше не должна быть узким местом:
  // после того как cropZoneFromPdf/cropDiagramFromPdf стали обрезать
  // собственную рамку картинки (см. trimBorderFromCanvas в diagramCrop.js),
  // соотношение сторон "Компоновки" даёт высоту ~105-115pt при полной
  // ширине 530pt (как у "Общего вида") — раньше здесь стояло 95pt, из-за
  // чего КАРТИНКА, А НЕ БЮДЖЕТ ТЕКСТА "Примечание", была тем, что мешало
  // картинке 2 стать вровень по ширине с картинкой 1 (жаловался
  // пользователь: "миниатюра"). Потолок строки в шаблоне (r23b, см.
  // gen_docx3.py) поднят вместе с этим значением.
  const NATURAL_TARGET_HEIGHT_PT_2 = 120;
  const MIN_TARGET_HEIGHT_PT_2 = 30;
  const noteHeightPt = estimateCertificatesNoteHeightPt(certificatesNoteText);
  const noteOverflowPt = Math.max(0, noteHeightPt - CERT_NOTE_BODY_BUDGET_PT);
  const TARGET_WIDTH_PT_2 = 530;
  const TARGET_HEIGHT_PT_2 = Math.max(MIN_TARGET_HEIGHT_PT_2, NATURAL_TARGET_HEIGHT_PT_2 - noteOverflowPt);
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

  // ВАЖНО: строки таблицы под картинки (r23/r23b в шаблоне) заданы с
  // ЗАПАСОМ по высоте (248pt/35pt — проверенный безопасный максимум, чтобы
  // при любой картинке гарантированно остаться на 1 странице A4, см.
  // комментарий выше). Но у большинства картинок реальная высота ПОСЛЕ
  // вписывания по ширине (fitSize) заметно меньше этого максимума — если
  // оставить фиксированный запас как есть, вокруг картинки остаётся много
  // пустого места внутри рамки (жаловался пользователь: "не гармонично").
  // Поэтому здесь высота строки в уже отрендеренном документе подгоняется
  // под ФАКТИЧЕСКИЙ размер конкретной картинки — рамка обхватывает картинку
  // плотно, но НИКОГДА не растягивается больше исходного проверенного
  // максимума (только уменьшается), так что безопасность (1 страница)
  // не может пострадать — это исключительно про плотность вёрстки.
  const outZip = doc.getZip();
  let xml = outZip.file('word/document.xml').asText();

  // ВАЖНО: в самом шаблоне абзацы с картинками (d1p/d2p) обнулены через
  // zero_spacing (gen_docx3.py) — но docxtemplater-image-module-free при
  // подстановке {%tag} картинкой пересобирает <w:p>/<w:r> заново и теряет
  // <w:spacing> из исходного <w:pPr> (проверено: остаётся только <w:jc>).
  // Абзац тогда наследует докдефолт документа (interval 1.15 + отступ
  // после абзаца) и после картинки резервируется лишних ~7-8pt — почти всё
  // это ложится СНИЗУ картинки (сама картинка выравнивается по верху своей
  // строки), что и давало заметный зазор до нижней линии рамки ("снизу под
  // картинкой есть много места" — см. историю чата). Возвращаем обнулённый
  // интервал напрямую в уже отрендеренный XML, только для абзацев с
  // <w:drawing> (не задевает остальной документ).
  xml = xml.replace(
    /<w:p><w:pPr><w:jc w:val="center"\/><\/w:pPr><w:r><w:rPr\/><w:drawing>/g,
    '<w:p><w:pPr><w:spacing w:after="0" w:before="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr/><w:drawing>'
  );

  function tightenRowHeight(marker, img, boxWpx, boxHpx, marginPt, minPt, maxTwips) {
    if (!img) return;
    const [, hpx] = fitSize(img, boxWpx, boxHpx);
    const heightPt = (hpx * 72) / 96;
    const desiredPt = Math.max(minPt, heightPt + marginPt);
    const desiredTwips = Math.min(maxTwips, Math.round(desiredPt * 20));
    if (desiredTwips >= maxTwips) return; // уже на максимуме — менять нечего
    const from = `w:trHeight w:val="${maxTwips}" w:hRule="atLeast"`;
    const to = `w:trHeight w:val="${desiredTwips}" w:hRule="atLeast"`;
    if (xml.includes(from)) xml = xml.replace(from, to);
  }

  tightenRowHeight('diagram1', diagramImage, TARGET_WIDTH_PX, TARGET_HEIGHT_PX, 16, 60, 4961);
  if (hasDiagram2) {
    // marginPt уменьшен (10 -> 6): раньше запас держали и под возможную
    // рамку картинки, и под погрешность вписывания — рамки у картинки
    // больше нет (trimBorderFromCanvas), так что содержимое можно подвести
    // почти вплотную к линии таблицы снизу, как просил пользователь
    // ("чтобы совпала линия картинки и линия блока внизу"). maxTwips поднят
    // вместе с потолком строки r23b в шаблоне (125pt -> 145pt).
    tightenRowHeight('diagram2', diagram2Image, TARGET_WIDTH_PX_2, TARGET_HEIGHT_PX_2, 6, 24, 2900);
  }
  outZip.file('word/document.xml', xml);

  return outZip.generate({ type: 'uint8array', compression: 'DEFLATE',
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
