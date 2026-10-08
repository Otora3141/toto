// ===== メインアプリケーション =====

const KIND_LABEL = { toto: "toto (13試合)", miniA: "mini toto A組 (5試合)", miniB: "mini toto B組 (5試合)" };
const STATUS_LABEL = { onsale: "販売中", upcoming: "販売前", closed: "販売終了", unknown: "" };
const OUTCOME_NAME = { "1": "ホーム勝ち", "0": "引き分け", "2": "アウェイ勝ち" };
const FORM_MARK = { W: "○", D: "△", L: "×" };

const AppState = {
  serverOk: false,
  rounds: [],
  round: null,          // /api/round の結果
  kind: "toto",
  matches: [],          // {no, date, time, stadium, home, away, homeFull, awayFull, vote}
  picks: [],            // 試合ごとの選択印 ["1","0"] など
  history: { matches: [], aliases: {} },
  model: null,
  preds: [],
  settings: {
    voteWeight: 0.5,     // 確率 = 過去データ 50% + 投票率 50% (投票率がある場合)
    h2hWeight: 0.2,      // 過去データ内の直接対決の重み
    level: 2,            // 保証する等級 (2=2等, 3=3等)。mini toto は常に全通り
    perPage: 100,        // 買い目リストの1ページの表示件数
  },
  cover: null,
  view: "setup",
};

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (x, d = 0) => (x * 100).toFixed(d) + "%";
const $ = id => document.getElementById(id);

// ===== 保存 (ブラウザ内の簡易保存) =====
function storageKey() {
  return AppState.round ? `toto-picks-${AppState.round.id}-${AppState.kind}` : null;
}
function savePicks() {
  const k = storageKey();
  if (!k) return;
  try { localStorage.setItem(k, JSON.stringify(AppState.picks)); } catch (e) { /* 保存できなくても動作に影響なし */ }
}
function loadPicks() {
  const k = storageKey();
  try {
    const v = k && JSON.parse(localStorage.getItem(k) || "null");
    if (Array.isArray(v) && v.length === AppState.matches.length) return v;
  } catch (e) { /* 無視 */ }
  return null;
}
function saveSettings() {
  try {
    localStorage.setItem("toto-level", String(AppState.settings.level));
    localStorage.setItem("toto-per-page", String(AppState.settings.perPage));
  } catch (e) { /* 無視 */ }
}
function loadSettings() {
  try {
    const lv = Number(localStorage.getItem("toto-level"));
    if ([2, 3].includes(lv)) AppState.settings.level = lv;
    const pp = Number(localStorage.getItem("toto-per-page"));
    if (PER_PAGE_OPTIONS.includes(pp)) AppState.settings.perPage = pp;
  } catch (e) { /* 無視 */ }
}

// ===== API =====
async function api(path) {
  const res = await fetch(path, { cache: "no-store" });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error || res.statusText);
  return json;
}

// ===== 初期化 =====
async function init() {
  loadSettings();
  try {
    await loadHistory();
    AppState.serverOk = true;
  } catch (e) {
    AppState.serverOk = false;
  }
  if (AppState.serverOk) {
    await loadRounds();
    watchHistory();
  } else {
    $("round-status").innerHTML = `<span class="warn-text">サーバーに接続できません。<code>python server.py</code> で起動してから開いてください（手入力は可能です）。</span>`;
    setManualMatches(13);
  }
}

async function loadHistory() {
  AppState.history = await api("/api/history");
  rebuildModel();
}

// サーバーが起動時に過去データを更新するので、終わったら読み込み直す
async function watchHistory() {
  try {
    let st = await api("/api/history/status");
    if (!st.running) return;
    while (st.running) {
      await new Promise(r => setTimeout(r, 3000));
      st = await api("/api/history/status");
    }
    await loadHistory();
    if (AppState.round) await selectRound(AppState.round.id); // 別名表が増えたのでチーム名を再解決
    if (AppState.view === "predict") renderPredictView();
    if (AppState.view === "results") renderResultsView();
  } catch (e) { /* 取得できなくても既存データで動作 */ }
}

