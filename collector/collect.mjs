// 바이낸스 스팟 호가창을 한 번 찍어 매물대 기록(data/<심볼>.json)을 갱신한다.
// GitHub Actions가 5분마다 실행한다. index.html의 매물대 판정 규칙과 같은 규칙을 쓴다.
import fs from 'node:fs';
import path from 'node:path';

const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api-gcp.binance.com', 'https://api1.binance.com'];
const OUT = process.env.OUT_DIR || 'data';
const RANGE = 0.03, KEEP_MS = 72 * 36e5, MAX_WALLS = 800;
const symbols = JSON.parse(fs.readFileSync(new URL('./symbols.json', import.meta.url), 'utf8'));

async function get(p) {
  let last;
  for (const h of HOSTS) {
    try {
      const r = await fetch(h + p, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(h + ' HTTP ' + r.status);
      return await r.json();
    } catch (e) { last = e; console.warn('  실패:', e.message); }
  }
  throw last;
}
const stepAt = k => [1, 2, 5][((k % 3) + 3) % 3] * Math.pow(10, Math.floor(k / 3));
function baseK(price) {
  const target = price * 0.0002; let best = 0, bd = Infinity;
  for (let k = -30; k <= 30; k++) { const d = Math.abs(Math.log(stepAt(k) / target)); if (d < bd) { bd = d; best = k; } }
  return best;
}

export function update(prev, depth, klines, now) {
  const bids = depth.bids.map(x => [+x[0], +x[1]]), asks = depth.asks.map(x => [+x[0], +x[1]]);
  let bb = -Infinity, ba = Infinity, lowBid = Infinity, highAsk = -Infinity;
  for (const [p] of bids) { if (p > bb) bb = p; if (p < lowBid) lowBid = p; }
  for (const [p] of asks) { if (p < ba) ba = p; if (p > highAsk) highAsk = p; }
  const mid = (bb + ba) / 2;
  // 가격 묶음 단위는 가격이 크게 변했을 때만 바꾼다 (바뀌면 기록을 새로 시작)
  let b = prev && prev.bucket;
  const ratio = b ? mid * 0.0002 / b : 0;
  if (!b || ratio < 0.45 || ratio > 2.2) { b = stepAt(baseK(mid)); prev = null; }
  const lo = Math.max(mid * (1 - RANGE), lowBid);
  const hi = Math.min(mid * (1 + RANGE), highAsk);
  const bidB = new Map(), askB = new Map();
  const add = (m, p, q) => { const i = Math.floor(p / b + 1e-9); let o = m.get(i); if (!o) { o = { q: 0, n: 0 }; m.set(i, o); } o.q += q; o.n += p * q; };
  for (const [p, q] of bids) if (p >= lo) add(bidB, p, q);
  for (const [p, q] of asks) if (p <= hi) add(askB, p, q);
  const all = [...bidB.values(), ...askB.values()].map(o => o.n).sort((x, y) => x - y);
  const raw = Math.max((all[all.length >> 1] || 0) * 5, all[Math.floor(all.length * 0.97)] || 0);
  const thr = prev && prev.thr ? prev.thr * 0.5 + raw * 0.5 : raw;

  const first = !prev;
  const walls = prev ? prev.walls : [];
  const active = new Map(walls.filter(w => w.active).map(w => [w.key, w]));
  for (const [side, m] of [['bid', bidB], ['ask', askB]]) {
    for (const [i, o] of m) {
      const key = side + i, w = active.get(key), tier = o.n >= thr * 2.5 ? 2 : 1, n = Math.round(o.n);
      if (w) {
        if (o.n >= thr * 0.6) {
          w.last = now; w.size = n; w.qty = +o.q.toPrecision(6); if (n > w.max) w.max = n;
          const sg = w.segs[w.segs.length - 1];
          if (sg.tier !== tier || Math.abs(n - sg.n) / sg.n > 0.25) w.segs.push({ t: now, n, tier });
          if (w.segs.length > 60) w.segs = w.segs.slice(-60);
        }
      } else if (o.n >= thr) {
        const nw = { key, side, lo: i * b, hi: (i + 1) * b, price: (i + 0.5) * b, start: now, last: now, size: n, qty: +o.q.toPrecision(6), max: n, active: true, segs: [{ t: now, n, tier }] };
        if (first) nw.pre = true;
        walls.push(nw); active.set(key, nw);
      }
    }
  }
  // 이번에 보이지 않은 매물대는 종료 처리하고, 그 사이 가격이 닿았는지로 체결/취소를 추정한다
  for (const w of active.values()) {
    if (w.last === now) continue;
    if (w.hi < lo || w.lo > hi) continue; // 탐지 범위 밖이면 판단을 미룬다
    let kh = -Infinity, kl = Infinity;
    for (const k of klines) if (k[0] + 60000 >= w.last) { if (+k[2] > kh) kh = +k[2]; if (+k[3] < kl) kl = +k[3]; }
    kh = Math.max(kh, ba); kl = Math.min(kl, bb);
    w.active = false;
    w.fate = (w.side === 'ask' ? kh >= w.lo : kl <= w.hi) ? 'filled' : 'pulled';
  }
  let kept = walls.filter(w => w.active || (now - w.last <= KEEP_MS && (w.last > w.start || w.pre)));
  if (kept.length > MAX_WALLS) { let drop = kept.length - MAX_WALLS; kept = kept.filter(w => w.active || drop-- <= 0); }
  return { bucket: b, thr: Math.round(thr), range: RANGE, t: now, started: prev && prev.started ? prev.started : now, walls: kept };
}

async function run(sym) {
  const file = path.join(OUT, sym + '.json');
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  const [depth, klines] = await Promise.all([get('/api/v3/depth?symbol=' + sym + '&limit=5000'), get('/api/v3/klines?symbol=' + sym + '&interval=1m&limit=120')]);
  const next = update(prev, depth, klines, Date.now());
  next.symbol = sym;
  fs.writeFileSync(file, JSON.stringify(next));
  console.log(sym, '묶음', next.bucket, '기준', next.thr, '매물대', next.walls.length, '(유지 중', next.walls.filter(w => w.active).length + ')');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  fs.mkdirSync(OUT, { recursive: true });
  let failed = 0;
  for (const s of symbols) { try { await run(s); } catch (e) { failed++; console.error(s, '수집 실패:', e.message); } }
  if (failed === symbols.length) process.exit(1);
}
