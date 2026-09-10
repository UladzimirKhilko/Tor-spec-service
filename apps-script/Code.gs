/**
 * Code.gs — принимает POST-запрос от сервиса tor-spec-service и (1) добавляет
 * строку в лист "Журнал" привязанной Google Таблицы, в формате бумажного
 * журнала БСИ: № | Условное обозначение теплообменника | Дата | Объект |
 * Заказчик | Примечание, со строками-разделителями по году и месяцу
 * ("2020", "Январь" и т.п. — по образцу, который дал пользователь), и (2),
 * если в запросе передан сам файл — сохраняет .docx на Google Диск, в папку
 * "Документы" рядом с этой таблицей, сгруппированную по году и месяцу (та
 * же логика, что и в журнале) — см. saveDocumentToDrive ниже.
 *
 * УСТАНОВКА (см. подробно README.md, раздел "Журнал расчётов"):
 * 1. Создайте Google Таблицу (sheets.google.com) на нужном аккаунте.
 * 2. В таблице: Расширения -> Apps Script.
 * 3. Вставьте этот код вместо содержимого Code.gs, сохраните.
 * 4. Деплой -> Новый деплой -> тип "Веб-приложение":
 *      - Выполнять от имени: "Я"
 *      - У кого есть доступ: "Все"
 * 5. Скопируйте URL веб-приложения и вставьте его в js/config.js
 *    как APPS_SCRIPT_URL.
 *
 * Если журнал уже был настроен раньше и меняется только этот файл — не
 * нужен новый деплой: Деплой -> Управление деплоями -> карандаш (изменить)
 * у существующего веб-приложения -> Версия: "Новая версия" -> Деплой.
 * URL веб-приложения при этом не меняется, js/config.js трогать не нужно.
 */

const SHEET_NAME = 'Журнал';
const HEADERS = ['№', 'Условное обозначение теплообменника', 'Дата', 'Объект', 'Заказчик', 'Примечание'];
const NUM_COLS = HEADERS.length;
const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const DOCUMENTS_ROOT_FOLDER_NAME = 'Документы';

