/*
 * app.js — склейка UI: загрузка PDF-бланка + разбор спецификации,
 * форма полей, генерация Word-документа, запись в журнал.
 *
 * Приложение универсально: сотрудник ВСЕГДА сам загружает PDF фирменного
 * бланка нужной модели (шаг 1) — координаты полей и раскладка одни и те же
 * для всей линейки бланков БСИ этого вида (см. builtinPdfMapping.js), а
 * марка/исполнение теплообменника распознаются прямо из текста этого PDF
 * (modelExtract.js), без единого "зашитого" шаблона по умолчанию. Под
 * другой тип/линейку бланков в будущем потребуется отдельная настройка
 * координат — это вне рамок текущей версии.
 */

// Мастер-шаблоны Word — обычный (1х/2хЦ/3х) и моноблок (2хБГВ/3хБГВ, см.
// TEMPLATES[1] в fieldMap.js). Путь к обычному не хранится в TEMPLATES[0]
// (там лежит легаси .vsdx для старого способа) — держим отдельной константой.
const NORMAL_LETTERHEAD_DOCX = 'templates/BSI-letterhead-template.docx';
const MONOBLOCK_TEMPLATE_ID = 'tor-monoblock-2xbgv';

let currentTemplate = null;
let currentFieldValues = {}; // key -> string (то, что реально попадёт в документ)
let currentDebugMatches = [];

let customTplBytes = null;   // ArrayBuffer исходного PDF-бланка как есть
let customTplHash = null;
let customTplFileName = null;
let customTplOffsetXFrac = 0;
let customTplOffsetYFrac = 0;
// Высота окна вырезки картинки (доля высоты страницы) — по умолчанию родная
// высота DIAGRAM_BOX (см. diagramCrop.js). У некоторых моделей (многоходовые
// — 2х, 2хЦ, 3х и т.п.) в бланке под основной картинкой сразу идёт ещё одна
// схема ("Компоновка пластин"), которая может частично попасть в кадр —
// сотрудник уменьшает это значение в форме, чтобы обрезать вырезку выше
// лишнего содержимого (см. поле "Высота картинки, мм").
let customTplCropHeightFrac = DIAGRAM_BOX_DEFAULT_HEIGHT_FRAC;

const PT_PER_MM = 2.8346456693;
const mmToXFrac = (mm) => (Number(mm) || 0) * PT_PER_MM / LETTERHEAD_PAGE.width;
const mmToYFrac = (mm) => (Number(mm) || 0) * PT_PER_MM / LETTERHEAD_PAGE.height;
const xFracToMm = (frac) => (frac * LETTERHEAD_PAGE.width) / PT_PER_MM;
const yFracToMm = (frac) => (frac * LETTERHEAD_PAGE.height) / PT_PER_MM;

const el = (id) => document.getElementById(id);

// Блок "Примечание" (сертификаты и т.п.) заранее заполняется текстом —
// чтобы пользователь мог его сразу проверить и, если нужно, поправить, а не
// начинать с пустого поля. По просьбе пользователя текст каждый раз
// забирается из САМОГО загруженного PDF-бланка (extractCertificatesTextFromPdf,
// modelExtract.js) — а не подставляется один и тот же образец для любого
// файла: у разных бланков номер/дата сертификата и формулировки могут
// отличаться. Пока PDF ещё читается (или если в его области ничего не
// нашлось — нестандартный бланк), полем остаётся текст-образец
// (DEFAULT_CERTIFICATES_TEXT, builtinPdfMapping.js) как запасной вариант.
function applyDefaultFieldValues(fields) {
  currentFieldValues = {};
  if (fields.some((f) => f.key === 'certificates_note')) {
    currentFieldValues['certificates_note'] = DEFAULT_CERTIFICATES_TEXT;
  }
}

// Пытается заменить текст-образец в certificates_note на текст, реально
// напечатанный в этой области на загруженном PDF-бланке (customTplBytes).
// Вызывается ПОСЛЕ applyDefaultFieldValues (тот уже поставил образец как
// подстраховку) — если извлечение ничего не нашло/не удалось, образец
// так и остаётся. Ничего не делает, если у текущего набора полей нет
// certificates_note (шаблон без этого блока) или PDF-бланк ещё не загружен.
async function refreshCertificatesFromPdf(fields) {
  if (!fields.some((f) => f.key === 'certificates_note')) return;
  if (!customTplBytes) return;
  try {
    const extracted = await extractCertificatesTextFromPdf(customTplBytes);
    if (extracted) currentFieldValues['certificates_note'] = extracted;
  } catch (e) {
    console.warn('Не удалось обновить блок "Примечание" из PDF-бланка', e);
  }
}

/* ---------------- Загрузка своего бланка (самообслуживание, без разметки) ---------------- */
//
// Раньше здесь был мастер разметки — инженер кликал мышкой по каждому из
// ~26 полей на КАЖДОМ новом файле. От этого отказались: у всей линейки
// фирменных бланков БСИ одна и та же табличная разметка, меняется только
// картинка теплообменника и марка/размеры в тексте — поэтому координаты,
// один раз снятые с образца (js/builtinPdfMapping.js, LETTERHEAD_FIELDS),
// применяются к любому новому бланку этого вида сразу, без единого клика.
//
// Подстраховка на случай, если у конкретного файла вёрстка всё же чуть-чуть
// отличается (другой экспорт из Word/CorelDraw, другие поля страницы и
// т.п.): кнопка "Проверить совмещение" формирует тестовый PDF с заметными
// значениями во всех полях, а два числа "сдвиг по X/Y" (в мм) позволяют
// один раз поправить общее смещение — оно запоминается в этом браузере по
// хэшу файла, как и раньше с разметкой.

