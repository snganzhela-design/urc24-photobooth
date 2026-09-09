// Состояние киоска: настройки времени выполнения (runtime.json), счётчики, лог jsonl, замок single-flight.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function createState(root) {
  const runtimePath = join(root, 'runtime.json');
  const shotsDir = join(root, 'shots');
  const pendingDir = join(shotsDir, 'pending');
  const logsDir = join(root, 'logs');
  for (const d of [shotsDir, pendingDir, logsDir]) mkdirSync(d, { recursive: true });

  const defaults = {
    nextNumber: Number(process.env.START_NUMBER || 1),
    aiEnabled: true,
    aiDisabled: false, // выставляется автоматически на 401/402/403 от шлюза, снимает оператор
    aiDisabledReason: '',
    model: '', // пусто = список из .env
    style: process.env.STYLE || 'gray', // gray | color
    cameraLabel: '',
  };
  let runtime = { ...defaults };
  if (existsSync(runtimePath)) {
    try { runtime = { ...defaults, ...JSON.parse(readFileSync(runtimePath, 'utf8')) }; } catch { /* битый файл — дефолты */ }
  }
  const save = () => writeFileSync(runtimePath, JSON.stringify(runtime, null, 2));

  const counters = { shots: 0, aiOk: 0, aiFail: 0, finalized: 0, uploaded: 0 };
  // Восстановление счётчиков из архива при старте.
  for (const dir of readdirSync(shotsDir, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name === 'pending') continue;
    const metaPath = join(shotsDir, dir.name, 'meta.json');
    if (!existsSync(metaPath)) { counters.shots++; continue; }
    try {
      const m = JSON.parse(readFileSync(metaPath, 'utf8'));
      counters.shots++;
      if (m.ai) counters.aiOk++; else if (m.aiTried) counters.aiFail++;
      if (m.final) counters.finalized++;
      if (m.uploaded) counters.uploaded++;
    } catch { counters.shots++; }
  }

  const log = (stage, data = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), stage, ...data });
    const day = new Date().toISOString().slice(0, 10);
    try { appendFileSync(join(logsDir, `booth-${day}.jsonl`), line + '\n'); } catch { /* диск */ }
    console.log(line);
  };

  let inFlight = null; // {id, since}

  return {
    root, shotsDir, pendingDir, logsDir,
    get runtime() { return runtime; },
    setRuntime(patch) { runtime = { ...runtime, ...patch }; save(); return runtime; },
    takeNumber() { const n = runtime.nextNumber; runtime.nextNumber = n + 1; save(); return n; },
    counters,
    log,
    get inFlight() { return inFlight; },
    lock(id) {
      if (inFlight && Date.now() - inFlight.since < 150000) return false; // защёлка снимается сама через 150 с
      inFlight = { id, since: Date.now() };
      return true;
    },
    unlock(id) { if (inFlight && inFlight.id === id) inFlight = null; },
    shotDir(id) { const d = join(shotsDir, id); mkdirSync(d, { recursive: true }); return d; },
    readMeta(id) {
      const p = join(shotsDir, id, 'meta.json');
      try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
    },
    writeMeta(id, patch) {
      const p = join(this.shotDir(id), 'meta.json');
      const m = { ...this.readMeta(id), ...patch };
      writeFileSync(p, JSON.stringify(m, null, 2));
      return m;
    },
  };
}
