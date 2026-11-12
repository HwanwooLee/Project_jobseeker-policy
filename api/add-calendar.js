/* =========================================================
   GET /api/add-calendar?d=<일정데이터>&sig=<서명> — 메일의 [📱 내 폰 캘린더에 추가] 버튼이 여는 주소
   처리 순서
   1) 서명(ICS_SIGN_SECRET) 검사 — 맞을 때만 아래로 (틀리면 기기와 관계없이 400)
   2) 앱 안의 브라우저(네이버·카카오톡·인스타그램 등)면 → 기본 브라우저로 넘김
        아이폰  : 카카오톡이면 kakaotalk://web/openExternal 먼저, 아니면 x-safari-https:// (사파리)
        안드로이드: 카카오톡이면 kakaotalk://web/openExternal 먼저, 아니면 intent://…package=com.android.chrome (크롬)
        자동으로 안 넘어갈 때를 위해 안내 페이지([사파리/크롬으로 열기], [링크 복사])도 함께 보여줌
   3) 기본 브라우저
        아이폰·맥 사파리 → .ics를 바로 보여줌 (inline) → "모두 추가" 창
        안드로이드 크롬·PC → 안내 페이지 ([캘린더 파일 받기] = &dl=1 다운로드 / 구글 캘린더 링크)
   ========================================================= */
'use strict';

const L = require('./_lib');
const ICS = require('./_ics');

const FILE_NAME = 'dontmiss-plan.ics';

// ----- 기기·브라우저 판별 (User-Agent) -----
// 앱 안의 브라우저: 네이버, 카카오톡, 인스타그램, 페이스북, 라인, 다음, 에브리타임, 안드로이드 웹뷰(; wv)
const IN_APP_RE = /NAVER\(inapp|NAVER|KAKAOTALK|Instagram|FBAN|FBAV|FB_IAB|\bLine\/|DaumApps|everytimeApp|; wv\)/i;
function isInApp(ua) { return IN_APP_RE.test(ua); }
function isKakao(ua) { return /KAKAOTALK/i.test(ua); }
function isIOS(ua) { return /iPhone|iPad|iPod/i.test(ua); }
function isAndroid(ua) { return /Android/i.test(ua); }
function isApple(ua) {
  if (isIOS(ua)) return true;
  // 아이패드는 맥처럼 보이게 접속하기도 함. 맥 사파리도 .ics를 바로 캘린더로 열 수 있음
  return /Macintosh/i.test(ua) && /Safari/i.test(ua) && !/Chrome|CriOS|Edg|Firefox|FxiOS|OPR/i.test(ua);
}

// ----- 다른 앱으로 넘길 주소 (서명 검사를 통과한 d·sig로 다시 만듦 — 요청 주소를 그대로 쓰지 않음) -----
function selfUrl(req, d, sig) {
  const base = L.publicBaseUrl(req) || ('https://' + String(req.headers.host || '').replace(/[^A-Za-z0-9.:-]/g, ''));
  return base + ICS.LINK_PATH + '?d=' + d + '&sig=' + sig;
}
function safariUrl(url) { return 'x-safari-' + url; }                       // x-safari-https://…
function chromeIntent(url) {
  const u = new URL(url);
  return 'intent://' + u.host + u.pathname + u.search + '#Intent;scheme=' + u.protocol.replace(':', '') + ';package=com.android.chrome;end';
}
function kakaoExternal(url) { return 'kakaotalk://web/openExternal?url=' + encodeURIComponent(url); }

// ----- 화면 (흰 배경, 간단한 안내) -----
const STYLE = 'body{margin:0;background:#fff;color:#1E2340;font-family:"Malgun Gothic","Apple SD Gothic Neo",sans-serif;line-height:1.6}' +
  '.w{max-width:520px;margin:0 auto;padding:28px 18px 40px}.k{font-size:13px;font-weight:700;color:#2F6BFF}h1{font-size:22px;margin:4px 0 6px}' +
  '.m{color:#5d6280;font-size:14px}.b{display:block;width:100%;box-sizing:border-box;text-align:center;background:#2F6BFF;color:#fff;font:inherit;font-weight:700;font-size:17px;' +
  'text-decoration:none;border:0;border-radius:999px;padding:15px 18px;margin:20px 0 8px;cursor:pointer}' +
  '.b2{background:#fff;color:#2F6BFF;border:2px solid #2F6BFF;margin-top:4px}' +
  '.box{background:#f6f7fb;border-radius:14px;padding:14px 16px;margin-top:18px;font-size:14px}.box h2{font-size:15px;margin:0 0 8px}' +
  '.g{display:block;color:#2F6BFF;font-weight:700;text-decoration:none;padding:8px 0;border-bottom:1px solid #e3e5ef}.g:last-child{border-bottom:0}' +
  '.s{font-size:12px;color:#5d6280}.ok{color:#157a48;font-weight:700;font-size:14px;min-height:1.4em;text-align:center}' +
  '.u{font-size:11px;color:#5d6280;word-break:break-all;background:#f6f7fb;border-radius:10px;padding:8px 10px;margin-top:10px}';

function page(res, status, title, bodyHtml, script) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end('<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + L.escapeHtml(title) + '</title><style>' + STYLE + '</style></head><body><div class="w">' + bodyHtml + '</div>' +
    (script ? '<script>' + script + '</script>' : '') + '</body></html>');
}

