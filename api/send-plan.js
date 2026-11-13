/* =========================================================
   POST /api/send-plan — 신청 후 관리 메일 + 캘린더 추가 버튼 (첨부 파일 없음)
   받는 값: { email, mode: "full" | "update", plan: { policyName, plcyNo, appliedAt },
            steps: [{ id, title, type: "exact"|"approx"|"none"|"monthly", date, done, note, warning, evidence, sourceUrl }],
            record: 관리 기록(복원 링크용, api/_plan.js가 허용한 항목만 씀 — 이메일·설문 답 없음) }
     full   : 전체 단계 타임라인 + 모든 일정
     update : 안내 문자에서 새로 저장한 일정만
   메일 맨 위 [📱 내 폰 캘린더에 추가] → /api/add-calendar (서명된 링크, add-calendar.js)
     앱 안의 브라우저면 사파리·크롬으로 넘겨서 "모두 추가"까지 이어짐
   버튼이 안 될 때: 단계별 구글 캘린더 링크 (최대 5개)
   스팸으로 분류되지 않게 링크는 최소로: 관리 화면 1개 + 캘린더 버튼 1개 + 구글 캘린더 최대 5개
   (단계별 "출처 확인" 링크는 넣지 않음 — 출처는 관리 화면에서 확인)
   HTML 메일과 같은 내용의 글 버전(text/plain)도 함께 보냄
   (.ics 첨부는 하지 않음 — 메일 앱에서 미리보기만 되거나 회의 초대로 보이는 문제가 있어서 버튼 하나로 통일)
   이후 알림은 사용자 캘린더가 담당 (매일 자동 메일 없음)
   키는 환경변수(GMAIL_USER, GMAIL_APP_PASSWORD, ICS_SIGN_SECRET)에서만 읽음
   ========================================================= */
'use strict';

const nodemailer = require('nodemailer');
const L = require('./_lib');
const ICS = require('./_ics');
const PLAN = require('./_plan');   // [관리 화면 열기] 복원 링크 (다른 브라우저에서도 관리 기록이 열리게)

// ===== 1. 설정 =====
const MAX_BODY_BYTES = 24 * 1024;
const SAME_EMAIL_WAIT_MS = 30 * 1000;   // 같은 주소·같은 종류 메일은 30초에 한 번
const SAME_IP_WAIT_MS = 10 * 1000;
const LINK_WARN_CHARS = 2000;            // 이보다 긴 링크는 일부 메일 앱에서 잘릴 수 있음
// 링크에 관리 기록·(암호화된) 이메일이 들어 있어서, 다른 사람에게 전달하지 않도록 안내
const PRIVATE_LINK_NOTE = '이 메일의 링크는 본인만 사용해 주세요.';
const MAX_GOOGLE_LINKS = 5;               // 구글 캘린더 링크는 최대 5개 (링크가 많으면 스팸으로 분류되기 쉬움)
const BUTTON_HINT ="누르면 사파리(안드로이드는 크롬)로 넘어가요. 거기서 '모두 추가'를 눌러 주세요.";

const C = {
  text: '#1E2340', muted: '#5d6280', line: '#e3e5ef', accent: '#2F6BFF', soft: '#eef3ff',
  red: '#e5484d', redSoft: '#fdecec', green: '#157a48', greenSoft: '#e6f6ed',
};

// ===== 2. 메일 본문 =====
function prettyDate(ymd) {
  const p = ymd.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return p[1] + '월 ' + p[2] + '일 (' + '일월화수목금토'[d.getUTCDay()] + ')';
}
function dateText(s) {
  if (s.type === 'exact' && s.date) return prettyDate(s.date);
  if (s.type === 'monthly') return '매월 반복';
  return '날짜 미정';
}
function link(text, url, size) {
  return '<a href="' + L.escapeHtml(url) + '" style="color:' + C.accent + ';font-size:' + (size || 13) + 'px;font-weight:700;text-decoration:none;">' + L.escapeHtml(text) + '</a>';
}

