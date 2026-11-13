/* =========================================================
   캘린더 파일(.ics) + 구글 캘린더 링크 만들기 (send-plan.js가 씀)
   - 시간대: Asia/Seoul
   - exact  : 그 날짜 하루 종일 일정 + 하루 전(전날 오전 9시) 알림
   - monthly: 매월 1일 하루 종일 일정, 6회 반복, 그날 오전 9시 알림
   - none   : 매주 월요일 오전 9시 "안내 왔는지 확인", 4회 반복, 시작 시각 알림
   (_로 시작하는 파일이라 Vercel 주소로는 열리지 않음)
   ========================================================= */
'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const L = require('./_lib');

const TZ = 'Asia/Seoul';
const PRODID = '-//놓치지 마!//신청 후 관리//KO';
const MONTHLY_COUNT = 6;
const WEEKLY_COUNT = 4;

// ----- 날짜 계산 ("YYYY-MM-DD" 문자열끼리, 시간대 영향 없게 UTC로 계산) -----
function parse(ymd) { const p = ymd.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])); }
function fmt(d) { return d.toISOString().slice(0, 10); }
function addDays(ymd, n) { const d = parse(ymd); d.setUTCDate(d.getUTCDate() + n); return fmt(d); }
function compact(ymd) { return ymd.replace(/-/g, ''); }
// 오늘 이후 가장 가까운 월요일 (오늘이 월요일이면 다음 주 월요일 — 오늘 9시가 이미 지났을 수 있어서)
function nextMonday(today) {
  const dow = parse(today).getUTCDay();          // 0=일 … 1=월
  const add = ((8 - dow) % 7) || 7;
  return addDays(today, add);
}
// 다가오는 1일 (오늘이 1일이면 오늘)
function nextFirstOfMonth(today) {
  const d = parse(today);
  if (d.getUTCDate() === 1) return today;
  return fmt(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)));
}

// ----- 단계 → 캘린더 일정 정보 -----
// 돌려주는 값: null(일정 안 만듦) 또는 { kind, start, end, allDay, rrule, alarm, summary, alarmText }
function eventFor(step, today) {
  if (step.done) return null;
  if (step.type === 'exact') {
    if (!step.date || step.date < today) return null;       // 지난 날짜는 넣지 않음
    return {
      kind: 'exact', allDay: true, start: step.date, end: addDays(step.date, 1), rrule: '',
      alarm: '-PT15H',                                       // 하루 종일 일정은 0시 시작 → 15시간 전 = 전날 오전 9시
      summary: step.title, alarmText: '내일: ' + step.title,
    };
  }
  if (step.type === 'monthly') {
    const first = nextFirstOfMonth(today);
    return {
      kind: 'monthly', allDay: true, start: first, end: addDays(first, 1),
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;COUNT=' + MONTHLY_COUNT,
      alarm: 'PT9H',                                          // 그날 오전 9시
      summary: '이번 달 ' + step.title, alarmText: '이번 달 할 일: ' + step.title,
    };
  }
  // none / approx: 날짜를 모르니 매주 확인
  const mon = nextMonday(today);
  return {
    kind: 'none', allDay: false, start: mon, end: mon, rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=' + WEEKLY_COUNT,
    alarm: 'PT0M',
    summary: step.title + ' — 안내 왔는지 확인', alarmText: step.title + ' 안내가 왔는지 확인해 보세요',
  };
}

// ----- .ics 글자 규칙 -----
function esc(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
// 한 줄은 75바이트까지 (한글은 3바이트라 글자 중간에서 자르지 않게 글자 단위로 셈)
function fold(line) {
  const out = [];
  let cur = '', bytes = 0, limit = 75;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > limit) { out.push(cur); cur = ' '; bytes = 1; limit = 75; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}
function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }   // 20261112T080000Z
function uidPart(s) { return String(s).replace(/[^A-Za-z0-9-]/g, '').slice(0, 60) || 'x'; }