// 앱 안의 브라우저 → 기본 브라우저로 자동 이동 + 안 될 때 안내
function openOutsidePage(res, ua, url) {
  const ios = isIOS(ua);
  const browser = ios ? '사파리' : '크롬';
  const openHref = ios ? safariUrl(url) : (isAndroid(ua) ? chromeIntent(url) : url);
  const first = isKakao(ua) ? kakaoExternal(url) : openHref;      // 카카오톡은 카카오톡 방식부터
  // JS 문자열에 넣을 때 </script> 등이 끼지 않게 JSON + < 이스케이프
  const js = function (s) { return JSON.stringify(s).replace(/</g, '\\u003c'); };
  const script =
    'var first=' + js(first) + ',second=' + js(openHref) + ',url=' + js(url) + ';' +
    // 자동 이동: 첫 방법 → 0.8초 뒤에도 페이지에 남아 있으면 두 번째 방법
    'setTimeout(function(){location.href=first;},50);' +
    'if(first!==second){setTimeout(function(){if(!document.hidden)location.href=second;},800);}' +
    'document.getElementById("copy").addEventListener("click",function(){' +
    ' var done=function(){document.getElementById("msg").textContent="링크를 복사했어요. ' + browser + ' 주소창에 붙여넣어 주세요.";};' +
    ' if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(url).then(done,fallback);}else{fallback();}' +
    ' function fallback(){var t=document.createElement("textarea");t.value=url;t.setAttribute("readonly","");t.style.position="fixed";t.style.opacity="0";' +
    '  document.body.appendChild(t);t.select();t.setSelectionRange(0,url.length);try{document.execCommand("copy");done();}' +
    '  catch(e){document.getElementById("msg").textContent="아래 주소를 길게 눌러 복사해 주세요.";}document.body.removeChild(t);}' +
    '});';
  return page(res, 200, browser + '에서 열기',
    '<div class="k">놓치지 마!</div>' +
    '<h1>' + browser + '에서 열어야 캘린더에 추가돼요</h1>' +
    '<p class="m">지금은 앱 안의 브라우저라 캘린더에 바로 넣을 수 없어요. ' + browser + '로 넘어가는 중이에요.</p>' +
    '<a class="b" href="' + L.escapeHtml(openHref) + '">' + browser + '로 열기</a>' +
    '<button type="button" class="b b2" id="copy">링크 복사</button>' +
    '<p class="ok" id="msg" role="status"></p>' +
    '<p class="s">자동으로 안 넘어가면 [링크 복사]를 누른 뒤 ' + browser + ' 주소창에 붙여넣어 주세요.</p>' +
    '<p class="u">' + L.escapeHtml(url) + '</p>',
    script);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return L.fail(res, 405, 'GET 요청만 받을 수 있어요.');

  const secret = process.env.ICS_SIGN_SECRET;
  if (!secret) return page(res, 500, '설정 필요', '<div class="k">놓치지 마!</div><h1>캘린더 추가 설정이 아직 안 돼 있어요</h1><p class="m">메일의 구글 캘린더 링크로 추가해 주세요.</p>');

  // 1) 서명 검사 — 어떤 기기·앱이든 가장 먼저
  const q = new URL(req.url, 'http://localhost').searchParams;
  const d = q.get('d'), sig = q.get('sig');
  const got = ICS.readCalendarLink(d, sig, secret);
  if (got.error) {
    return page(res, 400, '링크 오류', '<div class="k">놓치지 마!</div><h1>링크가 올바르지 않아요</h1>' +
      '<p class="m">메일에 있던 버튼을 그대로 눌러 주세요. 계속 안 되면 메일의 구글 캘린더 링크로 추가해 주세요.</p>');
  }

  const ua = String(req.headers['user-agent'] || '');
  const url = selfUrl(req, d, sig);

  // 2) 앱 안의 브라우저 → 기본 브라우저로
  if (isInApp(ua)) return openOutsidePage(res, ua, url);

  const today = L.todayKst();
  const base = L.publicBaseUrl(req);
  const plan = Object.assign({}, got.plan, { manageUrl: base ? base + '/manage.html' : '' });
  const ics = ICS.buildIcs(plan, got.steps, today);
  if (!ics.count) {
    return page(res, 200, '추가할 일정 없음', '<div class="k">놓치지 마!</div><h1>지금 캘린더에 넣을 일정이 없어요</h1>' +
      '<p class="m">날짜가 이미 지났거나 모든 단계를 마쳤어요. 새 안내를 받으면 관리 화면에서 날짜를 입력해 주세요.</p>');
  }

  // 3) 기본 브라우저: 아이폰·맥 사파리는 바로 보여주기(inline) → "모두 추가" / [캘린더 파일 받기]는 다운로드
  const download = q.get('dl') === '1';
  if (download || isApple(ua)) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', (download && !isApple(ua) ? 'attachment' : 'inline') + '; filename="' + FILE_NAME + '"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.end(req.method === 'HEAD' ? undefined : ics.text);
  }

  // 안드로이드 크롬·PC: 안내 페이지
  const dlHref = ICS.LINK_PATH + '?d=' + d + '&sig=' + sig + '&dl=1';
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

// 테스트용
module.exports.isInApp = isInApp;
