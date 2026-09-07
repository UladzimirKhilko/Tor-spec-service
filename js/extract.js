if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
}

/*
 * extract.js
 * Извлечение текста из загруженного файла спецификации:
 *  - HTML-экспорт отчёта BelTO -> прямой разбор таблицы (точно, без OCR)
 *  - PDF с текстовым слоем -> pdf.js (быстро и точно)
 *  - Изображение (jpg/png) или PDF-скан -> tesseract.js (OCR, медленнее и менее точно)
 */

// HTML-экспорт отчёта BelTO — это простая вложенная HTML-таблица с ровно
// теми же подписями и значениями, что и в PDF/скане, только без всякого
// OCR: числа и точки/запятые в них всегда абсолютно точные. Разбираем
// каждую строку таблицы (<tr>) в одну текстовую строку "Подпись Единица
// Значение1 Значение2", после чего передаём получившийся текст в тот же
// самый parseBeltoText(), что используется для PDF/OCR — его регулярки
// уже терпимы к небольшим отличиям в пробелах и полностью справляются
// с таким чистым текстом.
function htmlDocToLines(doc) {
  const rows = Array.from(doc.querySelectorAll('tr'));
  const lines = [];
  rows.forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll('td'))
      .map((td) => (td.textContent || '')
        .replace(/ /g, ' ')
        .replace(/\s+/g, ' ')
        .trim())
      // "№" — самостоятельная ячейка-заголовок графы номера, ничего не
      // несёт и мешает регулярке модели теплообменника (даёт "хвост" в
      // конце строки) — выкидываем такие пустые "служебные" ячейки.
      .filter((t) => t && t !== '№');
    if (cells.length) lines.push(cells.join(' '));
  });
  return lines.join('\n');
}

async function extractTextFromHtml(file) {
  const raw = await file.text();
  const doc = new DOMParser().parseFromString(raw, 'text/html');
  return htmlDocToLines(doc);
}