function initCustomTemplateUpload() {
  el('customTplInput').addEventListener('change', () => {
    const file = el('customTplInput').files[0];
    if (file) handleCustomTplUpload(file);
  });
  el('offsetXInput').addEventListener('input', readOffsetInputs);
  el('offsetYInput').addEventListener('input', readOffsetInputs);
  el('cropHeightInput').addEventListener('input', readOffsetInputs);
  el('btnCheckAlignment').addEventListener('click', handleUpdateDiagramPreview);
}

function readOffsetInputs() {
  customTplOffsetXFrac = mmToXFrac(el('offsetXInput').value);
  customTplOffsetYFrac = mmToYFrac(el('offsetYInput').value);
  const cropHeightMm = parseFloat(el('cropHeightInput').value);
  customTplCropHeightFrac = (Number.isFinite(cropHeightMm) && cropHeightMm > 0)
    ? mmToYFrac(cropHeightMm)
    : DIAGRAM_BOX_DEFAULT_HEIGHT_FRAC;
  if (customTplHash) {
    saveLetterheadOffset(customTplHash, customTplFileName, customTplOffsetXFrac, customTplOffsetYFrac, customTplCropHeightFrac);
  }
}

async function handleCustomTplUpload(file) {
  setStatus('customTplStatus', `Читаю файл ${file.name}...`);
  try {
    const buf = await file.arrayBuffer();
    const hash = await sha256Hex(buf);
    customTplBytes = buf;
    customTplHash = hash;
    customTplFileName = file.name;

    // Режим (обычный/моноблок) окончательно определяется только после
    // разбора спецификации (is_monoblock, см. beltoParser.js/extract.js) —
    // на этапе загрузки бланка ставим обычный шаблон по умолчанию, а
    // handleFile переключит его на монобблочный, если понадобится (см. ниже).
    currentTemplate = { id: 'custom-letterhead', title: file.name, fields: TEMPLATES[0].fields, docxFile: NORMAL_LETTERHEAD_DOCX, mode: 'normal' };
    applyDefaultFieldValues(currentTemplate.fields);
    await refreshCertificatesFromPdf(currentTemplate.fields);
    renderForm();
    el('formSection').style.display = '';
    el('actionsSection').style.display = '';
    el('customTplActions').style.display = '';

    const existing = loadLetterheadOffset(hash);
    customTplOffsetXFrac = existing ? existing.offsetXFrac : 0;
    customTplOffsetYFrac = existing ? existing.offsetYFrac : 0;
    customTplCropHeightFrac = (existing && existing.cropHeightFrac) ? existing.cropHeightFrac : DIAGRAM_BOX_DEFAULT_HEIGHT_FRAC;
    el('offsetXInput').value = xFracToMm(customTplOffsetXFrac).toFixed(1);
    el('offsetYInput').value = yFracToMm(customTplOffsetYFrac).toFixed(1);
    el('cropHeightInput').value = yFracToMm(customTplCropHeightFrac).toFixed(1);

    setStatus(
      'customTplStatus',
      existing
        ? `Бланк «${file.name}» уже открывали в этом браузере (сдвиг ${(existing.offsetXFrac || existing.offsetYFrac) ? 'сохранён' : 'не потребовался'}) — можно заполнять поля и генерировать Word.`
        : `Бланк «${file.name}» загружен — можно заполнять поля и генерировать Word. Ниже показано превью вырезанной картинки теплообменника — если она съехала, поправьте сдвиг.`,
      'ok'
    );
    await handleUpdateDiagramPreview();
  } catch (err) {
    console.error(err);
    setStatus('customTplStatus', 'Не удалось прочитать PDF: ' + err.message, 'err');
  }
}

// Вырезает картинку(и) теплообменника из загруженного PDF-бланка.
// Сначала пробуем найти зоны "Общий вид" / "Компоновка пластин" по
// текстовым меткам (findDiagramZones — diagramZones.js): это даёт две
// отдельные картинки, без текста "Расчёт выполнил" (он дублировал бы наш
// собственный футер) и без гадания процентом от страницы для КАЖДОГО
// конкретного файла. Если меток не нашлось (нестандартный бланк) —
// откатываемся на старый способ: один кадр фиксированного окна с ручной
// поправкой высоты ("Высота картинки, мм").
async function getDiagramCrops(pdfBytes, offsetXFrac, offsetYFrac, cropHeightFrac) {
  let zones = null;
  try {
    zones = await findDiagramZones(pdfBytes);
  } catch (e) {
    console.warn('Не удалось определить зоны картинок по тексту PDF', e);
  }

  if (zones && zones.red) {
    const diagram1 = await cropZoneFromPdf(pdfBytes, zones.red, offsetXFrac);
    const diagram2 = zones.green ? await cropZoneFromPdf(pdfBytes, zones.green, offsetXFrac) : null;
    return { diagram1, diagram2, autoDetected: true };
  }

  const diagram1 = await cropDiagramFromPdf(pdfBytes, offsetXFrac, offsetYFrac, cropHeightFrac);
  return { diagram1, diagram2: null, autoDetected: false };
}

