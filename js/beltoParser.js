/*
 * beltoParser.js
 * Разбор текста отчёта "Спецификация" программы BelTO / ТеплоХИТ
 * (см. пример: скриншот из папки пользователя) в плоский словарь
 * source-ключей, которые затем маппятся в fieldMap.js.
 *
 * Работает как с "чистым" текстом из PDF (pdf.js), так и с текстом
 * после OCR (tesseract.js) — во втором случае распознавание менее
 * точное, поэтому все результаты обязательно показываются
 * пользователю для проверки перед генерацией документа.
 *
 * ВАЖНО: это эвристический построчный разбор под конкретный формат
 * отчёта BelTO. Если формат исходника отличается — часть полей может
 * не распознаться, тогда их просто нужно ввести/поправить руками в форме.
 */

// Описание строк отчёта: label - паттерн подписи (regex, без учёта регистра),
// valuesCount - сколько чисел ожидаем на этой строке (1 = общее значение,
// 2 = отдельно "греющий"/"нагреваемый" контур),
// keys - соответствующие source-ключи (длина === valuesCount)
//
// Многие подписи начинаются с "Те..." (Температура, Тепловая, Теплообменник,
// Теплопередачи, Теплообмена) — на реальном тесте построчный OCR на строках
// с плотным мелким шрифтом регулярно путал заглавную "Т" с "П" (например
// "Температура на Выходе" распознавалась как "Пемпература на Выходе"), из-за
// чего вся строка переставала находиться и связанные поля (в т.ч. вычисляемые
// из неё температурный график и вход-выход) оставались пустыми. Поэтому для
// всех таких подписей первая буква ищется как [ТП], а не только "Т".
const BELTO_LINES = [
  { label: /[ТП]еплообменник\s+Пластинчат\S*\s+Разборн\S*\s*:?\s*(.+)/i, kind: 'model' },
  // "на" и словоформы — терпимость к типичным ошибкам OCR (пропуск короткого
  // предлога, окончания "Температуры"/"Температур" и т.п.)
  { label: /[ТП]емператур\S*\s+(?:на\s+)?Вход\S*/i, valuesCount: 2, keys: ['t_in_hot', 't_in_cold'] },
  { label: /[ТП]емператур\S*\s+(?:на\s+)?Выход\S*/i, valuesCount: 2, keys: ['t_out_hot', 't_out_cold'] },
  { label: /Массов\S*\s+Расход/i, valuesCount: 2, keys: ['flow_hot', 'flow_cold'], unitKey: 'flow_unit' },
  // Потер[и]/Напор[а] — стеммингом переживаем окончания и мелкие опечатки OCR
  { label: /Потер\S*\s+Напор\S*/i, valuesCount: 2, keys: ['dp_hot', 'dp_cold'], unitKey: 'dp_unit' },
  // Строка "Среда" в отчёте BelTO — под заголовком "Контур | Греющий |
  // Нагреваемый" идёт строка "Среда | - | <название> | <название>"
  // (например "Вода"/"Вода", "Пропиленгликоль 40%"/"Вода", "Пар водяной"/...).
  // Для HTML-источника (метод 'html-table') название среды достаётся ТОЧНО,
  // напрямую из отдельных ячеек таблицы — см. parseBeltoHtmlStructured в
  // extract.js, она сильнее этого правила и переопределяет его результат.
  // Здесь — попытка "на глазок" по плоской строке (для PDF/OCR-источников,
  // где отдельных ячеек уже нет): работает только если после "Среда" и
  // отброшенного плейсхолдера "-" осталось РОВНО два "слова" (без пробелов
  // внутри названия) — так безопаснее, чем гадать границу между двумя
  // многословными названиями.
  { label: /^Сред[а-я]*\b/i, kind: 'medium' },
  // Мо[щш]ность и (?:Кол\S*\s+)?Ходов — терпимость к типичным ошибкам OCR
  // (Tesseract на скриншотах нередко путает "щ"/"ш" и теряет первые буквы
  // короткого слова перед границей ячейки таблицы)
  { label: /[ТП]епловая\s+Мо[щш]ность/i, valuesCount: 1, keys: ['heat_power'], unitKey: 'heat_load_unit' },
  { label: /Поверхность\s+[ТП]еплообмена/i, valuesCount: 1, keys: ['heat_surface'] },
  // "по/no" перед "Поверхности" нередко пропадает или сливается с соседним
  // словом при OCR — делаем его необязательным; "Поверхности" стеммингуем
  { label: /(?:Запас|Валас|Banac|3anac|3апас)\s*(?:по|no)?\s*Поверхн\S*/i, valuesCount: 1, keys: ['surface_margin'] },
  { label: /Коэф-?т\s+[ТП]еплопередачи\s+Факт\S*/i, valuesCount: 1, keys: ['heat_transfer_coef_actual'] },
  { label: /Коэф-?т\s+[ТП]еплопередачи\s+Необходим\S*/i, valuesCount: 1, keys: ['heat_transfer_coef_required'] },
  { label: /Количество\s+Пластин/i, valuesCount: 1, keys: ['plates_count'] },
  { label: /(?:Кол\S*\s+)?Ходов/i, valuesCount: 1, keys: ['passes_count'] },
  // "Диаметр" стеммингуем по началу/концу — OCR на этом слове нередко путает
  // среднюю "и" с "н" (в "Диаметр"), а в "Условный" — "л" с "п" ("Усповный")
  { label: /Ус[лп][оа]в\S*\s+Д\S*аметр/i, valuesCount: 2, keys: ['dn_hot', 'dn_cold'] },
  { label: /Вес\s+[ТП]еплообменника/i, valuesCount: 2, keys: ['mass_empty', 'mass_filled'] },
  // Раскладка каналов — нужна для сборки марки теплообменника вида
  // ТОР-15М/13-<кол-во пластин>-1х(<раскладка>). В спецификации BelTO
  // значение обычно состоит из ДВУХ групп через "+", например "9 HL + 2 LL"
  // (не одной!) — раньше регулярка захватывала только первую группу ("9 HL"),
  // и знак "+2 LL" терялся целиком: марка получалась "...(9НЛ)" вместо
  // "...(9НЛ+2ЛЛ)". Теперь захватывается ВСЯ цепочка "<число><буквы>(+<число>
  // <буквы>)*" — при этом греющий и нагреваемый контур в спецификации всегда
  // дублируют одно и то же значение раскладки, так что достаточно взять
  // только первое (до того, как паттерн начнёт повторяться на соседней
  // ячейке — между ячейками стоит просто пробел, не "+", поэтому регулярка
  // сама останавливается на границе).
  { label: /Раскладка\s+Канал\S*\D*(\d{1,3}\s*[A-Za-zА-Яа-я]{1,4}(?:\s*\+\s*\d{1,3}\s*[A-Za-zА-Яа-я]{1,4})*)/i, kind: 'channel_layout' },
];