// 단계에 딸린 항목(서류·할 일 등) — 체크한 항목은 ☑ + 흐리게
function itemsHtml(s) {
  if (!s.items || !s.items.length) return '';
  return '<div style="margin-top:6px;">' + s.items.map(function (x) {
    return '<div style="font-size:13px;line-height:1.6;color:' + (x.done ? C.muted : C.text) + ';' + (x.done ? 'text-decoration:line-through;' : '') + '">' +
      (x.done ? '☑ ' : '☐ ') + '<span style="color:' + C.muted + ';">[' + L.escapeHtml(x.kind) + ']</span> ' + L.escapeHtml(x.text) + '</div>';
  }).join('') + '</div>';
}

function stepRow(s, i, today) {
  const done = s.done;
  const mark = done
    ? '<div style="width:24px;height:24px;border-radius:50%;background:' + C.accent + ';color:#fff;font-size:13px;font-weight:700;text-align:center;line-height:24px;">✓</div>'
    : '<div style="width:20px;height:20px;border-radius:50%;border:2px solid ' + C.accent + ';color:' + C.accent + ';font-size:12px;font-weight:700;text-align:center;line-height:20px;">' + (i + 1) + '</div>';
  const alarm = ICS.alarmLabel(s, today);
  return '<tr>' +
    '<td valign="top" style="width:34px;padding:12px 0;">' + mark + '</td>' +
    '<td style="padding:12px 0;border-bottom:1px solid ' + C.line + ';">' +
    '<div style="font-size:15px;font-weight:700;color:' + (done ? C.muted : C.text) + ';' + (done ? 'text-decoration:line-through;' : '') + '">' + L.escapeHtml(s.title) + '</div>' +
    '<div style="font-size:13px;font-weight:700;color:' + C.accent + ';margin-top:2px;">' + L.escapeHtml(dateText(s)) + (alarm && !done ? ' · ' + L.escapeHtml(alarm) : '') + (done ? ' · 완료' : '') + '</div>' +
    (s.summary ? '<div style="font-size:13px;color:' + C.text + ';margin-top:3px;">' + L.escapeHtml(s.summary) + '</div>' : '') +
    itemsHtml(s) +
    (s.note ? '<div style="font-size:13px;color:' + C.muted + ';margin-top:3px;">' + L.escapeHtml(s.note) + '</div>' : '') +
    (s.evidence ? '<div style="font-size:12px;color:' + C.muted + ';margin-top:3px;border-left:3px solid #d5dcf3;padding-left:8px;">근거: “' + L.escapeHtml(s.evidence) + '”</div>' : '') +
    (s.warning ? '<div style="font-size:13px;font-weight:700;color:' + C.red + ';background:' + C.redSoft + ';border-radius:8px;padding:6px 10px;margin-top:6px;">⚠ ' + L.escapeHtml(s.warning) + '</div>' : '') +
    '</td></tr>';
}

// 맨 위 큰 버튼 하나 (링크를 못 만들면 버튼 없이 아래 구글 캘린더 링크만)
function topBox(calLink, icsCount) {
  if (!icsCount || !calLink) return '';
  return '<tr><td align="center" style="padding:20px 24px 0;">' +
    '<a href="' + L.escapeHtml(calLink) + '" style="display:block;background:' + C.accent + ';color:#ffffff;font-size:18px;font-weight:700;text-decoration:none;border-radius:14px;padding:16px 18px;text-align:center;">📱 내 폰 캘린더에 추가</a>' +
    '<div style="font-size:13px;color:' + C.muted + ';margin-top:8px;">' + L.escapeHtml(BUTTON_HINT) + '</div>' +
    '<div style="font-size:12px;color:' + C.muted + ';margin-top:2px;">일정 ' + icsCount + '개, 알림 포함</div>' +
    '</td></tr>';
}

// 구글 캘린더 링크: 아직 안 한 단계 중 링크를 만들 수 있는 것 앞에서부터 최대 5개
function googleLinks(plan, steps, today) {
  const all = steps.filter(function (s) { return !s.done; })
    .map(function (s) { return { title: s.title, href: ICS.googleLink(plan, s, today) }; })
    .filter(function (g) { return g.href; });
  return { list: all.slice(0, MAX_GOOGLE_LINKS), rest: Math.max(0, all.length - MAX_GOOGLE_LINKS) };
}
function restNote(n) { return '나머지 일정 ' + n + '개는 [내 폰 캘린더에 추가] 버튼이나 관리 화면에서 추가해 주세요.'; }

