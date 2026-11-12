/* =========================================================
   맞춤 정책 결과 (PRD F3)
   - sessionStorage "userProfile"(설문 답변) + data/policies.json(정책)을 읽어서
   - 정책마다 7가지 조건을 판정 → 조건 일치 / 추가 확인 필요 / 해당 없음(숨김)
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
  const DOCS_KEY_PREFIX = 'docChecklist:';           // 제출 서류 체크 상태 (localStorage, 정책번호별)
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

  // ----- 오른쪽 위 [내 신청 관리 (N)] — localStorage "myApplications"에 기록이 있을 때만 -----
  function updateManageButton() {
    let n = 0;
    try {
      const data = JSON.parse(localStorage.getItem('myApplications') || 'null');
      n = data && data.items ? Object.keys(data.items).length : 0;
    } catch (e) { n = 0; }
    const btn = document.getElementById('btn-manage');
    btn.hidden = n === 0;
    btn.textContent = '내 신청 관리 (' + n + ')';
  }
  updateManageButton();
  window.addEventListener('pageshow', updateManageButton);   // 관리 화면에서 뒤로 가기로 돌아왔을 때

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
  function row(label, r, free, policyText, userText, reason) {
    return { label: label, r: r, free: !!free, policyText: policyText, userText: userText, reason: reason || '' };
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
    return row('나이', (user.ageMin <= pMax && user.ageMax >= pMin) ? 'ok' : 'no', false, ageText(p), u);
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

  // 2. 지역
  function ruleRegion(p) {
    const u = user.sido;
    if (p.pvsnInstGroupCd === CODE.CENTRAL) return row('지역', 'ok', true, '전국 (중앙부처 정책)', u);
    const list = codes(p.zipCd);
    if (!list.length) return row('지역', 'check', false, '공고 확인 필요', u, '지역 조건 확인 필요');
    const match = list.some(function (c) { return c.slice(0, 2) === user.sidoCode; });
    return row('지역', match ? 'ok' : 'no', regionText(p) === '전국', regionText(p), u);
  }

  // 3. 학력
  function ruleSchool(p) {
    const u = user.education + ' · ' + user.schoolStatus;
    const list = codes(p.schoolCd);
    if (!list.length || list.indexOf(CODE.SCHOOL_ANY) !== -1) return row('학력', 'ok', true, '학력 제한 없음', u);
    return row('학력', list.indexOf(user.schoolCd) !== -1 ? 'ok' : 'no', false, namesOf(list, SCHOOL_NAME), u);
  }

  // 4. 취업 상태
  function ruleJob(p) {
    const u = user.jobStatus;
    const list = codes(p.jobCd);
    if (!list.length) return row('취업 상태', 'check', false, '공고 확인 필요', u, '취업 상태 조건 확인 필요');
    if (list.indexOf(CODE.JOB_ANY) !== -1) return row('취업 상태', 'ok', true, '취업 상태 제한 없음', u);
    return row('취업 상태', list.indexOf(user.jobCd) !== -1 ? 'ok' : 'no', false, namesOf(list, JOB_NAME), u);
  }

  // 5. 전공 (고등학교를 고르면 전공 질문이 없어서 plcyMajorCd = null)
  function ruleMajor(p) {
    const u = user.major || '질문 안 함 (고등학교)';
    const list = codes(p.plcyMajorCd);
    if (!list.length || list.indexOf(CODE.MAJOR_ANY) !== -1) return row('전공', 'ok', true, '전공 제한 없음', u);
    const match = !!user.plcyMajorCd && list.indexOf(user.plcyMajorCd) !== -1;
    return row('전공', match ? 'ok' : 'no', false, namesOf(list, MAJOR_NAME), u);
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
      if (user.incomeMin === null || user.incomeMin === undefined) return row('소득', 'check', false, pText, u, '소득 조건 확인 필요');
      const uMax = user.incomeMax === null || user.incomeMax === undefined ? Infinity : user.incomeMax;
      return row('소득', (user.incomeMin <= pMax && uMax >= pMin) ? 'ok' : 'no', false, pText, u);
    }
    if (code === CODE.EARN_ETC) {
      const pText = isBlank(p.earnEtcCn) ? '기타 소득 조건 (공고 확인)' : String(p.earnEtcCn).trim();
      return row('소득', 'check', false, pText, u, '소득 조건 확인 필요 — 가구 소득 기준일 수 있어요');
    }
    return row('소득', 'check', false, '공고 확인 필요', u, '소득 조건 확인 필요');
  }

  // 7. 실업급여 — 국민취업지원제도일 때만 표에 나옴
  function ruleBenefit(p) {
    if (String(p.plcyNm).indexOf('국민취업지원제도') === -1) return null;
    const u = user.unemploymentBenefit;
    if (u === '예') return row('실업급여', 'check', false, '실업급여 수급 여부에 따라 참여가 달라질 수 있음', u, '실업급여 받는 중에는 참여가 제한될 수 있어요');
    return row('실업급여', 'ok', false, '실업급여 수급 여부에 따라 참여가 달라질 수 있음', u);
  }

  const RULES = [ruleAge, ruleRegion, ruleSchool, ruleJob, ruleMajor, ruleIncome, ruleBenefit];

  // 하나라도 불일치 → 숨김 / 확인 필요가 있으면 → 추가 확인 필요 / 전부 일치 → 조건 일치
  // rows는 상세 패널의 "나랑 맞는지" 표에 그대로 씀
  function judge(p) {
    const rows = [], reasons = [];
    let level = 'ok';
    RULES.forEach(function (rule) {
      const res = rule(p);
      if (!res) return;
      rows.push(res);
      if (res.r === 'no') level = 'no';
      else if (res.r === 'check') {
        if (level !== 'no') level = 'check';
        if (reasons.indexOf(res.reason) === -1) reasons.push(res.reason);
      }
    });
    return { level: level, reasons: level === 'no' ? [] : reasons, rows: rows };
  }

  // ===== 5. 신청 기간 (오늘 기준으로 D-day 다시 계산) =====
  function todayDate() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  // policies.json을 받은 뒤 날짜가 지났을 수 있어서, 화면을 연 날 기준으로 다시 계산
  function periodOf(p, today) {
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
  let shown = [];        // 화면에 보여줄 정책 (조건 일치 + 추가 확인 필요)
  let hiddenCount = 0;   // 조건이 안 맞아 숨긴 정책
  let currentTab = 'all';
  let visibleCount = PAGE_SIZE;

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
    let hidden = 0, expired = 0;
    policies.forEach(function (p) {
      const period = periodOf(p, today);
      if (period.kind === 'expired') { expired++; return; }   // 받은 뒤 마감된 정책은 뺌
      const j = judge(p);
      if (j.level === 'no') { hidden++; return; }
      const tabs = [];
      (p.categories || []).forEach(function (c) {
        const t = tabOf(c);
        if (t && tabs.indexOf(t) === -1) tabs.push(t);
      });
      result.push({ p: p, level: j.level, reasons: j.reasons, rows: j.rows, period: period, tabs: tabs });
    });

    // 정렬: 조건 일치 먼저 → D-day 임박 순 → 기간 확인 필요 → 상시는 뒤로
    const periodRank = { open: 0, unknown: 1, always: 2 };
    result.sort(function (a, b) {
      if (a.level !== b.level) return a.level === 'ok' ? -1 : 1;
      if (a.period.kind !== b.period.kind) return periodRank[a.period.kind] - periodRank[b.period.kind];
      if (a.period.kind === 'open' && a.period.dDay !== b.period.dDay) return a.period.dDay - b.period.dDay;
      return String(a.p.plcyNm).localeCompare(String(b.p.plcyNm), 'ko');
    });

    shown = result;
    hiddenCount = hidden;
    // 확인용 (개발자 도구 콘솔에서 window.__resultStats 로 볼 수 있음)
    window.__resultStats = {
      ok: result.filter(function (x) { return x.level === 'ok'; }).length,
      check: result.filter(function (x) { return x.level === 'check'; }).length,
      hidden: hidden,
      expiredSinceFetch: expired,
    };
  }

  // ===== 7. 목록 그리기 =====
  const $ = function (id) { return document.getElementById(id); };
  const listEl = $('policy-list');
  const moreBtn = $('btn-more');
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
    const ok = window.__resultStats.ok, check = window.__resultStats.check;
    $('summary-title').innerHTML = '';
    $('summary-title').append('조건에 맞는 정책 ', el('strong', 'accent', (ok + check) + '개'), '를 찾았어요');
    $('summary-sub').textContent = '조건 일치 ' + ok + '개 · 추가 확인 필요 ' + check + '개';
    $('summary-hidden').textContent = '조건이 안 맞아 숨긴 정책 ' + hiddenCount + '개';
  }

  function renderTabs() {
    tabButtons.forEach(function (btn) {
      const tab = btn.dataset.tab;
      const n = tab === 'all' ? shown.length : shown.filter(function (x) { return x.tabs.indexOf(tab) !== -1; }).length;
      btn.querySelector('.tab-count').textContent = n;
      btn.setAttribute('aria-selected', String(tab === currentTab));
    });
  }

  // 신청 링크: aplyUrlAddr → 없으면 refUrlAddr1. http(s) 주소만 사용
  function safeUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return null;
    if (/^www\./i.test(u)) u = 'https://' + u;    // "www.xxx.kr" 처럼 앞부분이 빠진 주소 보정
    return /^https?:\/\//i.test(u) ? u : null;
  }
  function applyUrl(p) {
    return safeUrl(p.aplyUrlAddr) || safeUrl(p.refUrlAddr1);
  }

  function ddayBadge(period) {
    if (period.kind === 'always') return el('span', 'dday dday-always', '상시');
    if (period.kind === 'unknown') return el('span', 'dday', '기간 확인 필요');
    const d = period.dDay;
    return el('span', 'dday' + (d <= URGENT_DAYS ? ' dday-urgent' : ''), d === 0 ? 'D-Day' : 'D-' + d);
  }

  function badgesInto(box, item) {
    box.innerHTML = '';
    item.tabs.forEach(function (t) { box.appendChild(el('span', 'tag', TAB_LABEL[t])); });
    box.appendChild(item.level === 'ok' ? el('span', 'badge badge-ok', '조건 일치') : el('span', 'badge badge-check', '추가 확인 필요'));
    box.appendChild(ddayBadge(item.period));
  }

  function card(item) {
    const p = item.p;
    const art = el('article', 'pcard');

    const top = el('div', 'pcard-top');
    badgesInto(top, item);
    art.appendChild(top);

    art.appendChild(el('h2', 'pcard-title', p.plcyNm));
    art.appendChild(el('p', 'pcard-desc', p.plcyExplnCn || p.plcySprtCn || ''));

    if (item.reasons.length) {
      const ul = el('ul', 'reasons');
      item.reasons.forEach(function (r) { ul.appendChild(el('li', null, r)); });
      art.appendChild(ul);
    }

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

  function renderList() {
    const items = filtered();
    listEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    items.slice(0, visibleCount).forEach(function (item) { frag.appendChild(card(item)); });
    listEl.appendChild(frag);
    $('list-empty').hidden = items.length > 0;
    updateMoreButton(items);
  }

  // [더 보기]: 이미 그린 카드는 그대로 두고 뒤에 20개만 추가
  function showMore() {
    const items = filtered();
    const frag = document.createDocumentFragment();
    items.slice(visibleCount, visibleCount + PAGE_SIZE).forEach(function (item) { frag.appendChild(card(item)); });
    visibleCount += PAGE_SIZE;
    listEl.appendChild(frag);
    updateMoreButton(items);
  }

  function updateMoreButton(items) {
    moreBtn.hidden = items.length <= visibleCount;
    if (!moreBtn.hidden) moreBtn.textContent = '더 보기 (' + (items.length - visibleCount) + '개 남음)';
  }

  // ===== 8. 상세 패널 =====
  const sheet = $('sheet');
  const backdrop = $('sheet-backdrop');
  const sheetBody = $('sheet-body');
  let lastOpener = null;
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
        if (r.reason) res.appendChild(el('span', 'mr-reason', r.reason.replace(/^.*— /, '')));
      } else if (r.r === 'no') {
        res.appendChild(el('span', 'mr mr-no', '✕ 안 맞음'));
      } else if (r.free) {
        res.appendChild(el('span', 'mr mr-free', '제한 없음'));
      } else {
        res.appendChild(el('span', 'mr mr-ok', '✓ 일치'));
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

    // 신청 기간
    let period;
    if (item.period.kind === 'always') period = '상시 모집';
    else if (formatYmd(p.aplyYmd)) period = formatYmd(p.aplyYmd) + (item.period.kind === 'open' ? '  (' + (item.period.dDay === 0 ? '오늘 마감' : item.period.dDay + '일 남음') + ')' : '');
    else period = '';
    box('신청 기간', isBlank(period) ? el('p', 'empty-note', EMPTY_TEXT) : el('p', 'info-text', period));

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
    try { return JSON.parse(localStorage.getItem(DOCS_KEY_PREFIX + plcyNo) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveDocs(plcyNo, state) {
    try { localStorage.setItem(DOCS_KEY_PREFIX + plcyNo, JSON.stringify(state)); } catch (e) { /* 저장 못 해도 화면은 동작 */ }
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
    sec.appendChild(el('p', 'sheet-hint', '공고 글을 자동으로 나눈 목록이에요. 체크한 내용은 이 기기에 저장돼요.'));
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

  // --- 🔗 출처 ---
  function sourceSection(item) {
    const p = item.p;
    const sec = section('🔗', '출처');
    const links = el('div', 'src-links');
    const ref = safeUrl(p.refUrlAddr1);
    if (ref) {
      const a = el('a', 'src-link', '원문 공고 보기');
      a.href = ref; a.target = '_blank'; a.rel = 'noopener noreferrer';
      links.appendChild(a);
    }
    const yc = el('a', 'src-link', '온통청년에서 보기');
    yc.href = YOUTHCENTER_URL + encodeURIComponent(p.plcyNo);
    yc.target = '_blank'; yc.rel = 'noopener noreferrer';
    links.appendChild(yc);
    sec.appendChild(links);
    sec.appendChild(el('p', 'sheet-hint', '정보는 온통청년 공공데이터 기준이에요. 신청 전 공식 공고를 꼭 확인하세요.'));
    return sec;
  }

  function openSheet(item, opener) {
    const p = item.p;
    clearTimeout(closeTimer);
    lastOpener = opener || null;

    badgesInto($('sheet-badges'), item);
    $('sheet-title').textContent = p.plcyNm;
    $('sheet-desc').textContent = p.plcyExplnCn || '';

    sheetBody.innerHTML = '';
    sheetBody.append(matchSection(item), infoSection(item), docsSection(item), stepsSection(item), sourceSection(item));
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
      level: item.level,
      url: applyUrl(p) || YOUTHCENTER_URL + encodeURIComponent(p.plcyNo),
    };
  }
  function applicationsForMail() {
    try {
      const list = JSON.parse(localStorage.getItem(APPS_SUMMARY_KEY) || '[]');
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

    const urgent = shown.filter(function (x) { return x.period.kind === 'open' && x.period.dDay <= 7; })
      .slice().sort(function (a, b) { return a.period.dDay - b.period.dDay; }).slice(0, 5);
    const payload = {
      email: email,
      urgentPolicies: urgent.map(policyForMail),
      topPolicies: shown.slice(0, 5).map(policyForMail),
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
      visibleCount = PAGE_SIZE;
      renderTabs();
      renderList();
    });
  });
  moreBtn.addEventListener('click', showMore);

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
