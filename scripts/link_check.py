"""
신청 페이지 "마감 표시" 미리 점검 (fetch_policies.py 마지막 단계에서 사용, AI 안 씀)
- api/check-link.js와 같은 키워드 방식: 페이지 글자 조각 중 "서비스종료" 같은 상태 표시나
  "마감되었습니다" 같은 문장이 있으면 closed_hint
- 동시 요청 5개 이하, 링크당 5초 제한, 같은 사이트는 최소 0.7초 간격
- 결과: closed_hint(마감 표시 보임) / no_hint(표시 없음) / unknown(페이지를 못 읽음)
※ 키워드 규칙을 바꿀 때는 api/check-link.js도 같이 바꿀 것
"""
import html
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

MAX_WORKERS = 5
TIMEOUT_SEC = 5
SAME_HOST_GAP_SEC = 0.7
MAX_PAGE_BYTES = 1024 * 1024
MIN_TEXT_CHARS = 200
USER_AGENT = "Mozilla/5.0 (compatible; dontmiss-policy-check/1.0)"

LABEL_RE = re.compile(r"^(마감|접수\s*마감|모집\s*마감|예약\s*마감|신청\s*마감|서비스\s*종료|모집\s*종료|접수\s*종료|신청\s*종료|종료)$")
PHRASE_RE = re.compile(r"(마감\s*되었|마감됐|모집이\s*마감|접수가\s*마감|종료\s*되었(?!거나)|종료됐(?!거나)|종료된\s*(서비스|사업|모집|접수|프로그램|공고|강좌|교육)|신청\s*기간이\s*아닙니다|접수\s*기간이\s*아닙니다)")
STRIP_RE = re.compile(r"<(script|style|noscript|template|svg|head)\b.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
# "진행중 · 종료"처럼 목록 필터 탭으로 쓰인 표시는 마감 표시로 보지 않음
FILTER_RE = re.compile(r"^(전체|진행\s*중|접수\s*중|모집\s*중|예정|대기)$")

_host_lock = threading.Lock()
_host_next = {}   # 사이트 → 다음 요청을 보내도 되는 시각


def _wait_for_host(host):
    """같은 사이트에 너무 몰리지 않게 순서대로 간격을 둠"""
    with _host_lock:
        now = time.monotonic()
        start = max(now, _host_next.get(host, 0))
        _host_next[host] = start + SAME_HOST_GAP_SEC
    if start > now:
        time.sleep(start - now)


def _charset(content_type, head):
    m = re.search(r"charset=[\"']?([\w-]+)", content_type or "", re.IGNORECASE)
    if m:
        return m.group(1)
    m = re.search(rb"<meta[^>]+charset=[\"']?([\w-]+)", head, re.IGNORECASE)
    return m.group(1).decode("ascii", "ignore") if m else "utf-8"


def _fetch(url):
    _wait_for_host(urllib.parse.urlsplit(url).netloc.lower())
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,*/*;q=0.5"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as res:
            if res.status != 200:
                return None
            ctype = res.headers.get("Content-Type", "")
            if ctype and not re.search(r"html|text", ctype, re.IGNORECASE):
                return None
            raw = res.read(MAX_PAGE_BYTES)
    except Exception:   # 시간 초과·접속 실패·인증서 오류 등은 모두 "못 읽음"
        return None
    enc = _charset(ctype, raw[:4096])
    try:
        return raw.decode(enc, errors="replace")
    except LookupError:
        return raw.decode("utf-8", errors="replace")


def _text_nodes(page):
    body = STRIP_RE.sub(" ", COMMENT_RE.sub(" ", page))
    nodes = []
    for part in re.split(r"<[^>]*>", body):
        t = re.sub(r"\s+", " ", html.unescape(part)).strip()
        if t:
            nodes.append(t)
    return nodes


def _is_filter_tab(nodes, i):
    near = nodes[max(0, i - 2):i] + nodes[i + 1:i + 3]
    return any(FILTER_RE.match(t) for t in near)


def judge_page(page):
    if page is None:
        return {"result": "unknown"}
    nodes = _text_nodes(page)
    if sum(len(t) for t in nodes) < MIN_TEXT_CHARS:
        return {"result": "unknown"}
    for i, t in enumerate(nodes):
        if len(t) <= 12 and LABEL_RE.match(t) and not _is_filter_tab(nodes, i):
            snippet = " · ".join(nodes[max(0, i - 1):i + 2])
            return {"result": "closed_hint", "keyword": t, "snippet": re.sub(r"\s+", " ", snippet)[:120]}
        m = PHRASE_RE.search(t)
        if m:
            return {"result": "closed_hint", "keyword": m.group(0), "snippet": t[:120]}
    return {"result": "no_hint"}


def check_links(urls):
    """주소 목록을 점검해서 {주소: 결과} 로 돌려줌"""
    urls = list(dict.fromkeys(urls))   # 중복 제거 (순서 유지)
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        results = list(pool.map(lambda u: judge_page(_fetch(u)), urls))
    return dict(zip(urls, results))