// ----- 단계에 딸린 항목(서류·할 일 등) → 일정 설명 글 -----
// 예: "준비할 서류: 주민등록등본, 졸업증명서, 통장 사본" (아직 안 한 항목만)
const KIND_LABEL = { '서류': '준비할 서류', '할 일': '할 일', '준비물': '준비물', '장소': '장소', '연락처': '연락처' };
function itemLines(step) {
  const groups = {}, order = [];
  (step.items || []).forEach(function (x) {
    if (x.done) return;
    const k = KIND_LABEL[x.kind] ? x.kind : '할 일';
    if (!groups[k]) { groups[k] = []; order.push(k); }
    groups[k].push(x.text);
  });
  return order.map(function (k) { return KIND_LABEL[k] + ': ' + groups[k].join(', '); });
}
function detailLines(step) {
  return [step.summary].concat(itemLines(step)).filter(Boolean);
}

// plan: { policyName, plcyNo, manageUrl }, steps: [{ id, title, type, date, done, note, warning, sourceUrl, summary, items }]
function buildIcs(plan, steps, today) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:' + PRODID, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + esc('놓치지 마! · ' + plan.policyName), 'X-WR-TIMEZONE:' + TZ,
    'BEGIN:VTIMEZONE', 'TZID:' + TZ,
    'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900', 'TZNAME:KST', 'END:STANDARD',
    'END:VTIMEZONE',
  ];
  let count = 0;
  const now = stamp();
  steps.forEach(function (s) {
    const ev = eventFor(s, today);
    if (!ev) return;
    count++;
    const desc = [plan.policyName].concat(detailLines(s), [s.note, s.warning ? '⚠ ' + s.warning : '', s.evidence ? '근거: ' + s.evidence : '',
      '관리 화면: ' + plan.manageUrl, s.sourceUrl ? '출처: ' + s.sourceUrl : '']).filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT');
    // 같은 정책·단계는 같은 UID → 다시 받으면 캘린더가 새로 만들지 않고 고쳐 씀
    lines.push('UID:' + uidPart(plan.plcyNo) + '-' + uidPart(s.id) + '-' + ev.kind + '@dontmiss');
    lines.push('DTSTAMP:' + now);
    if (ev.allDay) {
      lines.push('DTSTART;VALUE=DATE:' + compact(ev.start));
      lines.push('DTEND;VALUE=DATE:' + compact(ev.end));
    } else {
      lines.push('DTSTART;TZID=' + TZ + ':' + compact(ev.start) + 'T090000');
      lines.push('DTEND;TZID=' + TZ + ':' + compact(ev.start) + 'T091500');
    }
    if (ev.rrule) lines.push('RRULE:' + ev.rrule);
    lines.push('SUMMARY:' + esc('[놓치지 마!] ' + ev.summary));
    lines.push('DESCRIPTION:' + esc(desc));
    if (plan.manageUrl) lines.push('URL:' + plan.manageUrl);
    lines.push('TRANSP:TRANSPARENT');   // 다른 일정과 겹쳐도 "바쁨"으로 막지 않게
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + esc(ev.alarmText), 'TRIGGER:' + ev.alarm, 'END:VALARM');
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return { text: lines.map(fold).join('\r\n') + '\r\n', count: count };
}

// ----- 구글 캘린더 "일정 추가" 링크 (링크로는 알림을 넣을 수 없어서 일정만 추가됨) -----
function googleLink(plan, step, today) {
  const ev = eventFor(step, today);
  if (!ev) return '';
  const q = new URLSearchParams();
  q.set('action', 'TEMPLATE');
  q.set('text', '[놓치지 마!] ' + ev.summary);
  q.set('dates', ev.allDay
    ? compact(ev.start) + '/' + compact(ev.end)
    : compact(ev.start) + 'T090000/' + compact(ev.start) + 'T091500');
  q.set('ctz', TZ);
  if (ev.rrule) q.set('recur', 'RRULE:' + ev.rrule);
  q.set('details', [plan.policyName].concat(detailLines(step), [step.note, '관리 화면: ' + plan.manageUrl]).filter(Boolean).join('\n'));
  return 'https://calendar.google.com/calendar/render?' + q.toString();
}

