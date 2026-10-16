// Очередь загрузки (lib/upload.mjs) на подставном fetch и временной папке: сеть не трогаем.
// Главный случай (16.10.2026): кадр, который сервер отверг насовсем, не должен запирать
// очередь, а неверный токен не должен разом выносить её в failed/.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState } from '../lib/state.mjs';
import { createUploader } from '../lib/upload.mjs';

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);
const LARAVEL_422 = JSON.stringify({ message: 'The photo field must not be greater than 5120 kilobytes.', errors: { photo: ['max'] } });

// respond(id, n) → [status, body] или исключение (обрыв сети); n — номер вызова с единицы.
function setup(t, respond) {
  const root = mkdtempSync(join(tmpdir(), 'booth-upload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {}); // state.log дублирует лог в консоль
  const state = createState(root);
  const calls = [];
  const fetch = async (url, init) => {
    const id = init.body.get('id');
    calls.push(id);
    const [status, body] = respond(id, calls.length);
    return new Response(body, { status });
  };
  const uploader = createUploader(state, { uploadUrl: 'http://booth.test/api/urc24/photo-booth', token: 'test-token', fetch });
  return { state, uploader, calls };
}

// Кадр в очереди так же, как его оставляет enqueue(), но без фонового drain через 50 мс.
function addShot(state, id, enqueuedAt) {
  const finalPath = join(state.shotDir(id), 'final.jpg');
  writeFileSync(finalPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  writeFileSync(join(state.pendingDir, `${id}.json`), JSON.stringify({ id, finalPath, ai: false, attempts: 0, enqueuedAt }));
}

const jsonFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const stages = (state) => readdirSync(state.logsDir).flatMap((f) => readFileSync(join(state.logsDir, f), 'utf8').trim().split('\n'))
  .filter(Boolean).map((l) => JSON.parse(l).stage);

test('422: кадр уезжает в failed/, следующий кадр загружается', async (t) => {
  // Отказ — первому по порядку, какой бы кадр ни шёл первым: так проверяется именно «очередь пошла дальше».
  const { state, uploader, calls } = setup(t, (id, n) => (n === 1 ? [422, LARAVEL_422] : [201, '{"success":true}']));
  addShot(state, ID_A, 1);
  addShot(state, ID_B, 2);

  await uploader.drain();

  assert.equal(calls.length, 2, 'после 422 очередь не остановилась');
  const [rejectedId, okId] = calls;
  assert.deepEqual(jsonFiles(state.pendingDir), []);
  assert.deepEqual(jsonFiles(state.failedDir), [`${rejectedId}.json`]);

  const failed = readJson(join(state.failedDir, `${rejectedId}.json`));
  assert.equal(failed.id, rejectedId);
  assert.equal(failed.status, 422);
  assert.match(failed.reason, /5120 kilobytes/);
  assert.equal(failed.attempts, 1);
  assert.ok(failed.finalPath && failed.failedAt, 'маркер в failed/ годится, чтобы вернуть кадр в очередь');

  assert.equal(state.readMeta(okId).uploaded, true);
  assert.equal(state.readMeta(rejectedId).uploadRejected.status, 422);
  assert.ok(existsSync(join(state.shotsDir, rejectedId, 'final.jpg')), 'сам кадр не удаляется');
  assert.ok(stages(state).includes('upload.rejected'));
  assert.deepEqual(
    { pending: uploader.status().pending, failed: uploader.status().failed, blocked: uploader.status().blocked },
    { pending: 0, failed: 1, blocked: '' },
  );

  await uploader.drain();
  assert.equal(calls.length, 2, 'отвергнутый кадр больше не отправляется');
});

for (const status of [401, 403, 404]) {
  test(`${status}: очередь стоит, ничего не переносится`, async (t) => {
    const { state, uploader, calls } = setup(t, () => [status, '{"message":"Unauthenticated."}']);
    addShot(state, ID_A, 1);
    addShot(state, ID_B, 2);

    await uploader.drain();

    assert.equal(calls.length, 1, 'после первого отказа по настройке остальные кадры не молотим');
    assert.deepEqual(jsonFiles(state.pendingDir), [`${ID_A}.json`, `${ID_B}.json`]);
    assert.deepEqual(jsonFiles(state.failedDir), []);
    assert.equal(readJson(join(state.pendingDir, `${calls[0]}.json`)).attempts, 1);
    assert.equal(uploader.status().blocked, `http ${status}`);
    assert.ok(stages(state).includes('upload.blocked'));
  });
}

for (const status of [503, 429]) {
  test(`${status}: кадр остаётся в pending/ и повторяется`, async (t) => {
    const { state, uploader, calls } = setup(t, () => [status, 'busy']);
    addShot(state, ID_A, 1);
    addShot(state, ID_B, 2);

    await uploader.drain();
    assert.equal(calls.length, 2, 'временный отказ не останавливает проход, как и раньше');
    await uploader.drain();
    assert.equal(calls.length, 4);

    assert.deepEqual(jsonFiles(state.pendingDir), [`${ID_A}.json`, `${ID_B}.json`]);
    assert.deepEqual(jsonFiles(state.failedDir), []);
    assert.equal(readJson(join(state.pendingDir, `${ID_A}.json`)).attempts, 2);
    assert.equal(uploader.status().blocked, '');
    assert.match(uploader.status().lastError, new RegExp(`http ${status}`));
  });
}

test('обрыв сети: кадр остаётся в pending/', async (t) => {
  const { state, uploader, calls } = setup(t, () => { throw new TypeError('fetch failed'); });
  addShot(state, ID_A, 1);

  await uploader.drain();

  assert.equal(calls.length, 1);
  assert.deepEqual(jsonFiles(state.pendingDir), [`${ID_A}.json`]);
  assert.deepEqual(jsonFiles(state.failedDir), []);
  assert.equal(readJson(join(state.pendingDir, `${ID_A}.json`)).attempts, 1);
});

test('папка failed/ не считается кадром при старте', (t) => {
  const { state } = setup(t, () => [201, '']);
  assert.equal(state.counters.shots, 0);
});
