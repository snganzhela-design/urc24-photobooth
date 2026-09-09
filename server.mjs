// URC24 фотозона — локальный сервер киоска (127.0.0.1:3777).
// Страница киоска (public/) снимает кадр и рисует рамку; сервер хранит архив, зовёт ИИ,
// делает QR и грузит готовые кадры на api.unigeniq.com (очередь с повторами).
import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, statSync, renameSync, copyFileSync } from 'node:fs';
import { createState } from './lib/state.mjs';
import { createUploader } from './lib/upload.mjs';
import { aiConfig, generateSuit, saveResult } from './lib/ai.mjs';
import { prepGuest } from './lib/prep.mjs';

const root = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(root, '.env') });

const PORT = Number(process.env.PORT || 3777);
const PUBLIC_BASE = (process.env.PUBLIC_BASE || 'https://api.unigeniq.com').replace(/\/+$/, '');
const UPLOAD_URL = process.env.UPLOAD_URL || `${PUBLIC_BASE}/api/urc24/photo-booth`;
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';
const REF_PATH = join(root, 'assets', 'reference-suit.jpg');
const ID_RE = /^[0-9a-f]{32}$/;

const state = createState(root);
const uploader = createUploader(state, { uploadUrl: UPLOAD_URL, token: UPLOAD_TOKEN });
const photoPageUrl = (id) => `${PUBLIC_BASE}/urc24/photo/${id}`;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(join(root, 'public'), { etag: false, maxAge: 0 }));
app.use('/shots', express.static(state.shotsDir, { etag: false, maxAge: 0 }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const id = String(req.body?.id || req.query?.id || '');
      if (!ID_RE.test(id)) return cb(new Error('bad id'));
      cb(null, state.shotDir(id));
    },
    filename: (req, file, cb) => cb(null, file.fieldname === 'final' ? 'final.jpg' : 'raw.jpg'),
  }),
  limits: { fileSize: 12 * 1024 * 1024 },
});

// Порядок полей в multipart важен: multer читает id раньше файла только если клиент положил его первым.
function requireId(req, res) {
  const id = String(req.body?.id || req.query?.id || '');
  if (!ID_RE.test(id)) { res.status(400).json({ error: 'bad id' }); return null; }
  return id;
}

app.get('/api/status', (req, res) => {
  const rt = state.runtime;
  const ai = aiConfig();
  res.json({
    ok: true,
    now: Date.now(),
    counters: state.counters,
    inFlight: state.inFlight,
    upload: uploader.status(),
    runtime: rt,
    ai: { configured: Boolean(ai.apiKey), gateway: ai.baseUrl, models: rt.model ? [rt.model] : ai.models, fallback: ai.fallbackModel },
    publicBase: PUBLIC_BASE,
  });
});

app.get('/api/qr/:id.png', async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).end();
  const png = await QRCode.toBuffer(photoPageUrl(id), {
    type: 'png', width: 520, margin: 1, errorCorrectionLevel: 'M',
    color: { dark: '#0F1012', light: '#F4F0E8' },
  });
  res.set('content-type', 'image/png').send(png);
});

// Шаг 1: сырой кадр → ИИ. Долгий запрос (до ~100 с), single-flight.
app.post('/api/shot', (req, res, next) => {
  upload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: String(err.message || err) });
    next();
  });
}, async (req, res) => {
  const id = requireId(req, res);
  if (!id) return;
  if (!req.file) return res.status(400).json({ error: 'no photo' });
  if (!state.lock(id)) return res.status(409).json({ error: 'busy', inFlight: state.inFlight });

  const t0 = Date.now();
  const dir = state.shotDir(id);
  const number = state.takeNumber();
  state.counters.shots++;
  state.log('shot.raw', { id, number, bytes: req.file.size });
  state.writeMeta(id, { id, number, createdAt: new Date().toISOString(), rawBytes: req.file.size });

  let aiUrl = null;
  let aiInfo = { tried: false };
  try {
    await prepGuest(join(dir, 'raw.jpg'), join(dir, 'prep.jpg'));
    const rt = state.runtime;
    const cfg = aiConfig();
    if (rt.aiEnabled && !rt.aiDisabled && cfg.apiKey) {
      aiInfo.tried = true;
      const result = await generateSuit({
        guestPath: join(dir, 'prep.jpg'), refPath: REF_PATH, cfg,
        models: rt.model ? [rt.model] : undefined,
        log: (stage, data) => state.log(stage, { id, ...data }),
      });
      aiInfo = { tried: true, ok: result.ok, model: result.model, ms: result.ms, attempts: result.attempts };
      if (result.ok) {
        const p = await saveResult(result, join(dir, 'ai'));
        aiUrl = `/shots/${id}/${p.split(/[\\/]/).pop()}`;
        state.counters.aiOk++;
      } else {
        state.counters.aiFail++;
        if (result.fatal) {
          const why = result.attempts.at(-1)?.error || 'auth/balance';
          state.setRuntime({ aiDisabled: true, aiDisabledReason: why.slice(0, 200) });
          state.log('ai.disabled', { id, why: why.slice(0, 200) });
        }
      }
    }
  } catch (e) {
    state.log('shot.error', { id, error: String(e?.message || e).slice(0, 300) });
  } finally {
    state.unlock(id);
  }
  state.writeMeta(id, { ai: Boolean(aiUrl), aiTried: aiInfo.tried, aiModel: aiInfo.model, aiMs: aiInfo.ms, aiAttempts: aiInfo.attempts });
  state.log('shot.done', { id, number, ai: Boolean(aiUrl), ms: Date.now() - t0 });
  res.json({ id, number, aiUrl, rawUrl: `/shots/${id}/raw.jpg`, ai: aiInfo, style: state.runtime.style, ms: Date.now() - t0 });
});