// Показывает вырезанную из загруженного PDF картинку(и) теплообменника
// прямо в форме (вместо старого способа — скачивать отдельный "тестовый
// PDF" и сверять руками) — это и есть самопроверка перед генерацией
// настоящего документа: если картинка на превью съехала (обрезаны
// патрубки/подписи), сотрудник сам поправит "сдвиг по X/Y" и нажмёт
// "Обновить превью" ещё раз.
async function handleUpdateDiagramPreview() {
  if (!customTplBytes) {
    setStatus('diagramPreviewStatus', 'Сначала загрузите бланк.', 'err');
    return;
  }
  readOffsetInputs();
  setStatus('diagramPreviewStatus', 'Вырезаю картинку из PDF...');
  try {
    const { diagram1, diagram2, autoDetected } = await getDiagramCrops(
      customTplBytes, customTplOffsetXFrac, customTplOffsetYFrac, customTplCropHeightFrac
    );
    const key = `custom:${customTplHash}:${customTplOffsetXFrac}:${customTplOffsetYFrac}:${customTplCropHeightFrac}`;
    cachedDiagramCrop = { key, diagram1, diagram2 };

    showPreviewImage('diagramPreviewImg', diagram1);
    el('diagramPreviewLabel1').style.display = autoDetected ? '' : 'none';
    if (diagram2) {
      showPreviewImage('diagramPreviewImg2', diagram2);
      el('diagramPreviewLabel2').style.display = '';
    } else {
      hidePreviewImage('diagramPreviewImg2');
      el('diagramPreviewLabel2').style.display = 'none';
    }

    setStatus(
      'diagramPreviewStatus',
      autoDetected
        ? (diagram2
          ? 'Готово — найдены обе зоны («Общий вид» и «Компоновка пластин»). Сверьте с образцом.'
          : 'Готово — найдена зона «Общий вид» (у этой модели «Компоновка пластин» не обнаружена — один ход). Сверьте с образцом.')
        : 'Готово (подписи на бланке не распознались — использован запасной способ вырезки по фиксированному окну). Если патрубки/подписи обрезаны, поправьте сдвиг/высоту и нажмите ещё раз.',
      'ok'
    );
  } catch (err) {
    console.error(err);
    setStatus('diagramPreviewStatus', 'Ошибка вырезки картинки: ' + err.message, 'err');
  }
}

function showPreviewImage(imgId, crop) {
  const blob = new Blob([crop.bytes], { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  const img = el(imgId);
  if (img.dataset.prevUrl) URL.revokeObjectURL(img.dataset.prevUrl);
  img.src = url;
  img.dataset.prevUrl = url;
  img.style.display = '';
}

function hidePreviewImage(imgId) {
  const img = el(imgId);
  if (img.dataset.prevUrl) { URL.revokeObjectURL(img.dataset.prevUrl); img.dataset.prevUrl = ''; }
  img.src = '';
  img.style.display = 'none';
}

function setStatus(elId, text, kind) {
  const node = el(elId);
  node.textContent = text || '';
  node.className = 'status-line' + (kind ? ' ' + kind : '');
}

/* ---------------- Загрузка и разбор файла ---------------- */

function initDropzone() {
  const dz = el('dropzone');
  const input = el('fileInput');
  dz.addEventListener('click', () => input.click());
  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); })
  );
  dz.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  input.addEventListener('change', () => {
    if (input.files[0]) handleFile(input.files[0]);
  });
}

// Марка/исполнение теплообменника (например "ТОР-15М/13" + "1х") — берутся
// из текстового слоя PDF-бланка (см. modelExtract.js), а не хардкодятся,
// чтобы то же самое приложение правильно работало и со "своим бланком"
// другой модели. Кэшируем по источнику бланка, чтобы не парсить PDF заново
// при каждой загрузке спецификации, если бланк не менялся.
let cachedModelParts = null; // { key, parts }

async function getModelPartsForCurrentTemplate() {
  if (!customTplBytes) return null;
  try {
    const key = `custom:${customTplHash}`;
    if (cachedModelParts && cachedModelParts.key === key) return cachedModelParts.parts;
    const parts = await extractModelPartsFromPdf(customTplBytes);
    cachedModelParts = { key, parts };
    return parts;
  } catch (e) {
    console.warn('Не удалось определить марку/исполнение из бланка', e);
    return null;
  }
}

