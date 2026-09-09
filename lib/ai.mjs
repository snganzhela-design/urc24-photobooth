// Вызов image-модели: кадр гостя + эталон комбинезона → кадр в комбинезоне.
// Основной путь — Gemini-формат (generateContent) через шлюз (ProxyAPI) или напрямую Google;
// запасной — OpenAI-формат /images/edits (gpt-image-1-mini) на том же шлюзе.
// Сырой fetch без SDK: SDK сам ретраит таймауты и утраивает ожидание.

import { readFile, writeFile } from 'node:fs/promises';
import { PROMPT_A, PROMPT_B } from './prompt.mjs';

const env = (k, d) => (process.env[k] ?? d);

export const aiConfig = () => ({
  baseUrl: env('AI_BASE_URL', 'https://api.proxyapi.ru').replace(/\/+$/, ''),
  apiKey: env('AI_API_KEY', ''),
  models: env('AI_MODELS', 'gemini-2.5-flash-image').split(',').map((s) => s.trim()).filter(Boolean),
  fallbackModel: env('AI_FALLBACK', '').trim(), // например openai/gpt-image-1-mini
  openaiBase: env('AI_OPENAI_BASE', 'https://api.proxyapi.ru/v1').replace(/\/+$/, ''),
  timeoutMs: Number(env('AI_TIMEOUT_MS', 45000)),
  budgetMs: Number(env('AI_BUDGET_MS', 100000)),
});

const REFUSAL_REASONS = new Set(['SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'RECITATION', 'BLOCKLIST']);

export class AiError extends Error {
  constructor(message, { kind, status, retryable } = {}) {
    super(message);
    this.kind = kind || 'error'; // network | http | refusal | empty
    this.status = status;
    this.retryable = Boolean(retryable);
  }
}

/** Разбор ответа generateContent → {data, mime} либо AiError(refusal/empty). */
export function extractImage(res) {
  const block = res?.promptFeedback?.blockReason;
  if (block && !res?.candidates?.length) {
    throw new AiError(`prompt blocked: ${block}`, { kind: 'refusal' });
  }
  const cand = res?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const img = parts.find((p) => p.inlineData?.data);
  if (img) return { data: img.inlineData.data, mime: img.inlineData.mimeType || 'image/png' };
  const said = parts.filter((p) => p.text).map((p) => p.text).join(' | ').slice(0, 300);
  if (REFUSAL_REASONS.has(cand?.finishReason) || said) {
    throw new AiError(`no image (${cand?.finishReason || 'text-only'})${said ? `: ${said}` : ''}`, { kind: 'refusal' });
  }
  throw new AiError(`empty response (${cand?.finishReason || 'no candidates'})`, { kind: 'empty', retryable: true });
}

async function postJson(url, headers, body, timeoutMs) {
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AiError(`network: ${e?.cause?.code || e?.name || e?.message}`, { kind: 'network', retryable: true });
  }
  const text = await r.text();
  if (!r.ok) {
    const retryable = r.status === 429 || r.status >= 500;
    throw new AiError(`http ${r.status}: ${text.slice(0, 300)}`, { kind: 'http', status: r.status, retryable });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError(`bad json: ${text.slice(0, 200)}`, { kind: 'http', status: r.status, retryable: true });
  }
}

/** Один вызов Gemini-формата. guest/ref — {data(base64), mime}. */
export async function geminiEdit({ model, guest, ref, prompt, cfg }) {
  const url = `${cfg.baseUrl}/v1beta/models/${model}:generateContent`;
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: guest.mime, data: guest.data } },
        { inlineData: { mimeType: ref.mime, data: ref.data } },
        { text: prompt },
      ],
    }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } },
    safetySettings: [
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };
  const res = await postJson(url, { 'x-goog-api-key': cfg.apiKey }, body, cfg.timeoutMs);
  return extractImage(res);
}

