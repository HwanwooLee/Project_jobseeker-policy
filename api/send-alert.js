/* =========================================================
   POST /api/send-alert — 알림 메일 즉시 발송 (시연용, 1회)
   받는 값: { email, urgentPolicies[], topPolicies[], applications[] }
     정책: { name, dDay(숫자|null), period("open"|"always"|"unknown"), level("ok"|"check"), url }
     신청: { name, todo, nextDate("YYYY-MM-DD"|"") }
   Gmail 앱 비밀번호로 보냄. 키는 환경변수(GMAIL_USER, GMAIL_APP_PASSWORD)에서만 읽음.
   ========================================================= */
'use strict';

const nodemailer = require('nodemailer');
const L = require('./_lib');

// ===== 1. 설정 =====
const MAX_BODY_BYTES = 16 * 1024;     // 받는 데이터 크기 제한 (16KB)
const SAME_EMAIL_WAIT_MS = 30 * 1000; // 같은 주소로 30초 안에 다시 보내지 않음
const SAME_IP_WAIT_MS = 10 * 1000;    // 같은 곳에서 10초 안에 다시 요청하지 않음
const SUBJECT = '[놓치지 마!] 오늘 챙길 정책 할 일';
const EMAIL_RE = /^[^\s@<>"',;:()\[\]\\]+@[^\s@<>"',;:()\[\]\\]+\.[A-Za-z]{2,}$/;

const C = {
  text: '#1E2340', muted: '#5d6280', line: '#e3e5ef', accent: '#2F6BFF', soft: '#eef3ff',
  red: '#e5484d', redSoft: '#fdecec', green: '#157a48', greenSoft: '#e6f6ed', orange: '#b85400', orangeSoft: '#fff1e3',
};

// ===== 2. 받은 값 정리 (모르는 값·너무 긴 값은 버림) =====
function cleanPolicies(list, max) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, max).map(function (p) {
    if (!p || typeof p !== 'object') return null;
    const name = L.oneLine(p.name, 120);
    if (!name) return null;
    const dDay = Number.isInteger(p.dDay) && p.dDay >= 0 && p.dDay < 3650 ? p.dDay : null;
    const period = ['open', 'always', 'unknown'].indexOf(p.period) !== -1 ? p.period : 'unknown';
    return {
      name: name,
      dDay: period === 'open' ? dDay : null,
      period: period,
      level: p.level === 'check' ? 'check' : 'ok',
      url: L.safeUrl(p.url),
    };
  }).filter(Boolean);
}

function cleanApplications(list, max) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, max).map(function (a) {
    if (!a || typeof a !== 'object') return null;
    const name = L.oneLine(a.name, 120);
    if (!name) return null;
    return { name: name, todo: L.oneLine(a.todo, 120), nextDate: L.isYmd(a.nextDate) ? a.nextDate : '' };
  }).filter(Boolean);
}

// ===== 3. 메일 본문 (HTML, 흰 배경) =====
function ddayLabel(p) {
  if (p.period === 'always') return '상시';
  if (p.period !== 'open' || p.dDay === null) return '기간 확인 필요';
  return p.dDay === 0 ? 'D-Day' : 'D-' + p.dDay;
}

function pill(text, color, bg) {
  return '<span style="display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700;color:' + color +
    ';background:' + bg + ';white-space:nowrap;">' + L.escapeHtml(text) + '</span>';
}