async function handleFile(file) {
  if (!customTplBytes) {
    setStatus('parseStatus', 'Сначала загрузите PDF бланка (шаг 1) — без него не из чего распознать марку/исполнение и картинку теплообменника.', 'err');
    return;
  }
  setStatus('parseStatus', `Обрабатываю файл: ${file.name}...`);
  el('debugDetails').style.display = 'none';
  try {
    const { text, method, structured } = await extractTextFromFile(file, (msg) => setStatus('parseStatus', msg));
    const { values, debugMatches } = parseBeltoText(text);
    currentDebugMatches = debugMatches;

    // Для HTML-отчёта (метод 'html-table') structured — точный разбор по
    // ячейкам (среда, единицы измерения, см. extract.js) — сильнее общего
    // построчного regex-разбора выше, где многословные названия ("Пар
    // водяной", "Пропиленгликоль 40%") надёжно не разделить. Накладываем
    // поверх, не перетирая уже найденное построчным разбором, если по
    // ячейкам что-то не нашлось.
    if (structured) {
      Object.keys(structured).forEach((k) => {
        if (structured[k]) values[k] = structured[k];
      });
    }

    // МОНОБЛОК (2хБГВ/3хБГВ): спецификация "МоноБлок" опознаётся автоматически
    // (is_monoblock, см. beltoParser.js/extract.js) — переключаем шаблон формы
    // и мастер-документ Word на монобблочный набор полей (4 столбца по ступеням,
    // 6 патрубков). Если сотрудник загрузил спецификацию МоноБлок, но нужного
    // шаблона нет (не должно случиться — он один и универсальный) — остаёмся
    // на обычном наборе полей и просто предупреждаем в статусе ниже.
    const wantMonoblock = !!values.is_monoblock;
    const monoblockTemplate = getTemplateById(MONOBLOCK_TEMPLATE_ID);
    if (wantMonoblock && monoblockTemplate && currentTemplate.mode !== 'monoblock') {
      currentTemplate.fields = monoblockTemplate.fields;
      currentTemplate.docxFile = monoblockTemplate.file;
      currentTemplate.mode = 'monoblock';
      applyDefaultFieldValues(currentTemplate.fields);
      await refreshCertificatesFromPdf(currentTemplate.fields);
    } else if (!wantMonoblock && currentTemplate.mode !== 'normal') {
      currentTemplate.fields = TEMPLATES[0].fields;
      currentTemplate.docxFile = NORMAL_LETTERHEAD_DOCX;
      currentTemplate.mode = 'normal';
      applyDefaultFieldValues(currentTemplate.fields);
      await refreshCertificatesFromPdf(currentTemplate.fields);
    }
    if (wantMonoblock) deriveMonoblockValues(values);

    // Марка (база) и исполнение — из PDF-бланка, а не из спецификации и не
    // из зашитого значения по умолчанию. Если строку не удалось распознать
    // (нестандартное форматирование бланка) — поля остаются пустыми, и
    // сотрудника явно предупреждаем ниже, чтобы он заполнил их вручную.
    const modelParts = await getModelPartsForCurrentTemplate();
    if (modelParts) {
      values.model_base = modelParts.base;
      values.model_execution = modelParts.execution;
      currentFieldValues['title_model'] = modelParts.base;
    } else {
      currentFieldValues['title_model'] = '';
    }

    applyParsedValues(values);
    resolveDynamicUnits(values);
    // Новая спецификация — это НОВЫЙ расчёт, поэтому номер предыдущего
    // расчёта (если он остался в поле с прошлой загрузки в этой же сессии)
    // сбрасываем, чтобы suggestNextCalcNumber ниже предложил свежий номер
    // из журнала, а не молча оставил старый (иначе подсказка сработает
    // только один раз за сессию — при самой первой загрузке).
    currentFieldValues['calc_number'] = '';
    renderForm();
    // Автономер расчёта — не блокирует отображение формы (запрос в фоне,
    // см. suggestNextCalcNumber): если из журнала придёт следующий номер,
    // поле "Номер расчёта" перерисуется с уже подставленным значением.
    suggestNextCalcNumber();

    const methodLabel = method === 'html-table'
      ? 'разбор HTML-таблицы, точно, без OCR'
      : method === 'pdf-text'
        ? 'текстовый слой PDF'
        : 'OCR-распознавание';
    const checkHint = method === 'html-table' ? '' : ' — особенно после OCR';
    let statusMsg = `Готово (${methodLabel}). Проверьте поля ниже перед генерацией${checkHint}.`;
    if (wantMonoblock) {
      statusMsg += ' Определён МОНОБЛОК (2хБГВ/3хБГВ) — форма и шаблон переключены на вариант с двумя ступенями.';
    }
    if (!modelParts) {
      statusMsg += ' ⚠ Не удалось распознать марку и исполнение теплообменника в PDF-бланке — заполните поле «Марка теплообменника» и проверьте заголовок документа вручную.';
    }
    setStatus('parseStatus', statusMsg, modelParts ? 'ok' : 'err');
    el('debugDetails').style.display = '';
    el('debugBox').textContent = debugMatches.length
      ? debugMatches.map((m) => `[${m.keys.join(', ')}] <- "${m.line}"`).join('\n')
      : 'Не удалось распознать ни одной известной строки. Проверьте текст вручную или введите значения в форму сами.\n\n--- Сырой текст ---\n' + text.slice(0, 4000);

    el('formSection').style.display = '';
    el('actionsSection').style.display = '';
    // Новая спецификация загружена — предыдущий результат генерации больше
    // не актуален, скрываем кнопку "Добавить в журнал" до следующей генерации.
    lastGeneratedLogFormat = null;
    const journalBtn = el('btnAddToJournal');
    if (journalBtn) journalBtn.style.display = 'none';
    setStatus('journalStatus', '');
  } catch (err) {
    console.error(err);
    setStatus('parseStatus', 'Ошибка распознавания: ' + err.message, 'err');
  }
}

// Единицы измерения "Ед.изм" в готовом документе — раньше были зашиты в
// шаблон (Гкал/ч, т/ч, кг/см2), теперь переносятся из спецификации, как и
// сами числа (см. историю чата — пользователь явно попросил перенос единиц
// "по такому же принципу как цифрами"). Если единицу в конкретной
// спецификации распознать не удалось (например источник — PDF/скан без
// чёткой структуры ячеек) — используется прежнее значение по умолчанию, то
// есть поведение НЕ ухудшается по сравнению с тем, что было раньше.
const UNIT_FALLBACKS = { heat_load_unit: 'Гкал/ч', flow_unit: 'т/ч', dp_unit: 'кг/см2' };

