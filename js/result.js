/* =========================================================
   맞춤 정책 결과 (PRD F3)
   - sessionStorage "userProfile"(설문 답변) + data/policies.json(정책)을 읽어서
   - 정책마다 8가지 조건(나이·거주 시·도·학력·학업 상태·취업 상태·전공·소득·실업급여 중복)을
     맞음 / 모름 / 안 맞음으로 판정 ("제한 없음"은 개수에서 뺌)
   - 4개 구역: 🎯 딱 맞아요 / 🔍 맞지만 확인이 필요해요 / ⚠️ 일부 조건이 달라요(1~2개) / 📋 참고용(3개 이상)
   - [자세히] → 상세 패널 (PC 오른쪽 / 모바일 아래 시트)
   ※ data/policies.json은 fetch로 읽기 때문에 로컬 서버(http://localhost)로 열어야 함
   ========================================================= */
(function () {
  'use strict';

  // ===== 1. 설정 =====
  const STORAGE_KEY = 'userProfile';
  const SURVEY_PAGE = 'survey.html';
  const DATA_URL = 'data/policies.json';
  const AFTER_STEPS_URL = 'data/after_steps.json';   // 6단계에서 만들 파일 (없으면 공통 단계만)
  const DOCS_KEY_PREFIX = 'docChecklist:';           // 제출 서류 체크 상태 (sessionStorage, 정책번호별 — 탭을 닫으면 사라짐)
  const YOUTHCENTER_URL = 'https://www.youthcenter.go.kr/youthPolicy/ythPlcyTotalSearch/ythPlcyDetail/';
  const PAGE_SIZE = 20;          // 처음 20개, [더 보기]마다 20개씩
  const URGENT_DAYS = 3;         // D-3 이하는 빨간 배지
  const EMPTY_TEXT = '공고에 적혀 있지 않아요. 공식 공고를 확인하세요.';

  // 온통청년 API 코드 (코드정의서 기준)
  const CODE = {
    CENTRAL: '0054001',          // 제공기관그룹: 중앙부처 → 전국 대상
    SCHOOL_ANY: '0049010',       // 학력 제한없음
    JOB_ANY: '0013010',          // 취업요건 제한없음
    MAJOR_ANY: '0011009',        // 전공 제한없음 (실제 데이터에서 가장 많이 쓰이는 값)
    EARN_ANY: '0043001',         // 소득 무관
    EARN_YEAR: '0043002',        // 연소득 (금액 단위: 만 원 — 4단계에서 실제 값으로 확인)
    EARN_ETC: '0043003',         // 기타 (주로 가구 중위소득 기준)
  };
  // 화면에 보여줄 코드 이름 (설문에서 확인한 코드만. 모르는 코드는 "그 밖의 조건"으로 표시)
  const SCHOOL_NAME = {
    '0049002': '고등학교 재학', '0049003': '고등학교 졸업 예정', '0049004': '고등학교 졸업',
    '0049005': '대학 재학', '0049006': '대학 졸업 예정', '0049007': '대학 졸업', '0049008': '대학원',
  };
  const JOB_NAME = { '0013001': '재직자', '0013003': '미취업자', '0013007': '단기근로자' };
  const MAJOR_NAME = {
    '0011001': '인문', '0011002': '사회', '0011003': '상경', '0011004': '자연과학',
    '0011005': '공학·IT', '0011006': '예체능', '0011007': '농업·생명', '0011008': '기타 전공',
  };
  // zipCd 앞 2자리 → 시·도 (4단계에서 실제 데이터로 확인한 값)
  const SIDO_NAME = {
    '11': '서울', '26': '부산', '27': '대구', '28': '인천', '12': '광주·전남', '30': '대전',
    '31': '울산', '36': '세종', '41': '경기', '51': '강원', '43': '충북', '44': '충남',
    '52': '전북', '47': '경북', '48': '경남', '50': '제주',
  };
  const ALL_SIDO_COUNT = Object.keys(SIDO_NAME).length;

  // 대분류 → 탭 (예전 표기 "교육", "복지문화"도 같은 탭으로)
  // API는 가운뎃점으로 '･'(U+FF65)를 써서, 글자 일부("교육", "복지")로 구분
  function tabOf(category) {
    if (category === '일자리') return 'job';
    if (category.indexOf('교육') !== -1) return 'edu';
    if (category.indexOf('복지') !== -1) return 'welfare';
    return null;
  }
  const TAB_LABEL = { job: '일자리', edu: '교육·직업훈련', welfare: '금융·복지·문화' };

  // 신청 후 단계 — data/after_steps.json의 정책별 단계, 없으면 같은 파일의 common 단계를 보여줌
  // 파일을 못 읽으면 아래 기본 공통 단계 (after_steps.json의 common과 같은 내용)
  // dateType: exact(정확한 날짜) / approx(예상) / none(날짜 미정·매주 확인) / monthly(매월 반복)
  const FALLBACK_COMMON_STEPS = [
    { id: 'applied', title: '신청 완료', dateType: 'exact', dateFrom: 'appliedAt' },
    { id: 'documents', title: '제출 서류 준비', dateType: 'none', onlyIfDocuments: true, note: '보완 요청이 오면 안내 받은 기한 안에 다시 내야 해요' },
    { id: 'result', title: '결과 발표 확인', dateType: 'none', noteFrom: 'srngMthdCn' },
    { id: 'after', title: '선정 후 안내 사항 확인', dateType: 'none', note: '선정되면 받은 안내에 따라 다음 할 일을 진행해요' },
  ];
  const DATE_TYPE_LABEL = { exact: '정확한 날짜', approx: '예상', none: '날짜 미정 · 매주 확인', monthly: '매월 반복' };
  const DATE_TYPE_CLASS = { exact: 'tl-exact', approx: 'tl-estimate', none: 'tl-unknown', monthly: 'tl-monthly' };

  // ===== 2. 설문 답변 읽기 (없으면 설문으로) =====
  function loadProfile() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      const profile = raw ? JSON.parse(raw) : null;
      if (!profile || !profile.birthYear || !profile.sidoCode) return null;
      return profile;
    } catch (e) {
      return null;
    }
  }

  const user = loadProfile();
  if (!user) {
    location.replace(SURVEY_PAGE);   // 뒤로 가기로 빈 결과 화면에 다시 오지 않게
    return;
  }


  // ===== 3. 도구 =====
  function codes(value) {
    return String(value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  function num(value) {
    const n = Number(value);
    return isFinite(n) ? n : 0;
  }
  function isBlank(text) {
    const t = String(text || '').trim();
    return !t || t === '-' || t === '.';
  }
  function won(n) { return n.toLocaleString('ko-KR') + '만 원'; }
  function namesOf(list, table) {
    const known = [], seen = {};
    let unknown = false;
    list.forEach(function (c) {
      if (table[c]) { if (!seen[table[c]]) { known.push(table[c]); seen[table[c]] = true; } }
      else unknown = true;
    });
    if (unknown) known.push('그 밖의 조건');
    return known.join(', ');
  }

  // 지역 코드 전체 목록 (시·도별로 어떤 시·군·구 코드가 있는지 — "일부 지역" 안내용)
  const allZipByPrefix = {};

  // ===== 4. 판정 =====
  // 각 규칙은 표 한 줄을 돌려줌:
  //   { label, r: 'ok' | 'check' | 'no', free: 제한 없음 여부, reason, policyText, userText }
  //   chip: 카드 칩에 붙일 짧은 글 (? 칩: 무엇을 확인할지 / ✕ 칩: 정책 조건)
  function row(label, r, free, policyText, userText, reason, chip) {
    return { label: label, r: r, free: !!free, policyText: policyText, userText: userText, reason: reason || '', chip: chip || '' };
  }

  function ageText(p) {
    const min = p.minAge || 0, max = p.maxAge || 0;
    if (p.noAgeLimit || (!min && !max)) return '나이 제한 없음';
    if (min && max) return '만 ' + min + '~' + max + '세';
    if (min) return '만 ' + min + '세 이상';
    return '만 ' + max + '세 이하';
  }

  // 1. 나이: 범위가 조금이라도 겹치면 일치
  function ruleAge(p) {
    const u = '만 ' + user.ageMin + '~' + user.ageMax + '세 (' + user.birthYear + '년생)';
    if (p.noAgeLimit || (!p.minAge && !p.maxAge)) return row('나이', 'ok', true, '나이 제한 없음', u);
    const pMin = p.minAge || 0;
    const pMax = p.maxAge ? p.maxAge : Infinity;   // 0 또는 없음 = 상한 없음
    if (user.ageMin <= pMax && user.ageMax >= pMin) return row('나이', 'ok', false, ageText(p), u);
    return row('나이', 'no', false, ageText(p), u, '', user.ageMin > pMax ? '만 ' + pMax + '세까지' : '만 ' + pMin + '세부터');
  }

  function regionText(p) {
    if (p.pvsnInstGroupCd === CODE.CENTRAL) return '전국 (중앙부처 정책)';
    const list = codes(p.zipCd);
    if (!list.length) return '';
    const prefixes = [];
    list.forEach(function (c) { const pf = c.slice(0, 2); if (prefixes.indexOf(pf) === -1) prefixes.push(pf); });
    if (prefixes.length >= ALL_SIDO_COUNT) return '전국';
    const names = prefixes.map(function (pf) { return SIDO_NAME[pf] || '기타 지역'; });
    let text = names.length > 4 ? names.slice(0, 4).join(', ') + ' 외 ' + (names.length - 4) + '곳' : names.join(', ');
    // 내 시·도 안에서 일부 시·군·구만 대상이면 알려줌 (판정은 시·도 단위라 바꾸지 않음)
    const mine = list.filter(function (c) { return c.slice(0, 2) === user.sidoCode; });
    const all = allZipByPrefix[user.sidoCode] || [];
    if (mine.length && all.length && mine.length < all.length) text += ' — ' + user.sido + ' 중 일부 시·군·구만 해당될 수 있어요';
    return text;
  }

  // 2. 거주 시·도 (내 시·도 안에서 일부 시·군·구만 대상이면 "? 시·군·구" — 설문은 시·도까지만 물어봄)
  function ruleRegion(p) {
    const L = '거주 시·도', u = user.sido;
    if (p.pvsnInstGroupCd === CODE.CENTRAL) return row(L, 'ok', true, '전국 (중앙부처 정책)', u);
    const list = codes(p.zipCd);
    if (!list.length) return row(L, 'check', false, '공고 확인 필요', u, '공고에 지역 정보가 없어요', '지역');
    const text = regionText(p);
    if (text === '전국') return row(L, 'ok', true, text, u);
    const mine = list.filter(function (c) { return c.slice(0, 2) === user.sidoCode; });
    if (!mine.length) {
      const names = [];
      list.forEach(function (c) { const n = SIDO_NAME[c.slice(0, 2)] || '기타 지역'; if (names.indexOf(n) === -1) names.push(n); });
      return row(L, 'no', false, text, u, '', names.length > 2 ? names.slice(0, 2).join('·') + ' 외' : names.join('·'));
    }
    const all = allZipByPrefix[user.sidoCode] || [];
    if (all.length && mine.length < all.length) return row(L, 'check', false, text, u, '내 시·도 중 일부 시·군·구만 대상이에요', '시·군·구');
    return row(L, 'ok', false, text, u);
  }

  // 3·4. 학력 / 학업 상태 — schoolCd 하나에 학교 단계와 재학·졸업 상태가 같이 들어 있어서 둘로 나눠 비교
  const SCHOOL_PARTS = {
    '0049002': ['고등학교', '재학 중'], '0049003': ['고등학교', '졸업 예정'], '0049004': ['고등학교', '졸업'],
    '0049005': ['대학', '재학 중'], '0049006': ['대학', '졸업 예정'], '0049007': ['대학', '졸업'],
    '0049008': ['대학원', null],
  };
  function userLevel() {
    if (user.education === '고등학교' || user.education === '대학원') return user.education;
    return '대학';
  }
  function schoolInfo(p) {
    const list = codes(p.schoolCd);
    const free = !list.length || list.indexOf(CODE.SCHOOL_ANY) !== -1;
    const known = list.filter(function (c) { return SCHOOL_PARTS[c]; });
    return { list: list, free: free, known: known, other: list.length > known.length };
  }
  function uniq(arr) { return arr.filter(function (x, i) { return x && arr.indexOf(x) === i; }); }
  function ruleSchool(p) {
    const s = schoolInfo(p), u = user.education;
    if (s.free) return row('학력', 'ok', true, '학력 제한 없음', u);
    const levels = uniq(s.known.map(function (c) { return SCHOOL_PARTS[c][0]; }));
    if (levels.indexOf(userLevel()) !== -1) return row('학력', 'ok', false, levels.join(', '), u);
    if (!levels.length || s.other) return row('학력', 'check', false, namesOf(s.list, SCHOOL_NAME), u, '공고의 학력 조건을 확인해 주세요', '학력');
    return row('학력', 'no', false, levels.join(', '), u, '', levels.join('·'));
  }
  function ruleSchoolStatus(p) {
    const s = schoolInfo(p), u = user.schoolStatus;
    if (s.free) return row('학업 상태', 'ok', true, '학업 상태 제한 없음', u);
    if (userLevel() === '대학원') return null;    // 대학원은 재학·졸업 구분 코드가 없어서 학력 줄로만 비교
    const myStatus = SCHOOL_PARTS[user.schoolCd] ? SCHOOL_PARTS[user.schoolCd][1] : null;
    const sameLevel = s.known.filter(function (c) { return SCHOOL_PARTS[c][0] === userLevel(); });
    const statuses = uniq((sameLevel.length ? sameLevel : s.known).map(function (c) { return SCHOOL_PARTS[c][1]; }));
    if (!statuses.length) return null;            // 대학원만 대상 → 학력 줄에서 이미 비교
    if (myStatus && statuses.indexOf(myStatus) !== -1) return row('학업 상태', 'ok', false, statuses.join(', '), u);
    return row('학업 상태', 'no', false, statuses.join(', '), u, '', statuses.join('·'));
  }

  // 5. 취업 상태
  function ruleJob(p) {
    const u = user.jobStatus;
    const list = codes(p.jobCd);
    if (!list.length) return row('취업 상태', 'check', false, '공고 확인 필요', u, '공고에 취업 상태 정보가 없어요', '취업 상태');
    if (list.indexOf(CODE.JOB_ANY) !== -1) return row('취업 상태', 'ok', true, '취업 상태 제한 없음', u);
    if (list.indexOf(user.jobCd) !== -1) return row('취업 상태', 'ok', false, namesOf(list, JOB_NAME), u);
    return row('취업 상태', 'no', false, namesOf(list, JOB_NAME), u, '', namesOf(list, JOB_NAME).replace(/, /g, '·'));
  }

  // 6. 전공 (고등학교를 고르면 전공 질문이 없어서 plcyMajorCd = null)
  function ruleMajor(p) {
    const u = user.major || '질문 안 함 (고등학교)';
    const list = codes(p.plcyMajorCd);
    if (!list.length || list.indexOf(CODE.MAJOR_ANY) !== -1) return row('전공', 'ok', true, '전공 제한 없음', u);
    if (!user.plcyMajorCd) return row('전공', 'check', false, namesOf(list, MAJOR_NAME), u, '전공 조건이 있어요. 공고를 확인해 주세요', '전공');
    if (list.indexOf(user.plcyMajorCd) !== -1) return row('전공', 'ok', false, namesOf(list, MAJOR_NAME), u);
    return row('전공', 'no', false, namesOf(list, MAJOR_NAME), u, '', namesOf(list, MAJOR_NAME).replace(/, /g, '·'));
  }

  function userIncomeText() {
    if (user.incomeMin === null || user.incomeMin === undefined) return '입력 안 함';
    if (user.incomeMin === 0 && user.incomeMax === 0) return '소득 없음';
    if (user.incomeMax === null || user.incomeMax === undefined) return won(user.incomeMin) + ' 이상';
    if (user.incomeMin === 0) return won(user.incomeMax) + ' 미만';
    return user.incomeMin.toLocaleString('ko-KR') + '~' + won(user.incomeMax);
  }

  // 6. 소득 (설문 incomeMin/incomeMax 와 정책 earnMinAmt/earnMaxAmt 모두 만 원 단위)
  function ruleIncome(p) {
    const u = userIncomeText();
    const code = p.earnCndSeCd;
    if (!code || code === CODE.EARN_ANY) return row('소득', 'ok', true, '소득 무관', u);
    if (code === CODE.EARN_YEAR) {
      const pMin = num(p.earnMinAmt);
      const pMax = num(p.earnMaxAmt) > 0 ? num(p.earnMaxAmt) : Infinity;
      const pText = '연소득 ' + (pMin > 0 ? won(pMin) + ' 이상 ' : '') + (pMax < Infinity ? won(pMax) + ' 이하' : '');
      if (user.incomeMin === null || user.incomeMin === undefined) return row('소득', 'check', false, pText, u, '소득 질문을 건너뛰어서 비교하지 못했어요', '소득');
      const uMax = user.incomeMax === null || user.incomeMax === undefined ? Infinity : user.incomeMax;
      if (user.incomeMin <= pMax && uMax >= pMin) return row('소득', 'ok', false, pText, u);
      return row('소득', 'no', false, pText, u, '', pText.replace(/^연소득 /, '').trim());
    }
    if (code === CODE.EARN_ETC) {
      const pText = isBlank(p.earnEtcCn) ? '기타 소득 조건 (공고 확인)' : String(p.earnEtcCn).trim();
      return row('소득', 'check', false, pText, u, '가구 소득 기준 등 복잡한 조건이라 직접 확인해야 해요', '소득');
    }
    return row('소득', 'check', false, '공고 확인 필요', u, '공고의 소득 조건을 확인해 주세요', '소득');
  }

  // 8. 실업급여 중복 — 국민취업지원제도일 때만 표에 나옴
  function ruleBenefit(p) {
    if (String(p.plcyNm).indexOf('국민취업지원제도') === -1) return null;
    const u = user.unemploymentBenefit, L = '실업급여 중복', t = '실업급여 수급 여부에 따라 참여가 달라질 수 있음';
    if (u === '예') return row(L, 'check', false, t, u, '실업급여 받는 중에는 참여가 제한될 수 있어요', '실업급여');
    if (u === '잘 모르겠어요') return row(L, 'check', false, t, u, '실업급여를 받는지 확인해 주세요', '실업급여');
    return row(L, 'ok', false, t, u);
  }

  const RULES = [ruleAge, ruleRegion, ruleSchool, ruleSchoolStatus, ruleJob, ruleMajor, ruleIncome, ruleBenefit];

  // 조건마다 맞음(ok) / 모름(check) / 안 맞음(no). "제한 없음"(free)은 개수에서 뺌
  // rows는 상세 패널의 "나랑 맞는지" 표와 카드 칩에 같이 씀
  function judge(p) {
    const rows = [];
    RULES.forEach(function (rule) { const res = rule(p); if (res) rows.push(res); });
    const counted = rows.filter(function (r) { return !r.free; });
    return {
      rows: rows,
      total: counted.length,
      ok: counted.filter(function (r) { return r.r === 'ok'; }).length,
      unknown: counted.filter(function (r) { return r.r === 'check'; }).length,
      mismatch: counted.filter(function (r) { return r.r === 'no'; }).length,
      // 나이·거주 시·도가 안 맞으면 사실상 신청할 수 없어서 바로 참고용
      hardMismatch: counted.some(function (r) { return r.r === 'no' && HARD_LABELS.indexOf(r.label) !== -1; }),
    };
  }

  // 4단계: perfect(딱 맞아요) / check(맞지만 확인 필요)
  //        partial(일부 다름: 학력·학업 상태·취업 상태·전공·소득·실업급여 중복 중 1~2개)
  //        reference(참고용: 나이·거주 시·도가 다르거나, 안 맞는 조건이 3개 이상)
  // 신청 페이지에 마감 표시가 보이면 perfect·check → check
  const HARD_LABELS = ['나이', '거주 시·도'];
  function tierOf(item) {
    const j = item.j;
    if (j.hardMismatch || j.mismatch >= 3) return 'reference';
    if (j.mismatch >= 1) return 'partial';
    if (j.unknown === 0 && item.period.exact && !closedOf(item.p).length) return 'perfect';
    return 'check';
  }

  // ===== 5. 신청 기간 (오늘 기준으로 D-day 다시 계산) =====
  function todayDate() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  // policies.json을 받은 뒤 날짜가 지났을 수 있어서, 화면을 연 날 기준으로 다시 계산
  // exact: 수집할 때 판단한 신청 기간 신뢰도 (연간 사업 기간처럼 보이면 false = "접수 기간 확인 필요")
  function periodOf(p, today) {
    const res = periodKind(p, today);
    res.exact = res.kind === 'always' || (res.kind === 'open' && p.aplyPeriodConfidence !== 'uncertain');
    return res;
  }
  function periodKind(p, today) {
    if (p.status === '상시') return { kind: 'always', dDay: null };
    if (p.aplyEndDate) {
      const parts = p.aplyEndDate.split('-').map(Number);
      const end = new Date(parts[0], parts[1] - 1, parts[2]);
      const dDay = Math.round((end - today) / 86400000);
      if (dDay < 0) return { kind: 'expired', dDay: dDay };
      return { kind: 'open', dDay: dDay };
    }
    return { kind: 'unknown', dDay: null };   // 기간 확인 필요
  }

  // ===== 6. 데이터 준비 =====
  let shown = [];          // 화면에 보여줄 정책 (4단계 모두)
  let expiredCount = 0;    // 데이터를 받은 뒤 마감돼서 뺀 정책
  let currentTab = 'all';
  // 구역(단계)별: 펼침 여부, 보여줄 개수 — 처음엔 위 두 구역만 펼침
  const TIERS = [
    { id: 'perfect', emoji: '🎯', title: '딱 맞아요', desc: '입력한 조건이 모두 맞고, 접수 기간도 확실해요.' },
    { id: 'check', emoji: '🔍', title: '맞지만 확인이 필요해요', desc: '안 맞는 조건은 없지만, 공고에 없는 정보나 접수 기간을 직접 확인해야 해요.' },
    { id: 'partial', emoji: '⚠️', title: '일부 조건이 달라요', desc: '학력·취업 상태·전공·소득 등 조건 1~2개가 달라요. 공고에서 예외가 있는지 확인해 보세요.' },
    { id: 'reference', emoji: '📋', title: '참고용', desc: '지역·나이가 다르거나 안 맞는 조건이 많아요' },
  ];
  const tierState = {
    perfect: { open: true, visible: PAGE_SIZE }, check: { open: true, visible: PAGE_SIZE },
    partial: { open: false, visible: PAGE_SIZE }, reference: { open: false, visible: PAGE_SIZE },
  };

  function prepare(policies) {
    // 시·도별 시·군·구 코드 모으기 (상세 패널의 "일부 지역" 안내용)
    policies.forEach(function (p) {
      codes(p.zipCd).forEach(function (c) {
        const pf = c.slice(0, 2);
        (allZipByPrefix[pf] = allZipByPrefix[pf] || {})[c] = true;
      });
    });
    Object.keys(allZipByPrefix).forEach(function (pf) { allZipByPrefix[pf] = Object.keys(allZipByPrefix[pf]); });

    const today = todayDate();
    const result = [];
    let expired = 0;
    policies.forEach(function (p) {
      const period = periodOf(p, today);
      if (period.kind === 'expired') { expired++; return; }   // 받은 뒤 마감된 정책은 뺌
      const j = judge(p);
      const tabs = [];
      (p.categories || []).forEach(function (c) {
        const t = tabOf(c);
        if (t && tabs.indexOf(t) === -1) tabs.push(t);
      });
      const item = { p: p, j: j, rows: j.rows, period: period, tabs: tabs };
      item.tier = tierOf(item);
      result.push(item);
    });
    result.sort(compareItems);
    shown = result;
    expiredCount = expired;
    updateStats();
  }

  // 정렬 (구역 안에서): 맞는 조건 비율 높은 순 → 접수 기간이 확실한(exact) 것 먼저 → 마감 임박 순 → 상시는 뒤로
  const PERIOD_RANK = { open: 0, unknown: 1, always: 2 };
  function ratio(item) { return item.j.total ? item.j.ok / item.j.total : 1; }
  function compareItems(a, b) {
    if (ratio(a) !== ratio(b)) return ratio(b) - ratio(a);
    if (a.period.exact !== b.period.exact) return a.period.exact ? -1 : 1;
    if (a.period.kind !== b.period.kind) return PERIOD_RANK[a.period.kind] - PERIOD_RANK[b.period.kind];
    if (a.period.kind === 'open' && a.period.dDay !== b.period.dDay) return a.period.dDay - b.period.dDay;
    return String(a.p.plcyNm).localeCompare(String(b.p.plcyNm), 'ko');
  }

  function updateStats() {
    const count = function (t) { return shown.filter(function (x) { return x.tier === t; }).length; };
    // 확인용 (개발자 도구 콘솔에서 window.__resultStats 로 볼 수 있음)
    window.__resultStats = {
      perfect: count('perfect'), check: count('check'), partial: count('partial'), reference: count('reference'),
      expiredSinceFetch: expiredCount,
    };
  }

  // 패널에서 마감 표시를 확인한 뒤: 단계가 바뀌면(perfect → check) 목록을 다시 그림
  function onLinkChecked(item) {
    item.tier = tierOf(item);
    if (item === currentItem) badgesInto($('sheet-badges'), item);
    updateStats();
    renderSummary();
    renderList();
  }

  // ===== 7. 목록 그리기 =====
  const $ = function (id) { return document.getElementById(id); };
  const listEl = $('policy-list');
  const tabButtons = Array.prototype.slice.call(document.querySelectorAll('.tab'));

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function filtered() {
    if (currentTab === 'all') return shown;
    return shown.filter(function (x) { return x.tabs.indexOf(currentTab) !== -1; });
  }

  function renderSummary() {
    const s = window.__resultStats;
    $('summary-title').innerHTML = '';
    $('summary-title').append('딱 맞는 정책 ', el('strong', 'accent', s.perfect + '개'), ', 확인이 필요한 정책 ', el('strong', 'accent', s.check + '개'));
    $('summary-sub').textContent = '일부 조건이 다른 정책 ' + s.partial + '개 · 참고용 ' + s.reference + '개도 아래에 있어요';
    $('summary-hidden').textContent = '조건 개수는 "제한 없음"인 조건을 빼고 셌어요.';
  }

  function renderTabs() {
    tabButtons.forEach(function (btn) {
      const tab = btn.dataset.tab;
      const n = tab === 'all' ? shown.length : shown.filter(function (x) { return x.tabs.indexOf(tab) !== -1; }).length;
      btn.querySelector('.tab-count').textContent = n;
      btn.setAttribute('aria-selected', String(tab === currentTab));
    });
  }

  // 신청 링크: 수집할 때 고른 bestLink (상세 신청 페이지 > 상세 참고 페이지 > 기관 첫 화면). http(s) 주소만 사용
  function safeUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return null;
    if (/^www\./i.test(u)) u = 'https://' + u;    // "www.xxx.kr" 처럼 앞부분이 빠진 주소 보정
    return /^https?:\/\//i.test(u) ? u : null;
  }
  function applyUrl(p) {
    return safeUrl(p.bestLink) || safeUrl(p.aplyUrlAddr) || safeUrl(p.refUrlAddr1);
  }
  // 링크 이름: 기관 첫 화면이면 "기관 홈페이지", 아니면 신청 페이지 / 참고 페이지 1·2
  const LINK_ROLE_LABEL = { apply: '신청 페이지', ref1: '참고 페이지 1', ref2: '참고 페이지 2' };
  function linkLabel(l) { return l.kind === 'home' ? '기관 홈페이지' : (LINK_ROLE_LABEL[l.role] || '링크'); }

  function ddayBadge(period) {
    if (period.kind === 'always') return el('span', 'dday dday-always', '상시');
    if (!period.exact) return el('span', 'dday dday-uncertain', '접수 기간 확인 필요');
    const d = period.dDay;
    return el('span', 'dday' + (d <= URGENT_DAYS ? ' dday-urgent' : ''), d === 0 ? 'D-Day' : 'D-' + d);
  }

  function badgesInto(box, item) {
    box.innerHTML = '';
    item.tabs.forEach(function (t) { box.appendChild(el('span', 'tag', TAB_LABEL[t])); });
    box.appendChild(ddayBadge(item.period));
  }

  // 조건 칩: ✕ 안 맞음(빨강) → ? 모름(노랑) → ✓ 맞음(초록). "제한 없음"은 칩도 만들지 않음
  function chipsOf(item) {
    const chips = [];
    item.rows.forEach(function (r) {
      if (r.free) return;
      if (r.r === 'no') chips.push({ cls: 'chip-no', text: '✕ ' + r.label + (r.chip ? ' ' + r.chip : ''), order: 0 });
      else if (r.r === 'check') chips.push({ cls: 'chip-check', text: '? ' + (r.chip || r.label), order: 1 });
      else chips.push({ cls: 'chip-ok', text: '✓ ' + r.label, order: 2 });
    });
    if (!item.period.exact) chips.push({ cls: 'chip-check', text: '? 접수 기간', order: 1 });
    if (closedOf(item.p).length) chips.unshift({ cls: 'chip-closed', text: '마감 표시 있음', order: -1 });
    return chips.sort(function (a, b) { return a.order - b.order; });
  }
  function matchLine(item) {
    const j = item.j;
    return j.total ? '조건 ' + j.total + '개 중 ' + j.ok + '개 맞아요' : '조건이 모두 "제한 없음"이에요';
  }

  function card(item) {
    const p = item.p;
    const art = el('article', 'pcard');

    const top = el('div', 'pcard-top');
    badgesInto(top, item);
    art.appendChild(top);

    art.appendChild(el('h2', 'pcard-title', p.plcyNm));
    art.appendChild(el('p', 'pcard-desc', p.plcyExplnCn || p.plcySprtCn || ''));

    // 조건 N개 중 M개 + 칩
    const match = el('div', 'pcard-match');
    match.appendChild(el('p', 'match-count', matchLine(item)));
    const chips = el('div', 'chips');
    chipsOf(item).forEach(function (c) { chips.appendChild(el('span', 'chip ' + c.cls, c.text)); });
    match.appendChild(chips);
    if (item.tier === 'partial') match.appendChild(el('p', 'partial-note', '이 조건 때문에 신청이 어려울 수 있어요'));
    art.appendChild(match);

    // 버튼
    const actions = el('div', 'pcard-actions');
    const more = el('button', 'btn-line', '자세히');
    more.type = 'button';
    more.setAttribute('aria-haspopup', 'dialog');
    more.addEventListener('click', function () { openSheet(item, more); });
    actions.appendChild(more);

    const url = applyUrl(p);
    if (url) {
      const go = el('a', 'btn-line', '신청하러 가기');
      go.href = url;
      go.target = '_blank';
      go.rel = 'noopener noreferrer';
      actions.appendChild(go);
    }

    const done = el('a', 'btn-solid', '신청했어요');
    done.href = 'manage.html?plcyNo=' + encodeURIComponent(p.plcyNo);
    actions.appendChild(done);

    art.appendChild(actions);
    return art;
  }

  // 목록: 지금 탭의 정책을 4개 구역(단계)으로 나눠 그림. 구역마다 [더 보기]와 펼치기/접기
  function renderList() {
    const items = filtered();
    listEl.innerHTML = '';
    TIERS.forEach(function (t) {
      const inTier = items.filter(function (x) { return x.tier === t.id; });
      listEl.appendChild(tierSection(t, inTier));
    });
    $('list-empty').hidden = items.length > 0;
  }

  function tierSection(t, inTier) {
    const st = tierState[t.id];
    const sec = el('section', 'tier tier-' + t.id);
    const head = el('button', 'tier-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(st.open && inTier.length > 0));
    const title = el('span', 'tier-title');
    title.append(el('span', 'tier-emoji', t.emoji), ' ' + t.title + ' ', el('span', 'tier-count', inTier.length + '개'));
    head.append(title, el('span', 'tier-toggle', st.open ? '접기' : '펼치기'));
    sec.appendChild(head);
    sec.appendChild(el('p', 'tier-desc', t.desc));

    const body = el('div', 'tier-body');
    body.hidden = !st.open;
    if (!inTier.length) body.appendChild(el('p', 'tier-empty', '이 구역에 해당하는 정책이 없어요.'));
    const grid = el('div', 'policy-list');
    inTier.slice(0, st.visible).forEach(function (item) { grid.appendChild(card(item)); });
    body.appendChild(grid);
    if (inTier.length > st.visible) {
      const more = el('button', 'btn btn-secondary more-btn', '더 보기 (' + (inTier.length - st.visible) + '개 남음)');
      more.type = 'button';
      const row = el('div', 'more-row');
      row.appendChild(more);
      more.addEventListener('click', function () {
        // 이미 그린 카드는 그대로 두고 뒤에 20개만 추가
        inTier.slice(st.visible, st.visible + PAGE_SIZE).forEach(function (item) { grid.appendChild(card(item)); });
        st.visible += PAGE_SIZE;
        if (inTier.length > st.visible) more.textContent = '더 보기 (' + (inTier.length - st.visible) + '개 남음)';
        else row.remove();
      });
      body.appendChild(row);
    }
    sec.appendChild(body);

    head.addEventListener('click', function () {
      st.open = !st.open;
      body.hidden = !st.open;
      head.setAttribute('aria-expanded', String(st.open));
      head.querySelector('.tier-toggle').textContent = st.open ? '접기' : '펼치기';
    });
    return sec;
  }

  // ===== 8. 상세 패널 =====
  const sheet = $('sheet');
  const backdrop = $('sheet-backdrop');
  const sheetBody = $('sheet-body');
  let lastOpener = null;
  let currentItem = null;   // 지금 패널에 보이는 정책
  let closeTimer = null;

  // 섹션 하나 (이모지는 제목에만)
  function section(emoji, title) {
    const sec = el('section', 'sheet-section');
    const h = el('h3', 'sheet-section-title');
    h.append(el('span', 'sheet-emoji', emoji), ' ' + title);
    sec.appendChild(h);
    return sec;
  }

  // 긴 글: 3줄까지만 보이고 [더 보기]로 펼침
  function clampText(text) {
    const wrap = el('div', 'clamp-wrap');
    if (isBlank(text)) {
      wrap.appendChild(el('p', 'empty-note', EMPTY_TEXT));
      return wrap;
    }
    const p = el('p', 'clamp', String(text).trim());
    const btn = el('button', 'clamp-btn', '더 보기');
    btn.type = 'button';
    btn.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', function () {
      const open = p.classList.toggle('open');
      btn.textContent = open ? '접기' : '더 보기';
      btn.setAttribute('aria-expanded', String(open));
    });
    wrap.append(p, btn);
    return wrap;
  }
  // 패널이 화면에 보인 뒤에 글이 3줄을 넘는지 재서 [더 보기] 표시
  function measureClamps() {
    sheetBody.querySelectorAll('.clamp').forEach(function (p) {
      p.nextSibling.hidden = p.scrollHeight <= p.clientHeight + 2;
    });
  }

  // --- ✅ 나랑 맞는지 ---
  function matchSection(item) {
    const sec = section('✅', '나랑 맞는지');
    sec.appendChild(el('p', 'match-count', matchLine(item) + ' ("제한 없음" 조건은 빼고 셌어요)'));
    const table = el('table', 'match-table');
    const head = el('tr');
    ['항목', '이 정책 조건', '내 조건', '결과'].forEach(function (h) { head.appendChild(el('th', null, h)); });
    const thead = el('thead');
    thead.appendChild(head);
    const tbody = el('tbody');
    item.rows.forEach(function (r) {
      const tr = el('tr');
      tr.appendChild(el('th', 'match-label', r.label));
      tr.appendChild(el('td', 'match-policy', r.policyText || '공고 확인 필요'));
      tr.appendChild(el('td', 'match-user', r.userText));
      const res = el('td', 'match-result');
      if (r.r === 'check') {
        res.appendChild(el('span', 'mr mr-check', '? 확인 필요'));
        if (r.reason) res.appendChild(el('span', 'mr-reason', r.reason));
      } else if (r.r === 'no') {
        res.appendChild(el('span', 'mr mr-no', '✕ 안 맞음'));
      } else if (r.free) {
        res.appendChild(el('span', 'mr mr-free', '제한 없음'));
      } else {
        res.appendChild(el('span', 'mr mr-ok', '✓ 맞음'));
      }
      tr.appendChild(res);
      tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    sec.appendChild(table);
    sec.appendChild(el('p', 'sheet-hint', '입력한 조건으로 대략 비교한 결과예요. 정확한 자격은 공고 기준이에요.'));
    return sec;
  }

  // --- 📋 핵심 정보 ---
  function formatYmd(ymd) {
    const m = String(ymd || '').match(/(\d{4})(\d{2})(\d{2})\s*~\s*(\d{4})(\d{2})(\d{2})/);
    return m ? m[1] + '.' + m[2] + '.' + m[3] + ' ~ ' + m[4] + '.' + m[5] + '.' + m[6] : '';
  }
  function infoSection(item) {
    const p = item.p;
    const sec = section('📋', '핵심 정보');
    const grid = el('div', 'info-grid');
    function box(title, content) {
      const b = el('div', 'info-box');
      b.appendChild(el('h4', 'info-title', title));
      b.appendChild(content);
      grid.appendChild(b);
    }
    box('지원 내용', clampText(p.plcySprtCn));

    // 지원 대상: 나이 + 지역 + 추가 자격
    const target = el('div');
    const ul = el('ul', 'target-list');
    ul.appendChild(el('li', null, '나이: ' + ageText(p)));
    ul.appendChild(el('li', null, '지역: ' + (regionText(p) || '공고 확인 필요')));
    target.appendChild(ul);
    if (!isBlank(p.addAplyQlfcCndCn)) {
      target.appendChild(el('p', 'info-sub', '추가 자격'));
      target.appendChild(clampText(p.addAplyQlfcCndCn));
    }
    box('지원 대상', target);

    box('신청 방법', clampText(p.plcyAplyMthdCn));
    box('운영기관', isBlank(p.operInstCdNm) ? el('p', 'empty-note', EMPTY_TEXT) : el('p', 'info-text', p.operInstCdNm.trim()));
    sec.appendChild(grid);
    return sec;
  }

  // --- 📄 제출 서류 체크리스트 ---
  // 줄바꿈 · 번호(①, 1.) · 기호(○ ❍ - •) · 쉼표 기준으로 나눔. 애매하면 null (원문 그대로 보여줌)
  function splitDocs(text) {
    if (isBlank(text)) return null;
    const src = String(text).replace(/\r/g, '');
    // "※ 증빙서류…", "* 유가족 범위…" 같은 주석 줄이 있으면 조건 설명이 섞인 글이라 나누지 않음
    if (/(^|\n)\s*[※*]/.test(src)) return null;
    const numbered = /[①-⑳]|(^|\n)\s*\d{1,2}[.)]\s/.test(src);          // ①, 1. 같은 번호 목록인지
    const hasMarker = numbered || /[○❍●•▪◦]|(^|\s)-\s/.test(src);
    const items = [];

    src.split('\n').forEach(function (line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      // 번호 목록 아래의 "- 설명" 줄은 앞 항목에 대한 설명이라 체크 항목으로 만들지 않음 (원문 보기에서 확인)
      if (numbered && /^-\s/.test(trimmed)) return;
      // 줄 안의 번호·기호 앞에서 끊기
      trimmed.split(/(?=[①-⑳])|\s(?=\d{1,2}[.)]\s)|(?:^|\s)[○❍●•▪◦]\s*|(?:^|\s)-\s+/).forEach(function (part) {
        const t = part.replace(/^[\s○❍●•▪◦\-①-⑳]+/, '').replace(/^\d{1,2}[.)]\s*/, '').trim();
        if (!t) return;
        if (hasMarker) { items.push(t); return; }
        // 기호 없이 한 줄로 나열된 글만 괄호 밖 쉼표로 나눔 ("신청서, 동의서, 등본 등")
        let depth = 0, buf = '';
        for (const ch of t) {
          if (ch === '(' || ch === '[') depth++;
          if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
          if (ch === ',' && depth === 0) { items.push(buf.trim()); buf = ''; } else buf += ch;
        }
        items.push(buf.trim());
      });
    });

    // 머리글("구비서류", "제출서류(…)", "…:")·빈 항목·중복은 뺌
    const docs = [];
    items.forEach(function (s) {
      if (!s || /^(구비|제출|필요|준비)\s*서류/.test(s) || /:$/.test(s)) return;
      if (docs.indexOf(s) === -1) docs.push(s);
    });
    if (docs.length < 2 || docs.length > 15) return null;               // 하나뿐이거나 너무 많으면 체크리스트로 보기 애매
    if (docs.some(function (s) { return s.length > 90; })) return null; // 너무 긴 문장이 섞이면 원문 그대로
    return docs;
  }

  function loadDocs(plcyNo) {
    try { return JSON.parse(sessionStorage.getItem(DOCS_KEY_PREFIX + plcyNo) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveDocs(plcyNo, state) {
    try { sessionStorage.setItem(DOCS_KEY_PREFIX + plcyNo, JSON.stringify(state)); } catch (e) { /* 저장 못 해도 화면은 동작 */ }
  }

  function docsSection(item) {
    const p = item.p;
    const sec = section('📄', '제출 서류');
    const docs = splitDocs(p.sbmsnDcmntCn);
    if (!docs) {
      sec.appendChild(isBlank(p.sbmsnDcmntCn) ? el('p', 'empty-note', EMPTY_TEXT) : clampText(p.sbmsnDcmntCn));
      return sec;
    }
    // 저장 형태: { checked: { "서류 이름": true }, updatedAt } — 6단계 관리 화면과 공유
    const state = loadDocs(p.plcyNo);
    state.checked = state.checked || {};
    const progress = el('p', 'docs-progress');
    function updateProgress() {
      const n = docs.filter(function (d) { return state.checked[d]; }).length;
      progress.textContent = docs.length + '개 중 ' + n + '개 준비했어요';
    }
    const list = el('ul', 'docs-list');
    docs.forEach(function (d, i) {
      const li = el('li');
      const id = 'doc-' + p.plcyNo + '-' + i;
      const box = el('input');
      box.type = 'checkbox';
      box.id = id;
      box.checked = !!state.checked[d];
      box.addEventListener('change', function () {
        if (box.checked) state.checked[d] = true; else delete state.checked[d];
        state.updatedAt = new Date().toISOString();
        saveDocs(p.plcyNo, state);
        updateProgress();
      });
      const label = el('label', null, d);
      label.htmlFor = id;
      li.append(box, label);
      list.appendChild(li);
    });
    updateProgress();
    sec.append(progress, list);
    sec.appendChild(el('p', 'sheet-hint', '공고 글을 자동으로 나눈 목록이에요. 체크한 내용은 이 탭을 닫으면 사라져요.'));
    // 나누면서 빠진 설명이 있을 수 있어서 원문도 접어서 함께 둠
    const raw = el('details', 'docs-raw');
    raw.appendChild(el('summary', null, '공고 원문 보기'));
    raw.appendChild(el('p', 'docs-raw-text', String(p.sbmsnDcmntCn).trim()));
    sec.appendChild(raw);
    return sec;
  }

  // --- 🗓 신청 후 단계 ---
  // data/after_steps.json 형식 (manage.js와 같이 씀):
  // { "policies": { "정책번호": { "matchNames": ["정책명 일부"], "source": "출처", "steps": [ {
  //       "id", "title", "dateType": "exact|approx|none|monthly", "dateFrom": "appliedAt", "weeks": N(approx일 때),
  //       "note", "warning", "weeklyCheck", "customDateKey", "source" } ] } },
  //   "common": { "steps": [ ... "onlyIfDocuments": true, "noteFrom": "srngMthdCn" ... ] } }
  let afterStepsPromise = null;
  function findAfterSteps(data, p) {
    if (!data || !data.policies) return null;
    if (data.policies[p.plcyNo]) return data.policies[p.plcyNo];
    // 같은 제도가 정책번호만 다르게 여러 건 있을 수 있어서 이름으로도 찾음 (예: 국민취업지원제도)
    const keys = Object.keys(data.policies);
    for (let i = 0; i < keys.length; i++) {
      const names = data.policies[keys[i]].matchNames || [];
      if (names.some(function (n) { return String(p.plcyNm).indexOf(n) !== -1; })) return data.policies[keys[i]];
    }
    return null;
  }
  function loadAfterSteps() {
    if (!afterStepsPromise) {
      afterStepsPromise = fetch(AFTER_STEPS_URL)
        .then(function (res) { return res.ok ? res.json() : null; })
        .catch(function () { return null; });   // 파일이 없으면 공통 단계만
    }
    return afterStepsPromise;
  }

  function stepsSection(item) {
    const p = item.p;
    const sec = section('🗓', '신청하면 이런 단계가 이어져요');
    const holder = el('div');
    holder.appendChild(el('p', 'sheet-hint', '불러오는 중…'));
    sec.appendChild(holder);
    sec.appendChild(el('p', 'steps-promise', '신청 후 할 일, 저희가 대신 기억하고 알려드릴게요'));

    loadAfterSteps().then(function (data) {
      const own = findAfterSteps(data, p);
      let steps, isCommon = false;
      if (own && Array.isArray(own.steps) && own.steps.length) {
        steps = own.steps;
      } else {
        isCommon = true;
        steps = (data && data.common && Array.isArray(data.common.steps)) ? data.common.steps : FALLBACK_COMMON_STEPS;
      }
      // 제출 서류가 없는 정책은 "제출 서류 준비" 단계를 빼고, noteFrom이면 정책 글을 설명으로
      steps = steps.filter(function (s) { return !(s.onlyIfDocuments && isBlank(p.sbmsnDcmntCn)); })
        .map(function (s) {
          const copy = Object.assign({}, s);
          if (copy.noteFrom && !isBlank(p[copy.noteFrom])) copy.note = String(p[copy.noteFrom]).trim();
          return copy;
        });
      holder.innerHTML = '';
      if (isCommon) holder.appendChild(el('p', 'sheet-hint', '이 정책은 아직 단계 정보를 정리하지 않아서, 일반적인 흐름을 보여드려요. 정책마다 다를 수 있어요.'));
      const ol = el('ol', 'timeline');
      steps.forEach(function (s) {
        const type = DATE_TYPE_LABEL[s.dateType] ? s.dateType : 'none';
        const li = el('li', 'tl-item');
        const head = el('div', 'tl-head');
        head.appendChild(el('span', 'tl-title', s.title));
        head.appendChild(el('span', 'tl-type ' + DATE_TYPE_CLASS[type], DATE_TYPE_LABEL[type]));
        li.appendChild(head);
        let when = '';
        if (s.dateFrom === 'appliedAt') when = '신청한 날짜';
        else if (type === 'exact' && s.date) when = s.date;
        else if (type === 'approx' && s.weeks) when = '예상: 신청 후 약 ' + s.weeks + '주';
        if (when) li.appendChild(el('p', 'tl-when', when));
        if (s.note) li.appendChild(el('p', 'tl-note', s.note));
        if (s.warning) li.appendChild(el('p', 'tl-warn', '⚠ ' + s.warning));
        ol.appendChild(li);
      });
      holder.appendChild(ol);
      const src = own && safeUrl(own.source);
      if (src) {
        const a = el('a', 'src-link', '단계 정리 출처 보기');
        a.href = src; a.target = '_blank'; a.rel = 'noopener noreferrer';
        holder.appendChild(a);
      }
    });
    return sec;
  }

  // --- 🗓️ 신청 기간 ---
  // exact → 기간 + D-day / uncertain → 회색 배지 + 안내 + [실제 접수 기간 확인]
  // 공고 글의 날짜 단서(dateHints)는 원문 문장 그대로 보여 줌 (새 날짜를 만들지 않음)
  function periodSection(item) {
    const p = item.p;
    const sec = section('🗓️', '신청 기간');
    const box = el('div', 'period-box');
    const range = formatYmd(p.aplyYmd);
    if (item.period.kind === 'always') {
      box.appendChild(el('p', 'info-text', '상시 모집'));
    } else if (item.period.exact) {
      box.appendChild(el('p', 'info-text', range + '  (' + (item.period.dDay === 0 ? '오늘 마감' : item.period.dDay + '일 남음') + ')'));
    } else {
      box.appendChild(el('span', 'dday dday-uncertain period-badge', '접수 기간 확인 필요'));
      if (range) box.appendChild(el('p', 'info-text period-raw', '공고에 적힌 기간: ' + range));
      box.appendChild(el('p', 'period-warn', '공고상 기간이 연간 사업 기간일 수 있어요. 실제 접수 기간은 신청 페이지에서 꼭 확인하세요.'));
    }
    sec.appendChild(box);

    // 신청 페이지 마감 표시 (패널을 열 때 확인, 결과가 오면 채움)
    sec.appendChild(el('div', 'closed-alerts'));

    if (p.dateHints && p.dateHints.length) {
      const hints = el('div', 'date-hints');
      hints.appendChild(el('p', 'info-sub', '공고 글에 이런 일정이 적혀 있어요:'));
      const ul = el('ul', 'hint-list');
      p.dateHints.forEach(function (h) {
        const li = el('li', null, '"' + h.text + '"');
        if (h.from) li.appendChild(el('span', 'hint-from', ' — ' + h.from));
        ul.appendChild(li);
      });
      hints.appendChild(ul);
      sec.appendChild(hints);
    }

    // AI 확인 버튼: 기간이 불확실하고, 읽어 볼 페이지(기관 첫 화면이 아닌 링크)가 있을 때만
    const readable = (p.links || []).some(function (l) { return l.kind !== 'home'; });
    if (!item.period.exact && readable) {
      const btn = el('button', 'btn-line period-check-btn', '실제 접수 기간 확인');
      btn.type = 'button';
      const out = el('div', 'period-result');
      btn.addEventListener('click', function () { checkPeriod(item, btn, out); });
      sec.append(btn, out);
    }
    return sec;
  }

  // --- 🔗 관련 링크 ---
  function linksSection(item) {
    const p = item.p;
    const sec = section('🔗', '관련 링크');
    if (p.bestLinkKind === 'home') {
      const note = el('div', 'home-note');
      note.appendChild(el('p', null, '기관 첫 화면으로 연결돼요. 정책 이름으로 검색해 주세요.'));
      const copy = el('button', 'btn-line copy-name-btn', '정책 이름 복사');
      copy.type = 'button';
      copy.addEventListener('click', function () { copyText(p.plcyNm, copy); });
      note.appendChild(copy);
      sec.appendChild(note);
    }
    const ul = el('ul', 'link-list');
    (p.links || []).forEach(function (l) {
      const url = safeUrl(l.url);
      if (!url) return;
      const li = el('li', 'link-item');
      li.dataset.url = l.url;
      const a = el('a', 'src-link', linkLabel(l));
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      li.appendChild(a);
      if (l.url === p.bestLink) li.appendChild(el('span', 'link-best', '신청하러 가기 버튼이 여는 곳'));
      ul.appendChild(li);
    });
    const yc = el('li', 'link-item');
    const ya = el('a', 'src-link', '온통청년에서 보기');
    ya.href = YOUTHCENTER_URL + encodeURIComponent(p.plcyNo);
    ya.target = '_blank'; ya.rel = 'noopener noreferrer';
    yc.appendChild(ya);
    ul.appendChild(yc);
    sec.appendChild(ul);
    sec.appendChild(el('p', 'sheet-hint', '정보는 온통청년 공공데이터 기준이에요. 신청 전 공식 공고를 꼭 확인하세요.'));
    return sec;
  }

  function copyText(text, btn) {
    function done(ok) {
      btn.textContent = ok ? '복사했어요' : '복사하지 못했어요';
      setTimeout(function () { btn.textContent = '정책 이름 복사'; }, 1800);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
    } else done(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  // --- 신청 페이지 마감 표시 확인 (/api/check-link, AI 안 씀) ---
  // 결과는 이 화면을 연 동안만 기억 (기기에 저장하지 않음). closed_hint만 화면에 보여 줌
  const linkChecks = {};   // plcyNo → results
  function postJson(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) { return { status: res.status, data: data }; });
      });
  }
  function checkLinks(item) {
    const p = item.p;
    if (!(p.links || []).some(function (l) { return l.kind === 'detail'; })) return;
    showLinkChecks(item);                       // 먼저 미리 점검한 결과를 보여 주고
    if (linkChecks[p.plcyNo]) return;           // 이 화면에서 이미 실시간으로 확인했으면 다시 안 부름
    postJson('api/check-link', { plcyNo: p.plcyNo }).then(function (r) {
      if (r.status !== 200 || !r.data || !r.data.ok) return;   // 확인하지 못하면 미리 점검한 결과를 그대로 둠
      const before = closedKey(p);
      // 실시간 결과로 바꿈. 단, 지금 못 읽은 링크(unknown)는 미리 점검한 결과를 유지
      const pre = p.linkStatus && Array.isArray(p.linkStatus.links) ? p.linkStatus.links : [];
      linkChecks[p.plcyNo] = (r.data.results || []).map(function (x) {
        if (x.result !== 'unknown') return x;
        return pre.find(function (y) { return y.url === x.url; }) || x;
      });
      if (closedKey(p) === before) { showLinkChecks(item); return; }   // 같으면 "미리 점검" 안내만 지움
      showLinkChecks(item);
      onLinkChecked(item);   // 미리 점검한 결과와 다를 때만 여기까지 옴
    }).catch(function () { /* 표시하지 않음 */ });
  }
  // 마감 표시: 패널에서 방금 확인한 결과가 있으면 그것, 없으면 데이터 수집 때 미리 점검한 결과(linkStatus)
  function linkResultsOf(p) {
    if (linkChecks[p.plcyNo]) return linkChecks[p.plcyNo];
    return p.linkStatus && Array.isArray(p.linkStatus.links) ? p.linkStatus.links : [];
  }
  function closedOf(p) {
    return linkResultsOf(p).filter(function (x) { return x.result === 'closed_hint'; });
  }
  function closedKey(p) { return closedOf(p).map(function (x) { return x.url; }).join('|'); }
  function showLinkChecks(item) {
    if (sheet.hidden || currentItem !== item) return;
    const box = sheetBody.querySelector('.closed-alerts');
    if (!box) return;
    box.innerHTML = '';
    sheetBody.querySelectorAll('.link-closed').forEach(function (n) { n.remove(); });
    closedOf(item.p).forEach(function (x) {   // no_hint · unknown은 표시하지 않음
      const line = el('p', 'closed-alert', '신청 페이지에 마감 표시가 보여요 (' + (LINK_ROLE_LABEL[x.role] || '링크') + ')');
      if (x.snippet) line.appendChild(el('span', 'closed-snippet', '페이지 글: "' + x.snippet + '"'));
      if (!linkChecks[item.p.plcyNo] && item.p.linkStatus && item.p.linkStatus.checkedAt) {
        line.appendChild(el('span', 'closed-snippet', item.p.linkStatus.checkedAt.slice(0, 10) + ' 미리 점검한 결과예요'));
      }
      box.appendChild(line);
      const li = Array.prototype.find.call(sheetBody.querySelectorAll('.link-item'), function (n) { return n.dataset.url === x.url; });
      if (li && !li.querySelector('.link-closed')) li.appendChild(el('span', 'link-closed', '마감 표시 있음'));
    });
  }

  // --- 실제 접수 기간 확인 (/api/check-period, 버튼을 눌렀을 때만 AI 호출) ---
  const STATUS_CLASS = { '접수중': 'ps-open', '마감': 'ps-closed', '알 수 없음': 'ps-unknown' };
  const PERIOD_FAIL = '신청 페이지를 읽을 수 없어요. 링크에서 직접 확인해 주세요.';
  function checkPeriod(item, btn, out) {
    btn.disabled = true;
    btn.textContent = '신청 페이지를 읽는 중…';
    out.innerHTML = '';
    function failed(message) {
      out.appendChild(el('p', 'period-fail', message || PERIOD_FAIL));
      btn.disabled = false;
      btn.textContent = '실제 접수 기간 확인';
    }
    postJson('api/check-period', { plcyNo: item.p.plcyNo }).then(function (r) {
      if (r.status === 200 && r.data && r.data.ok) {
        renderPeriodResults(out, r.data.results || []);
        btn.hidden = true;
      } else failed(r.data && r.data.message);
    }).catch(function () { failed(); });
  }
  function ymdDot(s) { return s ? s.replace(/-/g, '.') : '?'; }
  function renderPeriodResults(out, results) {
    out.appendChild(el('p', 'period-ai-note', 'AI가 신청 페이지를 읽고 정리한 내용이에요. 근거 문장을 꼭 확인하세요.'));
    results.forEach(function (x) {
      const box = el('div', 'period-card');
      const head = el('div', 'period-card-head');
      head.appendChild(el('strong', null, LINK_ROLE_LABEL[x.role] || '링크'));
      head.appendChild(el('span', 'ps ' + (STATUS_CLASS[x.status] || 'ps-unknown'), x.status || '알 수 없음'));
      box.appendChild(head);
      box.appendChild(el('p', 'info-text', x.start || x.end ? '접수 기간: ' + ymdDot(x.start) + ' ~ ' + ymdDot(x.end) : '접수 기간: 페이지에서 찾지 못했어요'));
      if (x.periodEvidence) box.appendChild(el('p', 'period-evidence', '근거: "' + x.periodEvidence + '"'));
      if (x.statusEvidence) box.appendChild(el('p', 'period-evidence', '상태 근거: "' + x.statusEvidence + '"'));
      if (x.note) box.appendChild(el('p', 'sheet-hint', x.note));
      out.appendChild(box);
    });
  }

  function openSheet(item, opener) {
    const p = item.p;
    clearTimeout(closeTimer);
    lastOpener = opener || null;

    badgesInto($('sheet-badges'), item);
    $('sheet-title').textContent = p.plcyNm;
    $('sheet-desc').textContent = p.plcyExplnCn || '';

    sheetBody.innerHTML = '';
    currentItem = item;
    sheetBody.append(matchSection(item), periodSection(item), infoSection(item), docsSection(item), stepsSection(item), linksSection(item));
    sheetBody.scrollTop = 0;

    const apply = $('sheet-apply');
    const url = applyUrl(p);
    apply.hidden = !url;
    if (url) apply.href = url;
    $('sheet-done').href = 'manage.html?plcyNo=' + encodeURIComponent(p.plcyNo);

    backdrop.hidden = false;
    sheet.hidden = false;
    document.body.classList.add('sheet-open');
    void sheet.offsetWidth;            // 애니메이션 시작점
    backdrop.classList.add('open');
    sheet.classList.add('open');
    $('sheet-close').focus();
    requestAnimationFrame(measureClamps);
    checkLinks(item);
  }

  function closeSheet() {
    if (sheet.hidden) return;
    sheet.classList.remove('open');
    backdrop.classList.remove('open');
    document.body.classList.remove('sheet-open');
    closeTimer = setTimeout(function () {
      sheet.hidden = true;
      backdrop.hidden = true;
    }, 320);
    if (lastOpener) lastOpener.focus();
  }

  $('sheet-close').addEventListener('click', closeSheet);
  backdrop.addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) {
    if (sheet.hidden) return;
    if (e.key === 'Escape') { closeSheet(); return; }
    // Tab 키가 패널 밖으로 나가지 않게
    if (e.key === 'Tab') {
      const focusables = Array.prototype.filter.call(
        sheet.querySelectorAll('a[href], button, input, [tabindex]:not([tabindex="-1"])'),
        function (n) { return !n.hidden && n.offsetParent !== null; });
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('resize', function () { if (!sheet.hidden) measureClamps(); });

  // ===== 9. 알림 메일 즉시 발송 (서버 기능 /api/send-alert) =====
  const EMAIL_RE = /^[^\s@<>"',;:()\[\]\\]+@[^\s@<>"',;:()\[\]\\]+\.[A-Za-z]{2,}$/;
  const SEND_COOLDOWN = 30;          // 보낸 뒤 30초 동안 버튼을 막아 반복 요청 방지
  const APPS_SUMMARY_KEY = 'myApplicationsSummary';   // manage.js가 저장하는 "지금 할 일" 요약
  const notifyBtn = document.querySelector('.notify-btn');
  let sending = false;

  function policyForMail(item) {
    const p = item.p;
    return {
      name: p.plcyNm,
      dDay: item.period.kind === 'open' ? item.period.dDay : null,
      period: item.period.kind === 'open' || item.period.kind === 'always' ? item.period.kind : 'unknown',
      level: item.tier === 'perfect' ? 'ok' : 'check',
      url: applyUrl(p) || YOUTHCENTER_URL + encodeURIComponent(p.plcyNo),
    };
  }
  function applicationsForMail() {
    try {
      const list = JSON.parse(sessionStorage.getItem(APPS_SUMMARY_KEY) || '[]');
      return Array.isArray(list) ? list.slice(0, 10) : [];
    } catch (e) { return []; }
  }

  // 버튼 30초 막기 (남은 시간 표시)
  function cooldown(seconds) {
    let left = seconds;
    notifyBtn.disabled = true;
    notifyBtn.textContent = '다시 보내기 ' + left + '초';
    const timer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        notifyBtn.disabled = false;
        notifyBtn.textContent = '알림 받기';
      } else {
        notifyBtn.textContent = '다시 보내기 ' + left + '초';
      }
    }, 1000);
  }

  $('notify-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (sending || notifyBtn.disabled) return;
    const input = $('notify-email');
    const msg = $('notify-msg');
    const email = input.value.trim();
    msg.className = 'notify-msg';
    if (!$('ch-email').checked) {
      msg.textContent = '알림 받을 방법을 골라 주세요.';
      msg.classList.add('error');
      return;
    }
    if (!EMAIL_RE.test(email) || email.length > 254) {
      msg.textContent = '이메일 주소를 다시 확인해 주세요. (예: name@example.com)';
      msg.classList.add('error');
      input.focus();
      return;
    }

    // 메일에는 안 맞는 조건이 없는 정책(딱 맞아요 + 확인 필요)만. 마감 임박은 접수 기간이 확실한 것만
    const fits = shown.filter(function (x) { return x.tier === 'perfect' || x.tier === 'check'; });
    const urgent = fits.filter(function (x) { return x.period.exact && x.period.kind === 'open' && x.period.dDay <= 7; })
      .slice().sort(function (a, b) { return a.period.dDay - b.period.dDay; }).slice(0, 5);
    const payload = {
      email: email,
      urgentPolicies: urgent.map(policyForMail),
      topPolicies: fits.filter(function (x) { return x.tier === 'perfect'; }).concat(fits.filter(function (x) { return x.tier === 'check'; })).slice(0, 5).map(policyForMail),
      applications: applicationsForMail(),
    };

    sending = true;
    notifyBtn.disabled = true;
    notifyBtn.textContent = '보내는 중…';
    msg.textContent = '';
    fetch('api/send-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) { return { status: res.status, data: data }; });
      })
      .then(function (r) {
        if (r.status === 200 && r.data && r.data.ok) {
          msg.textContent = '메일을 보냈어요! 받은편지함(또는 스팸함)을 확인해 주세요';
          msg.classList.add('success');
        } else if (r.status === 404 || r.status === 405 || r.status === 501) {
          msg.textContent = '메일 서버 기능을 찾지 못했어요. "npm run dev"로 켠 주소(또는 배포 주소)에서 열었는지 확인해 주세요.';
          msg.classList.add('error');
        } else {
          msg.textContent = (r.data && r.data.message) || '메일을 보내지 못했어요. 잠시 후 다시 시도해 주세요.';
          msg.classList.add('error');
        }
      })
      .catch(function () {
        msg.textContent = '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.';
        msg.classList.add('error');
      })
      .then(function () {
        sending = false;
        cooldown(SEND_COOLDOWN);   // 성공·실패와 관계없이 30초 뒤에 다시 보낼 수 있음
      });
  });

  // ===== 10. 이벤트 =====
  tabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      currentTab = btn.dataset.tab;
      Object.keys(tierState).forEach(function (k) { tierState[k].visible = PAGE_SIZE; });
      renderTabs();
      renderList();
    });
  });

  // ===== 11. 시작: 정책 데이터 불러오기 =====
  fetch(DATA_URL)
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      prepare(data.policies || []);
      renderSummary();
      renderTabs();
      renderList();
      if (data.baseDate) {
        $('data-note').textContent = '정책 정보는 ' + data.baseDate + ' 온통청년 기준이에요. 입력한 조건으로 대략 거른 결과라, 신청 전에 원문에서 자격을 꼭 확인해 주세요.';
      }
    })
    .catch(function () {
      $('summary-title').textContent = '정책 정보를 불러오지 못했어요';
      $('summary-sub').textContent = '파일을 더블클릭해서 열었다면 정책 데이터를 읽을 수 없어요. 로컬 서버(http://localhost)로 열어 주세요.';
      $('summary-hidden').textContent = '';
    });
})();