// GET .../exec?action=nextNumber — возвращает следующий номер расчёта
// (последний использованный номер + 1), чтобы сервис мог подставить его
// как подсказку в поле "Номер расчёта" при новом расчёте. Смотрит на
// числовую часть колонки "№" (до "/", например "5879" в "5879/09") по
// ВСЕМ строкам данных и берёт максимум — так надёжнее, чем "просто
// последняя строка", даже если кто-то отсортировал/добавил задним числом.
// Если данных ещё нет — nextNumber: null (инженер вводит первый номер сам).
function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === 'nextNumber') {
    try {
      const sheet = getOrCreateSheet();
      const lastRow = sheet.getLastRow();
      let maxNumber = null;
      if (lastRow >= 2) {
        const colA = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
        for (const [val] of colA) {
          const m = /^(\d+)\s*\//.exec(String(val).trim());
          if (m) {
            const n = parseInt(m[1], 10);
            if (maxNumber === null || n > maxNumber) maxNumber = n;
          }
        }
      }
      const nextNumber = maxNumber === null ? null : maxNumber + 1;
      return ContentService.createTextOutput(JSON.stringify({ ok: true, nextNumber: nextNumber }))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unknown action' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const sheet = getOrCreateSheet();
    ensureSectionHeaders(sheet, data.date);
    sheet.appendRow([
      data.number || '',
      data.model || '',
      data.date || '',
      data.site || '',
      data.customer || '',
      data.note || '',
    ]);
    // Сам файл .docx (необязательно) — сервис присылает его в том же
    // запросе, что и строку журнала (одна кнопка "Добавить в журнал" на
    // стороне сотрудника). Если fileBase64 не передан — ничего не сохраняем,
    // старое поведение (только строка в таблице) не меняется.
    //
    // Сохранение файла обёрнуто в СВОЙ try/catch: строка в журнал уже
    // добавлена (см. sheet.appendRow выше) и должна оставаться успешной,
    // даже если сохранение на Диск упадёт — и Logger.log здесь обязателен,
    // иначе ошибка проглатывается молча и не видна в "Выполнения" (это и
    // была причина, по которой баг было тяжело диагностировать 09.09.2026 —
    // ошибка есть, а в логе выполнения — просто "Выполнение завершено").
    let fileUrl = null;
    let fileError = null;
    if (data.fileBase64) {
      try {
        fileUrl = saveDocumentToDrive(data.date, data.fileName, data.fileBase64);
      } catch (fileErr) {
        fileError = String(fileErr);
        Logger.log('saveDocumentToDrive упал: ' + fileError);
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true, fileUrl: fileUrl, fileError: fileError }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('doPost упал (строка журнала не добавлена): ' + err);
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Папка "Документы" — создаётся (один раз, дальше переиспользуется) РЯДОМ
// с этой же таблицей: в той же папке Google Диска, где лежит сама таблица
// журнала — по просьбе пользователя, чтобы не искать файлы отдельно.
// Если у таблицы почему-то нет родительской папки (лежит в самом корне
// "Мой диск") — папка создаётся в корне Диска.
function getDocumentsRootFolder() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const file = DriveApp.getFileById(ss.getId());
  const parents = file.getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  return getOrCreateChildFolder(parent, DOCUMENTS_ROOT_FOLDER_NAME);
}

function getOrCreateChildFolder(parent, name) {
  const existing = parent.getFoldersByName(name);
  if (existing.hasNext()) return existing.next();
  return parent.createFolder(name);
}

// Сохраняет присланный .docx в "Документы/<год>/<ММ-Месяц>/<имя файла>" —
// та же группировка по году/месяцу, что и в самом журнале (ensureSectionHeaders
// выше), только оформленная как папки, а не строки-разделители. Если дата
// не распознана (не должно случаться — сервис всегда шлёт сегодняшнюю дату,
// см. formatTodayDateDMYDots в app.js) — сохраняет прямо в корень
// "Документы", без подпапок, чтобы файл в любом случае не потерялся.
function saveDocumentToDrive(dateStr, fileName, base64) {
  const root = getDocumentsRootFolder();
  let folder = root;
  const parts = String(dateStr || '').split('.');
  if (parts.length === 3) {
    const month = parseInt(parts[1], 10);
    const year = parts[2];
    if (month >= 1 && month <= 12 && /^\d{4}$/.test(year)) {
      const yearFolder = getOrCreateChildFolder(root, year);
      folder = getOrCreateChildFolder(yearFolder, `${String(month).padStart(2, '0')}-${MONTHS_RU[month - 1]}`);
    }
  }
  const bytes = Utilities.base64Decode(base64);
  const blob = Utilities.newBlob(bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName || 'расчёт.docx');
  const file = folder.createFile(blob);
  return file.getUrl();
}

function getOrCreateSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, NUM_COLS).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Перед добавлением строки — если начался новый год и/или новый месяц (по
// сравнению с последней такой же секцией в таблице), вставляет строку(и)
// "2026" / "Январь" (объединённые по всей ширине таблицы), как в образце
// бумажного журнала. Если у записи нет даты (dateStr пуст/не распознан) —
// секции не трогаем, строка просто добавится в конец.
function ensureSectionHeaders(sheet, dateStr) {
  const parts = String(dateStr || '').split('.');
  if (parts.length !== 3) return;
  const month = parseInt(parts[1], 10);
  const year = parts[2];
  if (!month || month < 1 || month > 12 || !/^\d{4}$/.test(year)) return;

  const state = readLastSectionState(sheet);
  if (state.year !== year) {
    appendSectionRow(sheet, year, true);
    appendSectionRow(sheet, MONTHS_RU[month - 1], false);
  } else if (state.month !== month) {
    appendSectionRow(sheet, MONTHS_RU[month - 1], false);
  }
}

function appendSectionRow(sheet, text, isYear) {
  const row = sheet.getLastRow() + 1;
  const range = sheet.getRange(row, 1, 1, NUM_COLS);
  range.merge();
  range.setValue(text);
  range.setHorizontalAlignment('center');
  range.setFontWeight('bold');
  range.setFontSize(isYear ? 13 : 11);
}

// Секционные строки (год/месяц) — это объединённая ячейка: в колонке A есть
// текст, а остальные колонки после merge читаются как пустые. Идём снизу
// вверх, пока не найдём последнюю строку года и последнюю строку месяца.
function readLastSectionState(sheet) {
  const lastRow = sheet.getLastRow();
  let year = null;
  let month = null;
  for (let r = lastRow; r >= 2; r--) {
    const rowVals = sheet.getRange(r, 1, 1, NUM_COLS).getValues()[0];
    const isSection = rowVals[0] !== '' && rowVals.slice(1).every((v) => v === '' || v === null);
    if (!isSection) continue;
    const text = String(rowVals[0]).trim();
    if (year === null && /^\d{4}$/.test(text)) {
      year = text;
    } else if (month === null) {
      const mi = MONTHS_RU.indexOf(text);
      if (mi >= 0) month = mi + 1;
    }
    if (year !== null && month !== null) break;
  }
  return { year: year, month: month };
}
