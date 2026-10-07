// ===== 買い目の削減 (被覆コード) =====
// 各試合で選んだ印の直積 P が「本来の予想」。そこから「外れそうな組み合わせ」を除いた集合 U について、
// U のどの結果に対しても、買い目のどれかとの不一致数が radius 以下になる買い目集合を作る。
//   radius 0 = 1等保証 (U を全部買う)、1 = 2等保証 (1試合外れまで)、2 = 3等保証
// 組み合わせは 3 進数の整数で表す (桁 i = 試合 i、 1→0, 0→1, 2→2)。

const DIGIT_OF = { "1": 0, "0": 1, "2": 2 };
const MARK_OF = ["1", "0", "2"];
const MAX_UNIVERSE = 600000;     // フィルタ後の U の上限
const MAX_PRODUCT = 1594323;     // 3^13
const TICKET_PRICE = 100;

function pow3(n) {
  const a = [1];
  for (let i = 1; i <= n; i++) a.push(a[i - 1] * 3);
  return a;
}

function decode(code, n) {
  const d = new Array(n);
  for (let i = 0; i < n; i++) { d[i] = code % 3; code = (code - d[i]) / 3; }
  return d;
}

function codeToMarks(code, n) {
  return decode(code, n).map(x => MARK_OF[x]).join("");
}

function marksToCode(marks) {
  const P = pow3(marks.length);
  let c = 0;
  for (let i = 0; i < marks.length; i++) c += DIGIT_OF[marks[i]] * P[i];
  return c;
}

// allowed: 試合ごとの許可された桁の配列 例 [[0],[0,1],[0,1,2],...]
function productSize(allowed) {
  return allowed.reduce((n, a) => n * a.length, 1);
}

// code の半径 r 以内 (各桁は allowed のみ) を列挙
function forEachInBall(code, digits, allowed, P, radius, cb) {
  cb(code);
  if (radius < 1) return;
  const n = digits.length;
  for (let i = 0; i < n; i++) {
    for (const a of allowed[i]) {
      if (a === digits[i]) continue;
      const ci = code + (a - digits[i]) * P[i];
      cb(ci);
      if (radius < 2) continue;
      for (let j = i + 1; j < n; j++) {
        for (const b of allowed[j]) {
          if (b === digits[j]) continue;
          cb(ci + (b - digits[j]) * P[j]);
        }
      }
    }
  }
}

// ===== 予想範囲の列挙とフィルタ =====
// probs: 試合ごとの [p1, p0, p2]
// filters: { massPct: 0..100, maxUpsets: number|null, drawMin, drawMax }
function buildUniverse(allowed, probs, filters) {
  const n = allowed.length;
  const P = pow3(n);
  const size = productSize(allowed);
  if (size > MAX_PRODUCT) throw new Error("組み合わせが多すぎます");

  const fav = probs.map(p => p.indexOf(Math.max(...p)));
  const codes = new Int32Array(size);
  const prob = new Float64Array(size);
  const upsets = new Uint8Array(size);
  const draws = new Uint8Array(size);

  // 直積を桁ごとに展開
  let len = 1;
  codes[0] = 0; prob[0] = 1;
  for (let i = 0; i < n; i++) {
    const opts = allowed[i];
    for (let k = len - 1; k >= 0; k--) {
      for (let o = opts.length - 1; o >= 0; o--) {
        const d = opts[o];
        const t = k * opts.length + o;
        codes[t] = codes[k] + d * P[i];
        prob[t] = prob[k] * probs[i][d];
        upsets[t] = upsets[k] + (d !== fav[i] ? 1 : 0);
        draws[t] = draws[k] + (d === 1 ? 1 : 0);
      }
    }
    len *= opts.length;
  }

  let totalMass = 0;
  for (let k = 0; k < size; k++) totalMass += prob[k];

  // 確率上位 massPct% に入るための下限値
  let minProb = 0;
  const massPct = filters.massPct ?? 100;
  if (massPct < 100) {
    const sortedP = Float64Array.from(prob).sort();
    const target = totalMass * massPct / 100;
    let acc = 0;
    for (let k = size - 1; k >= 0; k--) {
      acc += sortedP[k];
      if (acc >= target) { minProb = sortedP[k]; break; }
    }
  }

  const maxUp = filters.maxUpsets ?? n;
  const dMin = filters.drawMin ?? 0;
  const dMax = filters.drawMax ?? n;
  const keep = [];
  let keptMass = 0;
  const removed = { mass: 0, upsets: 0, draws: 0 };
  for (let k = 0; k < size; k++) {
    if (prob[k] < minProb) { removed.mass++; continue; }
    if (upsets[k] > maxUp) { removed.upsets++; continue; }
    if (draws[k] < dMin || draws[k] > dMax) { removed.draws++; continue; }
    keep.push(k);
    keptMass += prob[k];
  }

  const uCodes = new Int32Array(keep.length);
  const uProb = new Float64Array(keep.length);
  keep.forEach((k, i) => { uCodes[i] = codes[k]; uProb[i] = prob[k]; });

  return {
    n, P, allowed, fav,
    productSize: size, productMass: totalMass,
    codes: uCodes, prob: uProb, mass: keptMass,
    removed,
  };
}

