// Сборка демо-стенда для GitHub Pages: public/ → docs/.
//   node scripts/make-pages-demo.mjs
//
// Демо — та же страница киоска, но без сервера фотозоны: флаг window.BOOTH_DEMO включает
// в kiosk.js ветку «снимок и рамка целиком в браузере» (нет ИИ, нет загрузки, QR ведёт на
// лендинг). Панель оператора в статику не едет. Файл docs/ коммитится сгенерированным —
// как у snganzhela-design/prometrika-demo.
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import QRCode from 'qrcode';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'public');
const out = join(root, 'docs');
const QR_TARGET = 'https://unigeniq.com/urc24/';

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// 1. Копируем статику, кроме панели оператора (в демо она бессмысленна и светит внутренности).
await cp(src, out, {
  recursive: true,
  filter: (p) => !p.endsWith('admin.html'),
});

// 2. QR фиксированный — генерируем один раз в цветах лендинга.
await QRCode.toFile(join(out, 'assets', 'demo-qr.png'), QR_TARGET, {
  width: 520,
  margin: 1,
  color: { dark: '#0F1012', light: '#F4F0E8' },
});

// 3. index.html: флаг демо, метатеги для расшаривания, версии у css/js против кеша Pages.
const hash = async (f) => createHash('sha1').update(await readFile(join(out, f))).digest('hex').slice(0, 8);
const [vCss, vJs] = [await hash('kiosk.css'), await hash('kiosk.js')];

let html = await readFile(join(src, 'index.html'), 'utf8');
html = html
  .replace('<link rel="stylesheet" href="kiosk.css">', `<link rel="stylesheet" href="kiosk.css?v=${vCss}">`)
  .replace('<script src="kiosk.js"></script>', `<script>window.BOOTH_DEMO=1</script>\n  <script src="kiosk.js?v=${vJs}"></script>`)
  .replace(
    '<title>URC24 · Фотозона</title>',
    [
      '<title>URC24 · Фотозона «Стань пилотом» — демо</title>',
      '<meta name="description" content="Демо фотозоны UnigeniQ Regen Circuit 24: снимок с камеры превращается в карточку пилота URC24.">',
      '<meta name="theme-color" content="#0F1012">',
      '<meta property="og:type" content="website">',
      '<meta property="og:title" content="URC24 · Фотозона «Стань пилотом»">',
      '<meta property="og:description" content="Нажми кнопку — камера снимет кадр и оформит его в карточку пилота URC24. Демо работает прямо в браузере.">',
      '<meta property="og:url" content="https://snganzhela-design.github.io/urc24-photobooth/">',
    ].join('\n  '),
  );
await writeFile(join(out, 'index.html'), html, 'utf8');

// 4. .nojekyll — иначе Pages выкинет всё, что начинается с подчёркивания.
await writeFile(join(out, '.nojekyll'), '', 'utf8');

console.log(`docs/ собран: демо-флаг, QR → ${QR_TARGET}, версии css=${vCss} js=${vJs}`);
