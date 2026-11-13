/* =========================================================
   ⚠ 테스트 전용 — 아이폰 캘린더 저장 문제 원인 찾기가 끝나면 이 파일과 ics-test.html을 지울 것
   GET /api/ics-test?v=A~F — 서명 없이 같은 예시 데이터로 .ics를 만들어 보여 줌 (개인 정보 없음)
     A: 제목 + 날짜만
     B: A + 장소 + 짧은 메모 (링크 없음)
     C: B + URL 칸에 긴 관리 링크 (관리 데이터가 든 링크와 비슷한 길이의 가짜 링크)
     D: 지금 실제로 나가는 것과 같은 전체 버전 (이번 수정 후)
     E: 매주 반복(RRULE) 있는 버전
     F: 이번 수정 전에 실제로 나가던 버전 (URL 칸·메모에 관리 화면 주소, 긴 출처 주소)
   ========================================================= */
'use strict';

const crypto = require('crypto');
const L = require('./_lib');
const ICS = require('./_ics');

const POLICY = '자립준비청년 디지털 진로지원';
const PLCY_NO = '20260000000000000000';    // 테스트용 가짜 정책번호
const STEP = '대면 상담 참석';
const PLACE = 'DX캠퍼스, 가산디지털단지역 도보 5분 거리';
const MEMO = '대면 상담에 참석해 주세요';
// 고용24처럼 긴 출처 주소 (수정 전 메모에 그대로 들어가던 모양)
const LONG_SOURCE = 'https://www.work24.go.kr/hr/a/a/1100/trnnCrsInf8.do?dtlContextPath=&redirectUrl=%2Fa%2Fa%2F1100%2FtrnnCrsInf8Post.do&topArea=&programMenuIdentification=EBG020000001538&menuPurpSecd=EBM01&currentMenuId=EBG020040400100&action=trnnCrsInf8Post.do&pageId=12';

function addDays(ymd, n) {
  const p = ymd.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
}
function compact(ymd) { return ymd.replace(/-/g, ''); }

// 달력 껍데기 (실제 버전과 같은 머리말·시간대)
function wrap(events) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:' + ICS.PRODID, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    ICS.textProp('X-WR-CALNAME', '놓치지 마 · ' + POLICY, 120), 'X-WR-TIMEZONE:' + ICS.TZ,
    'BEGIN:VTIMEZONE', 'TZID:' + ICS.TZ,
    'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900', 'TZNAME:KST', 'END:STANDARD',
    'END:VTIMEZONE',
  ].concat(events, ['END:VCALENDAR']);
  return lines.map(ICS.fold).join('\r\n') + '\r\n';
}
// 하루 종일 일정 하나 (opts: place, memo, url, alarm)
function allDayEvent(date, opts) {
  const ev = [
    'BEGIN:VEVENT', 'UID:' + ICS.uidOf(PLCY_NO, 'test-' + opts.v, 'exact'), 'DTSTAMP:' + ICS.stamp(),
    'DTSTART;VALUE=DATE:' + compact(date), 'DTEND;VALUE=DATE:' + compact(addDays(date, 1)),
    ICS.textProp('SUMMARY', '[놓치지 마] ' + STEP, 120),
  ];
  if (opts.memo) ev.push(ICS.textProp('DESCRIPTION', opts.memo, 500));
  if (opts.place) ev.push(ICS.textProp('LOCATION', opts.place, 200));
  if (opts.url) ev.push('URL:' + opts.url);
  ev.push('TRANSP:TRANSPARENT');
  if (opts.alarm) ev.push('BEGIN:VALARM', 'ACTION:DISPLAY', ICS.textProp('DESCRIPTION', '내일: ' + STEP, 120), 'TRIGGER:-PT15H', 'END:VALARM');
  ev.push('END:VEVENT');
  return ev;
}