function extractNumbers(line) {
  const matches = line.match(/-?\d+(?:[.,]\d+)?/g);
  if (!matches) return [];
  return matches.map((m) => parseFloat(m.replace(',', '.')));
}

// На построчном OCR десятичная точка/запятая — самый мелкий и хрупкий
// элемент цифры — нередко либо пропадает целиком ("2.34" -> "234"), либо
// распознаётся как пробел ("2.34" -> "2 34"). Второй случай можно надёжно
// исправить: если "в лоб" на строке нашлось не столько чисел, сколько
// ожидается, пробуем слить пары "цифра(-ы) + пробел + 2 цифры" в одно
// дробное число и повторить извлечение — часто это и даёт нужное количество.
function extractValuesForRule(line, valuesCount) {
  const raw = extractNumbers(line);
  const merged = line.replace(/(\d)\s+(\d{2})(?=\D|$)/g, '$1.$2');
  const mergedNums = merged !== line ? extractNumbers(merged) : raw;
  // Предпочитаем "склеенный" вариант, если он даёт ровно ожидаемое
  // количество чисел, или хотя бы уменьшает их количество по сравнению с
  // исходным (значит слияние действительно нашло разделённую точку и с
  // большей вероятностью восстановило потерянное дробное число, даже если
  // в строке остались посторонние цифры, например от артефакта OCR на
  // соседней колонке единиц измерения).
  if (mergedNums.length === valuesCount) return mergedNums;
  if (raw.length === valuesCount) return raw;
  if (mergedNums.length < raw.length) return mergedNums;
  return raw;
}

// Второй, более грубый защитный уровень — на случай, когда точка пропала
// БЕЗ пробела (например "7.43" -> "743", "2.31" -> "231") и предыдущий приём
// не помогает, потому что делить уже нечего. В отчёте BelTO такие поля
// практически всегда однозначное число с одним-двумя знаками после запятой
// (5-50 для больших единиц измерения) — если распознанное целое попало в
// диапазон 100-999, десятичная точка почти наверняка "потерялась" перед
// последними двумя цифрами.
function recoverLostDecimal(n) {
  if (typeof n === 'number' && Number.isInteger(n) && n >= 100 && n < 1000) {
    return n / 100;
  }
  return n;
}