function resolveDynamicUnits(sourceValues) {
  currentFieldValues.heat_load_unit = sourceValues.heat_load_unit || UNIT_FALLBACKS.heat_load_unit;
  currentFieldValues.flow_unit = sourceValues.flow_unit || UNIT_FALLBACKS.flow_unit;

  const dpu = String(sourceValues.dp_unit || '').toLowerCase();
  if (!dpu) {
    currentFieldValues.dp_unit = UNIT_FALLBACKS.dp_unit; // как раньше: считаем кПа и конвертируем
  } else if (/кпа|kpa|бар|bar|кгс?\s*\/?\s*см\s*2/.test(dpu)) {
    currentFieldValues.dp_unit = 'кг/см2'; // опознали -> convertDpToKgfCm2 реально сконвертировал
  } else {
    currentFieldValues.dp_unit = sourceValues.dp_unit; // незнакомая единица — конвертации не было, подписываем как в спецификации
  }

  // МОНОБЛОК: "Тепловая нагрузка отопления" — поле ручного ввода (в
  // спецификации её нет), но единица измерения для неё — своя, РЕДАКТИРУЕМАЯ
  // (может понадобиться кВт/МВт/ккал/ч, а не тот же Гкал/ч, что у нагрузки
  // ГВС). Подставляем разумное значение по умолчанию (ту же единицу, что у
  // ГВС) только один раз — если сотрудник уже поменял её в форме, повторный
  // разбор спецификации (например другой файл) это значение не затирает.
  if (!currentFieldValues.heat_load_heating_unit) {
    currentFieldValues.heat_load_heating_unit = currentFieldValues.heat_load_unit;
  }
}

function applyParsedValues(sourceValues) {
  if (!currentTemplate) return;
  currentTemplate.fields.forEach((f) => {
    if (f.group !== 'auto') return;
    let raw = null;
    // Некоторые поля (например марка теплообменника) собираются из
    // нескольких source-ключей сразу, а не берутся напрямую — для этого
    // у поля может быть задана функция compute(sourceValues).
    if (typeof f.compute === 'function') {
      try {
        raw = f.compute(sourceValues);
      } catch (e) {
        console.warn('Ошибка compute() для поля', f.key, e);
        raw = null;
      }
    }
    if (raw === null || raw === undefined || raw === '') {
      for (const sk of f.sourceKeys) {
        if (sourceValues[sk] !== undefined && sourceValues[sk] !== null && sourceValues[sk] !== '') {
          raw = sourceValues[sk];
          break;
        }
      }
    }
    if (raw === null || raw === undefined || raw === '') return;
    let value;
    if (f.convert) {
      // convert может быть именем готового конвертера из units.js (строка)
      // ИЛИ функцией (raw, sourceValues) => число — второе нужно для полей,
      // где правильный способ конвертации зависит от того, какая единица
      // измерения реально стоит в спецификации (например потери давления —
      // см. dp_hot/dp_cold в fieldMap.js), а не всегда одна и та же.
      const converted = typeof f.convert === 'function'
        ? f.convert(raw, sourceValues)
        : convertValue(raw, f.convert);
      value = converted === null ? String(raw) : (f.decimals !== undefined ? formatFixed(converted, f.decimals) : formatNumber(converted, 3));
    } else if (typeof raw === 'number') {
      value = f.decimals !== undefined ? formatFixed(raw, f.decimals) : formatNumber(raw, 3);
    } else {
      value = String(raw);
    }
    currentFieldValues[f.key] = value;
  });
}

/* ---------------- Форма ---------------- */

function renderForm() {
  const autoWrap = el('autoFields');
  const manualWrap = el('manualFields');
  autoWrap.innerHTML = '';
  manualWrap.innerHTML = '';
  if (!currentTemplate) return;

  currentTemplate.fields.forEach((f) => {
    const wrap = document.createElement('div');
    wrap.className = 'field ' + f.group + (f.multiline ? ' field-wide' : '');

    const label = document.createElement('label');
    label.textContent = f.label;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = f.group === 'auto' ? 'авто · проверить' : 'вручную';
    label.appendChild(badge);
    wrap.appendChild(label);

    const input = document.createElement(f.multiline ? 'textarea' : 'input');
    if (!f.multiline) input.type = 'text';
    else input.rows = 10;
    input.value = currentFieldValues[f.key] || '';
    input.addEventListener('input', () => { currentFieldValues[f.key] = input.value; });
    // Суммы (цена за шт / общая сумма) — по просьбе пользователя всегда
    // вводятся и переносятся в документ с ровно 2 знаками после точки.
    // Реформатируем значение сразу при уходе фокуса с поля, чтобы инженер
    // видел итоговый вид числа ещё в форме, а не только в готовом документе.
    if (f.key === 'price_unit' || f.key === 'price_total') {
      input.addEventListener('blur', () => {
        const n = parseNumber(input.value);
        if (n !== null) {
          const formatted = formatFixed(n, 2);
          input.value = formatted;
          currentFieldValues[f.key] = formatted;
        }
      });
    }
    wrap.appendChild(input);

    if (f.notes) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = f.notes;
      wrap.appendChild(hint);
    }

    (f.group === 'auto' ? autoWrap : manualWrap).appendChild(wrap);
  });
}