function build(v, base, today) {
  const date = addDays(today, 10);
  const site = base || 'https://example.vercel.app';
  if (v === 'A') return wrap(allDayEvent(date, { v: v }));
  if (v === 'B') return wrap(allDayEvent(date, { v: v, place: PLACE, memo: MEMO }));
  if (v === 'C') {
    // 관리 데이터가 든 링크와 비슷한 길이 (약 1,500자)의 가짜 링크
    const fake = site + '/manage.html?d=' + crypto.randomBytes(1050).toString('base64url') + '&sig=' + crypto.randomBytes(24).toString('base64url');
    return wrap(allDayEvent(date, { v: v, place: PLACE, memo: MEMO, url: fake }));
  }
  if (v === 'E') {
    // 실제 "날짜 미정 → 매주 월요일 확인" 일정과 같은 모양 (시간 있는 일정 + RRULE)
    const mon = ICS.nextMonday(today);
    return wrap([
      'BEGIN:VEVENT', 'UID:' + ICS.uidOf(PLCY_NO, 'test-E', 'none'), 'DTSTAMP:' + ICS.stamp(),
      'DTSTART;TZID=' + ICS.TZ + ':' + compact(mon) + 'T090000', 'DTEND;TZID=' + ICS.TZ + ':' + compact(mon) + 'T091500',
      'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4',
      ICS.textProp('SUMMARY', '[놓치지 마] ' + STEP + ' — 안내 왔는지 확인', 120),
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM', 'ACTION:DISPLAY', ICS.textProp('DESCRIPTION', STEP + ' 안내가 왔는지 확인해 보세요', 120), 'TRIGGER:PT0M', 'END:VALARM',
      'END:VEVENT',
    ]);
  }
  // D: 실제 코드(buildIcs) 그대로 — 요약·[장소]·서류 항목·메모·근거·출처까지
  const steps = ICS.cleanSteps([{
    id: 'ai-test', title: STEP, type: 'exact', date: date, done: false,
    summary: '25일 오후 세 시까지 DX캠퍼스로 대면 상담 참석', note: MEMO,
    evidence: '25일 오후 세 시까지 DX캠퍼스로 집결해 주세요.', sourceUrl: LONG_SOURCE,
    items: [{ kind: '장소', text: PLACE }, { kind: '서류', text: '신분증' }, { kind: '준비물', text: '필기구' }],
  }]);
  if (v === 'D') return ICS.buildIcs({ policyName: POLICY, plcyNo: PLCY_NO, siteUrl: site }, steps, today).text;
  // F: 이번 수정 전 모양 — URL 칸에 관리 화면 주소, 메모에 "관리 화면: 주소", 예전 UID
  const s = steps[0];
  const memo = [POLICY, s.summary, '장소: ' + PLACE, '준비할 서류: 신분증', '준비물: 필기구', s.note, '근거: ' + s.evidence,
    '관리 화면: ' + site + '/manage.html', '출처: ' + LONG_SOURCE].join('\n');
  const ev = allDayEvent(date, { v: v, place: PLACE, memo: memo, url: site + '/manage.html', alarm: true });
  ev[1] = 'UID:' + PLCY_NO + '-ai-test-exact@dontmiss';
  return wrap(ev);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return L.fail(res, 405, 'GET 요청만 받을 수 있어요.');
  const v = String(new URL(req.url, 'http://localhost').searchParams.get('v') || '').toUpperCase();
  if (['A', 'B', 'C', 'D', 'E', 'F'].indexOf(v) === -1) return L.fail(res, 400, 'v는 A~F 중 하나예요.');
  const wait = L.rateLimit('ics-test:' + L.clientIp(req), 30, 60 * 1000);
  if (wait) return L.fail(res, 429, '잠시 후 다시 시도해 주세요', { retryAfter: wait });
  const text = build(v, L.publicBaseUrl(req), L.todayKst());
  // 실제 [내 폰 캘린더에 추가]와 같은 응답 방식 (사파리에서 바로 열림)
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="dontmiss-test-' + v + '.ics"');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.end(req.method === 'HEAD' ? undefined : text);
};