// Достаёт единицу измерения из уже сматченной строки — то, что осталось
// после отбрасывания подписи (label) и текстовых представлений найденных
// чисел (vals). Работает и на HTML-источнике, где сплющенная строка вида
// "Тепловая Мощность кВт 350" даёт единицу ПЕРЕД числом, и на плоском тексте
// вида "Потери Напора - 28.97 кПа 9.21 кПа", где единица(ы) стоят ПОСЛЕ
// каждого числа — remainder после вычитания label и чисел в обоих случаях
// содержит ровно текст единицы (возможно продублированный, если она была
// указана у каждого значения отдельно — дубликаты схлопываются).
//
// ВАЖНО: раньше единица измерения для этих полей была ЗАШИТА в форму/шаблон
// (например heat_load всегда считался в Гкал/ч) — в одной из спецификаций
// тепловая нагрузка оказалась в кВт, и в готовый документ подставилось
// число "как есть", но подписанное неверной единицей — прямая ошибка в
// величине, не опечатка. Эта функция даёт возможность реально ПРОВЕРИТЬ (и
// показать) единицу вместо того, чтобы её угадывать один раз и на все случаи.
function extractUnitFromLine(line, labelMatchText, vals) {
  let residual = line;
  if (labelMatchText) {
    const idx = residual.indexOf(labelMatchText);
    if (idx !== -1) residual = residual.slice(0, idx) + ' ' + residual.slice(idx + labelMatchText.length);
  }
  (vals || []).forEach((n) => {
    if (n === null || n === undefined || isNaN(n)) return;
    const candidates = [
      String(n),
      String(n).replace('.', ','),
      Number.isInteger(n) ? null : n.toFixed(2),
      Number.isInteger(n) ? null : n.toFixed(2).replace('.', ','),
    ].filter(Boolean);
    for (const c of candidates) {
      const idx = residual.indexOf(c);
      if (idx !== -1) {
        residual = residual.slice(0, idx) + ' ' + residual.slice(idx + c.length);
        break;
      }
    }
  });
  const tokens = residual
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t && t !== '-' && t !== '—' && t !== '.' && t !== ':');
  const uniq = [...new Set(tokens)];
  const unit = uniq.join(' ').trim();
  return unit || null;
}

function normalizeChannelLayoutLetters(raw) {
  // Раскладку каналов НЕ переводим на кириллицу — переносим буквы как есть
  // в спецификации (латиница: H, L и т.п.), только приводим регистр.
  return raw.toUpperCase();
}

function normalizeChannelLayoutBlock(raw) {
  // Приводим целиком захваченный блок раскладки каналов (может содержать
  // несколько "+"-групп, например "9 HL  +  2 LL") к компактному виду
  // без лишних пробелов, буквы — как в спецификации (латиница): "9HL+2LL".
  return normalizeChannelLayoutLetters(raw)
    .replace(/\s*\+\s*/g, '+')
    .replace(/\s+/g, '');
}

function buildChannelLayoutMarking(channelLayout, passesCount) {
  // Маркировка раскладки каналов в марке теплообменника: для одноходовых
  // аппаратов — один блок в скобках, для многоходовых — блок повторяется
  // по числу ходов, каждый раз в своих скобках, через "+":
  // 1 ход  -> (9НЛ+2ЛЛ)
  // 2 хода -> (9НЛ+2ЛЛ)+(9НЛ+2ЛЛ)
  // 3 хода -> (9НЛ+2ЛЛ)+(9НЛ+2ЛЛ)+(9НЛ+2ЛЛ)
  if (!channelLayout) return null;
  const n = Math.round(parseFloat(passesCount));
  const passes = Number.isFinite(n) && n > 0 ? n : 1;
  const block = `(${channelLayout})`;
  return Array(passes).fill(block).join('+');
}

