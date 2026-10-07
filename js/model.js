// ===== 過去データからの勝敗確率モデル =====
// 1. 全試合を時系列に Elo レーティングで処理 (得点差で重み付け)
// 2. 試合前のレート差 → 1/0/2 の確率を順序ロジットで表し、そのパラメータを過去データに当てはめる
// 3. 直接対決の成績・toto の投票率を任意の重みでブレンド

const ELO_START = 1500;
const ELO_HOME = 50;          // レート更新時のホーム補正 (確率計算のホーム補正は別途推定)
const ELO_GAP_DAYS = 200;     // これ以上試合が空いたらレートを平均に寄せる
const ELO_GAP_SHRINK = 0.75;
const FIT_MIN_GAMES = 6;      // 推定に使う試合: 両チームがこれ以上の試合数をこなしている

const OUTCOMES = ["1", "0", "2"];
const sigmoid = x => 1 / (1 + Math.exp(-x));

function eloK(games) {
  return games < 10 ? 40 : 24;
}

function goalFactor(gd) {
  const a = Math.abs(gd);
  if (a <= 1) return 1;
  if (a === 2) return 1.5;
  return (11 + a) / 8;
}

function daysBetween(a, b) {
  if (!a || !b) return 0;
  return (Date.parse(b) - Date.parse(a)) / 86400000;
}

// 順序ロジット: d = レート差 + h
function probsFromDiff(diff, params) {
  const d = diff + params.h;
  const p1 = sigmoid((d - params.c) / params.s);
  const p2 = sigmoid((-d - params.c) / params.s);
  const p0 = Math.max(0.02, 1 - p1 - p2);
  const t = p1 + p0 + p2;
  return [p1 / t, p0 / t, p2 / t];
}

function logLoss(samples, params) {
  let ll = 0;
  for (const smp of samples) {
    const p = probsFromDiff(smp.diff, params);
    ll -= Math.log(Math.max(1e-9, p[smp.r]));
  }
  return ll / samples.length;
}

// 座標ごとのグリッド探索でパラメータを当てはめる
function fitParams(samples) {
  const params = { h: 60, c: 110, s: 250 };
  if (samples.length < 300) return { params, fitted: false };
  const ranges = { h: [-50, 200], c: [10, 300], s: [80, 600] };
  let step = { h: 20, c: 20, s: 40 };
  for (let round = 0; round < 4; round++) {
    for (const key of ["h", "c", "s"]) {
      let best = params[key], bestLL = logLoss(samples, params);
      for (let v = params[key] - step[key] * 4; v <= params[key] + step[key] * 4; v += step[key]) {
        if (v < ranges[key][0] || v > ranges[key][1]) continue;
        const ll = logLoss(samples, { ...params, [key]: v });
        if (ll < bestLL) { bestLL = ll; best = v; }
      }
      params[key] = best;
    }
    step = { h: step.h / 2, c: step.c / 2, s: step.s / 2 };
  }
  return { params, fitted: true };
}

function resultIndex(r) {
  return r === "1" ? 0 : r === "0" ? 1 : 2;
}

// records: [{date, home, away, hg, ag, result}]
function buildModel(records) {
  const sorted = records
    .filter(m => m.home && m.away && OUTCOMES.includes(m.result))
    .slice()
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  const teams = new Map(); // name -> {rating, games, lastDate, history: []}
  const team = name => {
    if (!teams.has(name)) teams.set(name, { rating: ELO_START, games: 0, lastDate: null, history: [] });
    return teams.get(name);
  };
  const pairs = new Map();  // "A|B" (名前順) -> 試合リスト
  const samples = [];
  let draws = 0;

  for (const m of sorted) {
    const H = team(m.home), A = team(m.away);
    for (const t of [H, A]) {
      if (t.lastDate && daysBetween(t.lastDate, m.date) > ELO_GAP_DAYS) {
        t.rating = ELO_START + (t.rating - ELO_START) * ELO_GAP_SHRINK;
      }
    }
    const diff = H.rating - A.rating;
    if (H.games >= FIT_MIN_GAMES && A.games >= FIT_MIN_GAMES) {
      samples.push({ diff, r: resultIndex(m.result) });
    }
    const exp = 1 / (1 + Math.pow(10, -(diff + ELO_HOME) / 400));
    const score = m.result === "1" ? 1 : m.result === "0" ? 0.5 : 0;
    const g = goalFactor((m.hg ?? 0) - (m.ag ?? 0));
    H.rating += eloK(H.games) * g * (score - exp);
    A.rating -= eloK(A.games) * g * (score - exp);
    H.games++; A.games++;
    H.lastDate = A.lastDate = m.date;
    H.history.push({ ...m, side: "home" });
    A.history.push({ ...m, side: "away" });
    if (m.result === "0") draws++;

    const key = [m.home, m.away].sort().join("|");
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(m);
  }

  const { params, fitted } = fitParams(samples);

  // 当てはめた結果での的中率 (最も確率の高い印が当たった割合)
  let hits = 0;
  for (const smp of samples) {
    const p = probsFromDiff(smp.diff, params);
    if (p.indexOf(Math.max(...p)) === smp.r) hits++;
  }

  return {
    teams, pairs, params, fitted,
    total: sorted.length,
    drawRate: sorted.length ? draws / sorted.length : 0.25,
    lastDate: sorted.length ? sorted[sorted.length - 1].date : null,
    firstDate: sorted.length ? sorted[0].date : null,
    eval: {
      n: samples.length,
      accuracy: samples.length ? hits / samples.length : null,
      logLoss: samples.length ? logLoss(samples, params) : null,
    },
  };
}