// Шаг 2: готовый кадр с рамкой → архив + очередь загрузки. QR известен по id заранее.
app.post('/api/finalize', (req, res, next) => {
  upload.single('final')(req, res, (err) => {
    if (err) return res.status(400).json({ error: String(err.message || err) });
    next();
  });
}, (req, res) => {
  const id = requireId(req, res);
  if (!id) return;
  if (!req.file) return res.status(400).json({ error: 'no final' });
  const meta = state.writeMeta(id, { final: true, finalBytes: req.file.size, finalizedAt: new Date().toISOString() });
  state.counters.finalized++;
  state.log('finalize', { id, bytes: req.file.size });
  uploader.enqueue(id, req.file.path, meta.ai);
  res.json({ id, pageUrl: photoPageUrl(id), qrUrl: `/api/qr/${id}.png`, upload: uploader.status() });
});

app.get('/api/recent', (req, res) => {
  const items = readdirSync(state.shotsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'pending' && existsSync(join(state.shotsDir, d.name, 'final.jpg')))
    .map((d) => ({ id: d.name, mtime: statSync(join(state.shotsDir, d.name, 'final.jpg')).mtimeMs, ...state.readMeta(d.name) }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 12)
    .map((m) => ({ id: m.id, number: m.number, ai: m.ai, uploaded: Boolean(m.uploaded), url: `/shots/${m.id}/final.jpg`, pageUrl: photoPageUrl(m.id) }));
  res.json({ items });
});

app.post('/api/retry-uploads', async (req, res) => {
  await uploader.drain();
  res.json(uploader.status());
});

app.post('/api/settings', (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (typeof b.aiEnabled === 'boolean') patch.aiEnabled = b.aiEnabled;
  if (b.resetAiDisabled) { patch.aiDisabled = false; patch.aiDisabledReason = ''; }
  if (typeof b.model === 'string') patch.model = b.model.trim();
  if (b.style === 'gray' || b.style === 'color') patch.style = b.style;
  if (typeof b.cameraLabel === 'string') patch.cameraLabel = b.cameraLabel;
  if (Number.isInteger(b.nextNumber) && b.nextNumber > 0) patch.nextNumber = b.nextNumber;
  state.log('settings', patch);
  res.json(state.setRuntime(patch));
});

// Оператор: прогнать ИИ на последнем сыром кадре (проверка ключа/шлюза без гостя).
app.post('/api/test-ai', async (req, res) => {
  const last = readdirSync(state.shotsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(state.shotsDir, d.name, 'prep.jpg')))
    .map((d) => ({ id: d.name, mtime: statSync(join(state.shotsDir, d.name, 'prep.jpg')).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  const guestPath = last ? join(state.shotsDir, last.id, 'prep.jpg') : join(root, 'smoke-in', 'guest.jpg');
  if (!existsSync(guestPath)) return res.status(404).json({ error: 'нет кадра для теста' });
  const rt = state.runtime;
  const result = await generateSuit({ guestPath, refPath: REF_PATH, models: rt.model ? [rt.model] : undefined, log: (s, d) => state.log(s, { test: true, ...d }) });
  let url = null;
  if (result.ok) {
    const p = await saveResult(result, join(state.shotDir('test-' + Date.now().toString(16).padStart(32, '0')), 'ai'));
    url = '/shots/' + p.split(/[\\/]/).slice(-2).join('/');
  }
  res.json({ ok: result.ok, model: result.model, ms: result.ms, attempts: result.attempts, url });
});

app.get('/admin', (req, res) => res.sendFile(join(root, 'public', 'admin.html')));

app.listen(PORT, '127.0.0.1', () => {
  state.log('boot', { port: PORT, publicBase: PUBLIC_BASE, upload: uploader.status(), ai: { configured: Boolean(aiConfig().apiKey), gateway: aiConfig().baseUrl } });
  uploader.start();
});
