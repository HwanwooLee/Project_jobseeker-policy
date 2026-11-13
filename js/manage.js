/* =========================================================
   신청 후 관리 (PRD F4)
   - result.html [신청했어요] → manage.html?plcyNo=정책번호
   - 신청 날짜 입력 → 단계 체크리스트(세로 타임라인) 생성
   - 신청한 정책 여러 개를 함께 관리, "지금 할 일" 1개를 맨 위에 크게
   - 저장 원칙: 이 기기에는 아무것도 영구 저장하지 않음
       · 관리 기록은 sessionStorage "myApplications" (탭을 닫으면 사라짐)
       · 개인 기록은 본인 메일의 [관리 화면 열기] 링크(d+sig)로만 다시 열림 → api/restore-plan.js
       · 이메일 주소는 어디에도 저장하지 않음 (입력칸도 미리 채우지 않음)
       · 화면에서 바꾼 내용은 [관리 메일 다시 받기]를 눌러야 새 메일 링크에 담김
     제출 서류 체크는 상세 패널과 같은 키 "docChecklist:정책번호" (sessionStorage)
   ※ data/*.json을 fetch로 읽기 때문에 로컬 서버(http://localhost)로 열어야 함
   ========================================================= */
(function () {
  'use strict';

  // ===== 1. 설정 =====
  const APPS_KEY = 'myApplications';
  const DOCS_KEY_PREFIX = 'docChecklist:';
  const DATA_URL = 'data/policies.json';
  const AFTER_STEPS_URL = 'data/after_steps.json';
  const YOUTHCENTER_URL = 'https://www.youthcenter.go.kr/youthPolicy/ythPlcyTotalSearch/ythPlcyDetail/';
  const WEEKLY_DAYS = 7;         // "결과 안내 받으셨나요?"를 다시 묻는 간격
  const SOON_DAYS = 7;           // 이 날짜 안에 있는 일정은 "지금 할 일"에서 가장 먼저

  const DATE_TYPE_LABEL = { exact: '정확한 날짜', estimated: '예상 날짜', approx: '예상', none: '날짜 미정', monthly: '매월 반복' };
  const DATE_TYPE_CLASS = { exact: 'tl-exact', estimated: 'tl-estimate', approx: 'tl-estimate', none: 'tl-unknown', monthly: 'tl-monthly' };
  const ESTIMATED_NOTE = '문자에 월이 없어 가장 가까운 날짜로 정했어요';
  const CUSTOM_DATES = [
    { key: 'docDeadline', label: '서류 제출 기한', stepTitle: '서류 제출 기한' },
    { key: 'resultDate', label: '결과 발표일', stepTitle: '결과 발표' },
  ];
  // after_steps.json을 못 읽었을 때 쓰는 공통 단계 (파일의 common과 같은 내용)
  const FALLBACK_COMMON = [
    { id: 'applied', title: '신청 완료', dateType: 'exact', dateFrom: 'appliedAt' },
    { id: 'documents', title: '제출 서류 준비', dateType: 'none', onlyIfDocuments: true, customDateKey: 'docDeadline', note: '보완 요청이 오면 안내 받은 기한 안에 다시 내야 해요' },
    { id: 'result', title: '결과 발표 확인', dateType: 'none', weeklyCheck: '결과 안내 받으셨나요?', customDateKey: 'resultDate', noteFrom: 'srngMthdCn' },
    { id: 'after', title: '선정 후 안내 사항 확인', dateType: 'none', note: '선정되면 받은 안내에 따라 다음 할 일을 진행해요' },
  ];

  // ===== 2. 날짜 도구 (모두 이 기기 시간 기준, "YYYY-MM-DD" 문자열) =====
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  function today() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function daysFromToday(s) { const d = parseYmd(s); return d ? Math.round((d - today()) / 86400000) : null; }
  function thisMonth() { const d = today(); return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function monthDay(s) { const d = parseYmd(s); return d ? (d.getMonth() + 1) + '월 ' + d.getDate() + '일' : ''; }
  function prettyDate(s) {
    const d = parseYmd(s);
    if (!d) return '';
    return d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate()) + ' (' + '일월화수목금토'[d.getDay()] + ')';
  }
  function ddayText(n) {
    if (n === null) return '';
    if (n === 0) return '오늘';
    return n > 0 ? 'D-' + n : (-n) + '일 지남';
  }

  // ===== 3. 저장 / 불러오기 (sessionStorage — 이 탭에서만, 탭을 닫으면 사라짐) =====
  // myApplications = { version: 1, items: { 정책번호: {
  //   plcyNo, plcyNm, appliedAt, startedAt, snapshot,
  //   steps: { 단계id: { done, doneAt, doneMonths: ["2026-11"], lastCheckedAt } },
  //   customDates: { docDeadline: "YYYY-MM-DD", resultDate: "YYYY-MM-DD" },
  //   changed: 마지막 메일 이후 바뀐 내용이 있는지, mailedAt: 이 탭에서 관리 메일을 보낸 시각 } } }
  function loadApps() {
    try {
      const data = JSON.parse(sessionStorage.getItem(APPS_KEY) || 'null');
      if (data && data.items && typeof data.items === 'object') return data;
    } catch (e) { /* 깨진 값이면 새로 시작 */ }
    return { version: 1, items: {} };
  }
  function saveApps() {
    try {
      sessionStorage.setItem(APPS_KEY, JSON.stringify(apps));
      return true;
    } catch (e) {
      showLoadMsg('브라우저 저장 기능이 막혀 있어서 기록을 저장하지 못했어요.', true);
      return false;
    }
  }
  // 화면에서 바꾼 내용이 있음 → [관리 메일 다시 받기]를 눌러야 메일 링크에 담긴다는 안내를 띄움
  function markChanged(app) {
    if (app) app.changed = true;
  }
  function loadDocs(plcyNo) {
    try { return JSON.parse(sessionStorage.getItem(DOCS_KEY_PREFIX + plcyNo) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveDocs(plcyNo, state) {
    try { sessionStorage.setItem(DOCS_KEY_PREFIX + plcyNo, JSON.stringify(state)); } catch (e) { /* 무시 */ }
  }

  let apps = loadApps();
  let policyByNo = {};
  let afterData = null;
  let dataLoaded = false;   // policies.json을 읽었는지 (못 읽었으면 "목록에서 빠짐" 안내를 하지 않음)

  // ----- 정책 스냅샷: [관리 시작] 때 정책 정보를 신청 기록에 통째로 복사해 둠 -----
  // → 나중에 마감돼서 policies.json에서 빠져도 관리 화면이 그대로 보임
  const SNAPSHOT_FIELDS = ['plcyNm', 'operInstCdNm', 'aplyUrlAddr', 'refUrlAddr1', 'plcyExplnCn', 'plcySprtCn',
    'aplyYmd', 'status', 'aplyEndDate', 'sbmsnDcmntCn', 'srngMthdCn', 'categories', 'pvsnInstGroupCd'];
  function makeSnapshot(p) {
    const s = {};
    SNAPSHOT_FIELDS.forEach(function (k) { if (p[k] !== undefined && p[k] !== null && p[k] !== '') s[k] = p[k]; });
    s.savedAt = ymd(today());
    return s;
  }
  // 신청할 때 저장한 정보가 먼저, 스냅샷에 없는 항목(메일 링크로 복원한 경우 제출 서류 등)은 최신 목록에서 채움
  function policyOf(no) {
    const app = apps.items[no];
    const snap = app && app.snapshot, latest = policyByNo[no];
    if (snap && latest) return Object.assign({}, latest, snap);
    return snap || latest || null;
  }

  // 메일의 [관리 화면 열기] 복원 링크에 넣을 관리 기록 (이메일 주소는 빼고 보냄 — 서버에서도 허용 항목만 씀)
  const LINK_SNAPSHOT_FIELDS = ['plcyNm', 'operInstCdNm', 'aplyUrlAddr', 'refUrlAddr1', 'plcyExplnCn', 'aplyYmd', 'status', 'aplyEndDate'];
  function recordForLink(app) {
    const snap = {};
    const p = policyOf(app.plcyNo) || {};
    LINK_SNAPSHOT_FIELDS.forEach(function (k) { if (p[k]) snap[k] = p[k]; });
    return {
      plcyNo: app.plcyNo, plcyNm: app.plcyNm, appliedAt: app.appliedAt,
      steps: app.steps || {}, customDates: app.customDates || {}, stepDates: app.stepDates || {},
      dateEvidence: app.dateEvidence || {}, extraSteps: app.extraSteps || [], snapshot: snap,
      stepNotes: app.stepNotes || {},   // 단계별 요약·항목(서류·할 일 등)과 체크 상태
      dateEstimated: app.dateEstimated || {},   // 문자에 월이 없어 가장 가까운 날로 정한 날짜
      docChecked: Object.keys(loadDocs(app.plcyNo).checked || {}),   // 제출 서류 체크 (링크가 길면 서버가 가장 먼저 뺌)
    };
  }

  // ===== 4. 글 도구 =====
  function isBlank(text) {
    const t = String(text || '').trim();
    return !t || t === '-' || t === '.';
  }
  function safeUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return null;
    if (/^www\./i.test(u)) u = 'https://' + u;
    return /^https?:\/\//i.test(u) ? u : null;
  }
  function policyUrl(p, plcyNo) {
    return (p && (safeUrl(p.aplyUrlAddr) || safeUrl(p.refUrlAddr1))) || YOUTHCENTER_URL + encodeURIComponent(plcyNo);
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function link(text, url, className) {
    const a = el('a', className || 'src-mini', text);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  // 제출 서류 글 → 체크리스트 항목 (result.js의 splitDocs와 같은 규칙 — 바꿀 때는 두 곳 모두)
  function splitDocs(text) {
    if (isBlank(text)) return null;
    const src = String(text).replace(/\r/g, '');
    if (/(^|\n)\s*[※*]/.test(src)) return null;
    const numbered = /[①-⑳]|(^|\n)\s*\d{1,2}[.)]\s/.test(src);
    const hasMarker = numbered || /[○❍●•▪◦]|(^|\s)-\s/.test(src);
    const items = [];
    src.split('\n').forEach(function (line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (numbered && /^-\s/.test(trimmed)) return;
      trimmed.split(/(?=[①-⑳])|\s(?=\d{1,2}[.)]\s)|(?:^|\s)[○❍●•▪◦]\s*|(?:^|\s)-\s+/).forEach(function (part) {
        const t = part.replace(/^[\s○❍●•▪◦\-①-⑳]+/, '').replace(/^\d{1,2}[.)]\s*/, '').trim();
        if (!t) return;
        if (hasMarker) { items.push(t); return; }
        let depth = 0, buf = '';
        for (const ch of t) {
          if (ch === '(' || ch === '[') depth++;
          if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
          if (ch === ',' && depth === 0) { items.push(buf.trim()); buf = ''; } else buf += ch;
        }
        items.push(buf.trim());
      });
    });
    const docs = [];
    items.forEach(function (s) {
      if (!s || /^(구비|제출|필요|준비)\s*서류/.test(s) || /:$/.test(s)) return;
      if (docs.indexOf(s) === -1) docs.push(s);
    });
    if (docs.length < 2 || docs.length > 15) return null;
    if (docs.some(function (s) { return s.length > 90; })) return null;
    return docs;
  }

  // ===== 5. 정책별 단계 만들기 =====
  function findAfterSteps(p, plcyNo) {
    if (!afterData || !afterData.policies) return null;
    if (afterData.policies[plcyNo]) return afterData.policies[plcyNo];
    const name = p ? String(p.plcyNm) : '';
    const keys = Object.keys(afterData.policies);
    for (let i = 0; i < keys.length; i++) {
      const names = afterData.policies[keys[i]].matchNames || [];
      if (name && names.some(function (n) { return name.indexOf(n) !== -1; })) return afterData.policies[keys[i]];
    }
    return null;
  }

  // 화면에 그릴 단계 목록. 각 단계:
  //   { id, title, type, date, note, warning, weeklyCheck, source: {url, text} | {manual: true}, monthly, done, state }
  function buildSteps(app, p) {
    const own = findAfterSteps(p, app.plcyNo);
    const isCommon = !(own && Array.isArray(own.steps) && own.steps.length);
    const defs = isCommon
      ? ((afterData && afterData.common && afterData.common.steps) || FALLBACK_COMMON)
      : own.steps;
    const commonSource = { url: policyUrl(p, app.plcyNo), text: '출처 확인' };
    const custom = app.customDates || {};
    const steps = [];

    defs.forEach(function (d) {
      if (d.onlyIfDocuments && (!p || isBlank(p.sbmsnDcmntCn))) return;
      const state = (app.steps && app.steps[d.id]) || {};
      const s = {
        id: d.id, title: d.title, type: DATE_TYPE_LABEL[d.dateType] ? d.dateType : 'none',
        date: null, weeks: d.weeks || null,
        note: d.note || '', warning: d.warning || '', weeklyCheck: d.weeklyCheck || '',
        source: d.source ? { url: safeUrl(d.source), text: '출처 확인' } : (isCommon ? commonSource : (own.source ? { url: safeUrl(own.source), text: '출처 확인' } : commonSource)),
        state: state,
      };
      if (d.noteFrom && p && !isBlank(p[d.noteFrom])) s.note = String(p[d.noteFrom]).trim();
      if (d.dateFrom === 'appliedAt') { s.type = 'exact'; s.date = app.appliedAt; s.source = { manual: true, text: '내가 입력한 날짜' }; }
      s.dateKey = d.customDateKey || null;
      // 사용자가 안내 받은 날짜를 입력(또는 AI 결과를 저장)하면 그 단계는 정확한 날짜로 바뀜
      const manualDate = d.customDateKey ? custom[d.customDateKey] : (app.stepDates && app.stepDates[d.id]);
      if (manualDate && d.dateFrom !== 'appliedAt') {
        const evidence = evidenceOf(app, d.customDateKey || d.id);
        s.type = 'exact'; s.date = manualDate; s.weeklyCheck = '';
        s.source = { manual: true, text: evidence ? '안내 문자에서 찾은 날짜' : '내가 입력한 날짜' };
        s.evidence = evidence;
        s.estimated = !!(app.dateEstimated && app.dateEstimated[d.customDateKey || d.id]);
      }
      s.monthly = s.type === 'monthly';
      s.done = s.monthly ? (state.doneMonths || []).indexOf(thisMonth()) !== -1 : !!state.done;
      steps.push(s);
    });

    // 입력한 날짜를 받을 단계가 없으면 (예: 국민취업지원제도의 서류 제출 기한) 새 단계로 끼워 넣음
    CUSTOM_DATES.forEach(function (c) {
      if (!custom[c.key]) return;
      if (defs.some(function (d) { return d.customDateKey === c.key && steps.some(function (s) { return s.id === d.id; }); })) return;
      const id = 'custom-' + c.key;
      const state = (app.steps && app.steps[id]) || {};
      const evidence = evidenceOf(app, c.key);
      steps.splice(1, 0, {
        id: id, title: c.stepTitle, type: 'exact', date: custom[c.key], note: '', warning: '', weeklyCheck: '',
        source: { manual: true, text: evidence ? '안내 문자에서 찾은 날짜' : '내가 입력한 날짜' }, evidence: evidence,
        dateKey: c.key, state: state, monthly: false, done: !!state.done,
      });
    });

    // 안내 문자에서 찾아 "새 단계로 추가"한 일정 (날짜가 없으면 "날짜 미정")
    (app.extraSteps || []).forEach(function (x) {
      const state = (app.steps && app.steps[x.id]) || {};
      steps.push({
        id: x.id, title: x.title, type: x.date ? 'exact' : 'none', date: x.date || null, note: '', warning: '', weeklyCheck: '',
        source: { manual: true, text: x.date ? '안내 문자에서 찾은 날짜' : '안내 문자에서 찾은 할 일' }, evidence: x.evidence || '',
        extra: true, state: state, monthly: false, done: !!state.done,
        estimated: !!(x.date && app.dateEstimated && app.dateEstimated[x.id]),
      });
    });

    // 안내 문자에서 저장한 요약·항목(서류·할 일 등)을 단계에 붙임
    const notes = app.stepNotes || {};
    steps.forEach(function (st) {
      const n = notes[st.id];
      st.summary = n && n.summary ? n.summary : '';
      st.items = n && Array.isArray(n.items) ? n.items : [];
    });
    return { steps: sortSteps(steps), isCommon: isCommon };
  }

  // 단계 순서 (관리 화면과 메일이 같은 순서):
  //   완료된 단계 → 위에, 완료한 날짜 순 (신청 완료는 신청일 기준)
  //   안 끝난 단계 → 날짜 순, 날짜 미정·매월 반복은 맨 아래 (원래 순서 유지)
  function sortSteps(steps) {
    const withIndex = steps.map(function (st, i) { return { s: st, i: i }; });
    function doneKey(x) {
      if (x.s.id === 'applied') return x.s.date || '';
      return String((x.s.state && x.s.state.doneAt) || '').slice(0, 10) || x.s.date || '9999-12-31';
    }
    const done = withIndex.filter(function (x) { return x.s.done && !x.s.monthly; })
      .sort(function (a, b) { return doneKey(a).localeCompare(doneKey(b)) || a.i - b.i; });
    const rest = withIndex.filter(function (x) { return !(x.s.done && !x.s.monthly); });
    const dated = rest.filter(function (x) { return x.s.type === 'exact' && x.s.date; })
      .sort(function (a, b) { return a.s.date.localeCompare(b.s.date) || a.i - b.i; });
    const undated = rest.filter(function (x) { return !(x.s.type === 'exact' && x.s.date); });
    return done.concat(dated, undated).map(function (x) { return x.s; });
  }

  function evidenceOf(app, key) {
    return (app.dateEvidence && app.dateEvidence[key]) || '';
  }

  // 날짜 줄에 보여줄 글
  function dateLine(s) {
    if (s.type === 'exact' && s.date) {
      const n = daysFromToday(s.date);
      return prettyDate(s.date) + (s.estimated ? ' (예상)' : '') + (n !== null && !s.done && s.id !== 'applied' ? ' · ' + ddayText(n) : '') +
        (s.estimated ? ' · ' + ESTIMATED_NOTE : '');
    }
    if (s.type === 'approx') return s.weeks ? '예상: 신청 후 약 ' + s.weeks + '주' : '예상 일정';
    if (s.type === 'monthly') return '매월 반복 · 이번 달(' + Number(thisMonth().slice(5)) + '월) ' + (s.done ? '완료' : '아직');
    return '날짜 미정 · 매주 확인 알림';
  }

  // "결과 안내 받으셨나요?"를 지금 물어볼지 (마지막으로 물은 지 7일 지났으면)
  function weeklyDue(s) {
    if (!s.weeklyCheck || s.done) return false;
    const last = s.state.lastCheckedAt;
    if (!last) return true;
    const n = daysFromToday(last);
    return n === null || -n >= WEEKLY_DAYS;
  }

  // ===== 6. 상태 바꾸기 =====
  function stepState(app, id) {
    app.steps = app.steps || {};
    app.steps[id] = app.steps[id] || {};
    return app.steps[id];
  }
  function setDone(plcyNo, step, done) {
    const app = apps.items[plcyNo];
    const st = stepState(app, step.id);
    if (step.monthly) {
      const list = st.doneMonths || [];
      const m = thisMonth();
      st.doneMonths = done ? (list.indexOf(m) === -1 ? list.concat(m) : list) : list.filter(function (x) { return x !== m; });
    } else {
      st.done = done;
      st.doneAt = done ? new Date().toISOString() : null;
    }
    markChanged(app);
    saveApps();
    render();
  }
  function markWeeklyChecked(plcyNo, step) {
    stepState(apps.items[plcyNo], step.id).lastCheckedAt = ymd(today());
    markChanged(apps.items[plcyNo]);
    saveApps();
    render();
  }

  // ===== 7. 화면 그리기 =====
  const $ = function (id) { return document.getElementById(id); };

  function showLoadMsg(text, isError) {
    const m = $('load-msg');
    m.hidden = !text;
    m.textContent = text || '';
    m.classList.toggle('error', !!isError);
  }

  function sourceNode(src) {
    if (!src) return null;
    if (src.manual) return el('span', 'src-mini manual', src.text);
    return src.url ? link(src.text, src.url) : null;
  }

  // --- 지금 할 일: 모든 정책 중 가장 급한 1개 ---
  function pickNow() {
    const cands = [];
    Object.keys(apps.items).forEach(function (no) {
      const app = apps.items[no];
      const p = policyOf(no);
      const built = buildSteps(app, p).steps;
      let nextFound = false;
      let blocked = false;   // 앞 단계(매월 할 일 제외)가 남아 있으면 매월 할 일은 아직 시작 전
      built.forEach(function (s, idx) {
        if (s.done || s.id === 'applied') return;
        if (s.type === 'exact' && s.date) {
          cands.push({ rank: daysFromToday(s.date) <= SOON_DAYS ? 0 : 3, sortKey: daysFromToday(s.date), app: app, step: s, kind: 'date' });
        } else if (s.monthly) {
          if (s.warning && !blocked) cands.push({ rank: 1, sortKey: idx, app: app, step: s, kind: 'monthly' });
        } else if (weeklyDue(s)) {
          cands.push({ rank: 2, sortKey: idx, app: app, step: s, kind: 'weekly' });
        } else if (!nextFound && !s.monthly) {
          cands.push({ rank: 4, sortKey: idx, app: app, step: s, kind: 'next' });
        }
        if (!s.monthly) { nextFound = true; blocked = true; }
      });
    });
    cands.sort(function (a, b) { return a.rank - b.rank || a.sortKey - b.sortKey; });
    return cands[0] || null;
  }

  function renderNow() {
    const card = $('now-card');
    const body = $('now-body');
    body.innerHTML = '';
    if (!Object.keys(apps.items).length) { card.hidden = true; return; }
    card.hidden = false;
    const now = pickNow();
    if (!now) {
      body.appendChild(el('p', 'now-title', '지금 급하게 할 일은 없어요'));
      body.appendChild(el('p', 'now-sub', '새 안내를 받으면 아래 정책 카드에 날짜를 입력해 주세요.'));
      return;
    }
    const s = now.step, no = now.app.plcyNo;
    const tag = { date: ddayText(daysFromToday(s.date)), monthly: '이번 달 할 일', weekly: '이번 주 확인', next: '다음 단계' }[now.kind];
    body.appendChild(el('span', 'now-tag' + (now.kind === 'date' && daysFromToday(s.date) <= 3 ? ' urgent' : ''), tag));
    body.appendChild(el('p', 'now-policy', now.app.plcyNm));
    body.appendChild(el('p', 'now-title', now.kind === 'weekly' ? s.title + ' — ' + s.weeklyCheck : s.title));
    const line = el('p', 'now-sub', now.kind === 'date' ? prettyDate(s.date) : (s.note || dateLine(s)));
    const src = sourceNode(s.source);
    if (src) line.append(' ', src);
    body.appendChild(line);
    if (s.warning) body.appendChild(el('p', 'now-warn', '⚠ ' + s.warning));

    const actions = el('div', 'now-actions');
    if (now.kind === 'weekly') {
      const yes = el('button', 'btn btn-primary now-btn', '네, 받았어요');
      yes.type = 'button';
      yes.addEventListener('click', function () { setDone(no, s, true); });
      const notYet = el('button', 'btn btn-secondary now-btn', '아직이요');
      notYet.type = 'button';
      notYet.addEventListener('click', function () { markWeeklyChecked(no, s); });
      actions.append(yes, notYet);
    } else {
      const done = el('button', 'btn btn-primary now-btn', s.monthly ? '이번 달 했어요' : '완료했어요');
      done.type = 'button';
      done.addEventListener('click', function () { setDone(no, s, true); });
      actions.appendChild(done);
    }
    const go = el('a', 'now-link', '이 정책 관리 화면 →');
    go.href = '#p=' + no;
    actions.appendChild(go);
    body.appendChild(actions);
  }

  // --- 정책 정보 글 ---
  function periodText(p) {
    if (!p) return '';
    if (p.status === '상시') return '상시 모집';
    const m = /(\d{4})(\d{2})(\d{2})\s*~\s*(\d{4})(\d{2})(\d{2})/.exec(String(p.aplyYmd || ''));
    return m ? m[1] + '.' + m[2] + '.' + m[3] + ' ~ ' + m[4] + '.' + m[5] + '.' + m[6] : '';
  }
  function progressText(steps) {
    const doneCount = steps.filter(function (s) { return s.done && !s.monthly; }).length;
    const total = steps.filter(function (s) { return !s.monthly; }).length;
    return total + '단계 중 ' + doneCount + '단계 완료' + (steps.some(function (s) { return s.monthly; }) ? ' + 매월 할 일' : '');
  }

  // --- 목록 보기용 짧은 카드 (누르면 그 정책 관리 화면) ---
  function summaryCard(app) {
    const no = app.plcyNo;
    const p = policyOf(no);
    const steps = buildSteps(app, p).steps;
    const pending = steps.filter(function (s) { return !s.done && s.id !== 'applied'; });
    const next = pending.find(function (s) { return !s.monthly; }) || pending[0];
    const a = el('a', 'app-summary');
    a.href = '#p=' + no;
    a.appendChild(el('span', 'app-summary-title', app.plcyNm));
    a.appendChild(el('span', 'app-meta', prettyDate(app.appliedAt) + ' 신청' + (p && p.operInstCdNm ? ' · ' + p.operInstCdNm : '')));
    a.appendChild(el('span', 'app-progress', progressText(steps)));
    if (next) a.appendChild(el('span', 'app-summary-next', '다음: ' + next.title + (next.type === 'exact' && next.date ? ' · ' + prettyDate(next.date) : '')));
    a.appendChild(el('span', 'app-summary-go', '관리하기 →'));
    return a;
  }

  // --- 정책 카드 (한 정책의 관리 화면) ---
  function appCard(app) {
    const no = app.plcyNo;
    const p = policyOf(no);
    const built = buildSteps(app, p);
    const steps = built.steps;
    const card = el('article', 'app-card');
    card.id = 'app-' + no;

    // 머리: 정책명 · 신청일 · 기관 · 신청 기간 · 요약 (신청할 때 저장한 스냅샷 기준)
    const head = el('div', 'app-head');
    head.appendChild(el('h3', 'app-title', app.plcyNm));
    const n = -daysFromToday(app.appliedAt);
    head.appendChild(el('p', 'app-meta', prettyDate(app.appliedAt) + ' 신청' + (n > 0 ? ' · ' + n + '일째' : n === 0 ? ' · 오늘' : '')));
    const info = [p && p.operInstCdNm ? '운영기관 ' + p.operInstCdNm : '', periodText(p) ? '신청 기간 ' + periodText(p) : ''].filter(Boolean).join(' · ');
    if (info) head.appendChild(el('p', 'app-meta', info));
    if (p && !isBlank(p.plcyExplnCn)) head.appendChild(el('p', 'app-desc', String(p.plcyExplnCn).trim()));
    head.appendChild(el('p', 'app-progress', progressText(steps)));
    if (dataLoaded && !policyByNo[no]) {
      head.appendChild(el('p', 'app-note', p
        ? '이 정책은 최신 정책 목록에서 빠졌어요(마감 등). 신청할 때 저장해 둔 정보로 보여 드려요.'
        : '정책 상세 정보가 없어요. 저장된 단계 기록만 보여 드려요.'));
    }
    card.appendChild(head);

    // 🗓 단계 타임라인
    const sec = el('section', 'sheet-section');
    sec.appendChild(sectionTitle('🗓', '신청 후 단계'));
    if (built.isCommon) sec.appendChild(el('p', 'sheet-hint', '이 정책은 단계 정보를 따로 정리하지 않아서 일반적인 흐름이에요. 안내를 받으면 아래에 날짜를 입력해 주세요.'));
    const ol = el('ol', 'timeline mtimeline');
    steps.forEach(function (s, i) {
      const li = el('li', 'tl-item mstep' + (s.done ? ' done' : ''));
      const head2 = el('div', 'tl-head');
      const box = el('input');
      box.type = 'checkbox';
      box.id = 'step-' + no + '-' + i;
      box.checked = s.done;
      box.addEventListener('change', function () { setDone(no, s, box.checked); });
      const label = el('label', 'tl-title', s.title);
      label.htmlFor = box.id;
      head2.append(box, label, el('span', 'tl-type ' + DATE_TYPE_CLASS[s.type], DATE_TYPE_LABEL[s.type]));
      li.appendChild(head2);

      const date = el('p', 'tl-when', dateLine(s));
      const src = sourceNode(s.source);
      if (src) date.append(' ', src);
      li.appendChild(date);
      if (s.summary) li.appendChild(el('p', 'tl-summary', s.summary));
      if (s.items.length) li.appendChild(itemChecklist(app, s));
      if (s.note) li.appendChild(el('p', 'tl-note', s.note));
      if (s.evidence) li.appendChild(el('p', 'tl-evidence', '근거: “' + s.evidence + '”'));
      if (s.warning) li.appendChild(el('p', 'tl-warn', '⚠ ' + s.warning));
      if (s.extra) {
        const del = el('button', 'mini-btn', '이 일정 지우기');
        del.type = 'button';
        del.addEventListener('click', function () {
          app.extraSteps = (app.extraSteps || []).filter(function (x) { return x.id !== s.id; });
          if (app.steps) delete app.steps[s.id];
          markChanged(app);
          saveApps();
          render();
        });
        li.appendChild(del);
      }

      if (weeklyDue(s)) {
        const ask = el('div', 'weekly-ask');
        ask.appendChild(el('span', null, s.weeklyCheck));
        const yes = el('button', 'mini-btn primary', '네, 받았어요');
        yes.type = 'button';
        yes.addEventListener('click', function () { setDone(no, s, true); });
        const later = el('button', 'mini-btn', '아직이요');
        later.type = 'button';
        later.addEventListener('click', function () { markWeeklyChecked(no, s); });
        ask.append(yes, later);
        li.appendChild(ask);
      }
      ol.appendChild(li);
    });
    sec.appendChild(ol);
    card.appendChild(sec);

    // 📅 직접 일정 입력
    card.appendChild(customDatesSection(app));

    // 📄 제출 서류 (상세 패널에서 체크한 상태 그대로)
    const docs = docsSection(no, p);
    if (docs) card.appendChild(docs);

    // 📧 관리 메일 + 캘린더 추가 버튼
    card.appendChild(mailSection(app));

    // ✉ 안내 문자 붙여넣기 → AI가 일정 정리 (저장은 사용자가 고른 것만)
    card.appendChild(pasteSection(app, steps));

    // 아래 버튼
    const foot = el('div', 'app-foot');
    foot.appendChild(link('공고 다시 보기', policyUrl(p, no), 'btn-line'));
    const stop = el('button', 'btn-line danger', '이 정책 관리 그만하기');
    stop.type = 'button';
    stop.addEventListener('click', function () {
      if (!confirm('"' + app.plcyNm + '" 관리를 그만할까요? 이 정책의 단계 체크와 입력한 날짜가 지워져요.')) return;
      delete apps.items[no];
      saveApps();
      render();
    });
    foot.appendChild(stop);
    card.appendChild(foot);
    return card;
  }

  // 단계에 딸린 항목(서류·할 일 등) 체크리스트 — 체크 상태도 메일 링크에 담김
  function itemChecklist(app, s) {
    const ul = el('ul', 'sub-checklist');
    s.items.forEach(function (x, k) {
      const li = el('li', 'sub-item' + (x.done ? ' done' : ''));
      const box = el('input');
      box.type = 'checkbox';
      box.id = 'item-' + app.plcyNo + '-' + s.id + '-' + k;
      box.checked = !!x.done;
      box.addEventListener('change', function () {
        x.done = box.checked;     // app.stepNotes 안의 항목을 그대로 바꿈
        if (!x.done) delete x.done;
        markChanged(app);
        saveApps();
        render();
      });
      const label = el('label', null);
      label.htmlFor = box.id;
      label.append(el('span', 'sub-kind', x.kind), ' ' + x.text);
      li.append(box, label);
      ul.appendChild(li);
    });
    return ul;
  }

  function sectionTitle(emoji, title) {
    const h = el('h4', 'sheet-section-title');
    h.append(el('span', 'sheet-emoji', emoji), ' ' + title);
    return h;
  }

  function customDatesSection(app) {
    const sec = el('section', 'sheet-section');
    sec.appendChild(sectionTitle('📅', '직접 일정 입력'));
    sec.appendChild(el('p', 'sheet-hint top', '문자·메일로 날짜 안내를 받으면 입력해 주세요. 해당 단계가 정확한 날짜로 바뀌어요.'));
    const grid = el('div', 'custom-grid');
    CUSTOM_DATES.forEach(function (c) {
      const wrap = el('div', 'custom-field');
      const id = 'cd-' + app.plcyNo + '-' + c.key;
      const label = el('label', 'custom-label', c.label);
      label.htmlFor = id;
      const input = el('input', 'date-input');
      input.type = 'date';
      input.id = id;
      input.value = (app.customDates && app.customDates[c.key]) || '';
      input.addEventListener('change', function () {
        app.customDates = app.customDates || {};
        if (input.value) app.customDates[c.key] = input.value; else delete app.customDates[c.key];
        if (app.dateEvidence) delete app.dateEvidence[c.key];   // 직접 고쳤으면 AI 근거는 떼어냄
        if (app.dateEstimated) delete app.dateEstimated[c.key];
        markChanged(app);
        saveApps();
        render();
      });
      wrap.append(label, input);
      grid.appendChild(wrap);
    });
    sec.appendChild(grid);
    return sec;
  }

  function docsSection(no, p) {
    if (!p || isBlank(p.sbmsnDcmntCn)) return null;
    const sec = el('section', 'sheet-section');
    sec.appendChild(sectionTitle('📄', '제출 서류'));
    const docs = splitDocs(p.sbmsnDcmntCn);
    if (!docs) {
      sec.appendChild(el('p', 'docs-raw-text', String(p.sbmsnDcmntCn).trim()));
      return sec;
    }
    const state = loadDocs(no);
    state.checked = state.checked || {};
    const progress = el('p', 'docs-progress');
    function update() {
      progress.textContent = docs.length + '개 중 ' + docs.filter(function (d) { return state.checked[d]; }).length + '개 준비했어요';
    }
    const list = el('ul', 'docs-list');
    docs.forEach(function (d, i) {
      const li = el('li');
      const box = el('input');
      box.type = 'checkbox';
      box.id = 'mdoc-' + no + '-' + i;
      box.checked = !!state.checked[d];
      box.addEventListener('change', function () {
        if (box.checked) state.checked[d] = true; else delete state.checked[d];
        state.updatedAt = new Date().toISOString();
        saveDocs(no, state);
        update();
        // 서류 체크도 메일 링크에 담기므로 "바꾼 내용 있음" 표시
        if (apps.items[no] && !apps.items[no].changed) { markChanged(apps.items[no]); saveApps(); render(); }
      });
      const label = el('label', null, d);
      label.htmlFor = box.id;
      li.append(box, label);
      list.appendChild(li);
    });
    update();
    sec.append(progress, list);
    const raw = el('details', 'docs-raw');
    raw.appendChild(el('summary', null, '공고 원문 보기'));
    raw.appendChild(el('p', 'docs-raw-text', String(p.sbmsnDcmntCn).trim()));
    sec.appendChild(raw);
    return sec;
  }

  // --- 📧 관리 메일 + 캘린더 추가 버튼 → /api/send-plan ---
  // full: 전체 단계 + 지금 화면 상태가 담긴 새 [관리 화면 열기] 링크
  // 메일 주소는 어디에도 저장하지 않음 (보낼 때마다 직접 입력)
  const CHANGED_NOTICE = '바꾼 내용은 [관리 메일 다시 받기]를 눌러야 메일 링크에 저장돼요.';
  const EMAIL_RE = /^[^\s@<>"',;:()\[\]\\]+@[^\s@<>"',;:()\[\]\\]+\.[A-Za-z]{2,}$/;
  const MAIL_COOLDOWN = 30;
  const mailState = {};   // 정책번호 → { sending, msg, error, cooldownLeft }

  // 메일·캘린더용 단계 목록 (화면의 단계와 같은 규칙)
  function stepsForMail(app, onlyIds) {
    return buildSteps(app, policyOf(app.plcyNo)).steps
      .filter(function (s) { return !onlyIds || onlyIds.indexOf(s.id) !== -1; })
      .map(function (s) {
        return {
          id: s.id, title: s.title, type: s.type === 'approx' ? 'none' : s.type, date: s.date || null,
          done: s.monthly ? false : !!s.done,       // 매월 할 일은 이번 달 체크와 관계없이 앞으로도 알림
          note: s.note || '', warning: s.warning || '', evidence: s.evidence || '',
          sourceUrl: (s.source && s.source.url) || '',
          estimated: !!s.estimated,
          summary: s.summary || '', items: (s.items || []).map(function (x) { return { kind: x.kind, text: x.text, done: !!x.done }; }),
        };
      });
  }

  function startCooldown(no) {
    const st = mailState[no];
    st.cooldownLeft = MAIL_COOLDOWN;
    const timer = setInterval(function () {
      st.cooldownLeft -= 1;
      if (st.cooldownLeft <= 0) { clearInterval(timer); st.cooldownLeft = 0; render(); return; }
      const btn = document.getElementById('mail-btn-' + no);
      if (btn) btn.textContent = '다시 보내기 ' + st.cooldownLeft + '초';
    }, 1000);
  }

  // 돌려주는 값: Promise<{ ok, message }>
  function sendPlan(app, mode, email, onlyIds) {
    const no = app.plcyNo;
    const st = mailState[no] = mailState[no] || {};
    st.sending = true; st.msg = ''; st.error = '';
    if (mode === 'full') render();
    const steps = stepsForMail(app, onlyIds);
    return fetch('api/send-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, mode: mode, plan: { policyName: app.plcyNm, plcyNo: no, appliedAt: app.appliedAt }, steps: steps, record: recordForLink(app) }),
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) { return { status: res.status, data: data }; });
      })
      .then(function (r) {
        if (r.status === 200 && r.data && r.data.ok) {
          // 이메일 주소는 저장하지 않음. 바뀐 내용이 새 링크에 담겼으니 "바뀜" 표시를 지움
          if (mode === 'full') { app.changed = false; app.mailedAt = new Date().toISOString(); }
          if (app.linkEmail) app.linkEmail = email;   // 메일 링크로 연 탭: 새 링크를 받은 주소로 바꿔 둠 (이 탭에서만)
          saveApps();
          return { ok: true, message: '메일을 보냈어요! 메일의 ' + (r.data.calendarButton ? '[📱 내 폰 캘린더에 추가] 버튼을' : '구글 캘린더 링크를') +
            ' 누르면 일정 ' + r.data.events + '개가 캘린더에 들어가요. (스팸함도 확인해 주세요)' };
        }
        if (r.status === 404 || r.status === 405 || r.status === 501) return { ok: false, message: '메일 기능을 찾지 못했어요. "npm run dev"로 켠 주소(또는 배포 주소)에서 열었는지 확인해 주세요.' };
        return { ok: false, message: (r.data && r.data.message) || '메일을 보내지 못했어요. 잠시 후 다시 시도해 주세요.' };
      })
      .catch(function () { return { ok: false, message: '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.' }; })
      .then(function (result) {
        st.sending = false;
        if (mode === 'full') {
          st.msg = result.ok ? result.message : '';
          st.error = result.ok ? '' : result.message;
          startCooldown(no);
          render();
        }
        return result;
      });
  }

  function mailSection(app) {
    const no = app.plcyNo;
    const st = mailState[no] = mailState[no] || {};
    const sec = el('section', 'sheet-section');
    sec.appendChild(sectionTitle('📧', '관리 메일 · 캘린더'));
    sec.appendChild(el('p', 'sheet-hint top', '단계별 할 일, [📱 내 폰 캘린더에 추가] 버튼, 이 관리 화면을 다시 여는 [관리 화면 열기] 링크를 메일로 보내 드려요. 캘린더에 넣으면 날짜 있는 일정은 하루 전, 매월 할 일은 매월 1일, 날짜 미정 단계는 매주 월요일에 캘린더가 알려 줘요.'));
    // 탭을 닫으면 사라진다는 안내 (바뀐 내용이 있으면 강조)
    sec.appendChild(el('p', app.changed ? 'changed-notice' : 'sheet-hint top', CHANGED_NOTICE + ' 이 탭을 닫으면 화면에서 바꾼 내용은 사라져요.'));
    const row = el('div', 'mail-row');
    const id = 'mail-' + no;
    const label = el('label', 'sr-only', '이메일');
    label.htmlFor = id;
    const input = el('input', 'date-input mail-input');
    input.type = 'email';
    input.id = id;
    input.placeholder = 'name@example.com';
    input.autocomplete = 'off';                 // 브라우저가 예전 주소를 채워 넣지 않게
    // 메일 링크로 연 경우에만 링크 속 이메일(암호화돼 있던 주소)로 채움. 링크 없이 들어오면 빈칸
    input.value = st.draft !== undefined ? st.draft : (app.linkEmail || '');
    input.addEventListener('input', function () { st.draft = input.value; });
    const btn = el('button', 'btn btn-primary mail-btn',
      st.sending ? '보내는 중…' : (st.cooldownLeft ? '다시 보내기 ' + st.cooldownLeft + '초' : (app.mailedAt || app.restoredAt ? '관리 메일 다시 받기' : '관리 메일 받기')));
    btn.type = 'button';
    btn.id = 'mail-btn-' + no;
    btn.disabled = !!st.sending || !!st.cooldownLeft;
    btn.addEventListener('click', function () {
      const email = input.value.trim();
      if (!EMAIL_RE.test(email)) { st.error = '이메일 주소를 다시 확인해 주세요. (예: name@example.com)'; st.msg = ''; render(); return; }
      st.draft = undefined;                     // 보낸 뒤: 링크로 연 탭이면 그 주소, 아니면 빈칸
      sendPlan(app, 'full', email);
    });
    row.append(label, input, btn);
    sec.appendChild(row);
    if (st.msg) sec.appendChild(el('p', 'notify-msg success', st.msg));
    if (st.error) sec.appendChild(el('p', 'form-error', st.error));
    return sec;
  }

  // --- ✉ 안내 문자 붙여넣기 → /api/parse-notice ---
  // 화면을 다시 그려도 붙여넣은 글과 AI 결과가 남도록 메모리에만 보관 (저장소에는 안 남김)
  const pasteState = {};   // 정책번호 → { open, text, loading, error, items, saved: {index: true} }
  const NOTICE_MAX = 3000;                                  // api/parse-notice.js와 같은 값
  const NOTICE_TOO_LONG = '3,000자 이내로 붙여넣어 주세요';    // 서버와 같은 안내 문구
  // AI가 찾은 단계 이름 → 어느 단계에 넣을지 처음 고를 값 (사용자가 바꿀 수 있음)
  const STEP_HINTS = [['상담'], ['결과', '발표', '수급자격', '선정', '심사'], ['서류', '제출', '보완'], ['수당', '지급']];

  function guessTarget(item, steps) {
    const text = item.step + ' ' + item.evidence;
    for (let g = 0; g < STEP_HINTS.length; g++) {
      if (!STEP_HINTS[g].some(function (k) { return text.indexOf(k) !== -1; })) continue;
      const hit = steps.find(function (s) {
        return !s.monthly && s.id !== 'applied' && !s.extra && STEP_HINTS[g].some(function (k) { return s.title.indexOf(k) !== -1; });
      });
      if (hit) return hit.id;
    }
    return 'new';
  }

  // 돌려주는 값: 저장한 단계의 id (메일로 이 일정만 다시 보낼 때 씀)
  // 요약·항목 저장: 같은 단계에 이미 있으면 뒤에 붙임 (같은 글자는 한 번만)
  function saveNotes(app, stepId, item) {
    const items = (item.items || []).map(function (x) { return { kind: x.kind, text: String(x.text || '').trim() }; })
      .filter(function (x) { return x.text; });
    if (!item.summary && !items.length) return;
    app.stepNotes = app.stepNotes || {};
    const cur = app.stepNotes[stepId] = app.stepNotes[stepId] || { summary: '', items: [] };
    if (item.summary) cur.summary = item.summary;
    items.forEach(function (x) { if (!cur.items.some(function (y) { return y.text === x.text; })) cur.items.push(x); });
    cur.items = cur.items.slice(0, 10);
  }

  function markEstimated(app, key, item) {
    app.dateEstimated = app.dateEstimated || {};
    if (item.date && item.dateType === 'estimated') app.dateEstimated[key] = true; else delete app.dateEstimated[key];
  }
  function saveAiItem(app, steps, item, targetId) {
    app.dateEvidence = app.dateEvidence || {};
    if (targetId === 'new') {
      const newId = 'ai-' + Date.now().toString(36);
      app.extraSteps = app.extraSteps || [];
      app.extraSteps.push({ id: newId, title: item.step.slice(0, 40), date: item.date || null, evidence: item.evidence });
      saveNotes(app, newId, item);
      markEstimated(app, newId, item);
      markChanged(app);
      saveApps();
      return newId;
    } else {
      const target = steps.find(function (s) { return s.id === targetId; });
      if (!target) return null;
      saveNotes(app, target.id, item);
      if (!item.date) {                        // 날짜 없는 결과 → 요약·항목만 붙이고 날짜는 그대로
        if (item.evidence && !evidenceOf(app, target.dateKey || target.id)) app.dateEvidence[target.dateKey || target.id] = item.evidence;
      } else if (target.dateKey) {             // 날짜 입력칸이 있는 단계 → 그 칸에 저장
        app.customDates = app.customDates || {};
        app.customDates[target.dateKey] = item.date;
        app.dateEvidence[target.dateKey] = item.evidence;
        markEstimated(app, target.dateKey, item);
      } else {                                  // 다른 단계 → 단계 날짜로 저장
        app.stepDates = app.stepDates || {};
        app.stepDates[target.id] = item.date;
        app.dateEvidence[target.id] = item.evidence;
        markEstimated(app, target.id, item);
      }
      markChanged(app);
      saveApps();
      return target.id;
    }
  }

  function pasteSection(app, steps) {
    const no = app.plcyNo;
    const st = pasteState[no] = pasteState[no] || { open: false, text: '', loading: false, error: '', items: null, saved: {} };
    const sec = el('section', 'sheet-section');
    sec.appendChild(sectionTitle('✉️', '안내 문자 붙여넣기'));
    const toggle = el('button', 'btn-line', st.open ? '닫기' : '안내 문자 붙여넣기');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(st.open));
    toggle.addEventListener('click', function () { st.open = !st.open; render(); });
    sec.appendChild(toggle);
    if (!st.open) return sec;

    const box = el('div', 'paste-box');
    const area = el('textarea', 'paste-area');
    area.rows = 5;
    // maxLength는 쓰지 않음: 긴 글을 붙여넣으면 뒤가 말없이 잘리기 때문. 대신 글자 수를 빨갛게 표시하고 보낼 때 막음
    area.value = st.text;
    area.placeholder = '받은 문자나 메일 내용을 붙여넣어 주세요 (최대 3,000자)';
    area.setAttribute('aria-label', '안내 문자 내용');
    const count = el('p', 'paste-count');
    function updateCount() {
      const over = area.value.length > NOTICE_MAX;
      count.textContent = area.value.length.toLocaleString('ko-KR') + ' / ' + NOTICE_MAX.toLocaleString('ko-KR') + (over ? ' — ' + NOTICE_TOO_LONG : '');
      count.classList.toggle('over', over);
    }
    updateCount();
    area.addEventListener('input', function () { st.text = area.value; updateCount(); });
    const run = el('button', 'btn btn-primary paste-run', st.loading ? 'AI가 정리하는 중…' : 'AI로 일정 정리');
    run.type = 'button';
    run.disabled = st.loading;
    run.addEventListener('click', function () { runParse(app, st); });
    box.append(area, count, run);
    box.appendChild(el('p', 'sheet-hint', '붙여넣은 글은 일정 정리에만 쓰고 저장하지 않아요. 주민번호·계좌번호 같은 개인정보는 지우고 붙여넣어 주세요.'));
    if (st.error) box.appendChild(el('p', 'form-error', st.error));
    if (st.items) box.appendChild(aiResults(app, steps, st));
    sec.appendChild(box);
    return sec;
  }

  function runParse(app, st) {
    const text = st.text.trim();
    if (text.length < 5) { st.error = '안내 문자나 메일 내용을 붙여넣어 주세요.'; render(); return; }
    if (text.length > NOTICE_MAX) { st.error = NOTICE_TOO_LONG; render(); return; }
    st.loading = true; st.error = ''; st.items = null; st.saved = {};
    render();
    fetch('api/parse-notice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policyName: app.plcyNm, text: text }),
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) { return { status: res.status, data: data }; });
      })
      .then(function (r) {
        if (r.status === 200 && r.data && r.data.ok) st.items = r.data.items || [];
        else if (r.status === 404 || r.status === 405 || r.status === 501) st.error = 'AI 정리 기능을 찾지 못했어요. "npm run dev"로 켠 주소(또는 배포 주소)에서 열었는지 확인해 주세요.';
        else st.error = (r.data && r.data.message) || 'AI가 정리하지 못했어요. 잠시 후 다시 시도해 주세요.';
      })
      .catch(function () { st.error = '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.'; })
      .then(function () { st.loading = false; render(); });
  }

  // "AI가 찾은 일정" 목록 — [이 일정 저장]을 누른 것만 반영
  function aiResults(app, steps, st) {
    const wrap = el('div', 'ai-results');
    wrap.appendChild(el('h5', 'ai-title', 'AI가 찾은 일정'));
    if (!st.items.length) {
      wrap.appendChild(el('p', 'empty-note', '이 글에서는 일정을 찾지 못했어요. 안내를 받으면 위 "직접 일정 입력"에 넣어 주세요.'));
      return wrap;
    }
    wrap.appendChild(el('p', 'sheet-hint top', 'AI가 글에서 뽑은 내용이라 틀릴 수 있어요. 근거 문장과 날짜를 확인하고, 맞는 것만 저장해 주세요.'));
    const targets = steps.filter(function (s) { return !s.monthly && s.id !== 'applied' && !s.extra; });
    st.items.forEach(function (item, i) {
      const box = el('div', 'ai-item');
      const head = el('div', 'tl-head');
      head.append(el('span', 'tl-title', item.step), el('span', 'tl-type ' + DATE_TYPE_CLASS[item.dateType], DATE_TYPE_LABEL[item.dateType]));
      box.appendChild(head);
      if (item.date && item.dateType === 'estimated') box.appendChild(el('p', 'tl-when', monthDay(item.date) + '(예상) · ' + (item.dateNote || ESTIMATED_NOTE)));
      else if (item.date) box.appendChild(el('p', 'tl-when', prettyDate(item.date)));
      else box.appendChild(el('p', 'ai-nodate', '날짜 없음 · 안내를 받으면 직접 입력해 주세요'));
      if (!st.saved[i]) box.appendChild(aiDateEditor(app, item, i));
      if (item.summary) box.appendChild(el('p', 'tl-summary', item.summary));
      if (!st.saved[i]) box.appendChild(aiItemEditor(item));
      else if (item.items && item.items.length) {
        const ul = el('ul', 'sub-checklist');
        item.items.forEach(function (x) { const li = el('li', 'sub-item'); li.append(el('span', 'sub-kind', x.kind), ' ' + x.text); ul.appendChild(li); });
        box.appendChild(ul);
      }
      if (item.evidence) box.appendChild(el('p', 'tl-evidence', '근거: “' + item.evidence + '”'));
      (item.warnings || []).forEach(function (w) { box.appendChild(el('p', 'tl-warn', '⚠ ' + w)); });

      if (item.date || (item.items && item.items.length) || item.summary) {
        if (st.saved[i]) {
          box.appendChild(el('p', 'ai-saved', '✓ 저장했어요'));
          const note = st.mailNotes && st.mailNotes[i];
          if (note) box.appendChild(el('p', note.ok ? 'notify-msg success' : 'form-error', note.text));
          // 메일 링크로 연 탭(이메일을 알고 있음)이면 바로 다시 받을 수 있는 버튼 — 자동 발송은 하지 않음
          if (note && note.offer && app.linkEmail) {
            const ms = mailState[app.plcyNo] || {};
            const again = el('button', 'mini-btn primary', ms.sending ? '보내는 중…' : (ms.cooldownLeft ? '다시 보내기 ' + ms.cooldownLeft + '초' : '[관리 메일 다시 받기] ' + app.linkEmail));
            again.type = 'button';
            again.disabled = !!ms.sending || !!ms.cooldownLeft;
            again.addEventListener('click', function () { note.offer = false; sendPlan(app, 'full', app.linkEmail); });
            box.appendChild(again);
          }
        } else {
          const row = el('div', 'ai-save-row');
          const selId = 'ai-target-' + app.plcyNo + '-' + i;
          const label = el('label', 'custom-label', '넣을 단계');
          label.htmlFor = selId;
          const sel = el('select', 'ai-select');
          sel.id = selId;
          targets.forEach(function (s) { const o = el('option', null, s.title); o.value = s.id; sel.appendChild(o); });
          const optNew = el('option', null, '새 단계로 추가: ' + item.step + (item.date ? '' : ' (날짜 미정)'));
          optNew.value = 'new';
          sel.appendChild(optNew);
          sel.value = guessTarget(item, steps);
          const save = el('button', 'mini-btn primary', '이 일정 저장');
          save.type = 'button';
          save.addEventListener('click', function () {
            const savedId = saveAiItem(app, steps, item, sel.value);
            st.saved[i] = true;
            st.mailNotes = st.mailNotes || {};
            // 이메일 주소를 저장하지 않으므로 자동 발송은 하지 않음 → 다시 받기를 안내
            if (savedId) st.mailNotes[i] = { ok: true, offer: !!app.linkEmail, text: CHANGED_NOTICE + (item.date ? ' 새 메일의 캘린더 버튼에 이 일정도 들어가요.' : '') };
            render();
          });
          row.append(label, sel, save);
          box.appendChild(row);
        }
      }
      wrap.appendChild(box);
    });
    return wrap;
  }

  // 저장 전에 날짜 고치기 (직접 고치면 "예상"이 아니라 내가 정한 날짜로 봄)
  function aiDateEditor(app, item, i) {
    const row = el('div', 'ai-date-row');
    const id = 'ai-date-' + app.plcyNo + '-' + i;
    const label = el('label', 'custom-label', item.date ? '날짜 고치기' : '날짜 넣기');
    label.htmlFor = id;
    const input = el('input', 'date-input');
    input.type = 'date';
    input.id = id;
    input.value = item.date || '';
    input.addEventListener('change', function () {
      item.date = input.value || null;
      item.dateType = input.value ? 'exact' : 'none';
      item.dateNote = '';
      render();
    });
    row.append(label, input);
    return row;
  }

  // AI가 찾은 항목(서류·할 일 등) 고치기·지우기 — 저장 전까지 화면 메모리에서만 바뀜
  const ITEM_KINDS = ['서류', '할 일', '준비물', '장소', '연락처'];
  function aiItemEditor(item) {
    const wrap = el('div', 'ai-items');
    item.items = item.items || [];
    if (!item.items.length) {
      wrap.appendChild(el('p', 'empty-note', '문자에 적힌 서류·할 일이 없어요.'));
      return wrap;
    }
    wrap.appendChild(el('p', 'custom-label', '문자에 적힌 항목 (고치거나 지운 뒤 저장할 수 있어요)'));
    const ul = el('ul', 'sub-checklist edit');
    item.items.forEach(function (x, k) {
      const li = el('li', 'sub-item');
      const kind = el('select', 'ai-kind');
      kind.setAttribute('aria-label', '항목 종류');
      ITEM_KINDS.forEach(function (name) { const o = el('option', null, name); o.value = name; kind.appendChild(o); });
      kind.value = ITEM_KINDS.indexOf(x.kind) !== -1 ? x.kind : '할 일';
      kind.addEventListener('change', function () { x.kind = kind.value; });
      const input = el('input', 'date-input ai-item-text');
      input.type = 'text';
      input.value = x.text;
      input.maxLength = 90;
      input.setAttribute('aria-label', '항목 내용');
      input.addEventListener('input', function () { x.text = input.value; });
      const del = el('button', 'mini-btn', '지우기');
      del.type = 'button';
      del.addEventListener('click', function () { item.items.splice(k, 1); render(); });
      li.append(kind, input, del);
      ul.appendChild(li);
    });
    wrap.appendChild(ul);
    return wrap;
  }

  // 지금 보고 있는 정책 (주소 끝 #p=정책번호). 없으면 목록 보기
  function currentView() {
    const m = /^#p=([0-9A-Za-z-]+)$/.exec(location.hash);
    return m && apps.items[m[1]] ? m[1] : null;
  }
  function openDetail(no, replace) {
    const url = location.pathname + '#p=' + no;
    if (replace && history.replaceState) history.replaceState(null, '', url); else location.hash = 'p=' + no;
  }

  function render() {
    const nos = Object.keys(apps.items);
    // 신청 날짜가 최근인 정책이 위로
    nos.sort(function (a, b) { return String(apps.items[b].appliedAt).localeCompare(String(apps.items[a].appliedAt)); });
    const view = currentView();
    const list = $('app-list');
    list.innerHTML = '';
    $('back-list').hidden = !view;
    if (view) {
      // 한 정책의 관리 화면
      $('now-card').hidden = true;
      $('list-title').hidden = true;
      list.appendChild(appCard(apps.items[view]));
    } else {
      // 목록 보기: 지금 할 일 + 관리 중인 정책 카드
      renderNow();
      nos.forEach(function (no) { list.appendChild(summaryCard(apps.items[no])); });
      $('list-title').hidden = !nos.length;
      $('list-title').textContent = '관리 중인 정책 ' + nos.length + '개';
    }
    list.classList.toggle('summary-list', !view);
    $('empty-card').hidden = nos.length > 0 || !$('start-card').hidden;
  }
  window.addEventListener('hashchange', function () { render(); window.scrollTo(0, 0); });

  // ===== 8. [신청했어요]로 들어왔을 때: 신청 날짜 → 관리 시작 =====
  const params = new URLSearchParams(location.search);
  const incomingNo = (params.get('plcyNo') || '').trim();

  function setupStart() {
    if (!incomingNo) return;
    if (apps.items[incomingNo]) {         // 이 탭에서 이미 관리 중이면 그 정책 관리 화면으로
      openDetail(incomingNo, true);
      return;
    }
    const p = policyByNo[incomingNo];
    if (!p) {
      showLoadMsg('정책 정보를 찾지 못했어요. 결과 화면에서 다시 [신청했어요]를 눌러 주세요.', true);
      clearQuery();
      return;
    }
    $('start-title').textContent = p.plcyNm;
    const dateInput = $('start-date');
    dateInput.value = ymd(today());
    dateInput.max = ymd(today());
    $('start-card').hidden = false;
    $('start-form').addEventListener('submit', function (e) {
      e.preventDefault();
      const v = dateInput.value;
      if (!parseYmd(v) || daysFromToday(v) > 0) {
        $('start-error').textContent = '신청한 날짜를 다시 확인해 주세요. 오늘 이후 날짜는 고를 수 없어요.';
        return;
      }
      apps.items[incomingNo] = {
        plcyNo: incomingNo, plcyNm: p.plcyNm, appliedAt: v, startedAt: new Date().toISOString(),
        steps: { applied: { done: true, doneAt: new Date().toISOString() } }, customDates: {},
        snapshot: makeSnapshot(p),        // 정책 정보 통째로 (마감돼서 목록에서 빠져도 그대로 보이게)
      };
      if (!saveApps()) return;
      $('start-card').hidden = true;
      openDetail(incomingNo, true);       // 주소의 ?plcyNo= 를 지우고 그 정책 관리 화면으로
      render();
      const target = document.getElementById('app-' + incomingNo);
      if (target) target.classList.add('flash');
    });
  }
  // 새로고침해도 같은 정책을 다시 시작하라고 묻지 않게 주소에서 ?plcyNo 를 뺌
  function clearQuery() {
    if (history.replaceState) history.replaceState(null, '', location.pathname);
  }

  // ===== 8-1. 메일의 [관리 화면 열기]로 들어왔을 때: ?d=…&sig=… → 관리 기록 되살리기 =====
  // - 서명 검사(api/restore-plan) 후 항상 링크 내용 기준으로 표시 (기기에 남은 기록이 없으니 링크가 기준)
  // - sessionStorage에만 넣음 (탭을 닫으면 사라짐)
  // - 끝나면 주소창에서 d·sig를 지움 (주소를 복사·공유해도 기록이 따라가지 않게)
  const linkD = params.get('d');
  const linkSig = params.get('sig');
  function restoreFromLink() {
    if (!linkD || !linkSig) return Promise.resolve();
    return fetch('api/restore-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ d: linkD, sig: linkSig }),
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) { return { status: res.status, data: data }; });
      })
      .then(function (r) {
        if (r.status === 200 && r.data && r.data.ok && r.data.record) {
          const rec = r.data.record;
          const no = rec.plcyNo;
          rec.restoredAt = new Date().toISOString();   // 메일 링크에서 되살린 기록이라는 표시
          rec.changed = false;
          // 제출 서류 체크 → 상세 패널·관리 화면이 함께 쓰는 서류 체크 저장소(sessionStorage)로
          if (Array.isArray(rec.docChecked)) {
            const checked = {};
            rec.docChecked.forEach(function (name) { checked[name] = true; });
            saveDocs(no, { checked: checked, updatedAt: new Date().toISOString() });
            delete rec.docChecked;
          }
          // 링크에 암호화돼 있던 이메일 → 이 탭의 기록에만 (입력칸 채우기용, 탭을 닫으면 사라짐)
          if (r.data.email) rec.linkEmail = r.data.email;
          apps.items[no] = rec;                         // 항상 링크 내용 기준
          if (saveApps()) showLoadMsg('메일 링크에서 관리 기록을 불러왔어요', false);
          if (history.replaceState) history.replaceState(null, '', location.pathname + '#p=' + no);
        } else {
          clearQuery();
          showLoadMsg((r.data && r.data.message) || '메일 링크에서 관리 기록을 불러오지 못했어요. 메일의 [관리 화면 열기]를 그대로 눌러 주세요.', true);
        }
      })
      .catch(function () {
        clearQuery();
        showLoadMsg('서버에 연결하지 못해서 관리 기록을 불러오지 못했어요. 잠시 후 메일의 링크를 다시 눌러 주세요.', true);
      });
  }

  // ===== 10. 시작: 정책 데이터 + 단계 데이터 불러오기 =====
  Promise.all([
    fetch(DATA_URL).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
    fetch(AFTER_STEPS_URL).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
  ]).then(function (res) {
    (res[0].policies || []).forEach(function (p) { policyByNo[p.plcyNo] = p; });
    afterData = res[1];
    dataLoaded = true;
    // 스냅샷 기능 이전에 저장된 기록은 지금 목록에 있으면 스냅샷을 채워 둠
    let filled = false;
    Object.keys(apps.items).forEach(function (no) {
      if (!apps.items[no].snapshot && policyByNo[no]) { apps.items[no].snapshot = makeSnapshot(policyByNo[no]); filled = true; }
    });
    if (filled) saveApps();
    showLoadMsg('');
    return restoreFromLink().then(function () {
      setupStart();
      render();
    });
  }).catch(function () {
    showLoadMsg('정책 정보를 불러오지 못했어요. 파일을 더블클릭해서 열었다면 로컬 서버(http://localhost)로 열어 주세요.', true);
    // 정책 목록이 없어도 메일 링크 복원과 저장된 기록은 보여줌 (링크에 스냅샷이 들어 있음)
    restoreFromLink().then(render);
  });
})();
