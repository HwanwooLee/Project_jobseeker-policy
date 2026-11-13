/* =========================================================
   /api/check-link — 정책 링크 상태를 규칙·키워드로 실시간 점검 (AI 안 씀)
   받는 값: POST { plcyNo } 또는 GET ?plcyNo=...   ← 링크 주소는 받지 않음. 우리 data/policies.json에 있는 링크만 엶
   돌려주는 값: { ok, checkedAt, results: [{ role, label, url, status, keyword, snippet, ages, nameMatch }] }
     status: verified_apply / verified_info / broken / search / home / unmatched / mismatch_page / closed_hint / unknown
     (규칙은 api/_linkrules.js — scripts/link_check.py와 같음)
   - 신청URL·참고URL 1·2 (최대 3개), 링크마다 5초 제한
   - 같은 링크는 1시간 동안 페이지를 다시 받지 않음 (서버 메모리 기준)
   - 같은 IP는 1분에 20번까지
   ========================================================= */
'use strict';

const L = require('./_lib');
const P = require('./_page');
const R = require('./_linkrules');

const MAX_BODY_BYTES = 2 * 1024;
const RATE_MAX = 20;
const RATE_WINDOW_MS = 60 * 1000;
const CACHE_MS = 60 * 60 * 1000;

const cache = new Map();   // url → { at, fetched }

async function fetchCached(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.fetched;
  const page = await P.fetchPage(url);
  const fetched = {
    httpStatus: page.httpStatus || null,
    finalUrl: page.finalUrl || url,
    title: page.ok ? P.pageTitle(page.html) : '',
    nodes: page.ok ? P.textNodes(page.html) : null,
  };
  cache.set(url, { at: Date.now(), fetched: fetched });
  if (cache.size > 500) cache.clear();   // 글자 조각을 들고 있으니 너무 많이 쌓이지 않게
  return fetched;
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

  const info = P.policyInfo(policy);
  const results = await Promise.all(P.policyLinks(policy).map(async function (link) {
    const fetched = await fetchCached(link.url);
    return Object.assign({}, link, R.judge(link.url, fetched, info));
  }));
  return L.send(res, 200, { ok: true, checkedAt: new Date().toISOString(), results: results });
};
