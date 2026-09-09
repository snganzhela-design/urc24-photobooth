// Эталон комбинезона для ИИ: торс пилота без лица, чтобы лицо эталона не утекало в результат.
//   node scripts/make-reference.mjs [speaker.jpg] [top=270]
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2] || join(root, '..', 'frontend', 'public', 'urc24', 'speaker-1.jpg');
const top = Number(process.argv[3] || 270);
const out = join(root, 'assets', 'reference-suit.jpg');
const meta = await sharp(src).metadata();
await sharp(src)
  .extract({ left: 0, top, width: meta.width, height: meta.height - top })
  .jpeg({ quality: 90 })
  .toFile(out);
console.log(`reference ${meta.width}x${meta.height - top} -> ${out}`);
