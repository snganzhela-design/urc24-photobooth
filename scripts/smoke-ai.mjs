// Шаг 0: смоук ИИ на реальных кадрах.
//   node scripts/smoke-ai.mjs <photo.jpg|dir> [model1,model2] [--out=dir]
// Для каждой картинки и модели пишет результат в smoke-out/, печатает сводку: время, отказы, mime.
// Ключ/шлюз — из photobooth/.env (AI_BASE_URL, AI_API_KEY).

import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname, resolve } from 'node:path';
import { mkdir, readdir, stat } from 'node:fs/promises';
import dotenv from 'dotenv';
import { aiConfig, generateSuit, saveResult } from '../lib/ai.mjs';
import { prepGuest } from '../lib/prep.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(root, '.env') });

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const outArg = process.argv.find((a) => a.startsWith('--out='));
const outDir = outArg ? resolve(outArg.slice(6)) : join(root, 'smoke-out');
const input = args[0];
if (!input) {
  console.error('usage: node scripts/smoke-ai.mjs <photo.jpg|dir> [models] [--out=dir]');
  process.exit(2);
}
const cfg = aiConfig();
const models = args[1] ? args[1].split(',') : cfg.models;
if (!cfg.apiKey) {
  console.error('AI_API_KEY не задан в photobooth/.env');
  process.exit(2);
}

const st = await stat(input);
const files = st.isDirectory()
  ? (await readdir(input)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).map((f) => join(input, f))
  : [input];
await mkdir(outDir, { recursive: true });
const refPath = join(root, 'assets', 'reference-suit.jpg');

console.log(`gateway=${cfg.baseUrl} models=${models.join(',')} files=${files.length}`);
const rows = [];
let fails = 0;
for (const f of files) {
  const name = basename(f, extname(f));
  const prepped = join(outDir, `${name}.prep.jpg`);
  await prepGuest(f, prepped);
  for (const model of models) {
    const t0 = Date.now();
    const res = await generateSuit({ guestPath: prepped, refPath, cfg, models: [model], log: () => {} });
    const ms = Date.now() - t0;
    if (res.ok) {
      const p = await saveResult(res, join(outDir, `${name}__${model}`));
      rows.push({ file: name, model, ok: true, ms, mime: res.mime, out: basename(p) });
      console.log(`OK   ${name} ${model} ${ms}ms -> ${basename(p)}`);
    } else {
      fails++;
      const why = res.attempts.map((a) => `${a.label}:${a.kind || 'ok'}${a.status ? ' ' + a.status : ''} ${a.error || ''}`).join(' || ');
      rows.push({ file: name, model, ok: false, ms, why });
      console.log(`FAIL ${name} ${model} ${ms}ms :: ${why}`);
    }
  }
}
console.log('\nСводка:');
console.table(rows.map(({ file, model, ok, ms, mime, out }) => ({ file, model, ok, ms, mime: mime || '', out: out || '' })));
process.exit(fails ? 1 : 0);
