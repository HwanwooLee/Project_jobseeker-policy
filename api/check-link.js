/* =========================================================
   /api/check-link — 신청 페이지에 "마감" 표시가 있는지 글자로만 확인 (AI 안 씀)
   받는 값: POST { plcyNo } 또는 GET ?plcyNo=...   ← 링크 주소는 받지 않음. 우리 data/policies.json에 있는 상세 링크만 엶
   돌려주는 값: { ok, results: [{ role, label, url, result, keyword, snippet }] }
     result: "closed_hint"(마감 표시 보임) / "no_hint"(마감 표시 없음) / "unknown"(페이지를 못 읽음)
   - 상세(detail) 링크 최대 3개, 링크마다 5초 제한
   - 같은 링크는 1시간 동안 결과를 재사용 (서버 메모리 기준)
   - 같은 IP는 1분에 20번까지
   주의: "마감 표시가 없다"가 "접수 중"이라는 뜻은 아님 (화면에서도 no_hint는 따로 표시하지 않음)
   ========================================================= */
'use strict';

const L = require('./_lib');
const P = require('./_page');

const MAX_BODY_BYTES = 2 * 1024;
const RATE_MAX = 20;
const RATE_WINDOW_MS = 60 * 1000;
const CACHE_MS = 60 * 60 * 1000;
const MIN_TEXT_CHARS = 200;   // 글자가 너무 적으면(화면을 스크립트로 그리는 페이지 등) 판단하지 않음

// 1) 글자 조각 하나가 통째로 상태 표시인 경우 (예: <span>서비스종료</span>)
const LABEL_RE = /^(마감|접수\s*마감|모집\s*마감|예약\s*마감|신청\s*마감|서비스\s*종료|모집\s*종료|접수\s*종료|신청\s*종료|종료)$/;
// 2) 문장 속에 마감·종료를 알리는 말이 있는 경우
const PHRASE_RE = /(마감\s*되었|마감됐|모집이\s*마감|접수가\s*마감|종료\s*되었(?!거나)|종료됐(?!거나)|종료된\s*(서비스|사업|모집|접수|프로그램|공고|강좌|교육)|신청\s*기간이\s*아닙니다|접수\s*기간이\s*아닙니다)/;

// "진행중 · 종료"처럼 목록 필터 탭으로 쓰인 표시는 마감 표시로 보지 않음
const FILTER_RE = /^(전체|진행\s*중|접수\s*중|모집\s*중|예정|대기)$/;
function isFilterTab(nodes, i) {
  return nodes.slice(Math.max(0, i - 2), i).concat(nodes.slice(i + 1, i + 3)).some(function (t) { return FILTER_RE.test(t); });
}
// ※ 키워드 규칙을 바꿀 때는 scripts/link_check.py도 같이 바꿀 것

const cache = new Map();   // url → { at, value }

function judgeText(nodes) {
  const total = nodes.reduce(function (n, t) { return n + t.length; }, 0);
  if (total < MIN_TEXT_CHARS) return { result: 'unknown' };
  for (let i = 0; i < nodes.length; i++) {
    const t = nodes[i];
    if (t.length <= 12 && LABEL_RE.test(t) && !isFilterTab(nodes, i)) return { result: 'closed_hint', keyword: t, snippet: around(nodes, i) };
    const m = PHRASE_RE.exec(t);
    if (m) return { result: 'closed_hint', keyword: m[0], snippet: L.oneLine(t, 120) };
  }
  return { result: 'no_hint' };
}
// 표시 앞뒤 글자를 조금 붙여 근거로 보여 줌
function around(nodes, i) {
  return L.oneLine(nodes.slice(Math.max(0, i - 1), i + 2).join(' · '), 120);
}

async function checkOne(link) {
  const hit = cache.get(link.url);
  if (hit && Date.now() - hit.at < CACHE_MS) return Object.assign({}, link, hit.value, { cached: true });
  const page = await P.fetchPage(link.url);
  const value = page.ok ? judgeText(P.textNodes(page.html)) : { result: 'unknown' };
  cache.set(link.url, { at: Date.now(), value: value });
  if (cache.size > 3000) cache.clear();
  return Object.assign({}, link, value);
}

// GET /api/check-link?plcyNo=... 도 받음 (배포 후 브라우저 주소창으로 확인하는 용도)
function plcyNoOf(req) {
  if (req.method === 'GET') {
    try { return new URL(req.url, 'http://x').searchParams.get('plcyNo') || ''; } catch (e) { return ''; }
  }
  const got = L.getBody(req, MAX_BODY_BYTES);
  return got.error ? null : got.body.plcyNo;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return L.fail(res, 405, 'GET 또는 POST 요청만 받을 수 있어요.');
  const no = plcyNoOf(req);
  if (no === null) return L.fail(res, 400, '요청 형식이 올바르지 않아요.');

  const policy = P.findPolicy(L.oneLine(no, 40));
  if (!policy) return L.fail(res, 404, '정책을 찾지 못했어요.');

  const wait = L.rateLimit('check-link:' + L.clientIp(req), RATE_MAX, RATE_WINDOW_MS);
  if (wait) return L.fail(res, 429, '잠시 후 다시 시도해 주세요', { retryAfter: wait });

  const links = P.detailLinks(policy);
  const results = await Promise.all(links.map(checkOne));
  return L.send(res, 200, { ok: true, results: results });
};
