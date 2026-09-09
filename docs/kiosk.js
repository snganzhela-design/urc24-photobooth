// Киоск URC24: машина состояний idle → count → proc → result, камера, кнопка, composition на canvas.
//
// Режим ДЕМО (window.BOOTH_DEMO выставляет только статическая сборка для GitHub Pages,
// см. scripts/make-pages-demo.mjs): сервера фотозоны нет, поэтому нет ИИ, серверного QR
// и загрузки — кадр собирается из локального blob и остаётся в браузере гостя.
// Второй копии файла намеренно нет: копии расходятся.
(() => {
  const DEMO = !!window.BOOTH_DEMO;
  const $ = (s) => document.querySelector(s);
  const body = document.body;
  const cam = $('#cam');
  const snd = $('#snd');
  const final = $('#final');
  const RESULT_MS = 40000;
  const IDLE_RELOAD_MS = 30 * 60 * 1000;
  const PROC_TEXTS = ['Подбираем комбинезон…', 'Затягиваем ремни…', 'Прогреваем шины…', 'Выезжаем на пит-лейн…', 'Ещё пара секунд…'];
  const W = 1080, H = 1080, PH = 820;

  let state = 'boot';
  let lastTrigger = 0;
  let resultTimer = null;
  let lastActivity = Date.now();
  let runtime = { style: 'gray', cameraLabel: '' };
  let stream = null;
  let statusMisses = 0;
  let adminOpen = false;
  let saveUrl = null;

  const setState = (s) => { state = s; body.dataset.state = s; lastActivity = Date.now(); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hex32 = () => crypto.randomUUID().replace(/-/g, '');

  // ---------- камера ----------
  async function startCamera() {
    try {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      let deviceId;
      if (runtime.cameraLabel) {
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
        deviceId = devs.find((d) => d.label === runtime.cameraLabel)?.deviceId;
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }) },
      });
      cam.srcObject = stream;
      await cam.play().catch(() => {});
      $('#camwarn').hidden = true;
      return true;
    } catch (e) {
      console.warn('camera', e);
      $('#camwarn').hidden = false;
      return false;
    }
  }
  // В демо камеру не трогаем, пока гость не нажал кнопку (см. trigger).
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', () => { if (state === 'idle' && (!DEMO || stream)) startCamera(); });

  function captureBlob() {
    const vw = cam.videoWidth || 1280, vh = cam.videoHeight || 720;
    const c = document.createElement('canvas');
    c.width = vw; c.height = vh;
    c.getContext('2d').drawImage(cam, 0, 0, vw, vh);
    return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
  }

  // ---------- сеть ----------
  async function postForm(url, fields, timeoutMs) {
    const fd = new FormData();
    for (const [k, v] of fields) (v[1] ? fd.append(k, v[0], v[1]) : fd.append(k, v[0])); // id ПЕРВЫМ — multer читает поля по порядку
    const r = await fetch(url, { method: 'POST', body: fd, signal: AbortSignal.timeout(timeoutMs) });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(json.error || `http ${r.status}`), { status: r.status });
    return json;
  }

  // ---------- композиция кадра ----------
  const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const assets = {};
  async function ensureAssets() {
    if (!assets.logo) assets.logo = await loadImage('assets/logo-blue.png');
    await document.fonts.load('800 52px "Golos Text"');
    await document.fonts.load('700 26px "JetBrains Mono"');
    await document.fonts.load('600 18px "JetBrains Mono"');
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  async function compose({ photoUrl, number, style }) {
    await ensureAssets();
    const bust = photoUrl.startsWith('blob:') ? '' : (photoUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
    const img = await loadImage(photoUrl + bust);
    const ctx = final.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0F1012'; ctx.fillRect(0, 0, W, H);

    // Фото: cover в окно 1080×820, якорь сверху (голова важнее ног)
    const s = Math.max(W / img.width, PH / img.height);
    const dw = img.width * s, dh = img.height * s, dx = (W - dw) / 2, dy = 0;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, PH); ctx.clip();
    ctx.filter = style === 'gray' ? 'grayscale(0.92) brightness(0.66)' : 'none';
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.filter = 'none';
    if (style === 'gray') { // как .pilot-locked .pilot-photo-lg::before на лендинге
      const g = ctx.createRadialGradient(W * .5, PH * .42, 0, W * .5, PH * .42, W * .8);
      g.addColorStop(0, 'rgba(255,77,0,.12)'); g.addColorStop(1, 'rgba(18,15,11,.5)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, PH);
    }
    ctx.restore();

    // Бейдж номера пилота
    const label = 'P' + String(number).padStart(3, '0');
    ctx.font = '700 28px "JetBrains Mono"'; ctx.letterSpacing = '0.16em';
    const tw = ctx.measureText(label).width + 44;
    ctx.fillStyle = 'rgba(12,13,16,.9)'; roundRect(ctx, W - 48 - tw, 44, tw, 56, 28); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#FF4D00'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(label, W - 48 - tw + 22, 44 + 29);

    // Панель айвори + неоновая линия
    ctx.fillStyle = '#F4F0E8'; ctx.fillRect(0, PH, W, H - PH);
    ctx.save(); ctx.shadowColor = 'rgba(255,77,0,.85)'; ctx.shadowBlur = 22; ctx.fillStyle = '#FF4D00'; ctx.fillRect(0, PH - 3, W, 6); ctx.restore();

    ctx.textBaseline = 'alphabetic'; ctx.letterSpacing = '0px';
    ctx.fillStyle = '#0F1012'; ctx.font = '800 54px "Golos Text"'; ctx.letterSpacing = '-0.01em';
    ctx.fillText('ПИЛОТ URC24', 56, PH + 96);
    ctx.fillStyle = '#A83400'; ctx.font = '600 19px "JetBrains Mono"'; ctx.letterSpacing = '0.16em';
    ctx.fillText('12 ДЕКАБРЯ 2026 · МОСКВА · ОТЕЛЬ «МОНАРХ»', 56, PH + 148);
    ctx.fillStyle = '#6F6B64'; ctx.font = '500 16px "JetBrains Mono"'; ctx.letterSpacing = '0.12em';
    ctx.fillText('UNIGENIQ REGEN CIRCUIT 24 · ФОТОЗОНА', 56, PH + 210);

    const lw = 300, lh = Math.round(lw * assets.logo.height / assets.logo.width);
    ctx.drawImage(assets.logo, W - 56 - lw, PH + 70, lw, lh);
    ctx.textAlign = 'right'; ctx.fillStyle = '#6F6B64'; ctx.font = '500 16px "JetBrains Mono"';
    ctx.fillText('unigeniq.com/urc24', W - 56, PH + 210);
    ctx.textAlign = 'left'; ctx.letterSpacing = '0px';

    return new Promise((res) => final.toBlob(res, 'image/jpeg', 0.86));
  }

  // ---------- сценарий ----------
  async function runShot() {
    const id = hex32();
    setState('count');
    for (const d of [3, 2, 1]) {
      const el = $('#digit'); el.textContent = d; el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
      await sleep(1000);
    }
    snd.currentTime = 0; snd.play().catch(() => {});
    const flash = $('#flash'); flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    const raw = await captureBlob();
    const rawUrl = URL.createObjectURL(raw);
    $('#proc-img').src = rawUrl;
    setState('proc');
    let ti = 0;
    const textTimer = setInterval(() => { $('#proc-text').textContent = PROC_TEXTS[++ti % PROC_TEXTS.length]; }, 3200);
    $('#proc-text').textContent = PROC_TEXTS[0];

    let shot;
    if (DEMO) {
      // Короткая пауза только ради ритма: без неё экран прыгает из вспышки сразу в результат.
      await sleep(900);
      const n = (Number(localStorage.getItem('urc24DemoNumber')) || 0) + 1;
      localStorage.setItem('urc24DemoNumber', String(n));
      shot = { id, number: n, aiUrl: null, demo: true, style: runtime.style };
    } else {
      try {
        shot = await postForm('/api/shot', [['id', [id]], ['photo', [raw, 'raw.jpg']]], 130000);
      } catch (e) {
        console.error('shot', e);
        shot = { id, number: 0, aiUrl: null, error: String(e.message || e), style: runtime.style };
      }
    }
    clearInterval(textTimer);

    const style = shot.style || runtime.style;
    let note = '';
    let blob = null;
    try {
      blob = await compose({ photoUrl: DEMO ? rawUrl : (shot.aiUrl || `/shots/${id}/raw.jpg`), number: shot.number || 0, style });
      if (!shot.aiUrl && !DEMO) note = shot.error ? 'Сервер фотозоны не ответил — кадр сохранён без комбинезона' : 'Комбинезон в этот раз не примерился — но кадр твой';
    } catch (e) {
      // Даже сырой файл недоступен (сервер лежит) — рисуем из локального blob
      blob = await compose({ photoUrl: rawUrl, number: shot.number || 0, style });
      note = 'Кадр сохранён локально — QR оживёт, когда фотозона снова на связи';
    }
    URL.revokeObjectURL(rawUrl);

    if (DEMO) {
      // Сервера нет: QR ведёт на лендинг, а кадр гость забирает кнопкой «Сохранить».
      if (saveUrl) URL.revokeObjectURL(saveUrl);
      saveUrl = URL.createObjectURL(blob);
      const a = $('#save');
      a.href = saveUrl;
      a.download = 'urc24-pilot-' + String(shot.number).padStart(3, '0') + '.jpg';
      a.hidden = false;
      $('#qr').src = 'assets/demo-qr.png';
      $('#qr').style.visibility = 'visible';
    } else {
      let fin = null;
      try {
        fin = await postForm('/api/finalize', [['id', [id]], ['final', [blob, 'final.jpg']]], 20000);
      } catch (e) {
        console.error('finalize', e);
        if (!note) note = 'Не удалось отправить кадр на сервер — попробуй ещё раз';
      }
      $('#qr').src = fin ? fin.qrUrl : '';
      $('#qr').style.visibility = fin ? 'visible' : 'hidden';
    }
    $('#result-note').textContent = note;
    setState('result');
    clearTimeout(resultTimer);
    resultTimer = setTimeout(goIdle, RESULT_MS);
  }

  function goIdle() {
    clearTimeout(resultTimer);
    $('#qr').src = '';
    $('#proc-img').src = '';
    if (DEMO) {
      $('#save').hidden = true;
      if (saveUrl) { URL.revokeObjectURL(saveUrl); saveUrl = null; }
    }
    setState('idle');
    if (!DEMO && (!stream || !stream.active)) startCamera();
  }

  async function trigger() {
    const now = Date.now();
    if (now - lastTrigger < 400) return;
    lastTrigger = now;
    if (state !== 'idle' && state !== 'result') return;
    // В демо камера просыпается по первому нажатию: жест пользователя — единственный
    // надёжный способ получить её на iOS Safari.
    if (DEMO && (!stream || !stream.active)) {
      setState('boot');
      const ok = await startCamera();
      setState('idle');
      if (!ok) return;
    }
    runShot().catch((e) => { console.error(e); goIdle(); });
  }

  // ---------- ввод: USB-кнопка = клавиатура; тач/клик — дубль ----------
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyA') { e.preventDefault(); toggleAdmin(); return; }
    if (adminOpen) { if (e.key === 'Escape') toggleAdmin(false); return; }
    if (e.repeat) return;
    if (['F5', 'F11', 'F12'].includes(e.key) || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    trigger();
  });
  // Ссылку «Сохранить кадр» исключаем: иначе тап по ней и скачает файл, и запустит новый снимок.
  document.addEventListener('pointerdown', (e) => { if (!adminOpen && !e.target.closest('a')) trigger(); });

  function toggleAdmin(force) {
    if (DEMO) return; // панели оператора в статической сборке нет
    adminOpen = force === undefined ? !adminOpen : force;
    const f = $('#adminframe');
    f.hidden = !adminOpen;
    f.src = adminOpen ? '/admin' : 'about:blank';
    body.classList.toggle('admin-open', adminOpen);
    if (!adminOpen) refreshStatus();
  }

  // ---------- здоровье сервера ----------
  async function refreshStatus() {
    try {
      const r = await fetch('/api/status', { signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      const prevCam = runtime.cameraLabel;
      runtime = { ...runtime, ...j.runtime };
      if (prevCam !== runtime.cameraLabel && state === 'idle') startCamera();
      if (statusMisses >= 3) location.reload();
      statusMisses = 0;
      $('#banner').hidden = true;
    } catch {
      statusMisses++;
      if (statusMisses >= 3) $('#banner').hidden = false;
    }
  }
  if (!DEMO) {
    setInterval(refreshStatus, 10000);
    setInterval(() => { if (state === 'idle' && Date.now() - lastActivity > IDLE_RELOAD_MS) location.reload(); }, 60000);
  }

  (async () => {
    if (DEMO) {
      // Тексты киоска обещают ИИ и QR — в демо этого нет, не вводим гостя в заблуждение.
      $('#s-idle .lead').textContent = 'Нажми кнопку — камера снимет кадр и оформит его в карточку пилота URC24.';
      $('#s-idle .consent').textContent = 'Демо-версия: кадр обрабатывается прямо в браузере, никуда не отправляется и нигде не сохраняется. Комбинезон примеряет ИИ — только на самой фотозоне 12 декабря.';
      $('.qr-lead').textContent = 'Наведи камеру телефона на QR — откроется программа URC24';
      $('.again').textContent = 'Нажми ещё раз, чтобы переснять';
      ensureAssets().catch(() => {});
      setState('idle');
      return;
    }
    await refreshStatus();
    await startCamera();
    ensureAssets().catch(() => {});
    setState('idle');
  })();
})();