// Точный разбор строк "Среда" и единиц измерения ПО ЯЧЕЙКАМ HTML-таблицы —
// сильнее построчного regex-разбора в beltoParser.js (parseBeltoText),
// потому что там после того, как ячейки схлопнули в одну строку текста
// (см. extractTextFromHtml), уже не различить, где кончается одно
// многословное название среды и начинается другое ("Пропиленгликоль 40%" +
// "Вода" не разделить надёжно как "текст1 текст2"). Здесь ячейки читаются
// как есть — "Среда | - | <греющая> | <нагреваемая>" — так же для единицы
// измерения тепловой нагрузки/расхода/давления, если она стоит в СВОЕЙ
// ячейке (2-я колонка), а не приклеена к значению.
//
// Результат подмешивается в values ПОВЕРХ того, что дал общий построчный
// разбор (см. app.js) — то есть только для метода 'html-table', где это
// надёжно; для PDF/OCR такой структуры уже нет, там остаётся эвристика.
function parseBeltoHtmlStructured(doc) {
  const result = {};
  const rows = Array.from(doc.querySelectorAll('tr'));
  // Моноблок (2хБГВ/3хБГВ): "Спецификация МоноБлок", шапка "Cтупень | I | II"
  const monoblock = isMonoblockText((doc.body && doc.body.textContent) || '');
  if (monoblock) result.is_monoblock = true;
  rows.forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll('td')).map((td) =>
      (td.textContent || '').replace(/\s+/g, ' ').trim()
    );
    if (!cells.length) return;
    const label = cells[0] || '';

    if (/^Сред[а-я]*$/i.test(label) && cells.length >= 4) {
      if (cells[2]) result.heat_medium_hot = cells[2];
      if (cells[3]) result.heat_medium_cold = cells[3];
      return;
    }
    if (!monoblock) {
      if (/^[ТП]епловая\s+Мо[щш]ность$/i.test(label) && cells[1] && cells[1] !== '-') {
        result.heat_load_unit = cells[1];
        return;
      }
      if (/^Массов\S*\s+Расход$/i.test(label) && cells[1] && cells[1] !== '-') {
        result.flow_unit = cells[1];
        return;
      }
      if (/^Потер\S*\s+Напор\S*$/i.test(label) && cells[1] && cells[1] !== '-') {
        result.dp_unit = cells[1];
        return;
      }
    }
    if (/^Раскладка\s+Канал\S*$/i.test(label) && cells[2]) {
      result.channel_layout = normalizeChannelLayoutBlock(cells[2]);
      // Моноблок: "33 LL | 24 LL | 33 LL | 24 LL" — по ступеням I/II
      if (monoblock && cells.length >= 6 && cells[3]) {
        result.channel_layout_s1 = normalizeChannelLayoutBlock(cells[2]);
        result.channel_layout_s2 = normalizeChannelLayoutBlock(cells[3]);
      }
      return;
    }

    if (!monoblock) return;

    // ---- Моноблок: строки с 4 значениями (греющий I, греющий II,
    // нагреваемый I, нагреваемый II) и с 2 значениями (ступени I, II).
    // Число может стоять вместе с единицей в одной ячейке ("140.09 т/ч") —
    // отделяем; единицу (если она в ячейке) записываем в *_unit.
    const four = (base, unitKey) => {
      if (cells.length < 6) return;
      const keys = [`${base}_s1_hot`, `${base}_s2_hot`, `${base}_s1_cold`, `${base}_s2_cold`];
      keys.forEach((k, i) => {
        const { value, unit } = splitNumberAndUnit(cells[2 + i]);
        if (value !== null) result[k] = value;
        if (unitKey && unit && !result[unitKey]) result[unitKey] = unit;
      });
      if (unitKey && !result[unitKey] && cells[1] && cells[1] !== '-') result[unitKey] = cells[1];
    };
    const two = (k1, k2, unitKey) => {
      if (cells.length < 4) return;
      const a = splitNumberAndUnit(cells[2]), b = splitNumberAndUnit(cells[3]);
      if (a.value !== null) result[k1] = a.value;
      if (b.value !== null) result[k2] = b.value;
      if (unitKey && cells[1] && cells[1] !== '-') result[unitKey] = cells[1];
    };

    if (/^[ТП]емператур\S*\s+(?:на\s+)?Вход\S*$/i.test(label)) return four('t_in');
    if (/^[ТП]емператур\S*\s+(?:на\s+)?Выход\S*$/i.test(label)) return four('t_out');
    if (/^Массов\S*\s+Расход$/i.test(label)) return four('flow', 'flow_unit');
    if (/^Потер\S*\s+Напор\S*$/i.test(label)) return four('dp', 'dp_unit');
    if (/^[ТП]епловая\s+Мо[щш]ность$/i.test(label)) return two('heat_power_s1', 'heat_power_s2', 'heat_load_unit');
    if (/^Поверхность\s+[ТП]еплообмена$/i.test(label)) return two('heat_surface_s1', 'heat_surface_s2');
    if (/^Запас\s+по\s+Поверхн\S*$/i.test(label)) return two('surface_margin_s1', 'surface_margin_s2');
    if (/^Коэф-?т\s+[ТП]еплопередачи\s+Факт\S*$/i.test(label)) return two('heat_transfer_coef_actual_s1', 'heat_transfer_coef_actual_s2');
    if (/^Коэф-?т\s+[ТП]еплопередачи\s+Необходим\S*$/i.test(label)) return two('heat_transfer_coef_required_s1', 'heat_transfer_coef_required_s2');
  });
  return result;
}

