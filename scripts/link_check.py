"""
정책 링크 점검 (fetch_policies.py 마지막 단계에서 사용, AI 안 씀)
정책마다 신청URL·참고URL 1·2를 열어서 링크별 상태를 하나로 정함. 위에서부터 먼저 걸리는 것:
  a) broken        : HTTP 404/410/5xx, 또는 "검색결과가 없습니다"·"페이지를 찾을 수 없습니다" 같은 글
  b) search        : 검색 페이지 주소 (search·srch 경로, 검색어가 들어간 query=·keyword= 등)
  c) home          : 기관 첫 화면 주소 (경로 없음, /, /index.do, /main …)
  d) unmatched     : 페이지 제목+본문에 정책명 핵심 단어가 절반 미만
  e) mismatch_page : 본문의 나이 범위("만 13~18세" 등)가 정책 나이 범위와 하나도 안 겹침
  f) closed_hint   : "서비스종료"·"접수마감" 표시, "마감되었습니다" 같은 문장
  g) verified_apply: 위에 안 걸리고 "신청하기"·"접수하기" 같은 버튼 글자가 있음
     verified_info : 위에 안 걸렸지만 신청 버튼 글자는 없음 (제도 안내 페이지)
  h) unknown       : 열지 못했거나, 자바스크립트로만 그려져 글자가 거의 없음
- 동시 요청 5개 이하, 링크당 5초 제한, 같은 사이트는 최소 0.7초 간격
※ 규칙을 바꿀 때는 api/_linkrules.js도 같이 바꿀 것 (결과 화면의 실시간 점검이 같은 규칙을 씀)
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

# ----- a) 열리지 않는 페이지 -----
# "0건"은 "댓글 0건"처럼 정상 페이지에도 흔해서 검색 결과를 말하는 경우만 봄
BROKEN_RE = re.compile(
    r"검색\s*결과가\s*없습니다|검색된\s*(결과|자료|게시물)가\s*없습니다|(검색\s*결과|총)\s*:?\s*0\s*건|0\s*건이\s*검색"
    r"|페이지를\s*찾을\s*수\s*없습니다|존재하지\s*않는\s*(페이지|게시물|게시글|글|정보|주소|콘텐츠|컨텐츠|URL|url)"
    r"|삭제된\s*(게시물|게시글|글)|잘못된\s*접근|^\s*(404\s*)?not\s*found\s*$", re.IGNORECASE)

# ----- b) 검색 페이지 -----
SEARCH_PATH_RE = re.compile(r"search|srch", re.IGNORECASE)
SEARCH_PARAM_NAMES = {"query", "q", "kwd", "keyword", "searchwrd", "searchkrwd", "srchwrd", "searchkeyword",
                      "searchword", "searchtext", "srchtext", "searchtxt", "srchkwd"}
SEARCH_PARAM_RE = re.compile(r"^(search|srch).*(wrd|word|kwd|krwd|keyword|text|txt|nm|query)$", re.IGNORECASE)

# ----- c) 기관 첫 화면 -----
HOME_PATHS = {"", "/index", "/index.do", "/index.html", "/index.htm", "/index.jsp", "/index.php",
              "/main", "/main.do", "/main.html", "/main.jsp", "/main.php", "/home", "/kor", "/kor/main.do"}
HOME_LAST_RE = re.compile(r"(index|main|home)(\.\w+)?", re.IGNORECASE)

# ----- d) 정책명 핵심 단어 (흔한 단어·연도는 뺌) -----
COMMON_WORDS = {"지원", "사업", "서비스", "청년", "모집", "운영", "프로그램", "및", "위한", "대상", "신청", "안내",
                "지원사업", "참여자", "년", "등", "제도", "the", "and"}
NAME_SPLIT_RE = re.compile(r"[\s()\[\]{}「」『』<>〈〉《》'\"·･‧ㆍ,./!?~:+&\-_|]+")

# ----- e) 본문 속 나이 범위 -----
AGE_RES = [
    re.compile(r"만\s*(\d{1,2})\s*세?\s*[~∼～\-–]\s*(?:만\s*)?(\d{1,2})\s*세"),
    re.compile(r"(?:만\s*)?(\d{1,2})\s*세\s*이상\s*[~∼～,]?\s*(?:만\s*)?(\d{1,2})\s*세\s*(?:이하|미만)"),
    re.compile(r"(?<![\d.])(\d{1,2})\s*[~∼～\-–]\s*(\d{1,2})\s*세"),
]

# ----- f) 마감 표시 -----
LABEL_RE = re.compile(r"^(마감|접수\s*마감|모집\s*마감|예약\s*마감|신청\s*마감|서비스\s*종료|모집\s*종료|접수\s*종료|신청\s*종료|종료)$")
PHRASE_RE = re.compile(r"(마감\s*되었|마감됐|모집이\s*마감|접수가\s*마감|종료\s*되었(?!거나)|종료됐(?!거나)|종료된\s*(서비스|사업|모집|접수|프로그램|공고|강좌|교육)|신청\s*기간이\s*아닙니다|접수\s*기간이\s*아닙니다)")
# "진행중 · 종료"처럼 목록 필터 탭으로 쓰인 표시는 마감 표시로 보지 않음
FILTER_RE = re.compile(r"^(전체|진행\s*중|접수\s*중|모집\s*중|예정|대기)$")

# ----- g) 신청 버튼 글자 (버튼·링크처럼 짧은 글자 조각 하나가 통째로 이 말일 때만) -----
APPLY_RE = re.compile(
    r"^((온라인|인터넷|모바일)\s*)?(신청|접수|지원|예약|참가\s*신청|수강\s*신청|교육\s*신청)\s*(하기|바로\s*가기|하러\s*가기)$"
    r"|^(온라인|인터넷)\s*(신청|접수)$|^신청서(\s*(작성|제출|접수))?(하기)?$")

STRIP_RE = re.compile(r"<(script|style|noscript|template|svg|head)\b.*?</\1\s*>", re.IGNORECASE | re.DOTALL)
COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)

_host_lock = threading.Lock()
_host_next = {}   # 사이트 → 다음 요청을 보내도 되는 시각


# ===============================================================
# 주소만 보고 판단 (b, c)
# ===============================================================
def is_search_url(url):
    parts = urllib.parse.urlsplit(url)
    path = parts.path
    if SEARCH_PATH_RE.search(path) and not re.search(r"detail|view", path, re.IGNORECASE):
        return True
    for name, value in urllib.parse.parse_qsl(parts.query, keep_blank_values=True):
        n = name.lower()
        if value.strip() and (n in SEARCH_PARAM_NAMES or SEARCH_PARAM_RE.match(n)):
            return True
    return False


def is_home_url(url):
    parts = urllib.parse.urlsplit(url)
    path = parts.path.rstrip("/").lower()
    last = path.rsplit("/", 1)[-1]
    return not parts.query and (path in HOME_PATHS or bool(HOME_LAST_RE.fullmatch(last)))


# ===============================================================
# 페이지 받기
# ===============================================================
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


def fetch(url):
    """돌려주는 값: {httpStatus, finalUrl, html(못 읽으면 None)}"""
    _wait_for_host(urllib.parse.urlsplit(url).netloc.lower())
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,*/*;q=0.5"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as res:
            status, final_url = res.status, res.geturl()
            ctype = res.headers.get("Content-Type", "")
            if ctype and not re.search(r"html|text", ctype, re.IGNORECASE):
                return {"httpStatus": status, "finalUrl": final_url, "html": None}
            raw = res.read(MAX_PAGE_BYTES)
    except urllib.error.HTTPError as e:
        return {"httpStatus": e.code, "finalUrl": url, "html": None}
    except Exception:   # 시간 초과·접속 실패·인증서 오류 등은 모두 "못 읽음"
        return {"httpStatus": None, "finalUrl": url, "html": None}
    enc = _charset(ctype, raw[:4096])
    try:
        text = raw.decode(enc, errors="replace")
    except LookupError:
        text = raw.decode("utf-8", errors="replace")
    return {"httpStatus": status, "finalUrl": final_url, "html": text}


def page_parts(page_html):
    """HTML → (제목, 글자 조각 목록)"""
    m = TITLE_RE.search(page_html)
    title = re.sub(r"\s+", " ", html.unescape(m.group(1))).strip() if m else ""
    body = STRIP_RE.sub(" ", COMMENT_RE.sub(" ", page_html))
    nodes = []
    for part in re.split(r"<[^>]*>", body):
        t = re.sub(r"\s+", " ", html.unescape(part)).strip()
        if t:
            nodes.append(t)
    return title, nodes


# ===============================================================
# 판단 도구
# ===============================================================
def name_keywords(name):
    """정책명 핵심 단어 (연도·숫자·흔한 단어·한 글자 단어는 뺌)"""
    words = []
    for w in NAME_SPLIT_RE.split(name or ""):
        w = w.strip().lower()
        if len(w) < 2 or w in COMMON_WORDS or re.fullmatch(r"\d+(년|년도)?", w):
            continue
        if w not in words:
            words.append(w)
    return words


def squash(text):
    return re.sub(r"\s+", "", text or "").lower()


def find_age_ranges(text):
    found = []
    for rx in AGE_RES:
        for m in rx.finditer(text):
            a, b = int(m.group(1)), int(m.group(2))
            if 5 <= a < b <= 99 and (a, b) not in found:
                found.append((a, b))
    return found


def _is_filter_tab(nodes, i):
    near = nodes[max(0, i - 2):i] + nodes[i + 1:i + 3]
    return any(FILTER_RE.match(t) for t in near)


def closed_mark(nodes):
    for i, t in enumerate(nodes):
        if len(t) <= 12 and LABEL_RE.match(t) and not _is_filter_tab(nodes, i):
            return t, re.sub(r"\s+", " ", " · ".join(nodes[max(0, i - 1):i + 2]))[:120]
        m = PHRASE_RE.search(t)
        if m:
            return m.group(0), t[:120]
    return None


def judge(url, fetched, policy):
    """링크 하나의 상태. policy = {"name", "minAge", "maxAge"} (나이 제한 없으면 둘 다 None)"""
    status = fetched.get("httpStatus")
    final_url = fetched.get("finalUrl") or url
    page = fetched.get("html")
    out = {}
    if status is not None:
        out["httpStatus"] = status

    # a) 열리지 않는 페이지
    if status in (404, 410) or (status is not None and status >= 500):
        return dict(out, status="broken", keyword="HTTP " + str(status))
    title, nodes = page_parts(page) if page else ("", [])
    for t in ([title] if title else []) + nodes:
        m = BROKEN_RE.search(t)
        if m:
            return dict(out, status="broken", keyword=m.group(0).strip(), snippet=t[:120])

    # b) 검색 페이지 / c) 기관 첫 화면 (열어 본 뒤 옮겨 간 주소도 봄)
    if is_search_url(url) or is_search_url(final_url):
        return dict(out, status="search")
    if is_home_url(url) or (final_url != url and is_home_url(final_url)):
        return dict(out, status="home")

    # h) 못 읽음
    if not page or sum(len(t) for t in nodes) < MIN_TEXT_CHARS:
        return dict(out, status="unknown")

    # d) 정책명 핵심 단어
    words = name_keywords(policy.get("name"))
    text = squash(title + " " + " ".join(nodes))
    hit = [w for w in words if squash(w) in text]
    out["nameMatch"] = f"{len(hit)}/{len(words)}"
    if words and len(hit) * 2 < len(words):
        return dict(out, status="unmatched", missing=[w for w in words if w not in hit][:5])

    # e) 나이 범위
    lo, hi = policy.get("minAge"), policy.get("maxAge")
    if lo is not None or hi is not None:
        lo, hi = lo or 0, hi or 200
        ranges = find_age_ranges(" ".join(nodes))
        if ranges and not any(a <= hi and b >= lo for a, b in ranges):
            return dict(out, status="mismatch_page", ages="만 %d~%d세" % ranges[0])

    # f) 마감 표시
    closed = closed_mark(nodes)
    if closed:
        return dict(out, status="closed_hint", keyword=closed[0], snippet=closed[1])

    # g) 확인된 페이지
    button = next((t for t in nodes if len(t) <= 20 and APPLY_RE.match(t)), None)
    if button:
        return dict(out, status="verified_apply", keyword=button)
    return dict(out, status="verified_info")


# ===============================================================
# 여러 정책 한꺼번에
# ===============================================================
def check_policies(jobs):
    """
    jobs: [(url, {"name", "minAge", "maxAge"}), ...]
    같은 주소는 한 번만 받고, 정책마다 따로 판단 (같은 기관 첫 화면을 여러 정책이 쓰는 경우)
    돌려주는 값: 결과 목록 (jobs와 같은 순서)
    """
    urls = list(dict.fromkeys(u for u, _ in jobs))
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        pages = dict(zip(urls, pool.map(fetch, urls)))
    return [judge(u, pages[u], pol) for u, pol in jobs], len(urls)
