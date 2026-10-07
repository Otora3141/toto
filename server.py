"""toto 予想アシスタント ローカルサーバー

標準ライブラリのみで動作します。
  python server.py        → http://127.0.0.1:8765/ を開く

提供 API
  GET /api/rounds                  販売中・販売予定の開催回一覧
  GET /api/round?id=1660           開催回の対象試合 (toto / mini A / mini B) と投票率
  GET /api/history                 過去の toto 対象試合の結果 (キャッシュ)
  GET /api/history/status          過去データ取得の進捗 (起動時に自動で取得)
"""

import gzip
import json
import os
import re
import sys
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")
# Heroku などでは環境変数 PORT が渡されるので、外部から接続できるように待ち受ける
ON_PAAS = "PORT" in os.environ
HOST = "0.0.0.0" if ON_PAAS else "127.0.0.1"
PORT = int(os.environ.get("PORT", 8765))
HISTORY_REFRESH_SEC = 6 * 3600  # 起動中も新しい結果を定期的に取り込む
# 公開するファイル (それ以外のソースやデータは配信しない)
STATIC_FILES = {"/", "/index.html"}
STATIC_DIRS = ("/css/", "/js/")
HISTORY_ROUNDS = 600

STORE = "https://store.toto-dream.com"
URL_SCHEDULE_JS = STORE + "/static_common_system/js/schedule_toto_{ym}.js"
URL_LOT_INFO = STORE + "/dcs/subos/screen/pi01/spin000/PGSPIN00001DisptotoLotInfo.form?holdCntId={id}"
URL_RESULT = STORE + "/dcs/subos/screen/pi04/spin011/PGSPIN01101LnkHoldCntLotResultLsttoto.form?holdCntId={id}"
URL_RESULT_LIST = STORE + "/dcs/subos/screen/pi04/spin011/PGSPIN01101InitLotResultLsttoto.form"
URL_VOTE = STORE + "/dcs/subos/screen/pi09/spin003/PGSPIN00301InitVoteRate.form?commodityId=01&holdCntId={id}"

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) toto-assistant/1.0"

GAME_KINDS = {"toto": "toto", "mini toto-A組": "miniA", "mini toto-B組": "miniB"}


# ===== HTTP / キャッシュ =====

_mem_cache = {}
_mem_lock = threading.Lock()


def fetch(url, ttl=600):
    now = time.time()
    with _mem_lock:
        hit = _mem_cache.get(url)
        if hit and now - hit[0] < ttl:
            return hit[1]
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ja"})
    with urllib.request.urlopen(req, timeout=20) as res:
        body = res.read().decode("utf-8", errors="replace")
    with _mem_lock:
        _mem_cache[url] = (now, body)
    return body


# ===== HTML パース =====

def norm(s):
    """全角英数を半角に、空白を整理 (チーム名の表記ゆれ対策)"""
    s = unicodedata.normalize("NFKC", s or "")
    return re.sub(r"\s+", " ", s).strip()


def strip_tags(s):
    s = re.sub(r"<br\s*/?>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    return norm(s)


def rows_of(html):
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, flags=re.S | re.I):
        yield [strip_tags(td) for td in re.findall(r"<td[^>]*>(.*?)</td>", tr, flags=re.S | re.I)]


SECTION_RE = re.compile(r"第\s*(\d+)\s*回\s*(toto|mini toto-A組|mini toto-B組|totoGOAL3)\s*くじ(結果|情報)")


def split_sections(html):
    """ページを「第N回 xxx くじ情報/結果」ごとに分割する"""
    text = unicodedata.normalize("NFKC", html)
    marks = list(SECTION_RE.finditer(text))
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        yield m.group(2), text[m.start():end]


DATE_RE = re.compile(r"(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日")


def full_dates(section):
    return [date(int(y), int(m), int(d)) for y, m, d in DATE_RE.findall(section)]