function rebuildModel() {
  const recs = AppState.history.matches;
  AppState.model = recs.length ? buildModel(recs) : null;
  const dl = $("team-list");
  if (dl && AppState.model) {
    dl.innerHTML = [...AppState.model.teams.keys()].sort((a, b) => a.localeCompare(b, "ja"))
      .map(t => `<option value="${esc(t)}">`).join("");
  }
}

// ===== 開催回 =====
async function loadRounds() {
  const sel = $("round-select");
  $("round-status").textContent = "開催回を取得中…";
  try {
    const { rounds } = await api("/api/rounds");
    AppState.rounds = rounds;
    sel.innerHTML = rounds.map(r => {
      const kinds = r.kinds.includes("toto") ? "" : "（mini のみ）";
      return `<option value="${r.id}">第${r.id}回 ${STATUS_LABEL[r.status] || ""} 販売 ${fmtDate(r.saleStart)}〜${fmtDate(r.saleEnd)}${kinds}</option>`;
    }).join("") + `<option value="manual">手入力する</option>`;
    const pick = rounds.find(r => r.status === "onsale" && r.kinds.includes("toto"))
      || rounds.find(r => r.kinds.includes("toto")) || rounds[0];
    if (pick) {
      sel.value = String(pick.id);
      await selectRound(pick.id);
    } else {
      sel.value = "manual";
      setManualMatches(13);
    }
  } catch (e) {
    $("round-status").innerHTML = `<span class="warn-text">開催回を取得できませんでした: ${esc(e.message)}</span>`;
    setManualMatches(13);
  }
}