// 아래쪽 작게: 버튼이 안 될 때 → 단계별 구글 캘린더 링크만
function fallbackBox(plan, steps, today, calLink, icsCount) {
  if (!icsCount) return '';
  const g = googleLinks(plan, steps, today);
  if (!g.list.length) return '';
  const gLinks = g.list.map(function (x) { return '<div style="padding:3px 0;">' + link('+ ' + x.title, x.href, 12) + '</div>'; }).join('') +
    (g.rest ? '<div style="padding-top:4px;">' + L.escapeHtml(restNote(g.rest)) + '</div>' : '');
  return '<tr><td style="padding:18px 24px 0;"><div style="background:#f6f7fb;border-radius:12px;padding:12px 14px;font-size:12px;line-height:1.6;color:' + C.muted + ';">' +
    '<b style="color:' + C.text + ';">' + (calLink ? '버튼이 안 될 때' : '캘린더에 추가하기') + '</b><br>' +
    '구글 캘린더에 하나씩 추가 (알림은 캘린더 기본 설정을 따라요):' + gLinks +
    '</div></td></tr>';
}

function buildHtml(plan, steps, mode, icsCount, today, calLink) {
  const title = mode === 'update' ? '새 일정을 캘린더에 넣어 드려요' : '신청 후 할 일을 정리했어요';
  const intro = mode === 'update'
    ? '안내 문자에서 찾아 저장한 일정이에요.'
    : (plan.appliedAt ? prettyDate(plan.appliedAt) + '에 신청한 정책의 다음 단계예요.' : '신청한 정책의 다음 단계예요.');
  // 복원 링크: 다른 브라우저에서 열어도 이 메일 시점의 관리 기록이 되살아남
  const openUrl = plan.manageLink || plan.manageUrl;
  const manageBtn = openUrl
    ? '<tr><td style="padding:18px 24px 0;">' + link('관리 화면 열기 →', openUrl, 14) +
      '<div style="font-size:12px;color:' + C.muted + ';margin-top:4px;">' + (plan.manageLink ? '내 관리 기록은 이 링크로만 열려요. 다른 폰·브라우저에서 열어도 이 메일을 보낸 때의 기록이 그대로 열려요. 화면에서 바꾼 내용은 [관리 메일 다시 받기]로 새 메일을 받아야 저장돼요.' : '이 메일에는 관리 기록을 담지 못했어요. 관리 화면에서 다시 시작해 주세요.') + '</div></td></tr>'
    : '';
  const rows = steps.map(function (s, i) { return stepRow(s, i, today); }).join('');

  return '<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:#ffffff;font-family:\'Malgun Gothic\',\'Apple SD Gothic Neo\',sans-serif;color:' + C.text + ';">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;"><tr><td align="center" style="padding:24px 12px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;border:1px solid ' + C.line + ';border-radius:16px;">' +
    '<tr><td style="padding:24px 24px 0;">' +
    '<div style="font-size:13px;font-weight:700;color:' + C.accent + ';">놓치지 마! · 신청 후 관리</div>' +
    '<div style="font-size:21px;font-weight:700;margin-top:4px;">' + L.escapeHtml(plan.policyName) + '</div>' +
    '<div style="font-size:14px;color:' + C.muted + ';margin-top:4px;">' + L.escapeHtml(title) + '. ' + L.escapeHtml(intro) + '</div>' +
    '</td></tr>' +
    topBox(calLink, icsCount) +
    '<tr><td style="padding:16px 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">' + rows + '</table></td></tr>' +
    manageBtn +
    fallbackBox(plan, steps, today, calLink, icsCount) +
    '<tr><td style="padding:22px 24px 24px;">' +
    '<div style="font-size:12px;color:' + C.muted + ';line-height:1.7;border-top:1px solid ' + C.line + ';padding-top:14px;">' +
    '정보는 온통청년 공공데이터와 공식 공고 기준이에요. 안내 받은 날짜가 다르면 안내를 따라 주세요.<br>' +
    '시연용 서비스라 매일 자동 메일은 보내지 않아요. 이후 알림은 캘린더가 담당해요.<br>' +
    '<b style="color:' + C.text + ';">' + L.escapeHtml(PRIVATE_LINK_NOTE) + '</b>' +
    '</div></td></tr>' +
    '</table></td></tr></table></body></html>';
}