// 메일에 보여줄 알림 설명
function alarmLabel(step, today) {
  const ev = eventFor(step, today);
  if (!ev) return '';
  if (ev.kind === 'exact') return '하루 전 알림';
  if (ev.kind === 'monthly') return '매월 1일 알림 (' + MONTHLY_COUNT + '회)';
  return '매주 월요일 오전 9시 확인 알림 (' + WEEKLY_COUNT + '회, ' + Number(ev.start.slice(5, 7)) + '/' + Number(ev.start.slice(8)) + '부터)';
}

// ----- 받은 단계 목록 정리 (send-plan.js, add-calendar.js가 함께 씀) -----
const MAX_STEPS = 15;
const TYPES = ['exact', 'approx', 'none', 'monthly'];
const ITEM_KINDS = ['서류', '할 일', '준비물', '장소', '연락처'];
const MAX_SUB_ITEMS = 10;
function cleanItems(list, maxText) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_SUB_ITEMS).map(function (x) {
    if (!x || typeof x !== 'object') return null;
    const text = L.oneLine(x.text, maxText || 90);
    if (!text) return null;
    const item = { kind: ITEM_KINDS.indexOf(x.kind) !== -1 ? x.kind : '할 일', text: text };
    if (x.done === true) item.done = true;
    return item;
  }).filter(Boolean);
}
function cleanSteps(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_STEPS).map(function (s) {
    if (!s || typeof s !== 'object') return null;
    const title = L.oneLine(s.title, 60);
    if (!title) return null;
    let type = TYPES.indexOf(s.type) !== -1 ? s.type : 'none';
    let date = L.isYmd(s.date) ? s.date : null;
    if (type === 'exact' && !date) type = 'none';
    if (type !== 'exact') date = null;
    return {
      id: L.oneLine(s.id, 40) || 'step',
      title: title, type: type, date: date, done: s.done === true,
      note: L.oneLine(s.note, 200), warning: L.oneLine(s.warning, 160), evidence: L.oneLine(s.evidence, 300),
      sourceUrl: L.safeUrl(s.sourceUrl),
      summary: L.oneLine(s.summary, 80), items: cleanItems(s.items),
    };
  }).filter(Boolean);
}

// ----- 서명된 "내 폰 캘린더에 추가" 링크 -----
// d   = 일정 데이터(JSON)를 압축해서 base64url로 바꾼 값
// sig = ICS_SIGN_SECRET으로 만든 HMAC 서명 → 우리가 만든 링크만 열리고, 남이 가짜 일정 파일을 못 만듦
const LINK_PATH = '/api/add-calendar';
const MAX_D_CHARS = 6000;               // 링크 데이터 최대 길이
const SIG_CHARS = 32;                   // 서명 길이 (base64url 32자 = 192비트)
const TYPE_CODE = { exact: 'e', approx: 'n', none: 'n', monthly: 'm' };
const CODE_TYPE = { e: 'exact', n: 'none', m: 'monthly' };

function sign(d, secret) {
  return crypto.createHmac('sha256', secret).update('cal-v1.' + d).digest('base64url').slice(0, SIG_CHARS);
}

const KIND_CODE = { '서류': 'd', '할 일': 't', '준비물': 'p', '장소': 'l', '연락처': 'c' };
const CODE_KIND = { d: '서류', t: '할 일', p: '준비물', l: '장소', c: '연락처' };