def infer_date(mmdd, base):
    """'10/14' と販売開始日から年を補完"""
    m = re.match(r"(\d{1,2})/(\d{1,2})", mmdd or "")
    if not m or not base:
        return None
    month, day = int(m.group(1)), int(m.group(2))
    year = base.year
    if month < base.month - 6:
        year += 1
    elif month > base.month + 6:
        year -= 1
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def parse_lot_info(html, hold_id):
    info = {"id": hold_id, "games": {}}
    for kind, sec in split_sections(html):
        key = GAME_KINDS.get(kind)
        if not key:
            continue
        dates = full_dates(sec)
        if dates and "saleStart" not in info:
            info["saleStart"] = dates[0].isoformat()
            if len(dates) > 1:
                info["saleEnd"] = dates[1].isoformat()
            if len(dates) > 2:
                info["resultDate"] = dates[2].isoformat()
        base = dates[0] if dates else None
        games = []
        for cells in rows_of(sec):
            # No | 開催日 | 開始時刻 | 競技場 | ホーム | VS | アウェイ
            if len(cells) >= 7 and cells[0].isdigit() and cells[5].upper() == "VS":
                games.append({
                    "no": int(cells[0]),
                    "date": infer_date(cells[1], base),
                    "time": cells[2],
                    "stadium": cells[3] if cells[3] != "-" else "",
                    "home": cells[4],
                    "away": cells[6],
                })
        if games:
            info["games"][key] = games
    return info


SCORE_RE = re.compile(r"^(\d+)\s*-\s*(\d+)$")


def parse_results(html, hold_id):
    """くじ結果ページ → 試合結果のリスト (toto / mini toto の全試合、重複除去)"""
    out, seen = [], set()
    for kind, sec in split_sections(html):
        if kind not in GAME_KINDS:
            continue
        dates = full_dates(sec)
        base = dates[0] if dates else None
        for cells in rows_of(sec):
            # 開催日 | 競技場 | No | ホーム | スコア | アウェイ | 結果
            if len(cells) < 7 or not cells[2].isdigit():
                continue
            sm = SCORE_RE.match(cells[4])
            if not sm or cells[6] not in ("0", "1", "2"):
                continue
            d = infer_date(cells[0], base)
            key = (d, cells[3], cells[5])
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "round": hold_id, "date": d, "home": cells[3], "away": cells[5],
                "hg": int(sm.group(1)), "ag": int(sm.group(2)), "result": cells[6],
                "kind": GAME_KINDS[kind], "no": int(cells[2]),
            })
    return out


def alias_key(name):
    return re.sub(r"[\s・.･]", "", norm(name))


def collect_aliases(info, results):
    """くじ情報 (正式名) と くじ結果 (略称) を No で突き合わせて別名表を作る"""
    pairs = {}
    by_no = {(r["kind"], r["no"]): r for r in results}
    for kind, games in info.get("games", {}).items():
        for g in games:
            r = by_no.get((kind, g["no"]))
            if r:
                pairs[alias_key(g["home"])] = r["home"]
                pairs[alias_key(g["away"])] = r["away"]
    return pairs


PCT_RE = re.compile(r"\(\s*([\d.]+)\s*%\s*\)")


def parse_vote(html):
    """投票状況ページ → [{no, home, away, rates:[p1,p0,p2]}]"""
    text = unicodedata.normalize("NFKC", html)
    if "投票" not in text or "表示できません" in text:
        return None
    m = re.search(r"\(([^()]*(?:\([^()]*\))?[^()]*時点)\)", strip_tags(text))
    out = []
    for cells in rows_of(text):
        pcts = [float(p) / 100 for c in cells for p in PCT_RE.findall(c)]
        if len(pcts) != 3:
            continue
        no_idx = next((i for i, c in enumerate(cells) if c.isdigit() and int(c) <= 13), None)
        if no_idx is None or no_idx + 5 >= len(cells):
            continue
        out.append({
            "no": int(cells[no_idx]),
            "home": cells[no_idx + 1],
            "away": cells[no_idx + 5],
            "rates": pcts,
        })
    return {"asOf": m.group(1) if m else "", "games": out} if out else None


# ===== 開催回一覧 =====

def month_add(d, n):
    y, m = divmod(d.year * 12 + d.month - 1 + n, 12)
    return date(y, m + 1, 1)


_rounds_cache = {"at": 0, "data": None}


def list_rounds():
    """開催回一覧 (10分キャッシュ)"""
    if _rounds_cache["data"] is not None and time.time() - _rounds_cache["at"] < 600:
        return _rounds_cache["data"]
    data = _list_rounds()
    _rounds_cache.update(at=time.time(), data=data)
    return data


