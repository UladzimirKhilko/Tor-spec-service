/**
 * Code.gs — принимает POST-запрос от сервиса tor-spec-service и добавляет
 * строку в лист "Журнал" привязанной Google Таблицы, в формате бумажного
 * журнала БСИ: № | Условное обозначение теплообменника | Дата | Объект |
 * Заказчик | Примечание, со строками-разделителями по году и месяцу
 * ("2020", "Январь" и т.п. — по образцу, который дал пользователь).
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
 */

const SHEET_NAME = 'Журнал';
const HEADERS = ['№', 'Условное обозначение теплообменника', 'Дата', 'Объект', 'Заказчик', 'Примечание'];
const NUM_COLS = HEADERS.length;
const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

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
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
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
