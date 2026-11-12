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
    "refUrlAddr1",
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

    record.update({
        "categories": categories,
        "status": status,                    # "모집중" / "상시" / "기간 확인 필요"
        "dDay": d_day,                       # 모집중일 때만 숫자 (0 = 오늘 마감), 나머지는 null
        "aplyEndDate": end_date,             # "2026-11-30" 형식, 없으면 null
        "minAge": None if no_age_limit else min_age,
        "maxAge": None if no_age_limit else max_age,
        "noAgeLimit": no_age_limit,
        "jobCheckNeeded": job_check_needed,  # true면 "추가 확인 필요" (jobCd 비어 있음)
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

    # 5) 저장
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
    print(f"\n저장 완료: {OUTPUT_PATH.relative_to(PROJECT_ROOT)}")


if __name__ == "__main__":
    main()