def _list_rounds():
    today = date.today()
    ids = set()
    for n in (-1, 0, 1):
        ym = month_add(today, n).strftime("%Y%m")
        try:
            js = fetch(URL_SCHEDULE_JS.format(ym=ym), ttl=3600)
            ids.update(int(x) for x in re.findall(r"holdCntId=(\d+)", js))
        except Exception:
            pass  # 翌月分は未公開のことがある
    infos = []

    def load(i):
        try:
            return parse_lot_info(fetch(URL_LOT_INFO.format(id=i), ttl=1800), i)
        except Exception as e:
            return {"id": i, "games": {}, "error": str(e)}

    with ThreadPoolExecutor(4) as ex:
        infos = list(ex.map(load, sorted(ids)))

    rounds = []
    for info in infos:
        if not info.get("games"):
            continue
        end = info.get("saleEnd")
        start = info.get("saleStart")
        status = "unknown"
        if start and end:
            if today < date.fromisoformat(start):
                status = "upcoming"
            elif today <= date.fromisoformat(end):
                status = "onsale"
            else:
                status = "closed"
        # 結果発表から1週間以上経った回は除外
        rd = info.get("resultDate")
        if rd and date.fromisoformat(rd) < today - timedelta(days=7):
            continue
        rounds.append({
            "id": info["id"], "saleStart": start, "saleEnd": end,
            "resultDate": rd, "status": status,
            "kinds": list(info["games"].keys()),
        })
    rounds.sort(key=lambda r: r["id"], reverse=True)
    return rounds


def resolve_names(info):
    """正式名 → 過去データで使われる略称 に揃える (投票率ページ > 別名表 > 部分一致)"""
    h = load_history()
    ren = h.get("renames", {})
    aliases = {k: ren.get(v, v) for k, v in h.get("aliases", {}).items()}
    known = set(aliases.values())
    vote = {g["no"]: g for g in (info.get("vote") or {}).get("games", [])}
    toto_by_names = {(g["home"], g["away"]): g["no"] for g in info["games"].get("toto", [])}

    def short(full, vote_name):
        if vote_name:
            aliases.setdefault(alias_key(full), vote_name)
            return vote_name
        k = alias_key(full)
        if k in aliases:
            return aliases[k]
        cands = [n for n in known if len(n) >= 2 and alias_key(n) in k]
        return max(cands, key=len) if cands else norm(full)

    for kind, games in info["games"].items():
        for g in games:
            no = g["no"] if kind == "toto" else toto_by_names.get((g["home"], g["away"]))
            v = vote.get(no) if no else None
            g["homeFull"], g["awayFull"] = g["home"], g["away"]
            g["home"] = short(g["home"], v and v["home"])
            g["away"] = short(g["away"], v and v["away"])
            if v:
                g["vote"] = v["rates"]


def get_round(hold_id):
    info = parse_lot_info(fetch(URL_LOT_INFO.format(id=hold_id), ttl=600), hold_id)
    try:
        info["vote"] = parse_vote(fetch(URL_VOTE.format(id=hold_id), ttl=300))
    except Exception:
        info["vote"] = None
    resolve_names(info)
    info["voteAsOf"] = (info.pop("vote") or {}).get("asOf")
    return info


# ===== 過去データ =====

_hist_lock = threading.Lock()
_hist_status = {"running": False, "done": 0, "total": 0, "added": 0, "message": ""}