function fmtDate(iso) {
  if (!iso) return "?";
  const d = new Date(iso + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}(${"日月火水木金土"[d.getDay()]})`;
}

async function onRoundChange(value) {
  if (value === "manual") {
    AppState.round = null;
    setManualMatches(AppState.kind === "toto" ? 13 : 5);
    return;
  }
  await selectRound(Number(value));
}

async function selectRound(id) {
  $("round-status").textContent = `第${id}回の対象試合を取得中…`;
  try {
    AppState.round = await api(`/api/round?id=${id}`);
    const kinds = Object.keys(AppState.round.games);
    if (!kinds.includes(AppState.kind)) AppState.kind = kinds[0];
    const r = AppState.round;
    $("round-status").innerHTML = `販売 ${fmtDate(r.saleStart)}〜${fmtDate(r.saleEnd)} ／ 結果発表 ${fmtDate(r.resultDate)}`
      + (r.voteAsOf ? ` ／ 投票率: ${esc(r.voteAsOf)}` : " ／ 投票率: -");
    applyKind();
  } catch (e) {
    $("round-status").innerHTML = `<span class="warn-text">取得に失敗しました: ${esc(e.message)}</span>`;
  }
}

function setKind(kind) {
  AppState.kind = kind;
  if (AppState.round) applyKind();
  else setManualMatches(kind === "toto" ? 13 : 5);
}

function applyKind() {
  const games = AppState.round.games[AppState.kind] || [];
  AppState.matches = games.map(g => ({ ...g }));
  AppState.picks = loadPicks() || AppState.matches.map(() => []);
  renderKindButtons();
  renderSetupTable();
}

function setManualMatches(count) {
  AppState.matches = Array.from({ length: count }, (_, i) => ({ no: i + 1, date: "", home: "", away: "" }));
  AppState.picks = AppState.matches.map(() => []);
  renderKindButtons();
  renderSetupTable();
}

function renderKindButtons() {
  const avail = AppState.round ? Object.keys(AppState.round.games) : Object.keys(KIND_LABEL);
  $("kind-buttons").innerHTML = Object.entries(KIND_LABEL).map(([k, label]) =>
    `<button class="mode-btn ${k === AppState.kind ? "active" : ""}" ${avail.includes(k) ? "" : "disabled"} onclick="setKind('${k}')">${label}</button>`
  ).join("");
}

// ===== 試合設定ビュー =====
function renderSetupTable() {
  const tbody = $("setup-tbody");
  tbody.innerHTML = AppState.matches.map((m, i) => {
    const v = m.vote ? m.vote.map(x => pct(x)).join(" / ") : "-";
    return `<tr>
      <td class="match-num">${m.no}</td>
      <td class="date-cell">${m.date ? fmtDate(m.date) : ""} ${esc(m.time || "")}</td>
      <td><input class="team-input" list="team-list" value="${esc(m.home)}" title="${esc(m.homeFull || "")}" onchange="onTeamEdit(${i},'home',this.value)"></td>
      <td class="vs-cell">vs</td>
      <td><input class="team-input" list="team-list" value="${esc(m.away)}" title="${esc(m.awayFull || "")}" onchange="onTeamEdit(${i},'away',this.value)"></td>
      <td class="vote-cell">${v}</td>
    </tr>`;
  }).join("");
  updateSetupProgress();
}

function onTeamEdit(i, side, value) {
  AppState.matches[i][side] = value.trim();
  renderSetupTable();
}

function updateSetupProgress() {
  const filled = AppState.matches.filter(m => m.home && m.away).length;
  const total = AppState.matches.length;
  const btn = $("btn-to-predict");
  btn.disabled = filled < total || total === 0;
  btn.textContent = filled < total ? `予想入力へ（残り ${total - filled} 試合のチーム名を入力）` : "予想入力へ →";
}

// ===== ビュー切替 =====
function switchView(view) {
  AppState.view = view;
  document.querySelectorAll(".view").forEach(el => el.classList.toggle("active", el.id === `view-${view}`));
  document.querySelectorAll(".step").forEach(el => el.classList.toggle("active", el.dataset.view === view));
  if (view === "predict") renderPredictView();
  if (view === "results") renderResultsView();
  window.scrollTo(0, 0);
}

// ===== 予想入力ビュー =====
function computePreds() {
  AppState.preds = AppState.matches.map(m => predictMatch(AppState.model, m, AppState.settings));
}

function renderPredictView() {
  computePreds();
  renderPredictCards();
}

function formHtml(list) {
  if (!list.length) return `<span class="sub">データなし</span>`;
  return list.map(f =>
    `<span class="form-mark form-${f.outcome}" title="${esc(f.date)} ${f.venue === "H" ? "ホーム" : "アウェイ"} vs ${esc(f.opponent)} ${esc(f.score)}">${FORM_MARK[f.outcome]}</span>`
  ).join("");
}

function probTriplet(p) {
  return p ? p.map(x => pct(x)).join(" / ") : "-";
}

function renderPredictCards() {
  const container = $("predict-cards");
  container.innerHTML = AppState.matches.map((m, i) => {
    const pr = AppState.preds[i];
    const sel = AppState.picks[i];
    const p = pr.p;
    const h2h = pr.h2h;
    const h2hRows = pr.h2hList.slice(0, 6).map(x =>
      `<li>${esc(x.date)}　${esc(x.home)} <strong>${x.hg}-${x.ag}</strong> ${esc(x.away)}</li>`).join("");
    const noData = !pr.games.home || !pr.games.away;
    const btn = (o, idx, label, team) => `
      <button class="pred-btn btn-${o} ${sel.includes(o) ? "selected" : ""}" onclick="onPickClick(${i},'${o}')">
        <span class="btn-num">${o}</span>
        <span class="btn-label">${label}</span>
        <span class="btn-team">${team ? esc(team) : "&nbsp;"}</span>
        <span class="btn-prob">${pct(p[idx])}</span>
      </button>`;
    return `
    <div class="match-card ${sel.length ? "predicted" : ""} ${sel.length > 1 ? "multi" : ""}" id="card-${i}">
      <div class="card-header">
        <span class="match-num-badge">${m.no}</span>
        <div class="team-names">
          <span class="home-name">${esc(m.home)}</span><span class="vs-sep">vs</span><span class="away-name">${esc(m.away)}</span>
        </div>
        <span class="date-note">${m.date ? fmtDate(m.date) : ""} ${esc(m.time || "")}</span>
        ${sel.length > 1 ? `<span class="data-badge multi">マルチ ${sel.length}</span>` : ""}
        ${noData ? `<span class="data-badge nodata">過去データ不足</span>` : ""}
      </div>
      ${buildProbBar(p, sel, m)}
      <div class="basis">
        <div><span class="basis-label">過去データ</span> ${probTriplet(pr.elo)} <span class="sub">（レート ${pr.ratings.home} vs ${pr.ratings.away}）</span></div>
        <div><span class="basis-label">直接対決</span> ${h2h.n ? `${esc(m.home)}から見て ${h2h.counts[0]}勝 ${h2h.counts[1]}分 ${h2h.counts[2]}敗` : `<span class="sub">対戦データなし</span>`}</div>
        <div><span class="basis-label">投票率</span> ${pr.vote ? probTriplet(pr.vote) : "-"}</div>
        <div class="form-row"><span class="basis-label">直近5試合</span>
          <span class="form-team">${esc(m.home)}</span> ${formHtml(pr.form.home)}
          <span class="form-team">${esc(m.away)}</span> ${formHtml(pr.form.away)}</div>
        ${h2hRows
          ? `<details><summary>直接対決の履歴</summary><ul class="h2h-list">${h2hRows}</ul></details>`
          : `<div class="h2h-none">直接対決の履歴 -</div>`}
      </div>
      <div class="prediction-buttons">
        ${btn("1", 0, "ホーム勝ち", m.home)}${btn("0", 1, "引き分け")}${btn("2", 2, "アウェイ勝ち", m.away)}
      </div>
    </div>`;
  }).join("");
  updatePredictSummary();
}

function buildProbBar(p, sel, m) {
  const w = p.map(x => (x * 100).toFixed(1));
  return `<div class="prob-bar-wrap"><div class="prob-bar">
    <div class="pb-home ${sel.includes("1") ? "pb-selected" : ""}" style="width:${w[0]}%" title="ホーム勝ち（${esc(m.home)}） ${w[0]}%"></div>
    <div class="pb-draw ${sel.includes("0") ? "pb-selected" : ""}" style="width:${w[1]}%" title="引き分け ${w[1]}%"></div>
    <div class="pb-away ${sel.includes("2") ? "pb-selected" : ""}" style="width:${w[2]}%" title="アウェイ勝ち（${esc(m.away)}） ${w[2]}%"></div>
  </div></div>`;
}

function onPickClick(i, o) {
  const sel = AppState.picks[i];
  const k = sel.indexOf(o);
  if (k >= 0) sel.splice(k, 1); else sel.push(o);
  savePicks();
  renderPredictCards();
}

function updatePredictSummary() {
  const filled = AppState.picks.filter(s => s.length).length;
  const total = AppState.matches.length;
  // 買い目の計算は印の組み合わせ全通りが対象なので、計算上限を超える予想はここで止める
  const size = AppState.picks.reduce((a, s) => a * Math.max(s.length, 1), 1);
  const tooMany = filled === total && size > MAX_UNIVERSE;
  const btn = $("btn-to-results");
  btn.disabled = filled < total || tooMany;
  btn.textContent = filled < total ? `買い目を作る（残り ${total - filled} 試合）`
    : tooMany ? "組み合わせが多すぎます" : "買い目を作る →";
  const el = $("combo-summary");
  el.classList.toggle("warn", tooMany);
  el.innerHTML = filled < total
    ? `全試合で1つ以上の印を選んでください（${filled}/${total}）。迷う試合は複数選択（マルチ）できます。`
    : tooMany
      ? `⚠ 選んだ印の組み合わせが ${size.toLocaleString()} 通りあり、計算上限（${MAX_UNIVERSE.toLocaleString()} 通り）を超えています。マルチを減らしてください。`
      : `選んだ印の組み合わせ: ${size.toLocaleString()} 通り`;
}

// ===== 結果ビュー =====
let coverWorker = null;
let coverJob = 0;
let coverTimer = null;

function renderResultsView() {
  computePreds();
  const n = AppState.matches.length;
  const isToto = n >= 13;
  const level = effectiveLevel();

  $("level-card").style.display = isToto ? "" : "none";
  $("level-buttons").innerHTML = [
    [2, "2等保証（1試合外れまで）"], [3, "3等保証（2試合外れまで）"],
  ].map(([lv, label]) =>
    `<button class="mode-btn ${level === lv ? "active" : ""}" onclick="setLevel(${lv})">${label}</button>`
  ).join("");

  renderMarksTable();
  scheduleCover(0);
}

function renderMarksTable() {
  const rows = AppState.matches.map((m, i) => {
    const sel = AppState.picks[i];
    return `<tr>
      <td>${m.no}</td>
      <td class="match-name-cell">${esc(m.home)} vs ${esc(m.away)}</td>
      <td class="pred-cell">${["1", "0", "2"].filter(o => sel.includes(o)).map(o => `<span class="pred-badge pred-${o}">${o}</span>`).join("")}</td>
    </tr>`;
  }).join("");
  $("marks-tbody").innerHTML = rows;
}

// mini toto は1等のみなので全通り
function effectiveLevel() {
  return AppState.matches.length >= 13 ? AppState.settings.level : 1;
}

function setLevel(lv) {
  AppState.settings.level = lv;
  saveSettings();
  renderResultsView();
}

function scheduleCover(delay) {
  clearTimeout(coverTimer);
  coverTimer = setTimeout(runCover, delay);
}

function runCover() {
  const allowed = AppState.picks.map(sel => sel.map(o => DIGIT_OF[o]).sort());
  const probs = AppState.preds.map(pr => pr.p);
  const size = allowed.reduce((a, x) => a * x.length, 1);
  const filters = {};
  const msg = { allowed, probs, filters, radius: effectiveLevel() - 1, timeBudgetMs: size > 50000 ? 2500 : 1500 };
  const job = ++coverJob;
  $("cover-status").textContent = "計算中…";
  $("cover-status").style.display = "block";

  const done = data => {
    if (job !== coverJob) return;
    $("cover-status").style.display = "none";
    AppState.cover = data;
    AppState.ticketPage = 0;
    renderCover();
  };
  try {
    if (coverWorker) coverWorker.terminate();
    coverWorker = new Worker("js/cover-worker.js");
    coverWorker.onmessage = e => done(e.data);
    coverWorker.onerror = () => { coverWorker = null; done(computeCoverInline(msg)); };
    coverWorker.postMessage(msg);
  } catch (e) {
    // file:// で開いた場合など Worker が使えないときはその場で計算
    setTimeout(() => done(computeCoverInline(msg)), 20);
  }
}

function computeCoverInline({ allowed, probs, filters, radius, timeBudgetMs }) {
  try {
    const U = buildUniverse(allowed, probs, filters);
    if (U.codes.length > MAX_UNIVERSE) throw new Error(`絞り込み後も ${U.codes.length.toLocaleString()} 通りあり、計算上限を超えています。`);
    const res = bestCover(U, radius, probs, Math.min(timeBudgetMs, 800));
    return {
      ok: true, n: U.n, productSize: U.productSize, productMass: U.productMass,
      universeSize: U.codes.length, universeMass: U.mass, removed: U.removed,
      tickets: res.tickets, ticketMass: ticketMass(res.tickets, probs, U.n), runs: res.runs,
      verified: verifyCover(U, res.tickets, radius), sim: simulatePrizes(res.tickets, probs, U.n),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const PER_PAGE_OPTIONS = [10, 20, 50, 100];

function renderCover() {
  const c = AppState.cover;
  const el = $("cover-content");
  const level = effectiveLevel();
  if (!c.ok) {
    el.innerHTML = `<div class="strat-explanation warn">${esc(c.error)}</div>`;
    ["sum-product", "sum-product-yen", "sum-tickets", "sum-tickets-yen"].forEach(id => $(id).textContent = "-");
    return;
  }
  const n = c.n;
  const levelName = { 1: "1等", 2: "2等", 3: "3等" }[level];

  $("sum-product").textContent = `${c.productSize.toLocaleString()}通り`;
  $("sum-product-yen").textContent = `${(c.productSize * TICKET_PRICE).toLocaleString()}円`;
  $("sum-tickets").textContent = `${c.tickets.length.toLocaleString()}枚`;
  $("sum-tickets-yen").textContent = `${(c.tickets.length * TICKET_PRICE).toLocaleString()}円`;

  const guarantee = level === 1
    ? `選んだ印の組み合わせを全通り購入します。結果がこの中に入れば1等です。`
    : `結果が選んだ印の範囲内（${c.universeSize.toLocaleString()} 通りのどれか）になれば、下の ${c.tickets.length.toLocaleString()} 枚のどれかが必ず ${n - (level - 1)} 試合以上的中します（${levelName}以上）。`;

  const perPage = AppState.settings.perPage;
  const pages = Math.max(1, Math.ceil(c.tickets.length / perPage));
  const page = Math.min(AppState.ticketPage || 0, pages - 1);
  const start = page * perPage;
  const shown = c.tickets.slice(start, start + perPage);
  const pager = c.tickets.length ? ticketPagerHtml(page, pages, start, shown.length, c.tickets.length) : "";
  const rows = shown.map((code, i) => `<div class="ticket-row">
      <span class="ticket-label">${(start + i + 1).toLocaleString()}枚目</span>
      <code class="ticket-code">${codeToMarks(code, n).split("").join("-")}</code></div>`).join("");

  el.innerHTML = `
    <div class="strat-explanation">
      ${guarantee}
      ${c.verified ? "" : "<br>⚠ 検証に失敗しました。印を変えて再計算してください。"}
    </div>
    <div class="tickets-section">
      <h4>購入リスト</h4>
      ${pager}
      ${rows}
      ${pager}
      <div class="cost-info">合計 <strong>${(c.tickets.length * TICKET_PRICE).toLocaleString()}円</strong>
        （全通り ${(c.productSize * TICKET_PRICE).toLocaleString()}円 から ${pct(1 - c.tickets.length / c.productSize)} 削減）</div>
    </div>
    <div class="btn-row">
      <button class="copy-btn" onclick="copyTickets()">📋 買い目をコピー</button>
      <button class="copy-btn" onclick="downloadTickets()">⬇ CSV で保存</button>
    </div>`;
}

function ticketPagerHtml(page, pages, start, count, total) {
  const go = (p, label, disabled, cur) =>
    `<button class="page-btn ${cur ? "current" : ""}" ${disabled ? "disabled" : ""} onclick="setTicketPage(${p})">${label}</button>`;
  // 先頭・末尾と現在ページの前後2ページだけ番号を出し、間は … で省略する
  const nums = [];
  for (let p = 0; p < pages; p++) {
    if (p === 0 || p === pages - 1 || Math.abs(p - page) <= 2) nums.push(go(p, p + 1, false, p === page));
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  const perPage = AppState.settings.perPage;
  const sizeSel = `<label class="page-size">表示件数
    <select onchange="setTicketsPerPage(Number(this.value))">
      ${PER_PAGE_OPTIONS.map(v => `<option value="${v}" ${v === perPage ? "selected" : ""}>${v}件</option>`).join("")}
    </select></label>`;
  const nav = pages > 1 ? `
    ${go(page - 1, "‹ 前へ", page === 0)}
    ${nums.map(x => x === "…" ? `<span class="page-gap">…</span>` : x).join("")}
    ${go(page + 1, "次へ ›", page === pages - 1)}` : "";
  return `<div class="ticket-pager">
    ${nav}
    ${sizeSel}
    <span class="page-info">${(start + 1).toLocaleString()}〜${(start + count).toLocaleString()} / ${total.toLocaleString()}枚</span>
  </div>`;
}

function setTicketPage(p) {
  AppState.ticketPage = p;
  renderCover();
  document.querySelector(".tickets-section")?.scrollIntoView({ block: "start" });
}

// 表示件数を変えても、今見ている先頭の買い目を含むページにとどまる
function setTicketsPerPage(n) {
  const first = (AppState.ticketPage || 0) * AppState.settings.perPage;
  AppState.settings.perPage = n;
  AppState.ticketPage = Math.floor(first / n);
  saveSettings();
  renderCover();
}

function ticketLines() {
  const c = AppState.cover;
  return c.tickets.map(code => codeToMarks(code, c.n));
}

function copyTickets() {
  const text = ticketLines().map((t, i) => `${i + 1}. ${t.split("").join("-")}`).join("\n");
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    showToast("コピーしました");
  };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => showToast("コピーしました"), fallback);
  else fallback();
}

function downloadTickets() {
  const head = ["#"].concat(AppState.matches.map(m => `${m.no}:${m.home}-${m.away}`));
  const lines = [head.join(",")].concat(ticketLines().map((t, i) => [i + 1].concat(t.split("")).join(",")));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `toto_${AppState.round ? AppState.round.id : "manual"}_${AppState.kind}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function showToast(msg) {
  let t = $("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2000);
}

document.addEventListener("DOMContentLoaded", init);