// "140.09 т/ч" -> { value: 140.09, unit: 'т/ч' }; "350" -> { value: 350, unit: null };
// "-" / пусто -> { value: null, unit: null }
function splitNumberAndUnit(cellText) {
  const t = String(cellText || '').trim();
  const m = t.match(/^(-?\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!m) return { value: null, unit: null };
  const value = parseFloat(m[1].replace(',', '.'));
  const unit = (m[2] || '').trim().replace(/^-+$/, '') || null;
  return { value: Number.isFinite(value) ? value : null, unit };
}

async function extractTextFromFile(file, onProgress) {
  const isHtml = file.type === 'text/html' || /\.html?$/i.test(file.name);
  if (isHtml) {
    onProgress && onProgress('Читаю HTML-отчёт BelTO (точный разбор таблицы, без OCR)...');
    const raw = await file.text();
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const text = htmlDocToLines(doc);
    const structured = parseBeltoHtmlStructured(doc);
    return { text, method: 'html-table', structured };
  }

  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

  if (isPdf) {
    const text = await extractTextFromPdf(file, onProgress);
    if (text && text.replace(/\s/g, '').length > 30) {
      return { text, method: 'pdf-text' };
    }
    // PDF без текстового слоя (скан) — гоним через OCR первой страницы
    onProgress && onProgress('В PDF нет текстового слоя, распознаём как скан (OCR)...');
    const imageDataUrl = await renderPdfPageToImage(file);
    const trimmedImageDataUrl = await trimBlackMargins(imageDataUrl);
    const ocrText = await extractTextFromImage(trimmedImageDataUrl, onProgress);
    return { text: ocrText, method: 'ocr-from-pdf' };
  }

  // Обычное изображение — экспериментально (реальный скриншот BelTO) масштабирование
  // и повышение контраста только ухудшали распознавание Tesseract (модель уже
  // натренирована на "обычных" фото/скринах) — поэтому передаём файл как есть.
  // Единственное преобразование, которое реально помогает: обрезка чёрных полей
  // по краям (частый случай для скриншотов с телефона) — см. trimBlackMargins.
  const dataUrl = await fileToDataUrl(file);
  const trimmedDataUrl = await trimBlackMargins(dataUrl);
  const ocrText = await extractTextFromImage(trimmedDataUrl, onProgress);
  return { text: ocrText, method: 'ocr-image' };
}

/*
 * Обрезает сплошные чёрные поля по краям изображения (typичный артефакт
 * скриншотов с телефона — например когда страница сфотографирована/
 * сэкранена с чёрными полосами сверху/снизу или по бокам). Эти поля сами
 * по себе не мешают человеку читать текст, но сильно портят автоматическую
 * сегментацию страницы в Tesseract — на реальном тесте с таким скриншотом
 * обрезка вернула распознавание сразу нескольких строк, которые пропадали
 * целиком (например "Потери Напора").
 *
 * Если чёрных полей не обнаружено — возвращает исходное изображение без
 * изменений (безопасно для обычных, уже плотно скадрированных фото).
 */
async function trimBlackMargins(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const W = img.width;
        const H = img.height;
        if (!W || !H) { resolve(dataUrl); return; }

        // Анализируем не полное изображение, а уменьшенную копию — быстрее
        // и достаточно точно для поиска границ сплошных чёрных полей.
        const THUMB_W = 200;
        const scale = THUMB_W / W;
        const thumbH = Math.max(1, Math.round(H * scale));
        const tcanvas = document.createElement('canvas');
        tcanvas.width = THUMB_W;
        tcanvas.height = thumbH;
        const tctx = tcanvas.getContext('2d');
        tctx.drawImage(img, 0, 0, THUMB_W, thumbH);
        const { data } = tctx.getImageData(0, 0, THUMB_W, thumbH);

        const colBright = new Float64Array(THUMB_W);
        const rowBright = new Float64Array(thumbH);
        for (let y = 0; y < thumbH; y++) {
          let rowSum = 0;
          for (let x = 0; x < THUMB_W; x++) {
            const idx = (y * THUMB_W + x) * 4;
            const b = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
            colBright[x] += b;
            rowSum += b;
          }
          rowBright[y] = rowSum / THUMB_W;
        }
        for (let x = 0; x < THUMB_W; x++) colBright[x] /= thumbH;

        const THRESH = 60; // порог "почти чёрный фон"
        const firstAbove = (arr) => {
          for (let i = 0; i < arr.length; i++) if (arr[i] > THRESH) return i;
          return 0;
        };
        const lastAbove = (arr) => {
          for (let i = arr.length - 1; i >= 0; i--) if (arr[i] > THRESH) return i;
          return arr.length - 1;
        };

        const x0 = firstAbove(colBright);
        const x1 = lastAbove(colBright);
        const y0 = firstAbove(rowBright);
        const y1 = lastAbove(rowBright);

        // Поля не найдены (края и так светлые) — ничего не обрезаем
        const marginFound = x0 > 2 || x1 < THUMB_W - 3 || y0 > 2 || y1 < thumbH - 3;
        if (!marginFound) { resolve(dataUrl); return; }

        const pad = 5; // небольшой запас, чтобы не обрезать край текста впритык
        const fx0 = Math.max(0, Math.floor(x0 / scale) - pad);
        const fx1 = Math.min(W, Math.ceil((x1 + 1) / scale) + pad);
        const fy0 = Math.max(0, Math.floor(y0 / scale) - pad);
        const fy1 = Math.min(H, Math.ceil((y1 + 1) / scale) + pad);

        const cw = fx1 - fx0;
        const ch = fy1 - fy0;
        if (cw < 50 || ch < 50) { resolve(dataUrl); return; } // подстраховка от вырожденного кропа

        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, fx0, fy0, cw, ch, 0, 0, cw, ch);
        resolve(canvas.toDataURL('image/png'));
      } catch (e) {
        console.warn('trimBlackMargins: не удалось обрезать поля, использую исходное изображение', e);
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function extractTextFromPdf(file, onProgress) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress && onProgress(`Читаю PDF, страница ${i}/${pdf.numPages}...`);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Группируем по строкам через координату Y, чтобы сохранить построчную структуру таблицы
    const items = content.items.map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: Math.round(it.transform[5]),
    }));
    items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    let lastY = null;
    let line = [];
    const lines = [];
    for (const it of items) {
      if (lastY === null || Math.abs(it.y - lastY) > 2) {
        if (line.length) lines.push(line.map((l) => l.str).join(' '));
        line = [it];
        lastY = it.y;
      } else {
        line.push(it);
      }
    }
    if (line.length) lines.push(line.map((l) => l.str).join(' '));
    fullText += lines.join('\n') + '\n';
  }
  return fullText;
}