// ---------------------------------------------------------------------------
// МОНОБЛОК (исполнение 2хБГВ/3хБГВ — "блок горячей воды", две ступени
// нагрева в одном корпусе). Спецификация BelTO "МоноБлок" отличается от
// обычной тем, что вместо пары значений "греющий | нагреваемый" в строках
// рабочих параметров стоят ЧЕТЫРЕ (шапка "Cтупень | I | II | I | II":
// греющий I, греющий II, нагреваемый I, нагреваемый II), а в блоке
// "Характеристики" (мощность, поверхность, запас, коэффициенты) — ДВА
// (по ступеням I и II). Эти правила заменяют одноимённые обычные правила,
// когда текст опознан как моноблок (см. isMonoblockText). Ключи с суффиксами
// _s1/_s2 — ступени I/II В ПОРЯДКЕ СПЕЦИФИКАЦИИ; перестановку "II слева,
// I справа" (как в бланке) делает fieldMap.js.
//
// Для HTML-отчёта эти же значения дополнительно (и точнее) достаются прямо
// из ячеек таблицы — parseBeltoHtmlStructured в extract.js.
const MONOBLOCK_LINES = [
  { label: /[ТП]емператур\S*\s+(?:на\s+)?Вход\S*/i, valuesCount: 4, keys: ['t_in_s1_hot', 't_in_s2_hot', 't_in_s1_cold', 't_in_s2_cold'] },
  { label: /[ТП]емператур\S*\s+(?:на\s+)?Выход\S*/i, valuesCount: 4, keys: ['t_out_s1_hot', 't_out_s2_hot', 't_out_s1_cold', 't_out_s2_cold'] },
  { label: /Массов\S*\s+Расход/i, valuesCount: 4, keys: ['flow_s1_hot', 'flow_s2_hot', 'flow_s1_cold', 'flow_s2_cold'], unitKey: 'flow_unit' },
  { label: /Потер\S*\s+Напор\S*/i, valuesCount: 4, keys: ['dp_s1_hot', 'dp_s2_hot', 'dp_s1_cold', 'dp_s2_cold'], unitKey: 'dp_unit' },
  { label: /[ТП]епловая\s+Мо[щш]ность/i, valuesCount: 2, keys: ['heat_power_s1', 'heat_power_s2'], unitKey: 'heat_load_unit' },
  { label: /Поверхность\s+[ТП]еплообмена/i, valuesCount: 2, keys: ['heat_surface_s1', 'heat_surface_s2'] },
  { label: /(?:Запас|Валас|Banac|3anac|3апас)\s*(?:по|no)?\s*Поверхн\S*/i, valuesCount: 2, keys: ['surface_margin_s1', 'surface_margin_s2'] },
  { label: /Коэф-?т\s+[ТП]еплопередачи\s+Факт\S*/i, valuesCount: 2, keys: ['heat_transfer_coef_actual_s1', 'heat_transfer_coef_actual_s2'] },
  { label: /Коэф-?т\s+[ТП]еплопередачи\s+Необходим\S*/i, valuesCount: 2, keys: ['heat_transfer_coef_required_s1', 'heat_transfer_coef_required_s2'] },
  // Раскладка каналов у моноблока — по ступеням: "33 LL | 24 LL | 33 LL | 24 LL"
  // (греющий I, греющий II, нагреваемый I, нагреваемый II; контуры дублируют
  // друг друга) — берём первые две группы.
  { label: /Раскладка\s+Канал\S*\D*(\d{1,3}\s*[A-Za-zА-Яа-я]{1,4}(?:\s*\+\s*\d{1,3}\s*[A-Za-zА-Яа-я]{1,4})*)\s+(\d{1,3}\s*[A-Za-zА-Яа-я]{1,4}(?:\s*\+\s*\d{1,3}\s*[A-Za-zА-Яа-я]{1,4})*)/i, kind: 'channel_layout_stages' },
];
// Правила из обычного набора, которые у моноблока ЗАМЕНЯЮТСЯ (по ключам
// результата) — остальные (модель, среда, пластины, ходы, DN, вес) общие.
const MONOBLOCK_REPLACED_KEYS = new Set([
  't_in_hot', 't_out_hot', 'flow_hot', 'dp_hot', 'heat_power', 'heat_surface',
  'surface_margin', 'heat_transfer_coef_actual', 'heat_transfer_coef_required',
]);

function isMonoblockText(text) {
  // "Спецификация МоноБлок" в заголовке и/или шапка "Cтупень | I | II"
  // (в отчёте BelTO первая буква — латинская "C", подстраховываемся обоими).
  return /Моно\s*Блок/i.test(text) || /[CС]тупень\s+I\b/i.test(text);
}

