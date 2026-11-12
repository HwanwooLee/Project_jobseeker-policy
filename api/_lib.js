/* =========================================================
   api 공용 도구 (Vercel은 _로 시작하는 파일을 주소로 열지 않음)
   - 요청 크기 제한, 반복 요청 막기, 글 정리, HTML 이스케이프
   ========================================================= */
'use strict';

// ----- 같은 요청 반복 막기 (서버 메모리 기준: 서버가 다시 켜지면 초기화되는 가벼운 장치) -----
const lastHit = new Map();
// key로 ms 안에 다시 오면 남은 초를 돌려줌, 아니면 0 (그리고 지금 시각을 기록)
function tooSoon(key, ms) {
  const now = Date.now();
  const last = lastHit.get(key) || 0;
  if (now - last < ms) return Math.ceil((ms - (now - last)) / 1000);
  lastHit.set(key, now);
  if (lastHit.size > 5000) lastHit.clear();   // 메모리가 계속 늘지 않게
  return 0;
}

// key로 windowMs 안에 max번까지 허용. 넘으면 다시 가능할 때까지 남은 초, 아니면 0 (그리고 이번 호출을 기록)
const hitLog = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const recent = (hitLog.get(key) || []).filter(function (t) { return now - t < windowMs; });
  if (recent.length >= max) {
    hitLog.set(key, recent);
    return Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
  }
  recent.push(now);
  hitLog.set(key, recent);
  if (hitLog.size > 5000) hitLog.clear();
  return 0;
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  const ip = xf ? String(xf).split(',')[0] : (req.socket && req.socket.remoteAddress) || '';
  return ip.trim() || 'unknown';
}

// ----- 요청 본문 읽기 + 크기 제한 -----
// Vercel은 JSON을 req.body로 미리 읽어 줌. dev-server.js도 같은 모양으로 넣어 줌.
function getBody(req, maxBytes) {
  const len = Number(req.headers['content-length'] || 0);
  if (len > maxBytes) return { error: 'too_large' };
  let body = req.body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > maxBytes) return { error: 'too_large' };
    try { body = JSON.parse(body); } catch (e) { return { error: 'bad_json' }; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'bad_json' };
  if (Buffer.byteLength(JSON.stringify(body)) > maxBytes) return { error: 'too_large' };
  return { body: body };
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

// 사용자에게 보여줄 오류 (쉬운 말)
function fail(res, status, message, extra) {
  send(res, status, Object.assign({ ok: false, message: message }, extra || {}));
}

// ----- 글 정리 -----
// 제어 문자 제거 + 앞뒤 공백 제거 + 최대 길이
function str(value, max) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);
}
function oneLine(value, max) {
  return str(value, max).replace(/\s+/g, ' ');
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// http(s) 주소만 허용
function safeUrl(value) {
  const u = str(value, 500);
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(u)) return '';
  return u;
}
function isYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}
// 한국 시간 기준 오늘 (서버가 UTC로 돌아도 날짜가 하루 밀리지 않게)
function todayKst() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// ----- 이메일 주소 검사 -----
const EMAIL_RE = /^[^\s@<>"',;:()\[\]\\]+@[^\s@<>"',;:()\[\]\\]+\.[A-Za-z]{2,}$/;
function isEmail(s) { return typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s); }

// ----- 메일에 넣을 우리 서비스 주소 -----
// 화면이 보낸 주소를 믿지 않고 서버가 정함: 배포 땐 PUBLIC_BASE_URL, 로컬에선 localhost일 때만 요청 주소
function publicBaseUrl(req) {
  const fixed = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^\s/]+$/i.test(fixed)) return fixed;
  const host = String(req.headers.host || '');
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return 'http://' + host;
  return '';
}

module.exports = { tooSoon, rateLimit, clientIp, getBody, send, fail, str, oneLine, escapeHtml, safeUrl, isYmd, todayKst, isEmail, publicBaseUrl };
