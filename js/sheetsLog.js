/*
 * sheetsLog.js
 * Отправка строки журнала в Google Таблицу через Google Apps Script Web App.
 * Сам скрипт — см. apps-script/Code.gs и README.md.
 *
 * Используем "no-cors" fetch: Apps Script Web App не всегда отдаёт корректные
 * CORS-заголовки для чтения ответа из браузера, но сама запись при этом происходит.
 * Поэтому мы не читаем ответ, а просто фиксируем факт отправки.
 */
async function logToSheet(entry) {
  if (!APPS_SCRIPT_URL) {
    console.info('APPS_SCRIPT_URL не задан — запись в журнал пропущена');
    return { skipped: true };
  }
  try {
    await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(entry),
    });
    return { ok: true };
  } catch (e) {
    console.warn('Не удалось записать в журнал расчётов:', e);
    return { ok: false, error: e };
  }
}

/*
 * Автономер расчёта: инженер один раз вводит первый номер вручную, дальше
 * при каждом новом расчёте сервис подсказывает следующий — берёт последний
 * записанный номер прямо из листа "Журнал" (см. doGet в apps-script/Code.gs),
 * чтобы номер был общим для всех, кто пользуется сервисом, а не только для
 * этого браузера.
 *
 * В отличие от записи (logToSheet, POST), здесь нужен именно ОТВЕТ сервера —
 * поэтому используем обычный (не "no-cors") GET-запрос: Apps Script Web App
 * отдаёт финальный ответ с домена script.googleusercontent.com, который
 * браузер разрешает читать из fetch() без дополнительной настройки CORS
 * (в отличие от POST с JSON, который упирается в CORS-preflight — поэтому
 * запись сделана иначе, см. logToSheet выше).
 */
async function fetchNextCalcNumber() {
  if (!APPS_SCRIPT_URL) return { ok: false, skipped: true };
  try {
    const res = await fetch(`${APPS_SCRIPT_URL}?action=nextNumber`, { method: 'GET' });
    const data = await res.json();
    if (data && data.ok) return { ok: true, nextNumber: data.nextNumber };
    return { ok: false };
  } catch (e) {
    console.warn('Не удалось получить следующий номер расчёта из журнала:', e);
    return { ok: false, error: e };
  }
}