function parseBeltoText(rawText) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const result = {};
  const debugMatches = [];
  const monoblock = isMonoblockText(rawText);
  if (monoblock) result.is_monoblock = true;

  const rules = monoblock
    ? BELTO_LINES.filter((r) => !(r.keys && r.keys.some((k) => MONOBLOCK_REPLACED_KEYS.has(k))) && r.kind !== 'channel_layout')
        .concat(MONOBLOCK_LINES)
    : BELTO_LINES;

  for (const line of lines) {
    for (const rule of rules) {
      if (!rule.label.test(line)) continue;

      if (rule.kind === 'channel_layout_stages') {
        const m = line.match(rule.label);
        if (m && m[1] && m[2]) {
          result.channel_layout_s1 = normalizeChannelLayoutBlock(m[1]);
          result.channel_layout_s2 = normalizeChannelLayoutBlock(m[2]);
          debugMatches.push({ line, keys: ['channel_layout_s1', 'channel_layout_s2'], values: [result.channel_layout_s1, result.channel_layout_s2] });
        }
        continue;
      }

      if (rule.kind === 'model') {
        const m = line.match(rule.label);
        if (m && m[1]) {
          // отрезаем возможный "№" в конце строки модели
          result.model = m[1].split(/№/)[0].trim();
          debugMatches.push({ line, keys: ['model'] });
        }
        continue;
      }

      if (rule.kind === 'channel_layout') {
        const m = line.match(rule.label);
        if (m && m[1]) {
          result.channel_layout = normalizeChannelLayoutBlock(m[1]);
          debugMatches.push({ line, keys: ['channel_layout'], values: [result.channel_layout] });
        }
        continue;
      }

      if (rule.kind === 'medium') {
        // Плоская строка (PDF/OCR-источник, без отдельных ячеек) —
        // "на глазок": отрезаем подпись "Среда" и плейсхолдер "-", и если
        // осталось РОВНО два однословных токена — считаем их греющей и
        // нагреваемой средой. Многословные названия ("Пропиленгликоль 40%",
        // "Пар водяной") здесь надёжно не разобрать — оставляем пустым,
        // сотрудник заполнит вручную (для HTML-источника это поле в любом
        // случае перекрывается точным разбором ячеек, см. extract.js).
        const m = line.match(rule.label);
        let residual = m ? line.slice(m[0].length) : line;
        residual = residual.replace(/^[\s:.-]+/, '').trim();
        const tokens = residual.split(/\s+/).filter((t) => t && t !== '-' && t !== '—');
        if (tokens.length === 2) {
          result.heat_medium_hot = tokens[0];
          result.heat_medium_cold = tokens[1];
          debugMatches.push({ line, keys: ['heat_medium_hot', 'heat_medium_cold'], values: tokens });
        }
        continue;
      }

      const nums = extractValuesForRule(line, rule.valuesCount);
      if (nums.length >= rule.valuesCount) {
        // Берём последние N чисел в строке (на случай, если в начале
        // строки случайно попала цифра из названия)
        const vals = nums.slice(nums.length - rule.valuesCount);
        rule.keys.forEach((k, i) => {
          result[k] = vals[i];
        });
        debugMatches.push({ line, keys: rule.keys, values: vals });

        if (rule.unitKey) {
          const labelMatch = line.match(rule.label);
          const unit = extractUnitFromLine(line, labelMatch ? labelMatch[0] : null, vals);
          if (unit) {
            result[rule.unitKey] = unit;
            debugMatches.push({ line, keys: [rule.unitKey], values: [unit] });
          }
        }
      }
    }
  }

  // Защитный второй уровень восстановления потерянной точки — применяем
  // только к полям, где физически ожидаются некрупные дробные значения
  // (расход т/ч, потери давления кПа, поверхность теплообмена м2).
  ['flow_hot', 'flow_cold', 'dp_hot', 'dp_cold', 'heat_surface'].forEach((k) => {
    if (result[k] !== undefined) result[k] = recoverLostDecimal(result[k]);
  });

  // Производные поля для fieldMap.js
  // Температуры вход-выход по контуру — через тире, например "95-70"
  // (формат, принятый в фирменном листе БСИ).
  if (result.t_in_hot !== undefined && result.t_out_hot !== undefined) {
    result.temp_in_hot_out_hot = `${formatNumber(result.t_in_hot, 0)}-${formatNumber(result.t_out_hot, 0)}`;
  }
  if (result.t_in_cold !== undefined && result.t_out_cold !== undefined) {
    result.temp_in_cold_out_cold = `${formatNumber(result.t_in_cold, 0)}-${formatNumber(result.t_out_cold, 0)}`;
  }
  // Температурный график сетевой воды = вход/выход ГРЕЮЩЕЙ среды (не путать
  // с нагреваемой) — например "95/70".
  if (result.t_in_hot !== undefined && result.t_out_hot !== undefined) {
    result.temp_graph = `${formatNumber(result.t_in_hot, 0)}/${formatNumber(result.t_out_hot, 0)}`;
  }
  if (result.dn_hot !== undefined) {
    result.dn = result.dn_hot;
  }
  // Коэффициент теплопередачи в шаблоне — одна ячейка вида "фактический/необходимый"
  if (result.heat_transfer_coef_actual !== undefined && result.heat_transfer_coef_required !== undefined) {
    result.heat_transfer_coef_combined = `${formatNumber(result.heat_transfer_coef_actual, 0)}/${formatNumber(result.heat_transfer_coef_required, 0)}`;
  }
  // Запас по поверхности — 2 знака после точки (десятичной), без знака "%"
  if (result.surface_margin !== undefined) {
    let sm = result.surface_margin;
    // OCR иногда "съедает" десятичный разделитель (например точку/запятую
    // в "5.26" — она мелкая и сливается с фоном таблицы), и вместо 5.26
    // распознаётся целое "526". Запас по поверхности почти всегда однозначное
    // число с двумя знаками после разделителя — если пришло трёхзначное
    // целое, это почти наверняка тот случай, восстанавливаем разделитель.
    sm = recoverLostDecimal(sm);
    result.surface_margin = sm;
    // ВАЖНО: БЕЗ знака "%" в самом значении — колонка "Ед.изм" в шаблоне уже
    // печатает "%" отдельно, добавлять его в значение тоже — задваивать знак
    // (пользователь заметил на реальном документе: "43,02%" в ячейке рядом
    // с "%" в столбце единиц). Формат — РОВНО 2 знака после ТОЧКИ (десятичная
    // запятая нигде в документе больше не используется — единый вид
    // разделителя по всей форме, по просьбе пользователя), без знака %.
    const s = formatFixed(sm, 2);
    if (s) result.surface_margin_pct = s;
  }

  return { values: result, debugMatches };
}