/* ---------------- Генерация Word-документа ---------------- */
//
// Общие значения: ФИО/дата в подписи (две
// разные точки на бланке) и номер расчёта с автоматически дописанным "№ " и
// "/MM-ГГГГ" (закрашиваем и перерисовываем весь "№ ..." целиком — см.
// комментарий у calc_number в builtinPdfMapping.js). Если номер не введён —
// ничего не рисуем и не трогаем исходный "№ --/---2020" с бланка.
// Все теги, которые ждёт Word-шаблон (templates/BSI-letterhead-template.docx) —
// см. полный список в js/docxTemplate.js. Явно перечисляем их здесь и берём
// каждое значение с фолбэком на '', чтобы в документ никогда не попадало
// "undefined" (ни от докстемплейтера, ни от case, когда поле есть в объекте,
// но со значением undefined) — сотрудник мог просто не тронуть необязательное
// поле, это нормально, тогда в ячейке должно остаться пусто.
const LETTERHEAD_VALUE_KEYS = [
  'site', 'customer', 'contact_person', 'contact_info',
  'heat_load', 'temp_graph', 'temp_hot', 'temp_cold', 'flow_hot', 'flow_cold',
  'dp_hot', 'dp_cold', 'plates_count', 'passes_count', 'heat_transfer_coef',
  'surface_margin', 'heat_surface', 'model', 'price_unit', 'price_total',
  'dim_a', 'dim_l', 'mass', 'certificates_note',
  // Единицы измерения — переносятся из спецификации так же, как и сами
  // числа (resolveDynamicUnits), а не зашиты в шаблон навсегда — см.
  // историю чата про тепловую нагрузку, перепутанную с Гкал/ч вместо кВт.
  'heat_load_unit', 'flow_unit', 'dp_unit',
  // Среда по контурам (вода/пар/гликоль и т.п.) — авто из строки "Среда" в
  // спецификации, с возможностью правки в форме (heat_medium_hot/cold).
  'heat_medium_hot', 'heat_medium_cold',
];

// МОНОБЛОК (2хБГВ/3хБГВ) — свой набор тегов (см. templates/BSI-letterhead-
// monoblock-template.docx / gen_docx_monoblock.py): 4 столбца по ступеням
// вместо 2, 6 патрубков вместо 4, плюс поля, которых нет у обычного шаблона
// (нагрузка отопления, температурный график в точке излома).
const MONOBLOCK_VALUE_KEYS = [
  'site', 'customer', 'contact_person', 'contact_info',
  'heat_load_gvs', 'heat_load_heating', 'heat_load_heating_unit', 'temp_graph', 'temp_graph_break',
  'heat_medium_s2_hot', 'heat_medium_s2_cold', 'heat_medium_s1_hot', 'heat_medium_s1_cold',
  'temp_s2_hot', 'temp_s2_cold', 'temp_s1_hot', 'temp_s1_cold',
  'flow_s2_hot', 'flow_s2_cold', 'flow_s1_hot', 'flow_s1_cold',
  'dp_s2_hot', 'dp_s2_cold', 'dp_s1_hot', 'dp_s1_cold',
  'plates_count', 'passes_s2', 'passes_s1',
  'heat_transfer_coef_s2', 'heat_transfer_coef_s1',
  'surface_margin_s2', 'surface_margin_s1',
  'heat_surface',
  'model', 'price_unit', 'price_total', 'dim_a', 'dim_l', 'mass', 'certificates_note',
  'heat_load_unit', 'flow_unit', 'dp_unit',
];

function buildLetterheadValues() {
  const formattedCalcNumber = formatCalcNumber(currentFieldValues['calc_number']);
  const isMonoblock = currentTemplate && currentTemplate.mode === 'monoblock';
  const keys = isMonoblock ? MONOBLOCK_VALUE_KEYS : LETTERHEAD_VALUE_KEYS;
  const values = {};
  keys.forEach((key) => { values[key] = currentFieldValues[key] || ''; });
  // Защитное форматирование сумм — на случай, если поле не потеряло фокус
  // (blur в renderForm) перед генерацией документа: суммы всегда должны
  // попадать в документ с ровно 2 знаками после точки.
  ['price_unit', 'price_total'].forEach((key) => {
    if (values[key]) {
      const n = parseNumber(values[key]);
      if (n !== null) values[key] = formatFixed(n, 2);
    }
  });
  const common = {
    ...values,
    executor_name: (currentFieldValues['executor'] || '').trim(),
    // Дата всегда сегодняшняя на момент формирования документа — не
    // зависит от того, заполнено ли ФИО.
    executor_date: formatTodayDateDMY(),
    calc_number: formattedCalcNumber ? `№ ${formattedCalcNumber}` : '',
    title_model: currentFieldValues['title_model'] || '',
  };
  const dnValue = currentFieldValues['dn'] || '';
  if (isMonoblock) {
    // DN печатается у всех 6 патрубков сразу (Т1,Т2,В1,Т3,Т22,Т4).
    return { ...common, dn_1: dnValue, dn_2: dnValue, dn_3: dnValue, dn_4: dnValue, dn_5: dnValue, dn_6: dnValue };
  }
  // Обычный шаблон: DN у 4 патрубков (Т1/Т2/В1/Т3), см. LETTERHEAD_FIELDS в
  // builtinPdfMapping.js / shapeIds:[7,42,43,45] для .vsdx-варианта.
  return { ...common, dn_1: dnValue, dn_2: dnValue, dn_3: dnValue, dn_4: dnValue };
}

