/*
 * fieldMap.js
 * Описание шаблонов (.vsdx) и соответствия полей.
 *
 * Каждый шаблон описывается:
 *  - id, title, file (путь к .vsdx в /templates)
 *  - fields: массив логических полей формы
 *      key         - внутренний ключ
 *      label       - подпись в форме
 *      group       - "auto" (авто из распознавания, но редактируемое) | "manual" (всегда пустое, вводится вручную)
 *      shapeIds    - ID фигур в visio/pages/page1.xml, куда пишется значение (может быть несколько -
 *                    например если в шаблоне значение продублировано в двух визуально одинаковых ячейках)
 *      unit        - единица измерения, которая ожидается В ШАБЛОНЕ
 *      sourceKeys  - список ключей из распознанной спецификации BelTO, откуда берётся значение
 *                    (см. beltoParser.js), в порядке приоритета
 *      sourceUnit  - единица измерения поля-источника (для конвертации)
 *      convert     - имя функции конвертации из units.js (или null, если конвертация не нужна)
 *      notes       - пояснение для пользователя (показывается как подсказка)
 */

const TEMPLATES = [
  {
    id: 'tor-15m-13-1x',
    title: 'ТОР-15М/13-1х (LL+НН)',
    file: 'templates/TOR-15M_13-1x.vsdx',
    // Настоящий фирменный бланк (PDF) для этой модели — используется при
    // "Скачать PDF" (см. handleGeneratePdf в app.js). Координаты полей общие
    // для всей линейки бланков БСИ (js/builtinPdfMapping.js).
    pdfFile: 'templates/TOR-15M_13-1x-original.pdf',
    previewImage: 'templates/TOR-15M_13-1x-preview.png',
    fields: [
      // --- Ручной ввод (в спецификации BelTO этих данных нет) ---
      { key: 'customer',        label: 'Заказчик',                         group: 'manual', shapeIds: [12], unit: null, notes: '' },
      { key: 'site',             label: 'Место установки',                  group: 'manual', shapeIds: [27], unit: null, notes: '' },
      { key: 'contact_person',   label: 'Фамилия И.О. (контактное лицо)',   group: 'manual', shapeIds: [11], unit: null, notes: '' },
      { key: 'contact_info',     label: 'Телефон, факс, E-mail',            group: 'manual', shapeIds: [13], unit: null, notes: '' },
      { key: 'calc_number',      label: 'Номер расчёта',                    group: 'manual', shapeIds: [1797], unit: null, notes: 'Введите только номер, например 19234 — месяц и год подставятся автоматически по сегодняшней дате: получится "19234/09-2026". После первого расчёта поле само подставляет следующий номер (из журнала) — можно менять вручную' },
      { key: 'price_unit',       label: 'Цена без НДС за единицу, руб',     group: 'manual', shapeIds: [31], unit: 'руб', notes: 'Округляется до 2 знаков после точки при вводе' },
      { key: 'price_total',      label: 'ИТОГО цена без НДС, руб',          group: 'manual', shapeIds: [36, 1794], unit: 'руб', notes: 'Округляется до 2 знаков после точки при вводе' },
      { key: 'executor',         label: 'Расчёт выполнил (ФИО)',            group: 'manual', shapeIds: [56], unit: null, notes: 'Дата проставляется автоматически текущим числом (дд/мм/гггг) — вводить не нужно' },
      { key: 'journal_note',     label: 'Примечание (для журнала расчётов)', group: 'manual', shapeIds: [], unit: null, notes: 'Необязательно — короткая заметка для столбца «Примечание» в журнале расчётов (Google-таблица), в сам документ не попадает' },

      // --- Автозаполнение из спецификации BelTO (можно поправить руками) ---
      { key: 'model',
        label: 'Марка теплообменника',
        group: 'auto', shapeIds: [339], unit: null,
        // Базовая марка (например "ТОР-15М/13") и код исполнения (например
        // "1х", "2хЦ", "3хБГВ") берутся из текстового слоя PDF-бланка
        // (app.js -> modelExtract.js, поля v.model_base/v.model_execution,
        // проставляются до вызова compute) — работает для любого загруженного
        // бланка этой линейки, без зашитого значения по умолчанию. Количество
        // пластин и раскладка каналов по-прежнему берутся из спецификации
        // BelTO — это надёжнее, чем строка "Теплообменник Пластинчатый..."
        // из спецификации, которая на OCR часто искажается. Если марку/
        // исполнение не удалось распознать в бланке — поле остаётся пустым
        // (compute вернёт null), сотрудник заполняет его вручную — статус
        // после разбора спецификации явно предупреждает об этом (см. app.js).
        compute: (v) => (v.plates_count && v.channel_layout && v.model_base && v.model_execution)
          ? `${v.model_base}-${Math.round(parseFloat(v.plates_count))}-${v.model_execution} ${buildChannelLayoutMarking(v.channel_layout, v.passes_count)}`
          : null,
        sourceKeys: ['model'], sourceUnit: null, convert: null,
        notes: 'Собирается автоматически как <марка из бланка>-<кол-во пластин>-<исполнение из бланка>(<раскладка каналов>) — для многоходовых аппаратов блок раскладки повторяется по числу ходов, например (9HL+2LL)+(9HL+2LL) для 2 ходов; если марка/исполнение не распознались из PDF, заполните вручную' },

      { key: 'heat_load',
        label: 'Тепловая нагрузка',
        group: 'auto', shapeIds: [136], unit: null, decimals: 3,
        sourceKeys: ['heat_power'], sourceUnit: null, convert: null,
        notes: 'Единица измерения переносится из спецификации как есть (Гкал/ч, кВт и т.п. — см. поле "Ед.изм" в документе), число не пересчитывается. Формат: 3 знака после точки (даже нулевые)' },

      { key: 'temp_graph',
        label: 'Температурный график греющей среды, °C',
        group: 'auto', shapeIds: [289], unit: '°C',
        sourceKeys: ['temp_graph'], sourceUnit: '°C', convert: null,
        notes: 'Формат вида 95/70 — вход/выход. Если в спецификации нет отдельного поля, соберите вручную из температур входа/выхода.' },

      { key: 'temp_hot',
        label: 'Температура вход-выход, греющий контур, °C',
        group: 'auto', shapeIds: [51], unit: '°C',
        sourceKeys: ['temp_in_hot_out_hot'], sourceUnit: '°C', convert: null,
        notes: 'Формат: вход-выход через тире, например 95-70' },

      { key: 'temp_cold',
        label: 'Температура вход-выход, нагреваемый контур, °C',
        group: 'auto', shapeIds: [746], unit: '°C',
        sourceKeys: ['temp_in_cold_out_cold'], sourceUnit: '°C', convert: null,
        notes: 'Формат: вход-выход через тире, например 65-90' },

      { key: 'flow_hot',
        label: 'Расход, греющий контур',
        group: 'auto', shapeIds: [94], unit: null, decimals: 2,
        sourceKeys: ['flow_hot'], sourceUnit: null, convert: null,
        notes: 'Единица измерения переносится из спецификации как есть (см. поле "Ед.изм" в документе). Формат: 2 знака после точки (даже нулевые)' },

      { key: 'flow_cold',
        label: 'Расход, нагреваемый контур',
        group: 'auto', shapeIds: [747, 350], unit: null, decimals: 2,
        sourceKeys: ['flow_cold'], sourceUnit: null, convert: null,
        notes: 'В шаблоне обнаружены две наложенные ячейки (747 и 350) — значение пишется в обе на всякий случай. Единица измерения переносится из спецификации как есть. Формат: 2 знака после точки (даже нулевые)' },

      // ВАЖНО: convert теперь ФУНКЦИЯ, а не имя готового конвертера — единица
      // измерения потерь давления в разных спецификациях может отличаться
      // (кПа/бар/уже кгс/см2), и раньше программа слепо считала её всегда
      // кПа. Реальная единица берётся из спецификации (dp_unit, см.
      // beltoParser.js/extract.js) и подставляется в колонку "Ед.изм"
      // документа (resolveDynamicUnits в app.js) — конвертация в кгс/см2
      // (принятый в БСИ формат подачи) применяется, только если единица
      // ОПОЗНАНА как кПа/бар/кгс/см2; для незнакомой единицы конвертация не
      // выполняется (чтобы не домножить на неверный коэффициент), значение
      // и её собственная подпись переносятся как есть.
      { key: 'dp_hot',
        label: 'Потери давления, греющий контур, кг/см2',
        group: 'auto', shapeIds: [95], unit: 'кг/см2', decimals: 3,
        sourceKeys: ['dp_hot'], sourceUnit: 'кПа',
        convert: (raw, sourceValues) => convertDpToKgfCm2(raw, sourceValues && sourceValues.dp_unit),
        notes: 'Конвертируется в кгс/см2, если единица в спецификации опознана (кПа/бар) — иначе переносится как в спецификации. Формат: 3 знака после точки (даже нулевые)' },

      { key: 'dp_cold',
        label: 'Потери давления, нагреваемый контур, кг/см2',
        group: 'auto', shapeIds: [15], unit: 'кг/см2', decimals: 3,
        sourceKeys: ['dp_cold'], sourceUnit: 'кПа',
        convert: (raw, sourceValues) => convertDpToKgfCm2(raw, sourceValues && sourceValues.dp_unit),
        notes: 'Конвертируется в кгс/см2, если единица в спецификации опознана (кПа/бар) — иначе переносится как в спецификации. Формат: 3 знака после точки (даже нулевые)' },

      { key: 'plates_count',
        label: 'Количество пластин, шт',
        group: 'auto', shapeIds: [117], unit: 'шт',
        sourceKeys: ['plates_count'], sourceUnit: 'шт', convert: null, notes: '' },

      { key: 'passes_count',
        label: 'Число ходов',
        group: 'auto', shapeIds: [119], unit: null,
        sourceKeys: ['passes_count'], sourceUnit: null, convert: null,
        notes: 'В шаблоне по умолчанию стоит "1"' },

      { key: 'heat_transfer_coef',
        label: 'Коэффициент теплопередачи (факт./необходимый), Вт/м2°C',
        group: 'auto', shapeIds: [121], unit: 'Вт/м2°C',
        // В шаблоне одна ячейка — пишем "фактический/необходимый" (напр. 4431/4210)
        sourceKeys: ['heat_transfer_coef_combined', 'heat_transfer_coef_actual'], sourceUnit: 'Вт/м2°K', convert: null,
        notes: 'Вт/(м²·К) численно равно Вт/(м²·°C) — конвертация не требуется. Формат: фактический/необходимый' },

      { key: 'surface_margin',
        label: 'Запас по поверхности, %',
        group: 'auto', shapeIds: [123], unit: '%',
        sourceKeys: ['surface_margin_pct', 'surface_margin'], sourceUnit: '%', convert: null,
        notes: 'Формат: 2 знака после точки, например 5.26 (без знака % — он уже напечатан в колонке "Ед.изм")' },

      { key: 'heat_surface',
        label: 'Поверхность теплообмена, м2',
        group: 'auto', shapeIds: [126], unit: 'м2', decimals: 2,
        sourceKeys: ['heat_surface'], sourceUnit: 'м2', convert: null,
        notes: 'Формат: 2 знака после точки (даже нулевые)' },

      { key: 'dn',
        label: 'Условный диаметр DN, мм (все патрубки)',
        group: 'auto', shapeIds: [7, 42, 43, 45], unit: 'мм',
        sourceKeys: ['dn'], sourceUnit: 'мм', convert: null,
        notes: 'По умолчанию в шаблоне везде стоит 50 — значение подставляется во все 4 патрубка (Т1,Т2,В1,Т3)' },

      { key: 'mass',
        label: 'Масса, кг',
        group: 'auto', shapeIds: [111], unit: 'кг',
        sourceKeys: ['mass_filled', 'mass_empty'], sourceUnit: 'кг', convert: null,
        notes: 'Берётся вес заполненного теплообменника, если есть в спецификации, иначе — пустого' },

      { key: 'dim_l',
        label: 'L, мм (длина)',
        group: 'manual', shapeIds: [748], unit: 'мм',
        notes: 'В спецификации BelTO обычно отсутствует, зависит от исполнения рамы — проверьте по чертежу/каталогу' },

      { key: 'dim_a',
        label: 'A, мм (размер стяжки)',
        group: 'manual', shapeIds: [], unit: 'мм',
        notes: 'В спецификации BelTO обычно отсутствует, зависит от исполнения рамы — проверьте по чертежу/каталогу' },

      { key: 'heat_medium_hot',
        label: 'Среда, греющий контур',
        group: 'auto', shapeIds: [], unit: null,
        sourceKeys: ['heat_medium_hot'], sourceUnit: null, convert: null,
        notes: 'Берётся из строки "Среда" в спецификации (например "Вода") — для HTML-отчёта точно по ячейке, для PDF/скана — если распозналось однозначно' },

      { key: 'heat_medium_cold',
        label: 'Среда, нагреваемый контур',
        group: 'auto', shapeIds: [], unit: null,
        sourceKeys: ['heat_medium_cold'], sourceUnit: null, convert: null,
        notes: 'Берётся из строки "Среда" в спецификации (например "Вода") — для HTML-отчёта точно по ячейке, для PDF/скана — если распозналось однозначно' },

      { key: 'certificates_note',
        label: 'Блок "Примечание" (сертификаты, ТР ТС, материалы)',
        group: 'manual', shapeIds: [], unit: null, multiline: true,
        notes: 'Текст подставляется автоматически из загруженного PDF-бланка — проверьте и поправьте при необходимости (например номер/дату сертификата)' },
    ],
  },

  // -------------------------------------------------------------------
  // МОНОБЛОК (2хБГВ/3хБГВ — "блок горячей воды", две ступени нагрева в
  // одном корпусе). Отдельный шаблон Word (BSI-letterhead-monoblock-
  // template.docx, 4 столбца данных + 6 патрубков) — см. план в проекте
  // ("короткий расчет теплообменников" -> claude/monoblock-2xBGV-plan.md).
  // Режим переключается автоматически (is_monoblock из спецификации), см.
  // app.js. Порядок ступеней в тегах — II слева, I справа, как в бланке
  // (согласовано с пользователем 07.09.2026); значения из спецификации
  // (I слева) переставляются в buildLetterheadValues (app.js).
  {
    id: 'tor-monoblock-2xbgv',
    title: 'Моноблок (2хБГВ/3хБГВ)',
    file: 'templates/BSI-letterhead-monoblock-template.docx',
    fields: [
      { key: 'customer',        label: 'Заказчик',                         group: 'manual', shapeIds: [], unit: null, notes: '' },
      { key: 'site',             label: 'Место установки',                  group: 'manual', shapeIds: [], unit: null, notes: '' },
      { key: 'contact_person',   label: 'Фамилия И.О. (контактное лицо)',   group: 'manual', shapeIds: [], unit: null, notes: '' },
      { key: 'contact_info',     label: 'Телефон, факс, E-mail',            group: 'manual', shapeIds: [], unit: null, notes: '' },
      { key: 'calc_number',      label: 'Номер расчёта',                    group: 'manual', shapeIds: [], unit: null, notes: 'Введите только номер — месяц и год подставятся автоматически по сегодняшней дате. После первого расчёта поле само подставляет следующий номер (из журнала) — можно менять вручную' },
      { key: 'price_unit',       label: 'Цена без НДС за единицу, руб',     group: 'manual', shapeIds: [], unit: 'руб', notes: 'Округляется до 2 знаков после точки при вводе' },
      { key: 'price_total',      label: 'ИТОГО цена без НДС, руб',          group: 'manual', shapeIds: [], unit: 'руб', notes: 'Округляется до 2 знаков после точки при вводе' },
      { key: 'executor',         label: 'Расчёт выполнил (ФИО)',            group: 'manual', shapeIds: [], unit: null, notes: 'Дата проставляется автоматически текущим числом' },
      { key: 'journal_note',     label: 'Примечание (для журнала расчётов)', group: 'manual', shapeIds: [], unit: null, notes: 'Необязательно — короткая заметка для столбца «Примечание» в журнале расчётов (Google-таблица), в сам документ не попадает' },

      // В спецификации BelTO этих двух данных нет — вводит инженер вручную
      // (согласовано с пользователем 07.09.2026).
      { key: 'heat_load_heating', label: 'Тепловая нагрузка отопления',     group: 'manual', shapeIds: [], unit: null, notes: 'В спецификации отсутствует — введите вручную только число (единицу — в поле ниже)' },
      { key: 'heat_load_heating_unit', label: 'Ед.изм. нагрузки отопления', group: 'manual', shapeIds: [], unit: null, notes: 'По умолчанию подставляется та же единица, что и у нагрузки ГВС (из спецификации) — при необходимости замените, например на кВт, МВт или ккал/ч; единица нагрузки ГВС при этом не меняется' },
      { key: 'temp_graph',        label: 'Температурный график греющей среды, °C', group: 'manual', shapeIds: [], unit: '°C', notes: 'В спецификации отсутствует — введите вручную, например 130/70' },

      { key: 'model',
        label: 'Марка теплообменника',
        group: 'auto', shapeIds: [], unit: null,
        compute: (v) => buildMonoblockModel(v),
        sourceKeys: ['model'], sourceUnit: null, convert: null,
        notes: 'Собирается автоматически как <марка из бланка>-<кол-во пластин>-<исполнение>(<раскладка II ступени>)+(<раскладка I ступени>), например ТОР-41-115-2хБГВ(24LL)+(33LL)' },

      { key: 'heat_load_gvs',
        label: 'Тепловая нагрузка ГВС (Исходные данные — сумма по ступеням)',
        group: 'auto', shapeIds: [], unit: null,
        sourceKeys: ['heat_load_gvs'], sourceUnit: null, convert: null,
        notes: 'Сумма мощностей I и II ступени из спецификации; единица измерения — как в спецификации. Печатается в "Исходных данных"' },

      // Те же мощности, но РАЗДЕЛЁННЫЕ по ступеням — для строки "Тепловая
      // нагрузка ГВС" в разделе "РАСЧЁТ" (в отличие от heat_load_gvs выше,
      // который печатается ТОЛЬКО в "Исходных данных" как общая сумма).
      { key: 'heat_load_gvs_s2',
        label: 'Тепловая нагрузка ГВС, II ступень (Расчёт)',
        group: 'auto', shapeIds: [], unit: null,
        sourceKeys: ['heat_load_gvs_s2'], sourceUnit: null, convert: null,
        notes: 'Мощность II ступени из спецификации, 3 знака после точки. Печатается в разделе "Расчёт"' },
      { key: 'heat_load_gvs_s1',
        label: 'Тепловая нагрузка ГВС, I ступень (Расчёт)',
        group: 'auto', shapeIds: [], unit: null,
        sourceKeys: ['heat_load_gvs_s1'], sourceUnit: null, convert: null,
        notes: 'Мощность I ступени из спецификации, 3 знака после точки. Печатается в разделе "Расчёт"' },

      { key: 'heat_medium_s2_hot', label: 'Среда, II ступень, греющий контур',    group: 'auto', shapeIds: [], unit: null, sourceKeys: ['heat_medium_hot'], sourceUnit: null, convert: null, notes: 'Из строки "Среда" в спецификации' },
      { key: 'heat_medium_s2_cold', label: 'Среда, II ступень, нагреваемый контур', group: 'auto', shapeIds: [], unit: null, sourceKeys: ['heat_medium_cold'], sourceUnit: null, convert: null, notes: 'Из строки "Среда" в спецификации' },
      { key: 'heat_medium_s1_hot', label: 'Среда, I ступень, греющий контур',     group: 'auto', shapeIds: [], unit: null, sourceKeys: ['heat_medium_hot'], sourceUnit: null, convert: null, notes: 'Из строки "Среда" в спецификации (обычно совпадает для обеих ступеней)' },
      { key: 'heat_medium_s1_cold', label: 'Среда, I ступень, нагреваемый контур', group: 'auto', shapeIds: [], unit: null, sourceKeys: ['heat_medium_cold'], sourceUnit: null, convert: null, notes: 'Из строки "Среда" в спецификации (обычно совпадает для обеих ступеней)' },

      { key: 'temp_s2_hot',  label: 'Температура вход-выход, II ступень, греющий, °C',     group: 'auto', shapeIds: [], unit: '°C', sourceKeys: ['temp_s2_hot'], sourceUnit: '°C', convert: null, notes: '' },
      { key: 'temp_s2_cold', label: 'Температура вход-выход, II ступень, нагреваемый, °C', group: 'auto', shapeIds: [], unit: '°C', sourceKeys: ['temp_s2_cold'], sourceUnit: '°C', convert: null, notes: '' },
      { key: 'temp_s1_hot',  label: 'Температура вход-выход, I ступень, греющий, °C',      group: 'auto', shapeIds: [], unit: '°C', sourceKeys: ['temp_s1_hot'], sourceUnit: '°C', convert: null, notes: '' },
      { key: 'temp_s1_cold', label: 'Температура вход-выход, I ступень, нагреваемый, °C',  group: 'auto', shapeIds: [], unit: '°C', sourceKeys: ['temp_s1_cold'], sourceUnit: '°C', convert: null, notes: '' },

      { key: 'flow_s2_hot',  label: 'Расход, II ступень, греющий контур',     group: 'auto', shapeIds: [], unit: null, sourceKeys: ['flow_s2_hot'], sourceUnit: null, convert: null, decimals: 2, notes: 'Единица — из спецификации. Формат: 2 знака после точки (даже нулевые)' },
      { key: 'flow_s2_cold', label: 'Расход, II ступень, нагреваемый контур', group: 'auto', shapeIds: [], unit: null, sourceKeys: ['flow_s2_cold'], sourceUnit: null, convert: null, decimals: 2, notes: 'Единица — из спецификации. Формат: 2 знака после точки (даже нулевые)' },
      { key: 'flow_s1_hot',  label: 'Расход, I ступень, греющий контур',      group: 'auto', shapeIds: [], unit: null, sourceKeys: ['flow_s1_hot'], sourceUnit: null, convert: null, decimals: 2, notes: 'Единица — из спецификации. Формат: 2 знака после точки (даже нулевые)' },
      { key: 'flow_s1_cold', label: 'Расход, I ступень, нагреваемый контур',  group: 'auto', shapeIds: [], unit: null, sourceKeys: ['flow_s1_cold'], sourceUnit: null, convert: null, decimals: 2, notes: 'Единица — из спецификации. Формат: 2 знака после точки (даже нулевые)' },

      { key: 'dp_s2_hot',  label: 'Потери давления, II ступень, греющий контур',     group: 'auto', shapeIds: [], unit: 'кг/см2', sourceKeys: ['dp_s2_hot'], sourceUnit: 'кПа', convert: (raw, sv) => convertDpToKgfCm2(raw, sv && sv.dp_unit), decimals: 3, notes: 'Конвертируется в кгс/см2, если единица опознана. Формат: 3 знака после точки (даже нулевые)' },
      { key: 'dp_s2_cold', label: 'Потери давления, II ступень, нагреваемый контур', group: 'auto', shapeIds: [], unit: 'кг/см2', sourceKeys: ['dp_s2_cold'], sourceUnit: 'кПа', convert: (raw, sv) => convertDpToKgfCm2(raw, sv && sv.dp_unit), decimals: 3, notes: 'Конвертируется в кгс/см2, если единица опознана. Формат: 3 знака после точки (даже нулевые)' },
      { key: 'dp_s1_hot',  label: 'Потери давления, I ступень, греющий контур',      group: 'auto', shapeIds: [], unit: 'кг/см2', sourceKeys: ['dp_s1_hot'], sourceUnit: 'кПа', convert: (raw, sv) => convertDpToKgfCm2(raw, sv && sv.dp_unit), decimals: 3, notes: 'Конвертируется в кгс/см2, если единица опознана. Формат: 3 знака после точки (даже нулевые)' },
      { key: 'dp_s1_cold', label: 'Потери давления, I ступень, нагреваемый контур',  group: 'auto', shapeIds: [], unit: 'кг/см2', sourceKeys: ['dp_s1_cold'], sourceUnit: 'кПа', convert: (raw, sv) => convertDpToKgfCm2(raw, sv && sv.dp_unit), decimals: 3, notes: 'Конвертируется в кгс/см2, если единица опознана. Формат: 3 знака после точки (даже нулевые)' },

      { key: 'plates_count', label: 'Количество пластин, шт', group: 'auto', shapeIds: [], unit: 'шт', sourceKeys: ['plates_count'], sourceUnit: 'шт', convert: null, notes: 'Общее число пластин на весь моноблок' },

      { key: 'passes_s2', label: 'Число ходов, II ступень', group: 'auto', shapeIds: [], unit: null, sourceKeys: ['passes_s2'], sourceUnit: null, convert: null, notes: 'Для 2хБГВ всегда 1 — проверьте' },
      { key: 'passes_s1', label: 'Число ходов, I ступень',  group: 'auto', shapeIds: [], unit: null, sourceKeys: ['passes_s1'], sourceUnit: null, convert: null, notes: 'Для 2хБГВ всегда 1; для 3хБГВ проверьте распределение (1+2)' },

      { key: 'heat_transfer_coef_s2', label: 'Коэффициент теплопередачи, II ступень (факт./необходимый), Вт/м2°C', group: 'auto', shapeIds: [], unit: 'Вт/м2°C', sourceKeys: ['heat_transfer_coef_combined_s2', 'heat_transfer_coef_actual_s2'], sourceUnit: 'Вт/м2°K', convert: null, notes: 'Формат: фактический/необходимый' },
      { key: 'heat_transfer_coef_s1', label: 'Коэффициент теплопередачи, I ступень (факт./необходимый), Вт/м2°C',  group: 'auto', shapeIds: [], unit: 'Вт/м2°C', sourceKeys: ['heat_transfer_coef_combined_s1', 'heat_transfer_coef_actual_s1'], sourceUnit: 'Вт/м2°K', convert: null, notes: 'Формат: фактический/необходимый' },

      { key: 'surface_margin_s2', label: 'Запас по поверхности, II ступень, %', group: 'auto', shapeIds: [], unit: '%', sourceKeys: ['surface_margin_pct_s2', 'surface_margin_s2'], sourceUnit: '%', convert: null, notes: '' },
      { key: 'surface_margin_s1', label: 'Запас по поверхности, I ступень, %',  group: 'auto', shapeIds: [], unit: '%', sourceKeys: ['surface_margin_pct_s1', 'surface_margin_s1'], sourceUnit: '%', convert: null, notes: '' },

      { key: 'heat_surface', label: 'Поверхность теплообмена, м2', group: 'auto', shapeIds: [], unit: 'м2', sourceKeys: ['heat_surface'], sourceUnit: 'м2', convert: null, notes: 'Одно значение на весь аппарат (общая площадь пластинчатого пакета) — не по ступеням' },

      { key: 'dn', label: 'Условный диаметр DN, мм (все 6 патрубков)', group: 'auto', shapeIds: [], unit: 'мм', sourceKeys: ['dn'], sourceUnit: 'мм', convert: null, notes: 'Подставляется во все 6 патрубков (Т1,Т2,В1,Т3,Т22,Т4)' },

      { key: 'mass', label: 'Масса, кг (пустого аппарата)', group: 'auto', shapeIds: [], unit: 'кг', sourceKeys: ['mass_empty', 'mass_filled'], sourceUnit: 'кг', convert: null, notes: 'Берётся вес ПУСТОГО теплообменника (для моноблока — по умолчанию, в отличие от обычного шаблона)' },

      { key: 'dim_l', label: 'L, мм (длина)', group: 'manual', shapeIds: [], unit: 'мм', notes: 'В спецификации BelTO обычно отсутствует — проверьте по чертежу/каталогу' },
      { key: 'dim_a', label: 'A, мм (размер стяжки)', group: 'manual', shapeIds: [], unit: 'мм', notes: 'В спецификации BelTO обычно отсутствует — проверьте по чертежу/каталогу' },

      { key: 'temp_graph_break',
        label: 'Температурный график в точке излома, °C',
        group: 'auto', shapeIds: [], unit: '°C',
        sourceKeys: ['temp_graph_break'], sourceUnit: '°C', convert: null,
        notes: 'Вход греющей среды во II ступень / выход греющей среды из I ступени — считается автоматически из спецификации' },

      { key: 'certificates_note',
        label: 'Блок "Примечание" (сертификаты, ТР ТС, материалы)',
        group: 'manual', shapeIds: [], unit: null, multiline: true,
        notes: 'Текст подставляется автоматически из загруженного PDF-бланка — проверьте и поправьте при необходимости (например номер/дату сертификата)' },
    ],
  },
];

function getTemplateById(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}
