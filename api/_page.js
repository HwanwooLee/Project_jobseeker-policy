/* =========================================================
   정책 신청 페이지 읽기 도구 (check-link.js, check-period.js가 씀)
   - 정책 번호로 data/policies.json에서 링크를 찾음 → 우리 데이터에 있는 링크만 엶 (아무 주소나 대신 열어 주지 않음)
   - 페이지를 5초 안에 받아서 글자만 남김 (script·style 제거, 한글 인코딩 처리)
   (_로 시작하는 파일이라 Vercel 주소로는 열리지 않음)
   ========================================================= */
'use strict';

const FETCH_TIMEOUT_MS = 5000;
const MAX_PAGE_BYTES = 1024 * 1024;   // 1MB 넘게는 읽지 않음
const MAX_LINKS = 3;
const ROLE_LABEL = { apply: '신청 페이지', ref1: '참고 페이지 1', ref2: '참고 페이지 2' };

// ----- 정책 데이터 (한 번 읽어 두고 재사용) -----
// require로 불러서 Vercel이 서버 기능을 묶을 때 data/policies.json도 확실히 함께 넣게 함
// (vercel.json의 includeFiles에도 같은 파일을 적어 둠 — 두 겹으로 대비)
let byNo = null;
function findPolicy(plcyNo) {
  if (!byNo) {
    byNo = new Map();
    const data = require('../data/policies.json');
    (data.policies || []).forEach(function (p) { byNo.set(String(p.plcyNo), p); });
  }
  return byNo.get(String(plcyNo || '')) || null;
}

// 확인할 링크: 상세(detail) 링크만, 최대 3개
function detailLinks(policy) {
  return (policy.links || []).filter(function (l) { return l.kind === 'detail'; }).slice(0, MAX_LINKS)
    .map(function (l) { return { role: l.role, label: ROLE_LABEL[l.role] || '링크', url: l.url }; });
}

// ----- 페이지 받기 -----
function pickCharset(contentType, headBytes) {
  const m1 = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (m1) return m1[1].toLowerCase();
  const m2 = /<meta[^>]+charset=["']?([\w-]+)/i.exec(headBytes.toString('latin1'));
  return m2 ? m2[1].toLowerCase() : 'utf-8';
}

// 돌려주는 값: { ok: true, html } 또는 { ok: false, reason }
async function fetchPage(url) {
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'bad_url' };
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; dontmiss-policy-check/1.0)', 'Accept': 'text/html,*/*;q=0.5' },
    });
    if (res.status !== 200) return { ok: false, reason: 'status_' + res.status };
    const type = res.headers.get('content-type') || '';
    if (type && !/html|text/i.test(type)) return { ok: false, reason: 'not_html' };
    // 너무 큰 페이지는 앞부분만
    const reader = res.body.getReader();
    const chunks = []; let size = 0;
    while (size < MAX_PAGE_BYTES) {
      const r = await reader.read();
      if (r.done) break;
      chunks.push(Buffer.from(r.value)); size += r.value.length;
    }
    try { reader.cancel(); } catch (e) { /* 무시 */ }
    const buf = Buffer.concat(chunks).subarray(0, MAX_PAGE_BYTES);
    let html;
    try { html = new TextDecoder(pickCharset(type, buf.subarray(0, 4096))).decode(buf); }
    catch (e) { html = buf.toString('utf8'); }
    return { ok: true, html: html };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// ----- HTML → 글자 조각(텍스트 노드) 목록 -----
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', '#39': "'" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, function (all, e) {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    }
    return ENTITIES[e.toLowerCase()] !== undefined ? ENTITIES[e.toLowerCase()] : all;
  });
}
function textNodes(html) {
  const body = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  return body.split(/<[^>]*>/).map(function (t) { return decodeEntities(t).replace(/\s+/g, ' ').trim(); })
    .filter(function (t) { return t.length > 0; });
}

module.exports = { findPolicy, detailLinks, fetchPage, textNodes, ROLE_LABEL };