// ===== グリーディ被覆 =====
function greedyCover(U, radius, opts = {}) {
  const { n, P, allowed } = U;
  const space = P[n];
  const m = U.codes.length;
  if (m === 0) return [];
  if (radius === 0) return Array.from(U.codes);

  const inU = new Uint8Array(space);
  for (let i = 0; i < m; i++) inU[U.codes[i]] = 1;

  // 候補 = U から半径以内の点 (ここ以外の買い目は U をカバーしない)
  const candIdx = new Int32Array(space).fill(-1);
  const cands = [];
  for (let i = 0; i < m; i++) {
    const c = U.codes[i];
    forEachInBall(c, decode(c, n), allowed, P, radius, v => {
      if (candIdx[v] < 0) { candIdx[v] = cands.length; cands.push(v); }
    });
  }
  const nc = cands.length;
  const candDigits = new Array(nc);
  const candProb = new Float64Array(nc);
  const probs = opts.probs;
  for (let k = 0; k < nc; k++) {
    const d = decode(cands[k], n);
    candDigits[k] = d;
    let p = 1;
    for (let i = 0; i < n; i++) p *= probs ? probs[i][d[i]] : 1;
    candProb[k] = p;
  }

  const ballMembersInU = (k, cb) => forEachInBall(cands[k], candDigits[k], allowed, P, radius, v => { if (inU[v]) cb(v); });

  const gain = new Int32Array(nc);
  let maxGain = 0;
  for (let k = 0; k < nc; k++) {
    let g = 0;
    ballMembersInU(k, () => g++);
    gain[k] = g;
    if (g > maxGain) maxGain = g;
  }

  // バケット: 同じ獲得数の中では、確率が高い候補 (または乱数順) を先に
  const rand = opts.seed != null ? mulberry32(opts.seed) : null;
  const order = Array.from({ length: nc }, (_, k) => k);
  if (rand) {
    for (let i = nc - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  } else {
    order.sort((a, b) => candProb[a] - candProb[b]); // 末尾から取り出すので昇順
  }
  const buckets = Array.from({ length: maxGain + 1 }, () => []);
  for (const k of order) buckets[gain[k]].push(k);

  const covered = new Uint8Array(space);
  let remaining = m;
  const chosen = [];

  const choose = k => {
    chosen.push(k);
    ballMembersInU(k, v => { if (!covered[v]) { covered[v] = 1; remaining--; } });
  };

  if (opts.first != null && candIdx[opts.first] >= 0) choose(candIdx[opts.first]);

  let g = maxGain;
  while (remaining > 0 && g > 0) {
    const b = buckets[g];
    if (!b.length) { g--; continue; }
    const k = b.pop();
    let real = 0;
    ballMembersInU(k, v => { if (!covered[v]) real++; });
    if (real === g) choose(k);
    else if (real > 0) buckets[real].push(k);
  }

  // 冗長な買い目を除去 (確率の低い順に、外しても全体がカバーされるなら外す)
  const cnt = new Uint8Array(space);
  for (const k of chosen) ballMembersInU(k, v => { if (cnt[v] < 255) cnt[v]++; });
  const byProb = chosen.slice().sort((a, b) => candProb[a] - candProb[b]);
  const removed = new Set();
  for (const k of byProb) {
    let redundant = true;
    ballMembersInU(k, v => { if (cnt[v] < 2) redundant = false; });
    if (redundant) {
      removed.add(k);
      ballMembersInU(k, v => { cnt[v]--; });
    }
  }

  return chosen.filter(k => !removed.has(k)).map(k => cands[k]);
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function ticketMass(tickets, probs, n) {
  let s = 0;
  for (const c of tickets) {
    const d = decode(c, n);
    let p = 1;
    for (let i = 0; i < n; i++) p *= probs[i][d[i]];
    s += p;
  }
  return s;
}

// 局所探索: 買い目 t だけがカバーしている点をすべてカバーできる別の買い目に置き換える (枚数は同じ)。
// これを乱択で繰り返す途中で、どこからも必要とされなくなった買い目を削除して枚数を減らす。
function improveCover(U, radius, tickets, ms, seed) {
  const { n, P, allowed } = U;
  const space = P[n];
  const inU = new Uint8Array(space);
  for (let i = 0; i < U.codes.length; i++) inU[U.codes[i]] = 1;
  const cnt = new Int32Array(space);
  const isT = new Uint8Array(space);
  const ball = (c, cb) => forEachInBall(c, decode(c, n), allowed, P, radius, v => { if (inU[v]) cb(v); });
  const T = tickets.slice();
  for (const t of T) { isT[t] = 1; ball(t, v => cnt[v]++); }

  const rand = mulberry32(seed);
  const t0 = performance.now();
  const mark = new Int32Array(space);
  let stamp = 0;
  while (performance.now() - t0 < ms && T.length > 1) {
    const idx = Math.floor(rand() * T.length);
    const t = T[idx];
    const only = [];
    ball(t, v => { if (cnt[v] === 1) only.push(v); });
    if (!only.length) {
      ball(t, v => cnt[v]--);
      isT[t] = 0;
      T[idx] = T[T.length - 1];
      T.pop();
      continue;
    }
    // 置き換え候補は only[0] から半径以内にある
    const cands = [];
    forEachInBall(only[0], decode(only[0], n), allowed, P, radius, c => { if (c !== t && !isT[c]) cands.push(c); });
    for (let i = cands.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [cands[i], cands[j]] = [cands[j], cands[i]];
    }
    for (const c of cands) {
      stamp++;
      ball(c, v => { mark[v] = stamp; });
      if (only.every(x => mark[x] === stamp)) {
        ball(t, v => cnt[v]--);
        isT[t] = 0;
        ball(c, v => cnt[v]++);
        isT[c] = 1;
        T[idx] = c;
        break;
      }
    }
  }
  return T;
}

// 時間内で乱択を繰り返し、最も枚数が少ない (同数なら1等確率が高い) 解を選び、局所探索で更に減らす
function bestCover(U, radius, probs, timeBudgetMs = 1500) {
  const t0 = performance.now();
  let first = null, bestP = -1;
  for (let i = 0; i < U.codes.length; i++) if (U.prob[i] > bestP) { bestP = U.prob[i]; first = U.codes[i]; }

  let best = greedyCover(U, radius, { probs, first });
  let bestMass = ticketMass(best, probs, U.n);
  let runs = 1;
  if (radius === 0) return { tickets: best, runs, mainTicket: first };
  while (performance.now() - t0 < timeBudgetMs * 0.4 && runs < 40) {
    const t = greedyCover(U, radius, { probs, seed: runs * 7919 });
    runs++;
    const mass = ticketMass(t, probs, U.n);
    if (t.length < best.length || (t.length === best.length && mass > bestMass)) {
      best = t; bestMass = mass;
    }
  }
  const rest = timeBudgetMs - (performance.now() - t0);
  if (rest > 50) {
    const improved = improveCover(U, radius, best, rest, 4242);
    if (improved.length < best.length) best = improved;
  }
  // 最も確率の高い買い目を先頭に
  const mass = new Map(best.map(c => [c, ticketMass([c], probs, U.n)]));
  best.sort((a, b) => mass.get(b) - mass.get(a));
  return { tickets: best, runs, mainTicket: best[0] };
}

// U 全体がカバーされているかを確認 (各買い目から半径内を全桁 0/1/2 で塗り、U の未塗りを探す)
function verifyCover(U, tickets, radius) {
  const { n, P } = U;
  const full = Array.from({ length: n }, () => [0, 1, 2]);
  const mark = new Uint8Array(P[n]);
  for (const c of tickets) forEachInBall(c, decode(c, n), full, P, radius, v => { mark[v] = 1; });
  for (let i = 0; i < U.codes.length; i++) if (!mark[U.codes[i]]) return false;
  return true;
}

// 実際の結果を確率どおりに乱数で発生させ、等級ごとの的中率を見積もる
function simulatePrizes(tickets, probs, n, samples = 30000) {
  const P = pow3(n);
  const has = new Uint8Array(P[n]);
  for (const c of tickets) has[c] = 1;
  const all = [[0, 1, 2]];
  const full = Array.from({ length: n }, () => all[0]);
  const rand = mulberry32(12345);
  const cum = probs.map(p => [p[0], p[0] + p[1]]);
  let hit = [0, 0, 0]; // 最良の等級: 1等, 2等以上, 3等以上
  for (let s = 0; s < samples; s++) {
    let code = 0;
    const d = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = rand();
      d[i] = r < cum[i][0] ? 0 : r < cum[i][1] ? 1 : 2;
      code += d[i] * P[i];
    }
    if (has[code]) { hit[0]++; hit[1]++; hit[2]++; continue; }
    let best = 3;
    forEachInBall(code, d, full, P, n >= 13 ? 2 : 1, v => {
      if (!has[v]) return;
      let dist = 0, x = v, y = code;
      for (let i = 0; i < n; i++) { if (x % 3 !== y % 3) dist++; x = Math.floor(x / 3); y = Math.floor(y / 3); }
      if (dist < best) best = dist;
    });
    if (best <= 1) hit[1]++;
    if (best <= 2) hit[2]++;
  }
  return { first: hit[0] / samples, second: hit[1] / samples, third: hit[2] / samples, samples };
}