function policyRow(p, forceRed) {
  const urgent = forceRed || (p.period === 'open' && p.dDay !== null && p.dDay <= 3);
  const dday = urgent ? pill(ddayLabel(p), C.red, C.redSoft) : pill(ddayLabel(p), C.muted, '#eef0f5');
  const level = p.level === 'ok' ? pill('조건 일치', C.green, C.greenSoft) : pill('추가 확인 필요', C.orange, C.orangeSoft);
  const link = p.url
    ? '<a href="' + L.escapeHtml(p.url) + '" style="color:' + C.accent + ';font-size:13px;font-weight:700;text-decoration:none;">신청·공고 보기 →</a>'
    : '';
  return '<tr><td style="padding:12px 0;border-bottom:1px solid ' + C.line + ';">' +
    '<div style="margin-bottom:6px;">' + dday + ' ' + level + '</div>' +
    '<div style="font-size:15px;font-weight:700;color:' + C.text + ';line-height:1.4;">' + L.escapeHtml(p.name) + '</div>' +
    (link ? '<div style="margin-top:4px;">' + link + '</div>' : '') +
    '</td></tr>';
}

function section(title, rowsHtml) {
  return '<tr><td style="padding:22px 24px 4px;">' +
    '<div style="font-size:16px;font-weight:700;color:' + C.text + ';margin-bottom:4px;">' + L.escapeHtml(title) + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">' + rowsHtml + '</table>' +
    '</td></tr>';
}

function prettyDate(ymd) {
  const p = ymd.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return p[1] + '월 ' + p[2] + '일 (' + '일월화수목금토'[d.getUTCDay()] + ')';
}

function buildHtml(urgent, top, apps) {
  let body = '';
  if (urgent.length) body += section('① 마감 임박 정책 (7일 이내)', urgent.map(function (p) { return policyRow(p, true); }).join(''));
  if (top.length) body += section((urgent.length ? '②' : '①') + ' 내 조건에 맞는 정책', top.map(function (p) { return policyRow(p, false); }).join(''));
  if (apps.length) {
    const n = (urgent.length ? 1 : 0) + (top.length ? 1 : 0) + 1;
    const rows = apps.map(function (a) {
      return '<tr><td style="padding:12px 0;border-bottom:1px solid ' + C.line + ';">' +
        '<div style="font-size:13px;color:' + C.muted + ';">' + L.escapeHtml(a.name) + '</div>' +
        '<div style="font-size:15px;font-weight:700;color:' + C.text + ';margin-top:2px;">' + L.escapeHtml(a.todo || '다음 안내 기다리는 중') + '</div>' +
        (a.nextDate ? '<div style="font-size:13px;color:' + C.accent + ';font-weight:700;margin-top:2px;">다음 일정 · ' + prettyDate(a.nextDate) + '</div>' : '') +
        '</td></tr>';
    }).join('');
    body += section(['①', '②', '③'][n - 1] + ' 신청한 정책의 지금 할 일', rows);
  }

  return '<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:#ffffff;font-family:\'Malgun Gothic\',\'Apple SD Gothic Neo\',sans-serif;color:' + C.text + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;"><tr><td align="center" style="padding:24px 12px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;border:1px solid ' + C.line + ';border-radius:16px;">' +
    '<tr><td style="padding:24px 24px 0;">' +
    '<div style="font-size:13px;font-weight:700;color:' + C.accent + ';">놓치지 마!</div>' +
    '<div style="font-size:22px;font-weight:700;margin-top:4px;">오늘 챙길 정책 할 일</div>' +
    '</td></tr>' +
    body +
    '<tr><td style="padding:22px 24px 24px;">' +
    '<div style="font-size:12px;color:' + C.muted + ';line-height:1.7;border-top:1px solid ' + C.line + ';padding-top:14px;">' +
    '정보는 온통청년 공공데이터 기준이에요. 신청 전 공식 공고를 확인하세요.<br>' +
    '시연용 서비스라 이 메일은 1회만 발송돼요.' +
    '</div></td></tr>' +
    '</table></td></tr></table></body></html>';
}

