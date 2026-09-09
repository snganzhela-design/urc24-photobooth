// Очередь загрузки готовых кадров на сервер (QR ведёт на страницу с этим id).
// Маркер в shots/pending/{id}.json живёт до успешной загрузки; drain() каждые 30 с и по кнопке оператора.
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createUploader(state, { uploadUrl, token, intervalMs = 30000 }) {
  let draining = false;
  let timer = null;
  let lastError = '';

  const markerPath = (id) => join(state.pendingDir, `${id}.json`);

  function enqueue(id, finalPath, ai) {
    writeFileSync(markerPath(id), JSON.stringify({ id, finalPath, ai: Boolean(ai), attempts: 0, enqueuedAt: Date.now() }));
    setTimeout(() => drain().catch(() => {}), 50);
  }

  function pending() {
    return readdirSync(state.pendingDir).filter((f) => f.endsWith('.json')).map((f) => {
      try { return JSON.parse(readFileSync(join(state.pendingDir, f), 'utf8')); } catch { return null; }
    }).filter(Boolean);
  }

  async function uploadOne(item) {
    if (!uploadUrl || !token) throw new Error('UPLOAD_URL/UPLOAD_TOKEN не заданы');
    if (!existsSync(item.finalPath)) { unlinkSync(markerPath(item.id)); return; }
    const fd = new FormData();
    fd.append('id', item.id);
    fd.append('ai', item.ai ? '1' : '0');
    fd.append('photo', new Blob([await readFile(item.finalPath)], { type: 'image/jpeg' }), 'final.jpg');
    const r = await fetch(uploadUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      body: fd,
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    if (!r.ok) {
      const err = new Error(`upload http ${r.status}: ${text.slice(0, 200)}`);
      err.status = r.status;
      throw err;
    }
    unlinkSync(markerPath(item.id));
    state.writeMeta(item.id, { uploaded: true, uploadedAt: new Date().toISOString() });
    state.counters.uploaded++;
    state.log('upload.ok', { id: item.id });
  }

  async function drain() {
    if (draining) return;
    draining = true;
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
          writeFileSync(markerPath(item.id), JSON.stringify(item));
          state.log('upload.fail', { id: item.id, attempts: item.attempts, error: lastError.slice(0, 200) });
          // 4xx кроме 429 — проблема не сети: не молотим остальные, оператор увидит ошибку.
          if (e.status && e.status !== 429 && e.status < 500) break;
        }
      }
    } finally {
      draining = false;
    }
  }

  function start() {
    if (!timer) timer = setInterval(() => drain().catch(() => {}), intervalMs);
    drain().catch(() => {});
  }

  return {
    enqueue, drain, start,
    status: () => ({ pending: pending().length, lastError, configured: Boolean(uploadUrl && token) }),
  };
}