// Кэш вырезанной картинки(картинок) теплообменника — по ключу (файл бланка
// + сдвиг), чтобы не перевырезать их из PDF при каждом клике "Скачать",
// если ничего не поменялось с прошлого раза.
let cachedDiagramCrop = null; // { key, diagram1, diagram2 }

async function handleGenerateCustomDocx() {
  if (!customTplBytes) {
    setStatus('genStatus', 'Сначала загрузите PDF бланка (шаг 1).', 'err');
    return;
  }
  setStatus('genStatus', 'Формирую Word-документ...');
  try {
    readOffsetInputs();
    const values = buildLetterheadValues();
    const key = `custom:${customTplHash}:${customTplOffsetXFrac}:${customTplOffsetYFrac}:${customTplCropHeightFrac}`;
    let diagram1, diagram2;
    if (cachedDiagramCrop && cachedDiagramCrop.key === key) {
      diagram1 = cachedDiagramCrop.diagram1;
      diagram2 = cachedDiagramCrop.diagram2;
    } else {
      const crops = await getDiagramCrops(customTplBytes, customTplOffsetXFrac, customTplOffsetYFrac, customTplCropHeightFrac);
      diagram1 = crops.diagram1;
      diagram2 = crops.diagram2;
      cachedDiagramCrop = { key, diagram1, diagram2 };
    }
    const templateBytes = await getDocxTemplateBytes(currentTemplate.docxFile || NORMAL_LETTERHEAD_DOCX);
    const bytes = await fillDocxTemplate(templateBytes, values, currentFieldValues['certificates_note'] || '', diagram1, diagram2);
    const filename = buildOutputFilename('docx');
    downloadDocxBytes(bytes, filename);
    setStatus('genStatus', `Скачан файл ${filename}`, 'ok');
    // Запись в журнал — не автоматически, а по отдельной кнопке (см.
    // handleAddToJournal): сотрудник сам решает, заносить ли конкретный
    // расчёт (черновики/тесты заносить не нужно). Байты документа
    // запоминаем здесь же — та же кнопка "Добавить в журнал" отправит их
    // в Apps Script, чтобы сохранить сам файл на Google Диске (не только
    // строку в таблице), см. handleAddToJournal.
    lastGeneratedLogFormat = 'docx-custom';
    lastGeneratedDocxBytes = bytes;
    const btn = el('btnAddToJournal');
    if (btn) { btn.style.display = ''; btn.disabled = false; }
    setStatus('journalStatus', '');
  } catch (err) {
    console.error(err);
    setStatus('genStatus', 'Ошибка формирования Word-документа: ' + err.message, 'err');
  }
}

// Заполняется после успешной генерации документа — что именно логировать,
// если сотрудник нажмёт "Добавить в журнал" (кнопка появляется только
// после генерации, см. handleGenerateCustomDocx).
let lastGeneratedLogFormat = null;
// Байты последнего сгенерированного .docx — нужны, чтобы та же кнопка
// "Добавить в журнал" могла отправить сам файл в Apps Script на
// сохранение в Google Диск (см. ниже). Если страницу перезагрузили после
// скачивания (байтов уже нет) — просто не отправляем файл, строка в
// журнал всё равно уходит как раньше.
let lastGeneratedDocxBytes = null;

