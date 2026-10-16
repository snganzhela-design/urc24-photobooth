// Очередь загрузки готовых кадров на сервер (QR ведёт на страницу с этим id).
// Маркер в shots/pending/{id}.json живёт до успешной загрузки; drain() каждые 30 с и по кнопке оператора.
// Кадр, который сервер отверг насовсем, переезжает в shots/failed/{id}.json с кодом и причиной.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Лимит бэкенда на готовый кадр: max:5120 (КБ) в StoreUrc24BoothPhotoRequest. Тот же лимит
// стоит на приёме /api/finalize (server.mjs), чтобы файл, который сервер не возьмёт, не вставал в очередь.
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

// Как читать 4xx (16.10.2026). Раньше любой 4xx, кроме 429, останавливал проход — и один кадр,
// который бэкенд отвергает навсегда (422: не тот формат или размер), запирал очередь: кадры
// после него не доезжали до QR-страниц до конца мероприятия.
// Отказ по КАДРУ: сервер разобрал запрос и не принял именно этот файл. Повтор ничего не даст —
// маркер уезжает в failed/, очередь идёт дальше.
const REJECTED = new Set([400, 413, 415, 422]);
// Отказ по НАСТРОЙКЕ: неверный токен (401/403) или адрес (404/405) — так же будет отвергнут любой
// кадр. В failed/ не переносим: за один проход туда уехала бы вся очередь. Стоим, пока не поправят
// .env; после перезапуска очередь дозагрузится сама. 404 — тоже адрес, а не кадр: id едет в теле
// запроса, и «нет такого кадра» бэкенд на POST ответить не может.
const BLOCKED = new Set([401, 403, 404, 405]);
// 429, 5xx и сеть — повтор на следующем проходе, как раньше. Прочие 4xx — тоже как раньше:
// проход стоит, маркер на месте.

export function createUploader(state, { uploadUrl, token, intervalMs = 30000, fetch: fetchImpl = globalThis.fetch }) {
  let draining = false;
  let timer = null;
  let lastError = '';
  let blocked = ''; // «http 401» и т. п., пока сервер не принимает токен или адрес

  const markerPath = (id) => join(state.pendingDir, `${id}.json`);
  const failedPath = (id) => join(state.failedDir, `${id}.json`);

  function enqueue(id, finalPath, ai) {
    writeFileSync(markerPath(id), JSON.stringify({ id, finalPath, ai: Boolean(ai), attempts: 0, enqueuedAt: Date.now() }));
    setTimeout(() => drain().catch(() => {}), 50);
  }

  function pending() {
    return readdirSync(state.pendingDir).filter((f) => f.endsWith('.json')).map((f) => {
      try { return JSON.parse(readFileSync(join(state.pendingDir, f), 'utf8')); } catch { return null; }
    }).filter(Boolean);
  }

  const failedCount = () => (existsSync(state.failedDir) ? readdirSync(state.failedDir).filter((f) => f.endsWith('.json')).length : 0);

  async function uploadOne(item) {
    if (!uploadUrl || !token) throw new Error('UPLOAD_URL/UPLOAD_TOKEN не заданы');
    if (!existsSync(item.finalPath)) { unlinkSync(markerPath(item.id)); return; }
    const fd = new FormData();
    fd.append('id', item.id);
    fd.append('ai', item.ai ? '1' : '0');
    fd.append('photo', new Blob([await readFile(item.finalPath)], { type: 'image/jpeg' }), 'final.jpg');
    const r = await fetchImpl(uploadUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      body: fd,
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    if (!r.ok) {
      const err = new Error(`upload http ${r.status}: ${text.slice(0, 200)}`);
      err.status = r.status;
      err.body = text.slice(0, 500);
      throw err;
    }
    unlinkSync(markerPath(item.id));
    state.writeMeta(item.id, { uploaded: true, uploadedAt: new Date().toISOString() });
    state.counters.uploaded++;
    state.log('upload.ok', { id: item.id });
  }

  // Сначала пишем failed/, потом убираем pending/: если киоск упадёт между ними, кадр
  // переотправится и снова уедет в failed/, а не пропадёт. Файл кадра (shots/{id}/final.jpg)
  // остаётся на месте — вернуть в очередь можно, переложив json обратно в pending/.
  function reject(item, e) {
    const at = new Date().toISOString();
    const reason = String(e.body || e.message || e);
    mkdirSync(state.failedDir, { recursive: true });
    writeFileSync(failedPath(item.id), JSON.stringify({ ...item, status: e.status, reason, failedAt: at }));
    unlinkSync(markerPath(item.id));
    state.writeMeta(item.id, { uploadRejected: { status: e.status, at } });
    state.log('upload.rejected', { id: item.id, status: e.status, attempts: item.attempts, reason: reason.slice(0, 200) });
  }

  async function drain() {
    if (draining) return;
    draining = true;
    let stop = '';
    try {
      for (const item of pending()) {
        try {
          await uploadOne(item);
          lastError = '';
        } catch (e) {
          lastError = String(e.message || e);
          item.attempts = (item.attempts || 0) + 1;
          item.lastError = lastError;
          item.lastTry = Date.now();
          if (REJECTED.has(e.status)) { reject(item, e); continue; }
          writeFileSync(markerPath(item.id), JSON.stringify(item));
          if (BLOCKED.has(e.status)) {
            stop = `http ${e.status}`;
            state.log('upload.blocked', {
              id: item.id, status: e.status, pending: pending().length, error: lastError.slice(0, 200),
              hint: 'сервер не принимает UPLOAD_TOKEN или UPLOAD_URL: проверьте .env и перезапустите сервер фотозоны',
            });
            break;
          }
          state.log('upload.fail', { id: item.id, attempts: item.attempts, error: lastError.slice(0, 200) });
          // Прочие 4xx кроме 429 — проблема не сети: не молотим остальные, оператор увидит ошибку.
          if (e.status && e.status !== 429 && e.status < 500) break;
        }
      }
    } finally {
      blocked = stop;
      draining = false;
    }
  }

  function start() {
    if (!timer) timer = setInterval(() => drain().catch(() => {}), intervalMs);
    drain().catch(() => {});
  }

  return {
    enqueue, drain, start,
    status: () => ({ pending: pending().length, failed: failedCount(), lastError, blocked, configured: Boolean(uploadUrl && token) }),
  };
}