// 메일 앱이 HTML을 못 보여줄 때를 위한 글 버전
function buildText(urgent, top, apps) {
  const lines = ['[놓치지 마!] 오늘 챙길 정책 할 일', ''];
  if (urgent.length) { lines.push('■ 마감 임박 정책 (7일 이내)'); urgent.forEach(function (p) { lines.push('- [' + ddayLabel(p) + '] ' + p.name + (p.url ? ' ' + p.url : '')); }); lines.push(''); }
  if (top.length) { lines.push('■ 내 조건에 맞는 정책'); top.forEach(function (p) { lines.push('- [' + ddayLabel(p) + '] ' + p.name + (p.url ? ' ' + p.url : '')); }); lines.push(''); }
  if (apps.length) { lines.push('■ 신청한 정책의 지금 할 일'); apps.forEach(function (a) { lines.push('- ' + a.name + ': ' + (a.todo || '다음 안내 기다리는 중') + (a.nextDate ? ' (' + a.nextDate + ')' : '')); }); lines.push(''); }
  lines.push('정보는 온통청년 공공데이터 기준이에요. 신청 전 공식 공고를 확인하세요.');
  lines.push('시연용 서비스라 이 메일은 1회만 발송돼요.');
  return lines.join('\n');
}

// ===== 4. 요청 처리 =====
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return L.fail(res, 405, 'POST 요청만 받을 수 있어요.');

  const got = L.getBody(req, MAX_BODY_BYTES);
  if (got.error === 'too_large') return L.fail(res, 413, '보낼 내용이 너무 커요.');
  if (got.error) return L.fail(res, 400, '요청 형식이 올바르지 않아요.');
  const body = got.body;

  const email = L.str(body.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) return L.fail(res, 400, '이메일 주소 형식을 다시 확인해 주세요.');

  const urgent = cleanPolicies(body.urgentPolicies, 5).filter(function (p) { return p.period === 'open' && p.dDay !== null && p.dDay <= 7; });
  const top = cleanPolicies(body.topPolicies, 5);
  const apps = cleanApplications(body.applications, 10);
  if (!urgent.length && !top.length && !apps.length) return L.fail(res, 400, '메일에 넣을 정책 정보가 없어요. 결과 화면을 새로고침한 뒤 다시 시도해 주세요.');

  const user = process.env.GMAIL_USER;
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');   // 구글 화면의 띄어쓰기 제거
  if (!user || !pass) return L.fail(res, 500, '메일 발송 설정이 아직 안 돼 있어요. (서버 환경변수 확인 필요)');

  // 반복 요청 막기 (형식 검사를 통과한 요청만 기록)
  const waitIp = L.tooSoon('ip:' + L.clientIp(req), SAME_IP_WAIT_MS);
  if (waitIp) return L.fail(res, 429, waitIp + '초 뒤에 다시 시도해 주세요.', { retryAfter: waitIp });
  const waitMail = L.tooSoon('mail:' + email, SAME_EMAIL_WAIT_MS);
  if (waitMail) return L.fail(res, 429, '같은 주소로 방금 보냈어요. ' + waitMail + '초 뒤에 다시 시도해 주세요.', { retryAfter: waitMail });

  try {
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: user, pass: pass } });
    await transporter.sendMail({
      from: { name: '놓치지 마!', address: user },
      to: email,
      subject: SUBJECT,
      text: buildText(urgent, top, apps),
      html: buildHtml(urgent, top, apps),
    });
    return L.send(res, 200, { ok: true });
  } catch (err) {
    // 자세한 오류는 서버 기록에만 (비밀번호 등은 nodemailer가 오류 메시지에 넣지 않음)
    console.error('[send-alert] 발송 실패:', err && err.code, err && err.responseCode, err && err.message);
    if (err && err.code === 'EAUTH') return L.fail(res, 502, '메일 서버 로그인에 실패해서 보내지 못했어요. (서버의 Gmail 앱 비밀번호 확인 필요)');
    if (err && err.code === 'EENVELOPE') return L.fail(res, 400, '이 주소로는 메일을 보낼 수 없어요. 주소를 다시 확인해 주세요.');
    return L.fail(res, 502, '메일을 보내지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
};

// 메일 미리보기·테스트용 (주소로는 열리지 않음)
module.exports.buildHtml = buildHtml;