// チーム視点の結果 W/D/L
function teamOutcome(m, name) {
  if (m.result === "0") return "D";
  const homeWon = m.result === "1";
  return (m.home === name) === homeWon ? "W" : "L";
}

function recentForm(model, name, n = 5) {
  const t = model.teams.get(name);
  if (!t) return [];
  return t.history.slice(-n).reverse().map(m => ({
    date: m.date,
    opponent: m.home === name ? m.away : m.home,
    venue: m.home === name ? "H" : "A",
    score: m.home === name ? `${m.hg}-${m.ag}` : `${m.ag}-${m.hg}`,
    outcome: teamOutcome(m, name),
  }));
}

function headToHead(model, home, away) {
  const list = model.pairs.get([home, away].sort().join("|")) || [];
  return list.slice().reverse();
}

// 直接対決の成績を「今回のホーム側から見た 1/0/2」の頻度に変換 (平均で平滑化)
function h2hProbs(list, home, prior) {
  const c = [0, 0, 0];
  for (const m of list) {
    const o = teamOutcome(m, home);
    c[o === "W" ? 0 : o === "D" ? 1 : 2]++;
  }
  const alpha = 3;
  const n = list.length;
  return { n, counts: c, p: c.map((x, i) => (x + alpha * prior[i]) / (n + alpha)) };
}

function blend(parts) {
  const out = [0, 0, 0];
  let wsum = 0;
  for (const { p, w } of parts) {
    if (!p || !(w > 0)) continue;
    for (let i = 0; i < 3; i++) out[i] += p[i] * w;
    wsum += w;
  }
  return out.map(x => x / wsum);
}

// 1試合の確率と根拠を返す
// settings: { h2hWeight: 0..1, voteWeight: 0..1 }
function predictMatch(model, match, settings) {
  const H = model && model.teams.get(match.home);
  const A = model && model.teams.get(match.away);
  const hr = H ? H.rating : ELO_START;
  const ar = A ? A.rating : ELO_START;
  const params = model ? model.params : { h: 60, c: 110, s: 250 };
  const elo = probsFromDiff(hr - ar, params);

  const h2hList = model ? headToHead(model, match.home, match.away) : [];
  const h2h = h2hProbs(h2hList, match.home, elo);
  // 対戦数が少ないほど効きを弱める
  const h2hW = (settings.h2hWeight || 0) * (h2h.n / (h2h.n + 4));

  const vote = Array.isArray(match.vote) && match.vote.length === 3 ? match.vote : null;
  const voteW = vote ? (settings.voteWeight || 0) : 0;

  const histW = Math.max(0, 1 - voteW);
  const fromHistory = blend([{ p: elo, w: 1 - h2hW }, { p: h2h.p, w: h2hW }]);
  const final = blend([{ p: fromHistory, w: histW }, { p: vote, w: voteW }]);

  return {
    p: final,
    elo,
    h2h,
    h2hList,
    vote,
    ratings: { home: Math.round(hr), away: Math.round(ar) },
    games: { home: H ? H.games : 0, away: A ? A.games : 0 },
    form: { home: model ? recentForm(model, match.home) : [], away: model ? recentForm(model, match.away) : [] },
  };
}