function buildText(plan, steps, today, mode, calLink) {
  const lines = ['[놓치지 마!] ' + plan.policyName + ' 신청 후 할 일', ''];
  if (calLink) lines.push('📱 내 폰 캘린더에 추가: ' + calLink, BUTTON_HINT, '');
  steps.forEach(function (s, i) {
    lines.push((s.done ? '[완료] ' : (i + 1) + '. ') + s.title + ' — ' + dateText(s) + (s.done ? '' : (ICS.alarmLabel(s, today) ? ' · ' + ICS.alarmLabel(s, today) : '')));
    if (s.summary) lines.push('   ' + s.summary);
    (s.items || []).forEach(function (x) { lines.push('   ' + (x.done ? '[v] ' : '[ ] ') + '[' + x.kind + '] ' + x.text); });
    if (s.note) lines.push('   ' + s.note);
    if (s.warning) lines.push('   ⚠ ' + s.warning);
    if (s.evidence) lines.push('   근거: "' + s.evidence + '"');
  });
  if (plan.manageLink || plan.manageUrl) lines.push('', '관리 화면: ' + (plan.manageLink || plan.manageUrl));
  // 버튼이 안 될 때: 단계별 구글 캘린더 링크
  const g = googleLinks(plan, steps, today);
  if (g.list.length) {
    lines.push('', (calLink ? '버튼이 안 될 때 — ' : '') + '구글 캘린더에 하나씩 추가:');
    g.list.forEach(function (x) { lines.push('- ' + x.title + ': ' + x.href); });
    if (g.rest) lines.push(restNote(g.rest));
  }
  lines.push('', '정보는 온통청년 공공데이터와 공식 공고 기준이에요. 안내 받은 날짜가 다르면 안내를 따라 주세요.');
  lines.push('시연용 서비스라 매일 자동 메일은 보내지 않아요. 이후 알림은 캘린더가 담당해요.');
  lines.push('', PRIVATE_LINK_NOTE);
  return lines.join('\n');
}