def load_history():
    if os.path.exists(HISTORY_FILE):
        with open(HISTORY_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {"updated": None, "rounds": [], "matches": []}


def save_history(h):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = HISTORY_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(h, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, HISTORY_FILE)


def latest_result_id():
    html = fetch(URL_RESULT_LIST, ttl=1800)
    ids = [int(x) for x in re.findall(r"holdCntId=(\d+)", html)]
    if not ids:
        raise RuntimeError("結果一覧から開催回を取得できませんでした")
    return max(ids)


def update_history(count):
    st = _hist_status
    try:
        latest = latest_result_id()
        h = load_history()
        have = set(h.get("rounds", []))
        targets = [i for i in range(latest, max(0, latest - count), -1) if i not in have]
        st.update(total=len(targets), done=0, added=0, message=f"第{latest}回から{count}回分を確認中")

        def work(i):
            try:
                recs = parse_results(fetch(URL_RESULT.format(id=i), ttl=60), i)
                pairs = {}
                if recs:
                    info = parse_lot_info(fetch(URL_LOT_INFO.format(id=i), ttl=60), i)
                    pairs = collect_aliases(info, recs)
            except Exception:
                return i, None, None
            finally:
                time.sleep(0.2)  # サイトへの負荷を抑える
            return i, recs, pairs

        new_rounds, new_matches, new_aliases, new_renames = [], [], {}, {}
        with ThreadPoolExecutor(4) as ex:
            # 新しい回から処理するので、表記が変わった場合は最新の略称が優先される
            for i, recs, pairs in ex.map(work, targets):
                st["done"] += 1
                if recs is None:
                    continue  # 通信エラーは次回再取得
                new_rounds.append(i)  # 結果なし(toto非開催回)も記録して再取得しない
                new_matches.extend(recs)
                for k, v in pairs.items():
                    newest = new_aliases.setdefault(k, v)
                    if newest != v:
                        new_renames[v] = newest  # 古い回の略称 → 最新の略称
                st["added"] += len(recs)

        with _hist_lock:
            h = load_history()
            seen = {(m["date"], m["home"], m["away"]) for m in h["matches"]}
            for m in new_matches:
                k = (m["date"], m["home"], m["away"])
                if k not in seen:
                    seen.add(k)
                    h["matches"].append(m)
            # 今回取得分が既存より新しい回なら、その略称で上書きする
            newer = max(new_rounds, default=0) > max(h.get("rounds") or [0])
            old = h.get("aliases", {})
            renames = {**h.get("renames", {}), **new_renames}
            for k in set(old) & set(new_aliases):
                if old[k] != new_aliases[k]:
                    a, b = (old[k], new_aliases[k]) if newer else (new_aliases[k], old[k])
                    renames[a] = b
            h["aliases"] = {**old, **new_aliases} if newer else {**new_aliases, **old}
            # 改名の連鎖を解決し、自分自身への改名は除く
            for a in list(renames):
                b, seen = renames[a], {a}
                while b in renames and b not in seen:
                    seen.add(b)
                    b = renames[b]
                renames[a] = b
            h["renames"] = {a: b for a, b in renames.items() if a != b}
            h["rounds"] = sorted(set(h.get("rounds", [])) | set(new_rounds))
            h["matches"].sort(key=lambda m: (m["date"] or "", m["round"]))
            h["updated"] = datetime.now().isoformat(timespec="seconds")
            save_history(h)
        st["message"] = f"完了: {st['added']}試合を追加 (合計 {len(h['matches'])}試合)"
    except Exception as e:
        st["message"] = f"エラー: {e}"
    finally:
        st["running"] = False


def start_history_update(count):
    with _hist_lock:
        if _hist_status["running"]:
            return False
        _hist_status.update(running=True, done=0, total=0, added=0, message="開始")
    threading.Thread(target=update_history, args=(count,), daemon=True).start()
    return True


# ===== HTTP サーバー =====

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        gz = len(body) > 2048 and "gzip" in (self.headers.get("Accept-Encoding") or "")
        if gz:
            body = gzip.compress(body)
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if not url.path.startswith("/api/"):
            path = urllib.parse.unquote(url.path)
            if ".." in path or not (path in STATIC_FILES or path.startswith(STATIC_DIRS)):
                return self.send_error(404)
            return super().do_GET()
        q = urllib.parse.parse_qs(url.query)
        try:
            if url.path == "/api/rounds":
                return self.send_json({"rounds": list_rounds()})
            if url.path == "/api/round":
                return self.send_json(get_round(int(q["id"][0])))
            if url.path == "/api/history":
                h = load_history()
                ren = h.get("renames", {})
                for m in h["matches"]:
                    m["home"] = ren.get(m["home"], m["home"])
                    m["away"] = ren.get(m["away"], m["away"])
                h["aliases"] = {k: ren.get(v, v) for k, v in h.get("aliases", {}).items()}
                return self.send_json(h)
            if url.path == "/api/history/status":
                return self.send_json(_hist_status)
            return self.send_json({"error": "not found"}, 404)
        except Exception as e:
            return self.send_json({"error": str(e)}, 502)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://127.0.0.1:{PORT}/"
    print(f"toto 予想アシスタント: {url}  (Ctrl+C で終了)")
    # 過去データを直近 HISTORY_ROUNDS 回分まで自動で補完 (取得済みの回は再取得しない)
    def refresh_loop():
        while True:
            start_history_update(HISTORY_ROUNDS)
            time.sleep(HISTORY_REFRESH_SEC)
    threading.Thread(target=refresh_loop, daemon=True).start()
    if not ON_PAAS and "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
