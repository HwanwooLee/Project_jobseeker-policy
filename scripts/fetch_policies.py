"""
온통청년 청년정책 API 수집 스크립트

하는 일 (순서대로)
  1) 대분류별로 전체 정책을 페이지를 넘기며 수집
  2) plcyNo(정책번호) 기준 중복 제거
  3) 마감 정책 제외 (PRD 7-3)
  4) 취준생 기준 1차 필터 (jobCd)
  5) data/policies.json 으로 저장  ← 웹 화면은 이 파일만 읽음

실행: 프로젝트 폴더에서  python scripts/fetch_policies.py
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from link_check import check_policies  # 같은 scripts 폴더의 링크 점검 도구 (규칙은 api/_linkrules.js와 같음)

# 윈도우 터미널에서 한글이 깨지지 않도록
sys.stdout.reconfigure(encoding="utf-8")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = PROJECT_ROOT / "data" / "policies.json"
API_URL = "https://www.youthcenter.go.kr/go/ythip/getPlcy"  # PRD 7-1
PAGE_SIZE = 500  # 한 번에 받는 건수 (500까지 되는 것 확인함)

# ---------------------------------------------------------------
# 요청할 대분류
# 주의: API는 가운뎃점으로 일반 '·'(U+00B7)가 아니라 반각 '･'(U+FF65)을 쓴다.
#       '·'로 요청하면 0건이 온다. (1단계 확인 결과)
#       "복지문화", "교육"은 예전 표기로 보여서 함께 요청한다.
#       API는 '포함' 검색이라 "교육"은 "교육･직업훈련"과 겹친다 → plcyNo 중복 제거로 정리.
# ---------------------------------------------------------------
DOT = "･"
CATEGORIES = ["일자리", f"교육{DOT}직업훈련", f"금융{DOT}복지{DOT}문화", "복지문화", "교육"]

# ---------------------------------------------------------------
# 코드정의서(온통청년 API코드정보.xlsx) 기준 코드
# ---------------------------------------------------------------
APLY_FIXED = "0057001"    # 특정기간
APLY_ALWAYS = "0057002"   # 상시
APLY_CLOSED = "0057003"   # 마감

JOB_UNEMPLOYED = "0013003"  # 미취업자
JOB_NO_LIMIT = "0013010"    # 제한없음

# 저장할 원본 항목 (PRD 7-4) + 원문 링크용 refUrlAddr1 + 제공기관그룹(pvsnInstGroupCd, 0054001=중앙부처)
# + 결과 화면 판정용: 전공(plcyMajorCd), 소득 금액(earnMinAmt/earnMaxAmt, 단위 만 원), 소득 기타(earnEtcCn), 신청 방법(plcyAplyMthdCn)
# + 상세 패널용: 추가 신청 자격(addAplyQlfcCndCn)
KEEP_FIELDS = [
    "pvsnInstGroupCd", "plcyMajorCd", "earnMinAmt", "earnMaxAmt", "earnEtcCn", "plcyAplyMthdCn", "addAplyQlfcCndCn",
    "plcyNo", "plcyNm", "lclsfNm", "mclsfNm", "plcyExplnCn", "plcySprtCn",
    "sprtTrgtMinAge", "sprtTrgtMaxAge", "sprtTrgtAgeLmtYn", "zipCd",
    "jobCd", "schoolCd", "earnCndSeCd", "aplyYmd", "aplyPrdSeCd",
    "srngMthdCn", "sbmsnDcmntCn", "aplyUrlAddr", "operInstCdNm",
    "refUrlAddr1", "refUrlAddr2",
    # 정확도 보강: 사업 기간(신청 기간과 비교용), 등록·수정일
    "bizPrdBgngYmd", "bizPrdEndYmd", "bizPrdSeCd", "bizPrdEtcCn", "frstRegDt", "lastMdfcnDt",
]

# 날짜 계산은 한국 시간 기준
KST = timezone(timedelta(hours=9))


# ===============================================================
# 1. API 호출
# ===============================================================
def load_api_key():
    """환경변수 또는 .env 파일에서 YOUTH_API_KEY를 읽는다. (키는 코드에 쓰지 않음)"""
    key = os.environ.get("YOUTH_API_KEY")
    if key:
        return key.strip()

    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            if name.strip() == "YOUTH_API_KEY":
                return value.strip().strip('"').strip("'")

    print("오류: YOUTH_API_KEY를 찾을 수 없어요. .env 파일을 확인해 주세요.")
    sys.exit(1)


def fetch_page(api_key, category, page_num):
    """대분류 하나의 한 페이지를 받아 (정책 목록, 전체 건수)를 돌려준다. 실패하면 3번까지 다시 시도."""
    params = {
        "apiKeyNm": api_key,
        "pageNum": page_num,
        "pageSize": PAGE_SIZE,
        "rtnType": "json",
        "lclsfNm": category,
    }
    url = API_URL + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "jobseeker-policy-script"})

    for attempt in range(1, 4):
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                data = json.loads(res.read().decode("utf-8"))
            result = data.get("result") or {}
            items = result.get("youthPolicyList") or []
            total = (result.get("pagging") or {}).get("totCount", 0)
            return items, total
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as e:
            # 키가 포함된 URL은 출력하지 않음
            print(f"  ! {category} {page_num}페이지 실패 ({attempt}/3): {type(e).__name__}")
            time.sleep(2 * attempt)

    print(f"오류: {category} {page_num}페이지를 받지 못했어요. 잠시 후 다시 실행해 주세요.")
    sys.exit(1)


def fetch_category(api_key, category):
    """대분류 하나의 전체 정책을 페이지를 넘기며 모두 받는다."""
    all_items = []
    page_num = 1
    while True:
        items, total = fetch_page(api_key, category, page_num)
        all_items.extend(items)
        if not items or len(all_items) >= total:
            break
        page_num += 1
        time.sleep(0.3)  # 서버에 부담 주지 않게 잠깐 쉼
    return all_items


# ===============================================================
# 2. 계산 함수
# ===============================================================
def to_int(value):
    """'19' 같은 문자열을 숫자로. 숫자가 아니면 None."""
    try:
        return int(str(value).strip())
    except (ValueError, TypeError):
        return None


def parse_end_date(aply_ymd):
    """'20261101 ~ 20261130' 에서 끝 날짜를 꺼낸다. 형식이 다르면 None."""
    match = re.fullmatch(r"\s*(\d{8})\s*~\s*(\d{8})\s*", aply_ymd or "")
    if not match:
        return None
    try:
        return datetime.strptime(match.group(2), "%Y%m%d").date()
    except ValueError:
        return None


def judge_period(policy, today):
    """
    마감 제외 규칙 (PRD 7-3)
    돌려주는 값: (포함 여부, status, dDay, 끝 날짜 문자열)
    """
    code = policy.get("aplyPrdSeCd", "")

    if code == APLY_CLOSED:
        return False, "마감", None, None
    if code == APLY_ALWAYS:
        return True, "상시", None, None

    end_date = parse_end_date(policy.get("aplyYmd"))
    if end_date is None:
        # 비었거나 형식이 다름 (또는 모르는 코드) → 제외하지 않음
        return True, "기간 확인 필요", None, None
    if code != APLY_FIXED:
        return True, "기간 확인 필요", None, end_date.isoformat()

    d_day = (end_date - today).days
    if d_day < 0:
        return False, "마감", d_day, end_date.isoformat()
    return True, "모집중", d_day, end_date.isoformat()


# ---------------------------------------------------------------
# 링크 분류: home(기관 첫 화면) / detail(정책·예약 상세) / page(그 밖의 페이지)
# ---------------------------------------------------------------
HOME_PATHS = {"", "/index", "/index.do", "/index.html", "/index.htm", "/index.jsp", "/index.php",
              "/main", "/main.do", "/main.html", "/main.jsp", "/main.php", "/home", "/kor", "/kor/main.do"}
DETAIL_RE = re.compile(r"view|reserv|detail|read\.|/read|article|(?:id|seq|no|idx|sn|key|num)=", re.IGNORECASE)


def clean_url(value):
    url = (value or "").strip()
    return url if re.match(r"^https?://[^\s]+$", url, re.IGNORECASE) else ""


def classify_link(url):
    parsed = urllib.parse.urlsplit(url)
    path = parsed.path.rstrip("/").lower()
    rest = parsed.path + ("?" + parsed.query if parsed.query else "")
    if DETAIL_RE.search(rest) or re.search(r"/\d{3,}$", path):
        return "detail"
    last = path.rsplit("/", 1)[-1]
    if not parsed.query and (path in HOME_PATHS or re.fullmatch(r"(index|main|home)(\.\w+)?", last)):
        return "home"
    return "page"


def build_links(policy):
    """링크 3개(신청·참고1·참고2)를 분류하고 가장 좋은 링크(bestLink)를 고른다."""
    links, seen = [], set()
    for role, field in (("apply", "aplyUrlAddr"), ("ref1", "refUrlAddr1"), ("ref2", "refUrlAddr2")):
        url = clean_url(policy.get(field))
        if url and url not in seen:
            seen.add(url)
            links.append({"role": role, "url": url, "kind": classify_link(url)})
    # 우선순위: detail 신청 > detail 참고 > page 신청 > page 참고 > home
    rank = {("detail", "apply"): 0, ("detail", "ref1"): 1, ("detail", "ref2"): 2,
            ("page", "apply"): 3, ("page", "ref1"): 4, ("page", "ref2"): 5,
            ("home", "apply"): 6, ("home", "ref1"): 7, ("home", "ref2"): 8}
    best = min(links, key=lambda l: rank[(l["kind"], l["role"])]) if links else None
    return links, best


# ---------------------------------------------------------------
# 신청 기간 신뢰도: 연간 사업 기간을 그대로 적어 둔 경우를 걸러낸다
# ---------------------------------------------------------------
def parse_range(aply_ymd):
    match = re.fullmatch(r"\s*(\d{8})\s*~\s*(\d{8})\s*", aply_ymd or "")
    if not match:
        return None, None
    try:
        return (datetime.strptime(match.group(1), "%Y%m%d").date(),
                datetime.strptime(match.group(2), "%Y%m%d").date())
    except ValueError:
        return None, None


def judge_confidence(policy, status):
    """돌려주는 값: ("exact" | "uncertain", 이유 또는 None)"""
    if status == "상시":
        return "exact", None
    if status != "모집중":
        return "uncertain", "기간 형식 확인 필요"
    start, end = parse_range(policy.get("aplyYmd"))
    if start is None:
        return "uncertain", "기간 형식 확인 필요"
    if start.month == 1 and start.day == 1 and end.month == 12 and end.day == 31:
        return "uncertain", "1월 1일~12월 31일 (연간)"
    biz_start = (policy.get("bizPrdBgngYmd") or "").strip()
    biz_end = (policy.get("bizPrdEndYmd") or "").strip()
    if biz_start and biz_end and biz_start == start.strftime("%Y%m%d") and biz_end == end.strftime("%Y%m%d"):
        return "uncertain", "신청 기간이 사업 기간과 같음"
    if (end - start).days >= 183:
        return "uncertain", "신청 기간이 6개월 이상"
    return "exact", None


# ---------------------------------------------------------------
# 설명 글 속 날짜 단서 (원문 문장 그대로, 새 날짜를 만들지 않음)
# ---------------------------------------------------------------
HINT_RE = re.compile(
    r"\d{1,2}\s*월\s*\d{1,2}\s*일"                     # 11월 30일
    r"|~\s*'?\d{0,4}\s*\d{1,2}\s*[./]\s*\d{1,2}"        # ~11.30 / ~ 2026.11.30
    r"|\d{4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2}"       # 2026.11.30
    r"|\d{1,2}\s*[./]\s*\d{1,2}\s*\.?\s*\([월화수목금토일]\)"  # 11.30(월)
    r"|회차별|차수별|선착순|조기\s*마감|예산\s*소진|소진\s*시"
)
# 신청 일정이 아닌 날짜(출생일·거주 기준일 등)가 든 문장은 뺌
HINT_SKIP_RE = re.compile(r"출생|생년|기준일|주민등록|보호종료|연령")
HINT_FIELDS = (("plcyExplnCn", "정책 설명"), ("plcySprtCn", "지원 내용"), ("plcyAplyMthdCn", "신청 방법"))
MAX_HINTS = 3
MAX_HINT_CHARS = 160


def extract_date_hints(policy):
    hints, seen = [], set()
    for field, label in HINT_FIELDS:
        text = policy.get(field) or ""
        # 줄바꿈·문장 끝(다. / 요.)·글머리 기호 기준으로 문장을 나눔
        for sentence in re.split(r"[\r\n]+|(?<=[다요]\.)\s+|\s(?=[○●■□▶※◦·\-]\s)", text):
            sentence = re.sub(r"\s+", " ", sentence).strip(" -○●■□▶※◦·")
            match = HINT_RE.search(sentence)
            if not sentence or not match or HINT_SKIP_RE.search(sentence):
                continue
            if len(sentence) > MAX_HINT_CHARS:  # 너무 길면 단서 주변만 잘라 냄
                begin = max(0, match.start() - 60)
                sentence = ("…" if begin else "") + sentence[begin:begin + MAX_HINT_CHARS - 2] + "…"
            if sentence in seen:
                continue
            seen.add(sentence)
            hints.append({"text": sentence, "from": label})
            if len(hints) >= MAX_HINTS:
                return hints
    return hints


def judge_job(policy):
    """
    취준생 1차 필터
    돌려주는 값: (포함 여부, 추가 확인 필요 여부)
    """
    codes = [c.strip() for c in (policy.get("jobCd") or "").split(",") if c.strip()]
    if not codes:
        return True, True  # 비어 있음 → 남기고 "추가 확인 필요"
    if JOB_UNEMPLOYED in codes or JOB_NO_LIMIT in codes:
        return True, False
    return False, False


def build_record(policy, status, d_day, end_date, job_check_needed):
    """저장할 형태로 정리: 원본 항목 + 계산한 값"""
    record = {field: policy.get(field, "") for field in KEEP_FIELDS}

    # 대분류: "교육･직업훈련,교육･직업훈련" 처럼 중복으로 붙어 오는 경우가 있어 목록으로 정리
    categories = []
    for name in (policy.get("lclsfNm") or "").split(","):
        name = name.strip()
        if name and name not in categories:
            categories.append(name)

    min_age = to_int(policy.get("sprtTrgtMinAge"))
    max_age = to_int(policy.get("sprtTrgtMaxAge"))
    # sprtTrgtAgeLmtYn은 의미가 불분명해서 무시. 최소·최대가 둘 다 0이면 나이 제한 없음.
    no_age_limit = min_age == 0 and max_age == 0
    links, best = build_links(policy)
    confidence, reason = judge_confidence(policy, status)

    record.update({
        "categories": categories,
        "status": status,                    # "모집중" / "상시" / "기간 확인 필요"
        "dDay": d_day,                       # 모집중일 때만 숫자 (0 = 오늘 마감), 나머지는 null
        "aplyEndDate": end_date,             # "2026-11-30" 형식, 없으면 null
        "minAge": None if no_age_limit else min_age,
        "maxAge": None if no_age_limit else max_age,
        "noAgeLimit": no_age_limit,
        "jobCheckNeeded": job_check_needed,  # true면 "추가 확인 필요" (jobCd 비어 있음)
        "links": links,                      # [{role: apply|ref1|ref2, url, kind: home|detail|page}]
        "bestLink": best["url"] if best else None,
        "bestLinkKind": best["kind"] if best else None,
        "aplyPeriodConfidence": confidence,  # "exact" / "uncertain"
        "aplyPeriodReason": reason,          # uncertain일 때 이유
        "dateHints": extract_date_hints(policy),  # [{text: 원문 문장, from: 어느 칸}]
    })
    return record


# ===============================================================
# 3. 실행
# ===============================================================
def main():
    api_key = load_api_key()
    today = datetime.now(KST).date()
    print(f"기준 날짜(한국 시간): {today}\n")

    # 1) 대분류별 수집
    raw_counts = {}
    collected = []
    for category in CATEGORIES:
        print(f"수집 중: {category} ...")
        items = fetch_category(api_key, category)
        raw_counts[category] = len(items)
        collected.extend(items)
        print(f"  → {len(items)}건")

    # 2) plcyNo 기준 중복 제거 (처음 나온 것을 남김)
    unique = {}
    for policy in collected:
        plcy_no = policy.get("plcyNo")
        if plcy_no and plcy_no not in unique:
            unique[plcy_no] = policy
    unique_list = list(unique.values())

    # 3) 마감 제외
    after_period = []
    for policy in unique_list:
        keep, status, d_day, end_date = judge_period(policy, today)
        if keep:
            after_period.append((policy, status, d_day, end_date))

    # 4) 취준생 1차 필터
    final = []
    for policy, status, d_day, end_date in after_period:
        keep, job_check_needed = judge_job(policy)
        if keep:
            final.append(build_record(policy, status, d_day, end_date, job_check_needed))

    # 정렬: 마감 임박 순 → 기간 확인 필요 → 상시 (PRD F3: 상시는 뒤로)
    order = {"모집중": 0, "기간 확인 필요": 1, "상시": 2}
    final.sort(key=lambda r: (order[r["status"]], r["dDay"] if r["dDay"] is not None else 0))

    # 5) 링크 점검: 정책마다 신청URL·참고URL 1·2를 모두 열어서 링크별 상태를 정함 (AI 안 씀, scripts/link_check.py)
    jobs, owners = [], []
    for r in final:
        pol = {"name": r["plcyNm"], "minAge": r["minAge"], "maxAge": r["maxAge"]}
        for l in r["links"]:
            jobs.append((l["url"], pol))
            owners.append((r, l))
    print(f"\n링크 점검 중: 링크 {len(jobs)}개 (동시 5개, 링크당 5초, 같은 사이트는 간격 두기) ...")
    check_started = time.monotonic()
    results, url_count = check_policies(jobs)
    check_seconds = time.monotonic() - check_started
    checked_at = datetime.now(KST).isoformat(timespec="seconds")
    for r in final:
        r["linkStatus"] = {"checkedAt": checked_at, "links": []}
    for (r, l), res in zip(owners, results):
        r["linkStatus"]["links"].append(dict({"role": l["role"], "url": l["url"]}, **res))
    link_count = {}
    for r in final:
        # bestLink: verified_apply > verified_info (신청URL → 참고 1 → 참고 2 순). 나머지는 쓰지 않음
        ok = [l for l in r["linkStatus"]["links"] if l["status"] in ("verified_apply", "verified_info")]
        best = next((l for l in ok if l["status"] == "verified_apply"), None) or (ok[0] if ok else None)
        r["bestLink"] = best["url"] if best else None
        r["bestLinkKind"] = best["status"] if best else None
        for l in r["linkStatus"]["links"]:
            link_count[l["status"]] = link_count.get(l["status"], 0) + 1

    # 6) 저장
    counts = {
        "byCategory": raw_counts,
        "collectedTotal": len(collected),
        "afterDedup": len(unique_list),
        "afterDeadline": len(after_period),
        "final": len(final),
    }
    output = {
        "generatedAt": datetime.now(KST).isoformat(timespec="seconds"),
        "baseDate": today.isoformat(),
        "counts": counts,
        "policies": final,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")

    # 결과 요약 출력
    print("\n========== 결과 요약 ==========")
    for category, n in raw_counts.items():
        print(f"  {category}: {n}건")
    print(f"  수집 합계: {len(collected)}건")
    print(f"  중복 제거 후: {len(unique_list)}건")
    print(f"  마감 제외 후: {len(after_period)}건")
    print(f"  취준생 필터 후(최종): {len(final)}건")
    status_count = {}
    for r in final:
        status_count[r["status"]] = status_count.get(r["status"], 0) + 1
    print(f"  최종 상태별: {status_count}")
    print(f"  추가 확인 필요(jobCd 비어 있음): {sum(r['jobCheckNeeded'] for r in final)}건")
    print(f"  신청 기간 확인 필요(uncertain): {sum(r['aplyPeriodConfidence'] == 'uncertain' for r in final)}건")
    print(f"  링크가 하나도 없음: {sum(not r['links'] for r in final)}건")
    print(f"  날짜 단서(dateHints) 있음: {sum(bool(r['dateHints']) for r in final)}건")
    order_names = ["verified_apply", "verified_info", "broken", "search", "home", "unmatched", "mismatch_page", "closed_hint", "unknown"]
    print(f"  링크 점검: 정책-링크 {len(jobs)}개 (주소 {url_count}개, {check_seconds:.0f}초)")
    print("    " + ", ".join(f"{k} {link_count.get(k, 0)}" for k in order_names))
    print(f"  bestLink: 신청 페이지(verified_apply) {sum(r['bestLinkKind'] == 'verified_apply' for r in final)}건, "
          f"안내 페이지(verified_info) {sum(r['bestLinkKind'] == 'verified_info' for r in final)}건, "
          f"없음 {sum(r['bestLink'] is None for r in final)}건")
    print(f"\n저장 완료: {OUTPUT_PATH.relative_to(PROJECT_ROOT)}")


if __name__ == "__main__":
    main()