// Преобразует байты файла в base64 через Blob/FileReader — так надёжнее
// для файлов заметного размера (сотни КБ, из-за встроенной картинки), чем
// btoa(String.fromCharCode(...bytes)): у последнего в некоторых браузерах
// есть предел на число аргументов при "растягивании" большого массива.
function bytesToBase64(bytes) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([bytes]);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const comma = dataUrl.indexOf(',');
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : '');
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Имя файла НА ГУГЛ ДИСКЕ — по просьбе пользователя другое, чем при
// скачивании (buildOutputFilename): номер расчёта (полный, с месяцем/годом,
// как в самом документе) + короткое название теплообменника (марка и
// исполнение, БЕЗ раскладки пластин в скобках — она не нужна для навигации
// по папке) + заказчик, если он указан. "/" в номере расчёта заменяем на
// "-", т.к. большинство файловых систем не разрешают "/" в имени файла.
function buildDriveFilename() {
  const numberPart = formatCalcNumber(currentFieldValues['calc_number']).replace(/\//g, '-');
  const fullModel = currentFieldValues['model'] || '';
  const shortModel = fullModel.replace(/\s*\(.*$/, '').trim(); // отрезаем " (24LL)+(33LL)" и т.п.
  const customer = (currentFieldValues['customer'] || '').trim();
  const parts = [numberPart, shortModel, customer].filter(Boolean);
  const raw = parts.join('_') || 'расчёт';
  const safe = raw.replace(/[\\/:*?"<>|]+/g, '_').trim();
  return `${safe}.docx`;
}

async function handleAddToJournal() {
  if (!lastGeneratedLogFormat) return;
  if (!APPS_SCRIPT_URL) {
    setStatus('journalStatus', 'Журнал не настроен — укажите APPS_SCRIPT_URL в js/config.js (см. README.md, раздел "Журнал расчётов").', 'err');
    return;
  }
  const btn = el('btnAddToJournal');
  if (btn) btn.disabled = true;
  const entry = buildLogEntry(lastGeneratedLogFormat);
  // Файл на Google Диск отправляется в том же запросе, что и строка
  // журнала (по просьбе пользователя — одна кнопка вместо двух).
  let willSaveFile = false;
  if (lastGeneratedDocxBytes) {
    try {
      entry.fileBase64 = await bytesToBase64(lastGeneratedDocxBytes);
      entry.fileName = buildDriveFilename();
      willSaveFile = true;
    } catch (e) {
      console.warn('Не удалось подготовить файл для сохранения на Google Диск', e);
    }
  }
  setStatus('journalStatus', willSaveFile ? 'Добавляю в журнал и сохраняю файл на Google Диск...' : 'Добавляю строку в журнал...');
  const result = await logToSheet(entry);
  if (result && result.ok) {
    // "no-cors" запрос (см. sheetsLog.js) — подтвердить именно успех
    // сохранения ФАЙЛА браузер не может (как и раньше не мог подтвердить
    // саму запись в таблицу), формулировка ниже — про то, что запрос ушёл.
    setStatus('journalStatus', willSaveFile ? 'Добавлено в журнал, файл отправлен на Google Диск.' : 'Добавлено в журнал.', 'ok');
  } else if (result && result.skipped) {
    setStatus('journalStatus', 'Журнал не настроен — укажите APPS_SCRIPT_URL в js/config.js.', 'err');
    if (btn) btn.disabled = false;
  } else {
    setStatus('journalStatus', 'Не удалось записать в журнал (проверьте интернет и адрес APPS_SCRIPT_URL).', 'err');
    if (btn) btn.disabled = false;
  }
}

/* ---------------- Вспомогательное ---------------- */

// Пользователь вводит только сам номер расчёта (например "19234") — месяц и
// год дописываются автоматически по ТЕКУЩЕЙ дате в момент формирования
// документа (не запоминаются заранее), формат "19234/09-2026".
function formatCalcNumber(rawNumber) {
  const num = (rawNumber || '').trim();
  if (!num) return '';
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  return `${num}/${mm}-${yyyy}`;
}

// Дата в правом нижнем углу документа ("Расчёт выполнил: ФИО ... дата") —
// всегда текущая на момент формирования документа, вводить вручную не нужно.
// Формат по просьбе пользователя — дд/мм/гггг (со слэшами).
function formatTodayDateDMY() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// То же самое, но с точками (дд.мм.гггг) — формат даты в журнале расчётов
// (Google-таблица), как в образце бумажного журнала БСИ.
function formatTodayDateDMYDots() {
  return formatTodayDateDMY().replace(/\//g, '.');
}

// Для .vsdx и "своего PDF-шаблона" ФИО и дата пишутся в одну и ту же ячейку
// одной строкой (как раньше, когда дату вводили руками) — просто дата теперь
// всегда сегодняшняя, а не то, что ввёл пользователь.
function formatExecutorCombined(rawName) {
  const name = (rawName || '').trim();
  const today = formatTodayDateDMY();
  return name ? `${name}, ${today}` : today;
}

function buildOutputFilename(ext) {
  const baseTitle = (currentTemplate.title || '').replace(/\.(pdf|vsdx)$/i, '');
  const model = (currentFieldValues['model'] || baseTitle).replace(/[^\wА-Яа-яЁё\-.]+/g, '_');
  const date = new Date().toISOString().slice(0, 10);
  return `${model}_${date}.${ext}`;
}

// Инженер вводит первый номер расчёта вручную один раз; при каждом
// следующем расчёте сервис сам подсказывает следующий (последний номер
// в Журнале + 1) — подставляет его прямо в поле "Номер расчёта" (его
// в любой момент можно поправить руками, это только подсказка). Не
// перетирает значение, если поле уже чем-то заполнено (например, если
// сотрудник уже начал вводить номер сам, пока шёл запрос к таблице).
// Работает молча — если APPS_SCRIPT_URL не настроен или запрос не
// удался, поле просто остаётся пустым, как раньше.
async function suggestNextCalcNumber() {
  if (currentFieldValues['calc_number']) return;
  const result = await fetchNextCalcNumber();
  if (result && result.ok && result.nextNumber != null && !currentFieldValues['calc_number']) {
    currentFieldValues['calc_number'] = String(result.nextNumber);
    renderForm();
  }
}

// Формат журнала — по образцу бумажного журнала БСИ (столбцы "№",
// "Условное обозначение теплообменника", "Дата", "Объект", "Заказчик",
// "Примечание"; строки группируются по году/месяцу — это делает сам
// Apps Script на стороне таблицы, см. apps-script/Code.gs). "№" — тот же
// ПОЛНЫЙ номер, что и в самом документе (formatCalcNumber, например
// "19234/09-2026"), а не сокращённый — по просьбе пользователя.
function buildLogEntry(format) {
  return {
    number: formatCalcNumber(currentFieldValues['calc_number']),
    model: currentFieldValues['model'] || '',
    date: formatTodayDateDMYDots(),
    site: currentFieldValues['site'] || '',
    customer: currentFieldValues['customer'] || '',
    note: currentFieldValues['journal_note'] || '',
  };
}

/* ---------------- Init ---------------- */

document.addEventListener('DOMContentLoaded', () => {
  initCustomTemplateUpload();
  initDropzone();
  el('btnCustomDocx').addEventListener('click', handleGenerateCustomDocx);
  el('btnAddToJournal').addEventListener('click', handleAddToJournal);
});