async function renderPdfPageToImage(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const page = await pdf.getPage(1);
  // scale: 2 давал на реальных PDF-спецификациях (без текстового слоя)
  // изображение только ~1180x1686px — при таком разрешении построчный OCR
  // регулярно терял мелкие десятичные точки в числах (например "2.34" ->
  // "234"/"2 34"). Поднимаем до 3, чтобы цифры и точки были крупнее и не
  // сливались при увеличении строк перед распознаванием (см. ocrByTableRows).
  const viewport = page.getViewport({ scale: 3 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL('image/png');
}

async function extractTextFromImage(dataUrl, onProgress) {
  // worker.min.js — локальный (vendor/), а wasm-ядро и языковые данные (rus/eng)
  // Tesseract.js по умолчанию подтягивает с CDN (jsdelivr) — для этого шага
  // браузеру нужен интернет, см. README.md.
  const worker = await Tesseract.createWorker('rus+eng', 1, {
    workerPath: 'vendor/worker.min.js',
    logger: (m) => {
      if (onProgress && m.status && m.progress !== undefined) {
        onProgress(`OCR: ${m.status} ${(m.progress * 100).toFixed(0)}%`);
      }
    },
  });
  try {
    // На отчёте BelTO (плотная таблица с большим количеством строк) единый
    // прогон Tesseract по всей странице систематически "терял" целиком
    // отдельные строки (например "Температура на Входе" и "Потери Напора")
    // — даже на идеально чистом, не сфотографированном скриншоте. Причина
    // оказалась не в качестве картинки, а в сегментации: соседняя с
    // границей ячейки цифра сливается с горизонтальной линией таблицы.
    // Поэтому сначала пробуем более надёжный путь — нарезать изображение
    // по обнаруженным горизонтальным линиям таблицы и распознавать каждую
    // строку отдельно (см. ocrByTableRows). Если чётких линий не нашлось
    // (например смазанное фото под углом) — используем прежний способ:
    // распознавание всего изображения одним проходом.
    onProgress && onProgress('Ищу структуру таблицы...');
    await worker.setParameters({
      tessedit_pageseg_mode: '6', // "единый однородный блок текста" — для одной строки/полосы
      preserve_interword_spaces: '1',
    });
    const rowText = await ocrByTableRows(dataUrl, worker, onProgress);
    if (rowText && rowText.replace(/\s/g, '').length > 50) {
      return rowText;
    }

    onProgress && onProgress('Чёткая сетка таблицы не найдена, распознаю целиком...');
    await worker.setParameters({
      // 4 = "Assume a single column of text of variable sizes" — на
      // тестовом отчёте BelTO дал заметно более чистый результат, чем
      // автоматическая сегментация (3), которая на такой плотной таблице
      // расползалась в мусор
      tessedit_pageseg_mode: '4',
      preserve_interword_spaces: '1',
    });
    const { data } = await worker.recognize(dataUrl);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

/*
 * Нарезает изображение отчёта на отдельные строки таблицы по обнаруженным
 * сплошным горизонтальным линиям (границам ячеек) и распознаёт каждую
 * строку отдельным проходом Tesseract, сильно увеличив её масштаб.
 *
 * Почему это нужно: на плотной таблице BelTO с ~50 строками единый прогон
 * OCR по всей странице нередко полностью терял отдельные строки (текст не
 * искажался, а исчезал целиком) — вероятно, из-за того, что автоматическая
 * сегментация страницы путает соседние строки/цифры с горизонтальными
 * линиями таблицы. Нарезка по строкам с небольшим отступом от самой линии
 * (чтобы линия не попадала в кадр и не "прилипала" к цифрам) и увеличение
 * масштаба перед распознаванием на практике даёт кардинально более чистый
 * результат для каждой отдельной строки.
 *
 * Возвращает null, если чётких горизонтальных линий недостаточно (например
 * смазанное или перекошенное фото без ровной сетки) — тогда вызывающий код
 * должен вернуться к распознаванию всего изображения одним проходом.
 */
async function ocrByTableRows(dataUrl, worker, onProgress) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = async () => {
      try {
        const W = img.width;
        const H = img.height;
        if (!W || !H) { resolve(null); return; }

        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, W, H);

        // Доля тёмных пикселей в каждой строке изображения
        const rowDark = new Float64Array(H);
        for (let y = 0; y < H; y++) {
          let dark = 0;
          const rowOffset = y * W * 4;
          for (let x = 0; x < W; x++) {
            const idx = rowOffset + x * 4;
            const b = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
            if (b < 100) dark++;
          }
          rowDark[y] = dark / W;
        }

        // Строки-кандидаты на "сплошная горизонтальная линия таблицы"
        const LINE_THRESH = 0.5;
        const lineRows = [];
        for (let y = 0; y < H; y++) if (rowDark[y] > LINE_THRESH) lineRows.push(y);

        // Слишком мало линий — не похоже на чистую таблицу с ровной сеткой
        // (например перекошенное или смазанное фото) — сигнализируем об
        // этом вызывающему коду, чтобы он использовал распознавание целиком
        if (lineRows.length < 8) { resolve(null); return; }

        // Группируем соседние строки-пиксели в одну линию (толщиной 1-2px)
        const groups = [[lineRows[0]]];
        for (let i = 1; i < lineRows.length; i++) {
          const y = lineRows[i];
          const lastGroup = groups[groups.length - 1];
          if (y - lastGroup[lastGroup.length - 1] <= 2) {
            lastGroup.push(y);
          } else {
            groups.push([y]);
          }
        }
        const bounds = groups.map((g) => ({ start: g[0], end: g[g.length - 1] }));
        if (bounds.length < 8) { resolve(null); return; }

        const PAD = 2; // отступ внутрь от линии, чтобы сама линия не попала в кадр строки
        const SCALE = 4; // увеличение перед распознаванием — заметно повышает точность
        // Внешняя рамка таблицы (левая и правая границы) на тесте регулярно
        // распознавалась Tesseract'ом как лишняя цифра "1" на конце строки
        // (например "6.91  1" вместо "6.91"), что портило извлечение чисел.
        // Обрезаем немного по краям, чтобы сама рамка не попадала в кадр.
        const XPAD = Math.max(4, Math.round(W * 0.007));
        const cropX0 = XPAD;
        const cropW = Math.max(1, W - 2 * XPAD);
        const lines = [];
        for (let i = 0; i < bounds.length - 1; i++) {
          const y0 = bounds[i].end + PAD;
          const y1 = bounds[i + 1].start - PAD;
          const rh = y1 - y0;
          if (rh < 10) continue; // слишком тонкая полоса — не строка с текстом

          const rowCanvas = document.createElement('canvas');
          rowCanvas.width = cropW * SCALE;
          rowCanvas.height = rh * SCALE;
          const rctx = rowCanvas.getContext('2d');
          rctx.imageSmoothingEnabled = true;
          rctx.drawImage(canvas, cropX0, y0, cropW, rh, 0, 0, cropW * SCALE, rh * SCALE);

          onProgress && onProgress(`OCR построчно: строка ${i + 1}/${bounds.length - 1}...`);
          // eslint-disable-next-line no-await-in-loop
          const { data: res } = await worker.recognize(rowCanvas.toDataURL('image/png'));
          if (res.text && res.text.trim()) lines.push(res.text.trim());
        }
        resolve(lines.join('\n'));
      } catch (e) {
        console.warn('ocrByTableRows: не удалось распознать построчно, использую исходный способ', e);
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}