// ===== 3. 요청 처리 =====
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return L.fail(res, 405, 'POST 요청만 받을 수 있어요.');

  const got = L.getBody(req, MAX_BODY_BYTES);
  if (got.error === 'too_large') return L.fail(res, 413, '보낼 내용이 너무 커요.');
  if (got.error) return L.fail(res, 400, '요청 형식이 올바르지 않아요.');
  const body = got.body;

  const email = L.str(body.email, 254).toLowerCase();
  if (!L.isEmail(email)) return L.fail(res, 400, '이메일 주소 형식을 다시 확인해 주세요.');
  const mode = body.mode === 'update' ? 'update' : 'full';
  const rawPlan = body.plan && typeof body.plan === 'object' ? body.plan : {};
  const policyName = L.oneLine(rawPlan.policyName, 120);
  if (!policyName) return L.fail(res, 400, '정책 정보가 없어요. 관리 화면을 새로고침한 뒤 다시 시도해 주세요.');
  const plcyNo = L.oneLine(rawPlan.plcyNo, 40).replace(/[^0-9A-Za-z-]/g, '');
  const steps = ICS.cleanSteps(body.steps);
  if (!steps.length) return L.fail(res, 400, '메일에 넣을 단계가 없어요.');

  const base = L.publicBaseUrl(req);
  const plan = {
    policyName: policyName,
    plcyNo: plcyNo,
    appliedAt: L.isYmd(rawPlan.appliedAt) ? rawPlan.appliedAt : '',
    manageUrl: base ? base + '/manage.html' : '',
  };

  const user = process.env.GMAIL_USER;
  const pass = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!user || !pass) return L.fail(res, 500, '메일 발송 설정이 아직 안 돼 있어요. (서버 환경변수 확인 필요)');

  // 전체 메일 직후 새 일정을 저장해도 막히지 않게 종류(full/update)별로 따로 셈
  const waitIp = L.tooSoon('plan-ip-' + mode + ':' + L.clientIp(req), SAME_IP_WAIT_MS);
  if (waitIp) return L.fail(res, 429, waitIp + '초 뒤에 다시 시도해 주세요.', { retryAfter: waitIp });
  const waitMail = L.tooSoon('plan-' + mode + ':' + email, SAME_EMAIL_WAIT_MS);
  if (waitMail) return L.fail(res, 429, '같은 주소로 방금 보냈어요. ' + waitMail + '초 뒤에 다시 시도해 주세요.', { retryAfter: waitMail });

  const today = L.todayKst();
  const ics = ICS.buildIcs(plan, steps, today);
  // 서명 비밀값이나 서비스 주소가 없으면 버튼 없이 구글 캘린더 링크만 보냄
  const calLink = ics.count ? ICS.makeCalendarLink(base, plan, steps, process.env.ICS_SIGN_SECRET) : '';
  // [관리 화면 열기] 복원 링크 (정책번호가 같은 기록만, 6,000자 넘으면 완료 체크 빼고 → 그래도 넘으면 기본 링크)
  const record = body.record && typeof body.record === 'object' && String(body.record.plcyNo || '') === plcyNo ? body.record : null;
  // 받는 사람 이메일은 암호화해서 링크에 넣음 → 링크로 열면 입력칸에 채워짐 (링크 글자에는 주소가 안 보임)
  const manage = PLAN.makeManageLink(base, record, process.env.ICS_SIGN_SECRET, email);
  plan.manageLink = manage.level === 'basic' ? '' : manage.url;   // 구글 캘린더 일정 설명에는 기본 주소(plan.manageUrl)만 씀
  if (!calLink && ics.count) console.warn('[send-plan] 캘린더 버튼 링크를 만들지 못함 (ICS_SIGN_SECRET 또는 PUBLIC_BASE_URL 확인)');
  if (calLink.length > LINK_WARN_CHARS) console.warn('[send-plan] 캘린더 링크가 김: ' + calLink.length + '자');
  // 제목: 스팸으로 분류되지 않게 느낌표·이모지·특수문자 없이 짧게 (정책명 속 특수문자도 정리)
  const subjectName = policyName.replace(/[!?~★☆♥♡※▶◀■□●○◆◇“”"'`^*#@$%&|<>{}\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const subject = mode === 'update'
    ? '놓치지 마 - ' + subjectName + ' 새 일정 안내'
    : '놓치지 마 - ' + subjectName + ' 신청 후 할 일 정리';

  try {
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: user, pass: pass } });
    await transporter.sendMail({
      from: { name: '놓치지 마', address: user },
      to: email,
      subject: subject,
      text: buildText(plan, steps, today, mode, calLink),
      html: buildHtml(plan, steps, mode, ics.count, today, calLink),
      // 첨부 파일 없음 — 캘린더 추가는 버튼 하나로 통일
    });
    return L.send(res, 200, { ok: true, events: ics.count, calendarButton: !!calLink, linkLength: calLink.length, manageLink: manage.level, manageLinkLength: plan.manageLink.length });
  } catch (err) {
    console.error('[send-plan] 발송 실패:', err && err.code, err && err.responseCode, err && err.message);
    if (err && err.code === 'EAUTH') return L.fail(res, 502, '메일 서버 로그인에 실패해서 보내지 못했어요. (서버의 Gmail 앱 비밀번호 확인 필요)');
    if (err && err.code === 'EENVELOPE') return L.fail(res, 400, '이 주소로는 메일을 보낼 수 없어요. 주소를 다시 확인해 주세요.');
    return L.fail(res, 502, '메일을 보내지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
};

// 미리보기·테스트용 (주소로는 열리지 않음)
module.exports.buildHtml = buildHtml;
module.exports.buildText = buildText;