/** Запасной путь: OpenAI-формат /images/edits (multipart, две картинки). */
export async function openaiEdit({ model, guest, ref, prompt, cfg }) {
  const fd = new FormData();
  fd.append('model', model);
  fd.append('image[]', new Blob([Buffer.from(guest.data, 'base64')], { type: guest.mime }), 'guest.jpg');
  fd.append('image[]', new Blob([Buffer.from(ref.data, 'base64')], { type: ref.mime }), 'suit.jpg');
  fd.append('prompt', prompt);
  fd.append('size', '1024x1024');
  fd.append('quality', 'medium');
  let r;
  try {
    r = await fetch(`${cfg.openaiBase}/images/edits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      body: fd,
      signal: AbortSignal.timeout(Math.max(cfg.timeoutMs, 90000)),
    });
  } catch (e) {
    throw new AiError(`network: ${e?.cause?.code || e?.name || e?.message}`, { kind: 'network', retryable: true });
  }
  const text = await r.text();
  if (!r.ok) {
    throw new AiError(`http ${r.status}: ${text.slice(0, 300)}`, {
      kind: r.status === 400 ? 'refusal' : 'http', status: r.status, retryable: r.status === 429 || r.status >= 500,
    });
  }
  const json = JSON.parse(text);
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new AiError('openai: no b64_json', { kind: 'empty' });
  return { data: b64, mime: 'image/png' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Полный сценарий с бюджетом времени: по каждой модели — попытка A, на сеть/5xx/429 один повтор,
 * на отказ — один повтор с промтом B; затем запасная OpenAI-модель.
 * Возвращает {ok, model, mime, data, ms, attempts[]} — при ok:false данные нет, attempts объясняет почему.
 */
export async function generateSuit({ guestPath, refPath, cfg = aiConfig(), models, log = () => {} }) {
  const started = Date.now();
  const guest = { data: (await readFile(guestPath)).toString('base64'), mime: 'image/jpeg' };
  const ref = { data: (await readFile(refPath)).toString('base64'), mime: 'image/jpeg' };
  const attempts = [];
  const timeLeft = () => cfg.budgetMs - (Date.now() - started);

  const tryCall = async (label, fn) => {
    const t0 = Date.now();
    try {
      const out = await fn();
      attempts.push({ label, ok: true, ms: Date.now() - t0 });
      log('ai.ok', { label, ms: Date.now() - t0 });
      return out;
    } catch (e) {
      const err = e instanceof AiError ? e : new AiError(String(e?.message || e), { kind: 'error' });
      attempts.push({ label, ok: false, ms: Date.now() - t0, kind: err.kind, status: err.status, error: err.message.slice(0, 300) });
      log('ai.fail', { label, kind: err.kind, status: err.status, error: err.message.slice(0, 300) });
      return err;
    }
  };

  const list = models || cfg.models;
  for (const model of list) {
    if (timeLeft() < cfg.timeoutMs / 2) break;
    let out = await tryCall(`${model}/A`, () => geminiEdit({ model, guest, ref, prompt: PROMPT_A, cfg }));
    if (out instanceof AiError && out.retryable && timeLeft() > cfg.timeoutMs) {
      await sleep(2000);
      out = await tryCall(`${model}/A-retry`, () => geminiEdit({ model, guest, ref, prompt: PROMPT_A, cfg }));
    }
    if (out instanceof AiError && out.kind === 'refusal' && timeLeft() > cfg.timeoutMs) {
      out = await tryCall(`${model}/B`, () => geminiEdit({ model, guest, ref, prompt: PROMPT_B, cfg }));
    }
    if (out instanceof AiError && (out.status === 401 || out.status === 402 || out.status === 403)) {
      return { ok: false, fatal: true, ms: Date.now() - started, attempts };
    }
    if (!(out instanceof AiError)) return { ok: true, model, ...out, ms: Date.now() - started, attempts };
  }

  if (cfg.fallbackModel && timeLeft() > 30000) {
    const out = await tryCall(`${cfg.fallbackModel}/A`, () =>
      openaiEdit({ model: cfg.fallbackModel, guest, ref, prompt: PROMPT_A, cfg }));
    if (!(out instanceof AiError)) return { ok: true, model: cfg.fallbackModel, ...out, ms: Date.now() - started, attempts };
  }
  return { ok: false, ms: Date.now() - started, attempts };
}

/** Утилита: записать результат generateSuit в файл (png/jpg по mime). */
export async function saveResult(result, pathNoExt) {
  const ext = result.mime?.includes('jpeg') ? '.jpg' : result.mime?.includes('webp') ? '.webp' : '.png';
  const p = pathNoExt + ext;
  await writeFile(p, Buffer.from(result.data, 'base64'));
  return p;
}
