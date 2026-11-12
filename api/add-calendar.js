/* =========================================================
   GET /api/add-calendar?d=<일정데이터>&sig=<서명> — 메일의 [📱 내 폰 캘린더에 추가] 버튼이 여는 주소
   - 서명(ICS_SIGN_SECRET)이 맞을 때만 .ics를 만들어 줌 → 아무나 우리 주소로 가짜 일정 파일을 못 만듦
   - 기기별 처리
       아이폰·아이패드·맥 사파리 → .ics를 바로 보여줌 (inline) → "모두 추가" 창이 뜸
       그 밖(안드로이드·PC 크롬 등) → 안내 페이지
           [캘린더 파일 받기] = 같은 주소 + &dl=1 → .ics 다운로드 (attachment) → 삼성 캘린더 등으로 열기
           구글 캘린더 앱만 쓰는 경우 → 일정별 "구글 캘린더에 추가" 링크
             (안드로이드 구글 캘린더 앱은 .ics 파일을 직접 가져오지 못해서)
   ========================================================= */
'use strict';

const L = require('./_lib');
const ICS = require('./_ics');

const FILE_NAME = 'dontmiss-plan.ics';

function isApple(ua) {
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // 아이패드는 맥처럼 보이게 접속하기도 함. 맥 사파리도 .ics를 바로 캘린더로 열 수 있음
  return /Macintosh/i.test(ua) && /Safari/i.test(ua) && !/Chrome|CriOS|Edg|Firefox|FxiOS|OPR/i.test(ua);
}

function page(res, status, title, bodyHtml) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end('<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + L.escapeHtml(title) + '</title>' +
    '<style>body{margin:0;background:#fff;color:#1E2340;font-family:"Malgun Gothic","Apple SD Gothic Neo",sans-serif;line-height:1.6}' +
    '.w{max-width:520px;margin:0 auto;padding:28px 18px 40px}.k{font-size:13px;font-weight:700;color:#2F6BFF}h1{font-size:22px;margin:4px 0 6px}' +
    '.m{color:#5d6280;font-size:14px}.b{display:block;text-align:center;background:#2F6BFF;color:#fff;font-weight:700;font-size:17px;text-decoration:none;border-radius:999px;padding:15px 18px;margin:20px 0 8px}' +
    '.box{background:#f6f7fb;border-radius:14px;padding:14px 16px;margin-top:18px;font-size:14px}.box h2{font-size:15px;margin:0 0 8px}' +
    '.box ol,.box ul{margin:0;padding-left:20px}.g{display:block;color:#2F6BFF;font-weight:700;text-decoration:none;padding:8px 0;border-bottom:1px solid #e3e5ef}' +
    '.g:last-child{border-bottom:0}.s{font-size:12px;color:#5d6280}</style></head><body><div class="w">' + bodyHtml + '</div></body></html>');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return L.fail(res, 405, 'GET 요청만 받을 수 있어요.');

  const secret = process.env.ICS_SIGN_SECRET;
  if (!secret) return page(res, 500, '설정 필요', '<div class="k">놓치지 마!</div><h1>캘린더 추가 설정이 아직 안 돼 있어요</h1><p class="m">메일에 첨부된 캘린더 파일을 열어 주세요.</p>');

  const url = new URL(req.url, 'http://localhost');
  const got = ICS.readCalendarLink(url.searchParams.get('d'), url.searchParams.get('sig'), secret);
  if (got.error) {
    return page(res, 400, '링크 오류', '<div class="k">놓치지 마!</div><h1>링크가 올바르지 않아요</h1>' +
      '<p class="m">메일에 있던 링크를 그대로 눌러 주세요. 계속 안 되면 메일에 첨부된 캘린더 파일을 열어 주세요.</p>');
  }

  const today = L.todayKst();
  const base = L.publicBaseUrl(req);
  const plan = Object.assign({}, got.plan, { manageUrl: base ? base + '/manage.html' : '' });
  const ics = ICS.buildIcs(plan, got.steps, today);
  if (!ics.count) {
    return page(res, 200, '추가할 일정 없음', '<div class="k">놓치지 마!</div><h1>지금 캘린더에 넣을 일정이 없어요</h1>' +
      '<p class="m">날짜가 이미 지났거나 모든 단계를 마쳤어요. 새 안내를 받으면 관리 화면에서 날짜를 입력해 주세요.</p>');
  }

  const ua = String(req.headers['user-agent'] || '');
  const download = url.searchParams.get('dl') === '1';

  // 아이폰·맥 사파리: 바로 보여주기(inline) → "모두 추가" / [캘린더 파일 받기]: 다운로드(attachment)
  if (download || isApple(ua)) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', (download && !isApple(ua) ? 'attachment' : 'inline') + '; filename="' + FILE_NAME + '"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.end(req.method === 'HEAD' ? undefined : ics.text);
  }

  // 안드로이드 등: 안내 페이지
  const dlHref = req.url + (req.url.indexOf('?') === -1 ? '?' : '&') + 'dl=1';
  const gLinks = got.steps.map(function (s) {
    const href = ICS.googleLink(plan, s, today);
    return href ? '<a class="g" href="' + L.escapeHtml(href) + '" target="_blank" rel="noopener">+ ' + L.escapeHtml(s.title) +
      ' <span class="s">(' + L.escapeHtml(ICS.alarmLabel(s, today)) + ')</span></a>' : '';
  }).join('');
  return page(res, 200, '캘린더에 추가', '<div class="k">놓치지 마!</div>' +
    '<h1>' + L.escapeHtml(plan.policyName) + '</h1>' +
    '<p class="m">신청 후 일정 ' + ics.count + '개를 캘린더에 넣을게요. 알림도 함께 들어가요.</p>' +
    '<a class="b" href="' + L.escapeHtml(dlHref) + '">📅 캘린더 파일 받기</a>' +
    '<p class="s">받은 파일(' + FILE_NAME + ')을 누르고 <b>삼성 캘린더</b> 같은 캘린더 앱을 고른 뒤 "저장/가져오기"를 눌러 주세요.</p>' +
    '<div class="box"><h2>구글 캘린더 앱만 쓴다면</h2><p class="s" style="margin:0 0 6px">구글 캘린더 앱은 파일을 직접 못 가져와서, 아래를 하나씩 눌러 추가해 주세요. (알림은 캘린더 기본 설정을 따라요)</p>' + gLinks + '</div>' +
    '<div class="box"><h2>아이폰이라면</h2><p class="s" style="margin:0">이 페이지를 <b>사파리</b>로 열면 "모두 추가" 창이 바로 떠요.</p></div>');
};