// Производные поля моноблока — считаются ПОСЛЕ того, как поверх построчного
// разбора наложен точный разбор HTML-ячеек (app.js), поэтому вынесены в
// отдельную функцию, а не в хвост parseBeltoText.
//
// Согласовано с пользователем (07.09.2026):
//  - "Тепловая нагрузка ГВС" = сумма мощностей ступеней I + II;
//  - "Температурный график в точке излома" = температура греющей среды на
//    входе во II ступень / на выходе из I ступени (например "60/52");
//  - "Число ходов": 2хБГВ — по одному ходу на ступень ("1 | 1"); при общем
//    числе ходов 3 (3хБГВ) — 1 + 2, распределение по ступеням уточняется
//    (поля редактируемые);
//  - раскладка каналов — латиницей, как в спецификации.
function deriveMonoblockValues(v) {
  const num = (x) => {
    if (x === null || x === undefined || x === '') return NaN;
    return typeof x === 'number' ? x : parseFloat(String(x).replace(',', '.'));
  };
  const has = (x) => Number.isFinite(num(x));
  const f0 = (x) => formatNumber(num(x), 0);

  ['s1', 's2'].forEach((s) => {
    ['hot', 'cold'].forEach((c) => {
      const tin = v[`t_in_${s}_${c}`], tout = v[`t_out_${s}_${c}`];
      if (has(tin) && has(tout)) v[`temp_${s}_${c}`] = `${f0(tin)}-${f0(tout)}`;
    });
    const ka = v[`heat_transfer_coef_actual_${s}`], kr = v[`heat_transfer_coef_required_${s}`];
    if (has(ka) && has(kr)) v[`heat_transfer_coef_combined_${s}`] = `${f0(ka)}/${f0(kr)}`;
    else if (has(ka)) v[`heat_transfer_coef_combined_${s}`] = f0(ka);
    const sm = v[`surface_margin_${s}`];
    if (has(sm)) {
      // РОВНО 2 знака после ТОЧКИ, без знака "%" (колонка "Ед.изм" уже
      // печатает "%" отдельно — см. комментарий у обычного surface_margin_pct
      // выше; единый разделитель-точка — по просьбе пользователя).
      const t = formatFixed(recoverLostDecimal(num(sm)), 2);
      if (t) v[`surface_margin_pct_${s}`] = t;
    }
  });

  // "Поверхность теплообмена" — ОДНА строка на весь аппарат, не по ступеням
  // (согласовано с пользователем 07.09.2026): физически это площадь ОДНОГО
  // и того же пластинчатого пакета, в спецификации BelTO указана в блоке
  // "Характеристики" отдельно на каждую ступень, но обе строки — одно и то
  // же число (проверено на реальном примере: 44.80 / 44.80). Берём значение
  // любой ступени, где оно есть. 2 знака после точки, всегда (даже с нулём
  // на конце) — по просьбе пользователя.
  if (has(v.heat_surface_s1) || has(v.heat_surface_s2)) {
    v.heat_surface = formatFixed(has(v.heat_surface_s1) ? num(v.heat_surface_s1) : num(v.heat_surface_s2), 2);
  }

  // Тепловая нагрузка ГВС — 3 знака после точки, всегда (даже с нулями на
  // конце) — по просьбе пользователя.
  //
  // В документе эта надпись встречается ДВАЖДЫ: в "ИСХОДНЫХ ДАННЫХ" — это
  // ОБЩАЯ нагрузка на весь аппарат (обе ступени вместе, heat_load_gvs), а
  // в "РАСЧЁТЕ" — та же нагрузка, но РАЗДЕЛЁННАЯ по ступеням, как в самой
  // спецификации (heat_load_gvs_s2/heat_load_gvs_s1, по аналогии с
  // остальными строками расчёта — "Расход", "Потери давления" и т.п.).
  // Замечено пользователем 08.09.2026: раньше в "РАСЧЁТЕ" по ошибке
  // печаталась та же ОБЩАЯ сумма, что и в "Исходных данных".
  if (has(v.heat_power_s1) && has(v.heat_power_s2)) {
    v.heat_load_gvs = formatFixed(num(v.heat_power_s1) + num(v.heat_power_s2), 3);
  } else if (has(v.heat_power_s1) || has(v.heat_power_s2)) {
    v.heat_load_gvs = formatFixed(has(v.heat_power_s1) ? num(v.heat_power_s1) : num(v.heat_power_s2), 3);
  }
  if (has(v.heat_power_s2)) v.heat_load_gvs_s2 = formatFixed(num(v.heat_power_s2), 3);
  if (has(v.heat_power_s1)) v.heat_load_gvs_s1 = formatFixed(num(v.heat_power_s1), 3);

  // Температурный график сетевой воды у моноблока вводится инженером вручную
  // (в спецификации нет) — производное значение НЕ подставляем. Точка
  // излома — из спецификации: вход греющей во II ступень / выход из I.
  if (has(v.t_in_s2_hot) && has(v.t_out_s1_hot)) {
    v.temp_graph_break = `${f0(v.t_in_s2_hot)}/${f0(v.t_out_s1_hot)}`;
  }

  const total = Math.round(num(v.passes_count));
  if (Number.isFinite(total) && total >= 2) {
    v.passes_s2 = '1';
    v.passes_s1 = String(total - 1);
  } else {
    v.passes_s2 = '1';
    v.passes_s1 = '1';
  }
  return v;
}

