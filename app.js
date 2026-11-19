(() => {
  const $ = id => document.getElementById(id);
  const canvas = $('preview'), ctx = canvas.getContext('2d');
  const FONT = '-apple-system, "Apple SD Gothic Neo", "Noto Sans KR", Helvetica, Arial, sans-serif';
  let bgImg = null;
  let worker = null;

  /* ---------- 상태 표시 ---------- */
  function status(msg, err = false) { const s = $('status'); s.textContent = msg; s.className = err ? 'err' : ''; }

  /* ---------- 이미지 로딩 ---------- */
  function loadImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => res({ img, url });
      img.onerror = () => rej(new Error('이미지를 열 수 없어요 (HEIC는 지원이 제한될 수 있어요)'));
      img.src = url;
    });
  }

  /* ---------- OCR 전처리: 어두운 배경 + 컬러 숫자 → 흰 배경 + 검은 글씨 ---------- */
  function preprocess(img) {
    const scale = Math.min(1, 1600 / img.naturalWidth);
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h), p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      const v = Math.max(p[i], p[i + 1], p[i + 2]);   // 컬러 숫자는 어느 채널이든 밝음
      const o = v > 110 ? 0 : 255;                    // 글씨=검정, 배경=흰색
      p[i] = p[i + 1] = p[i + 2] = o; p[i + 3] = 255;
    }
    g.putImageData(d, 0, 0);
    return c;
  }

  async function getWorker() {
    if (worker) return worker;
    const abs = p => new URL(p, location.href).href;
    worker = await Tesseract.createWorker('eng', 1, {
      workerPath: abs('vendor/worker.min.js'),
      corePath: abs('vendor/core/'),
      langPath: abs('vendor/lang/'),
      logger: m => { if (m.status === 'recognizing text') status(`글자 읽는 중… ${Math.round(m.progress * 100)}%`); }
    });
    await worker.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
    return worker;
  }

  /* ---------- 날짜 보정 ---------- */
  // 영어 OCR 은 「년/월/일」 을 숫자 옆의 잡음 글자(9, 2, ¥ 등)로 읽는다.
  //   예) "20269 112 18¥"  →  2026 / 11 / 18
  // 잡음이 붙은 토큰은 숫자만 남기고, 숫자만 있는 3자리 토큰은 마지막 글자를 잡음으로 보고 뗀다.
  function parseDate(text) {
    const m = text.match(/(20\d{2})\S?\s+(\d\S{0,2})\s+(\d\S{0,2})/);
    if (!m) return '';
    const pick = (tok, max) => {
      const digits = tok.match(/^\d+/)[0];
      const noisy = tok.length > digits.length;
      let cands = [];
      if (noisy) cands = [digits];
      else if (digits.length >= 3) cands = [digits.slice(0, -1)];
      else cands = [digits, digits.slice(0, 1)];
      for (const c of cands) { const n = +c; if (n >= 1 && n <= max) return n; }
      return 0;
    };
    const y = +m[1], mo = pick(m[2], 12), d = pick(m[3], 31);
    if (!mo || !d) return '';
    const dt = new Date(y, mo - 1, d);
    if (dt.getMonth() !== mo - 1) return '';     // 2월 30일 같은 잘못된 날짜 거르기
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  const WEATHER = {
    sunny: ['☀️', '맑음'], partly: ['🌤️', '구름 조금'], cloudy: ['☁️', '흐림'],
    rain: ['🌧️', '비'], snow: ['❄️', '눈'], fog: ['🌫️', '안개'], wind: ['💨', '바람']
  };
  const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
  function dateLabel(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    const dt = new Date(+m[1], +m[2] - 1, +m[3]);
    return `${m[1]}.${m[2]}.${m[3]} (${DAYS[dt.getDay()]})`;
  }

  /* ---------- OCR 결과에서 값 뽑기 ---------- */
  function parseResult(data) {
    const lines = [];
    (data.lines || []).forEach(l => lines.push({ text: l.text, x: l.bbox.x0, y: l.bbox.y0 }));
    // 단어 단위도 같이 (sparse 모드에서 한 줄에 두 칸이 붙을 수 있음)
    const words = (data.words || []).map(w => ({ text: w.text, x: w.bbox.x0, y: w.bbox.y0 }));
    const all = lines.concat(words);

    const times = [], kcals = [], dists = [];
    for (const t of all) {
      const s = t.text.replace(/[Oo]/g, '0').replace(/[|lI]/g, '1');
      for (const m of s.matchAll(/(\d{1,2})\s*[:;.]\s*([0-5]\d)\s*[:;.]\s*([0-5]\d)/g))
        times.push({ v: `${+m[1]}:${m[2]}:${m[3]}`, x: t.x, y: t.y });
      for (const m of t.text.matchAll(/(\d{2,4})\s*K?\s*C\s*A\s*L/gi))
        kcals.push({ v: m[1], x: t.x, y: t.y });
      for (const m of t.text.matchAll(/(\d{1,3}[.,]\d{1,2})\s*K\s*M/gi))
        dists.push({ v: m[1].replace(',', '.'), x: t.x, y: t.y });
    }
    const dedupe = a => { const seen = new Set(); return a.filter(o => { const k = o.v + '@' + Math.round(o.y / 20) + ',' + Math.round(o.x / 20); if (seen.has(k)) return false; seen.add(k); return true; }); };
    const byPos = (a, b) => a.y - b.y || a.x - b.x;
    const T = dedupe(times).sort(byPos), K = dedupe(kcals).sort(byPos), D = dedupe(dists).sort(byPos);

    // 운동 시간: 첫 번째(왼쪽 위) 시간 값 / 활동 칼로리: 가장 위쪽 kcal / 거리: 첫 번째 km
    // 시간대·날짜: 「2026년 11월 18일 16:53 ~ 17:23」 줄에서 뽑는다 (한글은 못 읽어서 숫자 뒤에 잡음 글자가 붙는다)
    let range = '', date = '';
    for (const l of lines.slice().sort(byPos)) {
      const rm = l.text.match(/(\d{1,2})\s*:\s*([0-5]\d)\s*[~∼\-–—]\s*(\d{1,2})\s*:\s*([0-5]\d)/);
      if (rm && !range) { range = `${+rm[1]}:${rm[2]} ~ ${+rm[3]}:${rm[4]}`; }
      if (!date) date = parseDate(l.text);
    }
    return { time: T[0]?.v || '', kcal: K[0]?.v || '', dist: D[0]?.v || '', range, date, raw: { T, K, D } };
  }

  async function runOcr(img) {
    const pre = preprocess(img);
    const w = await getWorker();
    const { data } = await w.recognize(pre);
    return parseResult(data);
  }

  /* ---------- 스크린샷 선택 ---------- */
  let thumbUrl = null;
  $('shot').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      status('이미지 불러오는 중…');
      const { img, url } = await loadImage(f);
      const th = $('shotThumb'); if (thumbUrl) URL.revokeObjectURL(thumbUrl); thumbUrl = url; th.src = url; th.style.display = 'block';
      status('글자 엔진 준비 중… (처음에는 몇 초 걸려요)');
      const r = await runOcr(img);
      $('vTime').value = r.time; $('vKcal').value = r.kcal; $('vDist').value = r.dist;
      $('vRange').value = r.range; $('vDate').value = r.date;
      const miss = [!r.time && '시간', !r.kcal && '칼로리'].filter(Boolean);
      if (miss.length) status(`${miss.join('·')}을(를) 못 읽었어요. 직접 입력해주세요.`, true);
      else status(r.date ? '완료! 값이 맞는지 확인하세요. (날짜는 한글 때문에 틀릴 수 있어요)' : '완료! 날짜는 못 읽었어요. 직접 골라주세요.');
      draw();
    } catch (err) {
      console.error(err);
      status('읽기 실패: ' + (err.message || err) + ' — 값을 직접 입력할 수 있어요.', true);
    }
  });

  /* ---------- 배경 사진 ---------- */
  $('bgPic').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const { img, url } = await loadImage(f); URL.revokeObjectURL(url); bgImg = img; $('dimWrap').style.display = 'block'; draw(); }
    catch (err) { status(err.message, true); }
  });
  $('bgClear').addEventListener('click', () => { bgImg = null; $('bgPic').value = ''; $('dimWrap').style.display = 'none'; draw(); });

  /* ---------- 카드 그리기 ---------- */
  function sizeFor(ratio) {
    const W = 1080;
    return ratio === '1:1' ? [W, 1080] : ratio === '9:16' ? [W, 1920] : [W, 1350];
  }

  function draw() {
    const [W, H] = sizeFor($('ratio').value);
    canvas.width = W; canvas.height = H;
    const bg = $('cBg').value, fg = $('cFg').value, acc = $('cAcc').value;

    // 배경
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    if (bgImg) {
      const s = Math.max(W / bgImg.naturalWidth, H / bgImg.naturalHeight);
      const dw = bgImg.naturalWidth * s, dh = bgImg.naturalHeight * s;
      ctx.drawImage(bgImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
      const dim = +$('dim').value / 100;
      $('dimVal').textContent = Math.round(dim * 100) + '%';
      if (dim > 0) { ctx.fillStyle = `rgba(0,0,0,${dim})`; ctx.fillRect(0, 0, W, H); }
    }

    // 항목
    const items = [];
    const t = $('vTime').value.trim(), k = $('vKcal').value.trim(), d = $('vDist').value.trim();
    if ($('showDist').checked && d) items.push({ label: 'DISTANCE', value: d, unit: 'KM' });
    items.push({ label: 'TIME', value: t || '–:––:––', unit: '' });
    items.push({ label: 'CALORIES', value: k || '–––', unit: 'KCAL' });

    // 날짜 · 시간대 · 날씨 (비어 있는 항목은 건너뜀)
    const metaParts = [];
    const dl = dateLabel($('vDate').value); if (dl) metaParts.push(dl);
    const rg = $('vRange').value.trim().replace(/\s*[~∼\-–—]\s*/, ' ~ '); if (rg) metaParts.push(rg);
    const wx = WEATHER[$('vWx').value], tp = $('vTemp').value.replace(/[^\d.\-]/g, '');
    const wxText = [wx ? `${wx[0]} ${wx[1]}` : '', tp ? `${tp}°C` : ''].filter(Boolean).join(' ');
    if (wxText) metaParts.push(wxText);
    const meta = metaParts.join('  ·  ');

    // 글씨 크기: 슬라이더 비율 적용. 항목이 많아 카드를 넘칠 땐 자동으로 줄여서 맞춘다.
    const fk = +$('fsize').value / 100;
    const layout = f => {
      const big = Math.round(W * 0.2 * f), lab = Math.round(W * 0.04 * f), unitSz = Math.round(W * 0.075 * f);
      const gap = Math.round(W * 0.07 * f);
      const blockH = lab + 18 + big;           // 라벨 + 간격 + 숫자
      const metaSz = meta ? Math.round(W * 0.043 * f) : 0;
      const metaBlock = meta ? metaSz + Math.round(W * 0.06 * f) : 0;
      return { big, lab, unitSz, gap, blockH, metaSz, metaBlock, totalH: metaBlock + items.length * blockH + (items.length - 1) * gap };
    };
    let L = layout(fk);
    if (L.totalH > H * 0.84) L = layout(fk * (H * 0.84) / L.totalH);
    // 가로로 넘치는 경우(긴 시간 값 등)도 자동 축소
    ctx.font = `800 ${L.big}px ${FONT}`;
    const widest = Math.max(...items.map(it => ctx.measureText(it.value).width + (it.unit ? L.unitSz * 2.4 : 0)));
    if (widest > W * 0.92) L = layout((L.big / (W * 0.2)) * (W * 0.92) / widest);
    const { big, lab, unitSz, gap, blockH, metaBlock, totalH } = L;
    let metaSz = L.metaSz;
    if (meta) {                                   // 메타 줄이 너무 길면 그 줄만 줄여서 맞춘다
      ctx.font = `600 ${metaSz}px ${FONT}`;
      const mw = ctx.measureText(meta).width;
      if (mw > W * 0.92) metaSz = Math.floor(metaSz * (W * 0.92) / mw);
    }
    $('fsizeVal').textContent = Math.round(fk * 100) + '%';
    const pos = $('pos').value;
    let y0 = pos === 'top' ? H * 0.12 : pos === 'bottom' ? H - totalH - H * 0.1 : (H - totalH) / 2;

    ctx.textBaseline = 'alphabetic';
    const shadow = !!bgImg;
    if (meta) {
      ctx.save();
      if (shadow) { ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 24; }
      ctx.textAlign = 'center'; ctx.fillStyle = fg; ctx.globalAlpha = 0.9;
      ctx.font = `600 ${metaSz}px ${FONT}`;
      ctx.fillText(meta, W / 2, y0 + metaSz);
      ctx.restore();
    }
    items.forEach((it, i) => {
      const y = y0 + metaBlock + i * (blockH + gap);
      ctx.save();
      if (shadow) { ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 24; }
      // 라벨
      ctx.textAlign = 'center';
      ctx.fillStyle = acc; ctx.font = `700 ${lab}px ${FONT}`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = Math.round(lab * 0.25) + 'px';
      ctx.fillText(it.label, W / 2, y + lab);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      // 값 + 단위 (한 덩어리로 가운데 정렬)
      ctx.font = `800 ${big}px ${FONT}`;
      const vw = ctx.measureText(it.value).width;
      ctx.font = `800 ${unitSz}px ${FONT}`;
      const uw = it.unit ? ctx.measureText(it.unit).width + 16 : 0;
      const startX = (W - (vw + uw)) / 2, baseY = y + lab + 18 + big * 0.86;
      ctx.textAlign = 'left'; ctx.fillStyle = fg;
      ctx.font = `800 ${big}px ${FONT}`; ctx.fillText(it.value, startX, baseY);
      if (it.unit) { ctx.font = `800 ${unitSz}px ${FONT}`; ctx.fillText(it.unit, startX + vw + 16, baseY); }
      ctx.restore();
    });
  }

  ['vTime', 'vKcal', 'vDist', 'vDate', 'vRange', 'vWx', 'vTemp'].forEach(id => $(id).addEventListener('input', draw));
  ['showDist', 'ratio', 'pos', 'cBg', 'cFg', 'cAcc', 'dim', 'fsize'].forEach(id => $(id).addEventListener('input', draw));

  /* ---------- 저장 / 공유 ---------- */
  $('btnShare').addEventListener('click', async () => {
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    if (!blob) return status('이미지 생성 실패', true);
    const file = new File([blob], 'running-card.png', { type: 'image/png' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a');
    const dl = URL.createObjectURL(blob);
    a.href = dl; a.download = 'running-card.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(dl), 10000);
  });

  draw();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW 등록 실패', err));
  }
})();