// 캘린더에 들어갈 단계만 짧게 담음 (끝난 단계·끝난 항목 제외, 빈 값 생략)
// itemChars: 항목 글자 수 제한 (링크가 너무 길면 줄여서 다시 만듦)
function packSteps(plan, steps, itemChars) {
  const urls = [];
  const s = steps.filter(function (x) { return !x.done; }).map(function (x) {
    let u = '';
    if (x.sourceUrl) { u = urls.indexOf(x.sourceUrl); if (u === -1) { urls.push(x.sourceUrl); u = urls.length - 1; } }
    const items = (x.items || []).filter(function (it) { return !it.done; })
      .map(function (it) { return (KIND_CODE[it.kind] || 't') + it.text.slice(0, itemChars || 90); });
    const row = [x.id, x.title, TYPE_CODE[x.type] || 'n', x.date || '', x.note || '', x.warning || '', x.evidence || '', u === '' ? '' : u,
      x.summary || '', items.length ? items : ''];
    while (row.length > 4 && (row[row.length - 1] === '' || row[row.length - 1] === undefined)) row.pop();   // 뒤쪽 빈 값 생략
    return row;
  });
  const json = JSON.stringify({ v: 1, n: plan.policyName, no: plan.plcyNo, u: urls, s: s });
  return zlib.deflateRawSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64url');
}

// 너무 길면: 항목을 앞 40자로 줄여서 → 그래도 길면 항목 없이 다시 만듦
function makeCalendarLink(base, plan, steps, secret) {
  if (!base || !secret) return '';
  const tries = [
    function () { return packSteps(plan, steps); },
    function () { return packSteps(plan, steps, 40); },
    function () { return packSteps(plan, steps.map(function (x) { return Object.assign({}, x, { items: [] }); })); },
  ];
  for (let i = 0; i < tries.length; i++) {
    const d = tries[i]();
    if (d.length <= MAX_D_CHARS) return base + LINK_PATH + '?d=' + d + '&sig=' + sign(d, secret);
  }
  return '';
}

// 돌려주는 값: { plan, steps } 또는 { error: 'bad_sig' | 'bad_data' }
function readCalendarLink(d, sig, secret) {
  d = String(d || ''); sig = String(sig || '');
  if (!d || d.length > MAX_D_CHARS || !/^[A-Za-z0-9_-]+$/.test(d)) return { error: 'bad_data' };
  const expected = Buffer.from(sign(d, secret));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { error: 'bad_sig' };
  let obj;
  try {
    // 압축 폭탄 방지: 풀었을 때 64KB까지만
    obj = JSON.parse(zlib.inflateRawSync(Buffer.from(d, 'base64url'), { maxOutputLength: 64 * 1024 }).toString('utf8'));
  } catch (e) { return { error: 'bad_data' }; }
  if (!obj || obj.v !== 1 || !Array.isArray(obj.s)) return { error: 'bad_data' };
  const urls = Array.isArray(obj.u) ? obj.u : [];
  const steps = cleanSteps(obj.s.map(function (r) {
    if (!Array.isArray(r)) return null;
    return { id: r[0], title: r[1], type: CODE_TYPE[r[2]] || 'none', date: r[3] || null, note: r[4], warning: r[5], evidence: r[6],
      sourceUrl: typeof r[7] === 'number' ? urls[r[7]] : '', summary: r[8] || '',
      items: Array.isArray(r[9]) ? r[9].map(function (t) { t = String(t || ''); return { kind: CODE_KIND[t[0]] || '할 일', text: t.slice(1) }; }) : [] };
  }));
  const plan = { policyName: L.oneLine(obj.n, 120), plcyNo: L.oneLine(obj.no, 40).replace(/[^0-9A-Za-z-]/g, '') };
  if (!plan.policyName || !steps.length) return { error: 'bad_data' };
  return { plan: plan, steps: steps };
}

module.exports = {
  buildIcs, googleLink, alarmLabel, eventFor, nextMonday, nextFirstOfMonth, itemLines, cleanItems,
  cleanSteps, makeCalendarLink, readCalendarLink, LINK_PATH,
};