// Марка моноблока: <марка из бланка>-<кол-во пластин>-<исполнение> (<раскладка
// II ступени>)+(<раскладка I ступени>) — группы в порядке ступеней В
// ДОКУМЕНТЕ (II слева, I справа), согласовано с пользователем; пример:
// ТОР-41-115-2хБГВ (24LL)+(33LL) (пробел перед первой скобкой — правка
// пользователя от 07.09.2026).
function buildMonoblockModel(v) {
  if (!(v.plates_count && v.model_base && v.model_execution)) return null;
  const blocks = [v.channel_layout_s2, v.channel_layout_s1].filter(Boolean);
  if (!blocks.length) return null;
  const marking = blocks.map((b) => `(${b})`).join('+');
  return `${v.model_base}-${Math.round(parseFloat(v.plates_count))}-${v.model_execution} ${marking}`;
}

// ---------------------------------------------------------------------------
// МОНОБЛОК ИЗ ДВУХ ОТДЕЛЬНЫХ ФАЙЛОВ (режим "Два файла" в app.js) — каждая
// ступень считалась в BelTO как САМОСТОЯТЕЛЬНЫЙ (обычный, не-моноблочный)
// аппарат и выгружена отдельным HTML/PDF файлом. В отличие от МОНОБЛОК-
// спецификации выше (одна общая выгрузка с 4-колоночной шапкой "Cтупень |
// I | II") здесь на входе — два НЕЗАВИСИМЫХ набора обычных source-значений
// (после parseBeltoText для не-моноблочного текста, т.е. с обычными ключами
// t_in_hot/t_in_cold/flow_hot/... без суффиксов ступеней). Эта функция сшивает
// их в тот же вид (*_s1/*_s2), что ждут deriveMonoblockValues / buildMonoblockModel
// / MONOBLOCK_VALUE_KEYS — дальше форма и генерация документа работают как
// для обычного моноблока.
//
// Согласовано с пользователем (см. обсуждение):
//  - I ступень — файл с НАИМЕНЬШЕЙ температурой на входе НАГРЕВАЕМОЙ
//    (холодной) среды (обычно ~5°C, свежая вода); второй файл — II ступень.
//  - Количество пластин марки = пластины II ступени + (пластины I ступени - 1).
//  - Число ходов каждой ступени берётся НАПРЯМУЮ из её собственной
//    спецификации (без эвристики "1|(N-1)", применяемой для одного общего файла).
//  - Поверхность теплообмена = СУММА площадей обеих ступеней (в отличие от
//    случая с одним файлом, где обе строки в спецификации — одна и та же
//    физическая площадь общего пакета).
function mergeTwoStageSpecs(valuesA, valuesB) {
  const num = (x) => {
    if (x === null || x === undefined || x === '') return NaN;
    return typeof x === 'number' ? x : parseFloat(String(x).replace(',', '.'));
  };
  const has = (x) => Number.isFinite(num(x));

  // I ступень — меньшая температура на входе нагреваемой (холодной) среды.
  // Если у обоих файлов её не нашлось (нестандартная спецификация) — берём
  // порядок загрузки как есть (первый файл = I ступень).
  const aCold = num(valuesA.t_in_cold);
  const bCold = num(valuesB.t_in_cold);
  let stage1, stage2;
  if (has(aCold) && has(bCold)) {
    stage1 = aCold <= bCold ? valuesA : valuesB;
    stage2 = aCold <= bCold ? valuesB : valuesA;
  } else {
    stage1 = valuesA;
    stage2 = valuesB;
  }
  // Подстраховка/самопроверка: вход греющей среды у II ступени должен быть
  // ВЫШЕ, чем у I (сетевая вода идёт по контуру II -> I, охлаждаясь) — если
  // это не так, данные необычные, но не блокируем, только предупреждаем в консоли.
  if (has(num(stage1.t_in_hot)) && has(num(stage2.t_in_hot)) && num(stage2.t_in_hot) < num(stage1.t_in_hot)) {
    console.warn('mergeTwoStageSpecs: температура на входе греющей среды у определённой как II ступень ниже, чем у I — проверьте, что файлы не перепутаны местами (порядок определяется по наименьшей температуре нагреваемой среды на входе).');
  }

  const v = { is_monoblock: true };

  ['hot', 'cold'].forEach((c) => {
    v[`t_in_s1_${c}`] = stage1[`t_in_${c}`];
    v[`t_in_s2_${c}`] = stage2[`t_in_${c}`];
    v[`t_out_s1_${c}`] = stage1[`t_out_${c}`];
    v[`t_out_s2_${c}`] = stage2[`t_out_${c}`];
    v[`flow_s1_${c}`] = stage1[`flow_${c}`];
    v[`flow_s2_${c}`] = stage2[`flow_${c}`];
    v[`dp_s1_${c}`] = stage1[`dp_${c}`];
    v[`dp_s2_${c}`] = stage2[`dp_${c}`];
  });

  v.heat_power_s1 = stage1.heat_power;
  v.heat_power_s2 = stage2.heat_power;
  v.surface_margin_s1 = stage1.surface_margin;
  v.surface_margin_s2 = stage2.surface_margin;
  v.heat_transfer_coef_actual_s1 = stage1.heat_transfer_coef_actual;
  v.heat_transfer_coef_actual_s2 = stage2.heat_transfer_coef_actual;
  v.heat_transfer_coef_required_s1 = stage1.heat_transfer_coef_required;
  v.heat_transfer_coef_required_s2 = stage2.heat_transfer_coef_required;
  v.channel_layout_s1 = stage1.channel_layout;
  v.channel_layout_s2 = stage2.channel_layout;

  v.flow_unit = stage2.flow_unit || stage1.flow_unit;
  v.dp_unit = stage2.dp_unit || stage1.dp_unit;
  v.heat_load_unit = stage2.heat_load_unit || stage1.heat_load_unit;
  v.heat_medium_hot = stage2.heat_medium_hot || stage1.heat_medium_hot;
  v.heat_medium_cold = stage2.heat_medium_cold || stage1.heat_medium_cold;
  v.dn_hot = stage2.dn_hot || stage1.dn_hot;
  v.dn_cold = stage2.dn_cold || stage1.dn_cold;
  if (v.dn_hot !== undefined) v.dn = v.dn_hot;
  v.mass_empty = stage2.mass_empty || stage1.mass_empty;
  v.mass_filled = stage2.mass_filled || stage1.mass_filled;
  v.model = stage2.model || stage1.model;

  // Производные поля (температуры вход-выход по ступеням, коэффициенты
  // "факт/необходимый", % запаса, разбивка нагрузки ГВС, точка излома
  // графика) — та же логика, что и для одного файла с готовой моноблок-
  // спецификацией.
  deriveMonoblockValues(v);

  // Поверхность теплообмена — здесь, В ОТЛИЧИЕ от случая с одним файлом, это
  // ДВА физически разных пластинчатых пакета (два отдельных расчёта BelTO),
  // поэтому суммируем, а не берём одно и то же число (перекрываем то, что
  // уже (неверно для этого случая) посчитал deriveMonoblockValues выше).
  if (has(stage1.heat_surface) || has(stage2.heat_surface)) {
    const sum = (has(stage1.heat_surface) ? num(stage1.heat_surface) : 0) + (has(stage2.heat_surface) ? num(stage2.heat_surface) : 0);
    v.heat_surface = formatFixed(sum, 2);
  }

  // Число ходов — напрямую из каждой ступени, без эвристики "1|(N-1)"
  // (перекрываем то, что посчитал deriveMonoblockValues выше).
  if (has(stage1.passes_count)) v.passes_s1 = String(Math.round(num(stage1.passes_count)));
  if (has(stage2.passes_count)) v.passes_s2 = String(Math.round(num(stage2.passes_count)));

  // Количество пластин марки = пластины II ступени + (пластины I ступени - 1)
  // — общий для двух ступеней пакет, где перегородочная пластина между
  // ступенями учтена в обеих спецификациях по отдельности.
  if (has(stage1.plates_count) && has(stage2.plates_count)) {
    v.plates_count = String(Math.round(num(stage2.plates_count) + (num(stage1.plates_count) - 1)));
  } else {
    v.plates_count = stage2.plates_count || stage1.plates_count;
  }

  v.__stage1FileName = stage1.__fileName || '';
  v.__stage2FileName = stage2.__fileName || '';

  return v;
}
