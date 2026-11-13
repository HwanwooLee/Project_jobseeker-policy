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

// ----- .ics 글자 규칙 (RFC 5545) -----
// 1) 정리: 제어 문자·이모지 제거 (아이폰 캘린더가 이상한 글자에서 멈추지 않게), 줄바꿈은 \n 하나로
const CONTROL_RE = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0000}-\u{E007F}]/gu;
function cleanText(text, maxChars) {
  let t = String(text || '').replace(/\r\n?/g, '\n').replace(CONTROL_RE, ' ').replace(EMOJI_RE, '')
    .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  if (maxChars && Array.from(t).length > maxChars) t = Array.from(t).slice(0, maxChars - 1).join('') + '…';
  return t;
}
// 2) TEXT 값 이스케이프: \ → \\, ; → \;, , → \,, 줄바꿈 → \n (실제 줄바꿈은 남기지 않음)
function esc(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
// SUMMARY·DESCRIPTION·LOCATION 같은 글자 속성 한 줄
function textProp(name, text, maxChars) { return name + ':' + esc(cleanText(text, maxChars)); }
const DESC_MAX = 500;          // DESCRIPTION 최대 글자 수
const SUMMARY_MAX = 120;
// 3) 한 줄은 75바이트까지. 바이트로 세되 한글(3바이트) 글자 중간과 "\," 같은 이스케이프 두 글자 사이에서는 자르지 않음.
//    이어지는 줄은 공백 한 칸으로 시작 (그 공백도 75바이트에 포함)
function fold(line) {
  const units = String(line).match(/\\.|[\s\S]/gu) || [];   // 이스케이프(\x)는 한 덩어리, 나머지는 글자 하나씩
  // 띄어쓰기 바로 앞에서는 접지 않음 (이어지는 줄이 공백 두 칸으로 시작하면 공백을 같이 지우는 캘린더가 있어서)
  //  → 그럴 땐 한 글자 앞에서 접어 그 글자를 다음 줄로 넘김
  const out = [];
  let cur = [], bytes = 0;
  units.forEach(function (u) {
    const b = Buffer.byteLength(u, 'utf8');
    if (bytes + b > 75) {
      let carry = [];
      if (u === ' ' && cur.length > 2) carry = [cur.pop()];
      out.push(cur.join(''));
      cur = [' '].concat(carry);
      bytes = 1 + carry.reduce(function (n, x) { return n + Buffer.byteLength(x, 'utf8'); }, 0);
    }
    cur.push(u); bytes += b;
  });
  out.push(cur.join(''));
  return out.join('\r\n');
}
// 메모에는 관리 링크를 넣지 않음 (링크에 관리 기록이 담겨 길고, 본인만 써야 해서)
const MANAGE_NOTE = '관리 화면은 받은 메일의 [관리 화면 열기]로 들어가세요.';
function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }   // 20261112T080000Z
// UID: 영문·숫자·@·- 만, 짧게. 같은 정책·단계·종류면 늘 같은 값 → 다시 받으면 캘린더가 새로 만들지 않고 고쳐 씀
function uidOf(plcyNo, stepId, kind) {
  const h = crypto.createHash('sha256').update(String(plcyNo) + '|' + String(stepId) + '|' + String(kind)).digest('hex').slice(0, 20);
  return 'dm-' + h + '@dontmiss';
}

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
// [장소] 항목 → 일정의 장소(LOCATION)
function placeOf(step) {
  return (step.items || []).filter(function (x) { return x.kind === '장소' && !x.done; })
    .map(function (x) { return x.text; }).join(' / ');
}
function detailLines(step) {
  return [step.summary].concat(itemLines(step)).filter(Boolean);
}

// plan: { policyName, plcyNo, siteUrl(사이트 주소, 짧게) }, steps: [{ id, title, type, date, done, note, warning, sourceUrl, summary, items }]
function buildIcs(plan, steps, today) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:' + PRODID, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    textProp('X-WR-CALNAME', '놓치지 마 · ' + plan.policyName, SUMMARY_MAX), 'X-WR-TIMEZONE:' + TZ,
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
    const desc = [plan.policyName].concat(detailLines(s), [s.note, s.warning ? '주의: ' + s.warning : '', s.evidence ? '근거: ' + s.evidence : '',
      MANAGE_NOTE, s.sourceUrl ? '출처: ' + s.sourceUrl : '']).filter(Boolean).join('\n');
    const place = placeOf(s);
    lines.push('BEGIN:VEVENT');
    // 같은 정책·단계는 같은 UID → 다시 받으면 캘린더가 새로 만들지 않고 고쳐 씀
    lines.push('UID:' + uidOf(plan.plcyNo, s.id, ev.kind));
    lines.push('DTSTAMP:' + now);
    if (ev.allDay) {
      lines.push('DTSTART;VALUE=DATE:' + compact(ev.start));
      lines.push('DTEND;VALUE=DATE:' + compact(ev.end));
    } else {
      lines.push('DTSTART;TZID=' + TZ + ':' + compact(ev.start) + 'T090000');
      lines.push('DTEND;TZID=' + TZ + ':' + compact(ev.start) + 'T091500');
    }
    if (ev.rrule) lines.push('RRULE:' + ev.rrule);
    lines.push(textProp('SUMMARY', '[놓치지 마] ' + ev.summary, SUMMARY_MAX));
    lines.push(textProp('DESCRIPTION', desc, DESC_MAX));
    if (place) lines.push(textProp('LOCATION', place, 200));
    if (/^https?:\/\/[A-Za-z0-9.:-]+$/.test(plan.siteUrl || '')) lines.push('URL:' + plan.siteUrl);   // 사이트 주소만 (긴 링크 금지)
    lines.push('TRANSP:TRANSPARENT');   // 다른 일정과 겹쳐도 "바쁨"으로 막지 않게
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', textProp('DESCRIPTION', ev.alarmText, SUMMARY_MAX), 'TRIGGER:' + ev.alarm, 'END:VALARM');
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
  q.set('text', cleanText('[놓치지 마] ' + ev.summary, SUMMARY_MAX));
  q.set('dates', ev.allDay
    ? compact(ev.start) + '/' + compact(ev.end)
    : compact(ev.start) + 'T090000/' + compact(ev.start) + 'T091500');
  q.set('ctz', TZ);
  if (ev.rrule) q.set('recur', 'RRULE:' + ev.rrule);
  q.set('details', cleanText([plan.policyName].concat(detailLines(step), [step.note, MANAGE_NOTE]).filter(Boolean).join('\n'), DESC_MAX));
  const place = placeOf(step);
  if (place) q.set('location', cleanText(place, 200));
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
      estimated: s.estimated === true && type === 'exact',   // 예상 날짜 (캘린더에는 그대로 하루 전 알림)
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
  cleanSteps, makeCalendarLink, readCalendarLink, LINK_PATH, esc, fold, cleanText, textProp, uidOf, stamp, TZ, PRODID, MANAGE_NOTE,
};
