/* =========================================================
   정책 링크 상태 판단 규칙 (AI 안 씀) — scripts/link_check.py와 같은 규칙
   ※ 규칙을 바꿀 때는 scripts/link_check.py도 같이 바꿀 것
   위에서부터 먼저 걸리는 것:
     broken → search → home → (unknown) → unmatched → mismatch_page → closed_hint → verified_apply / verified_info
   (_로 시작하는 파일이라 Vercel 주소로는 열리지 않음)
   ========================================================= */
'use strict';

const MIN_TEXT_CHARS = 200;

// a) 열리지 않는 페이지 ("0건"은 검색 결과를 말하는 경우만)
const BROKEN_RE = new RegExp(
  '검색\\s*결과가\\s*없습니다|검색된\\s*(결과|자료|게시물)가\\s*없습니다|(검색\\s*결과|총)\\s*:?\\s*0\\s*건|0\\s*건이\\s*검색' +
  '|페이지를\\s*찾을\\s*수\\s*없습니다|존재하지\\s*않는\\s*(페이지|게시물|게시글|글|정보|주소|콘텐츠|컨텐츠|URL|url)' +
  '|삭제된\\s*(게시물|게시글|글)|잘못된\\s*접근|^\\s*(404\\s*)?not\\s*found\\s*$', 'i');

// b) 검색 페이지
const SEARCH_PATH_RE = /search|srch/i;
const SEARCH_PARAM_NAMES = ['query', 'q', 'kwd', 'keyword', 'searchwrd', 'searchkrwd', 'srchwrd', 'searchkeyword',
  'searchword', 'searchtext', 'srchtext', 'searchtxt', 'srchkwd'];
const SEARCH_PARAM_RE = /^(search|srch).*(wrd|word|kwd|krwd|keyword|text|txt|nm|query)$/i;

// c) 기관 첫 화면
const HOME_PATHS = ['', '/index', '/index.do', '/index.html', '/index.htm', '/index.jsp', '/index.php',
  '/main', '/main.do', '/main.html', '/main.jsp', '/main.php', '/home', '/kor', '/kor/main.do'];
const HOME_LAST_RE = /^(index|main|home)(\.\w+)?$/i;

// d) 정책명 핵심 단어
const COMMON_WORDS = ['지원', '사업', '서비스', '청년', '모집', '운영', '프로그램', '및', '위한', '대상', '신청', '안내',
  '지원사업', '참여자', '년', '등', '제도', 'the', 'and'];
const NAME_SPLIT_RE = /[\s()[\]{}「」『』<>〈〉《》'"·･‧ㆍ,./!?~:+&\-_|]+/;

// e) 본문 속 나이 범위
const AGE_RES = [
  /만\s*(\d{1,2})\s*세?\s*[~∼～\-–]\s*(?:만\s*)?(\d{1,2})\s*세/g,
  /(?:만\s*)?(\d{1,2})\s*세\s*이상\s*[~∼～,]?\s*(?:만\s*)?(\d{1,2})\s*세\s*(?:이하|미만)/g,
  /(?<![\d.])(\d{1,2})\s*[~∼～\-–]\s*(\d{1,2})\s*세/g,
];

// f) 마감 표시
const LABEL_RE = /^(마감|접수\s*마감|모집\s*마감|예약\s*마감|신청\s*마감|서비스\s*종료|모집\s*종료|접수\s*종료|신청\s*종료|종료)$/;
const PHRASE_RE = /(마감\s*되었|마감됐|모집이\s*마감|접수가\s*마감|종료\s*되었(?!거나)|종료됐(?!거나)|종료된\s*(서비스|사업|모집|접수|프로그램|공고|강좌|교육)|신청\s*기간이\s*아닙니다|접수\s*기간이\s*아닙니다)/;
const FILTER_RE = /^(전체|진행\s*중|접수\s*중|모집\s*중|예정|대기)$/;   // "진행중 · 종료" 필터 탭

// g) 신청 버튼 글자 (짧은 글자 조각 하나가 통째로 이 말일 때만)
const APPLY_RE = /^((온라인|인터넷|모바일)\s*)?(신청|접수|지원|예약|참가\s*신청|수강\s*신청|교육\s*신청)\s*(하기|바로\s*가기|하러\s*가기)$|^(온라인|인터넷)\s*(신청|접수)$|^신청서(\s*(작성|제출|접수))?(하기)?$/;

function parseUrl(url) { try { return new URL(url); } catch (e) { return null; } }

function isSearchUrl(url) {
  const u = parseUrl(url);
  if (!u) return false;
  if (SEARCH_PATH_RE.test(u.pathname) && !/detail|view/i.test(u.pathname)) return true;
  for (const [name, value] of u.searchParams) {
    const n = name.toLowerCase();
    if (value.trim() && (SEARCH_PARAM_NAMES.indexOf(n) !== -1 || SEARCH_PARAM_RE.test(n))) return true;
  }
  return false;
}

function isHomeUrl(url) {
  const u = parseUrl(url);
  if (!u) return false;
  const path = u.pathname.replace(/\/+$/, '').toLowerCase();
  const last = path.split('/').pop();
  return !u.search && (HOME_PATHS.indexOf(path) !== -1 || HOME_LAST_RE.test(last));
}

function nameKeywords(name) {
  const words = [];
  String(name || '').split(NAME_SPLIT_RE).forEach(function (w) {
    w = w.trim().toLowerCase();
    if (w.length < 2 || COMMON_WORDS.indexOf(w) !== -1 || /^\d+(년|년도)?$/.test(w)) return;
    if (words.indexOf(w) === -1) words.push(w);
  });
  return words;
}
function squash(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }

function findAgeRanges(text) {
  const found = [];
  AGE_RES.forEach(function (rx) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(text))) {
      const a = Number(m[1]), b = Number(m[2]);
      if (a >= 5 && a < b && b <= 99 && !found.some(function (f) { return f[0] === a && f[1] === b; })) found.push([a, b]);
    }
  });
  return found;
}

function isFilterTab(nodes, i) {
  return nodes.slice(Math.max(0, i - 2), i).concat(nodes.slice(i + 1, i + 3)).some(function (t) { return FILTER_RE.test(t); });
}
function closedMark(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const t = nodes[i];
    if (t.length <= 12 && LABEL_RE.test(t) && !isFilterTab(nodes, i)) {
      return { keyword: t, snippet: nodes.slice(Math.max(0, i - 1), i + 2).join(' · ').replace(/\s+/g, ' ').slice(0, 120) };
    }
    const m = PHRASE_RE.exec(t);
    if (m) return { keyword: m[0], snippet: t.slice(0, 120) };
  }
  return null;
}

// fetched: { httpStatus, finalUrl, title, nodes(못 읽으면 null) }
// policy:  { name, minAge, maxAge } (나이 제한 없으면 둘 다 null)
function judge(url, fetched, policy) {
  const status = fetched.httpStatus;
  const finalUrl = fetched.finalUrl || url;
  const out = {};
  if (status) out.httpStatus = status;

  // a) 열리지 않는 페이지
  if (status === 404 || status === 410 || status >= 500) return Object.assign(out, { status: 'broken', keyword: 'HTTP ' + status });
  const title = fetched.title || '';
  const nodes = fetched.nodes || [];
  const texts = (title ? [title] : []).concat(nodes);
  for (let i = 0; i < texts.length; i++) {
    const m = BROKEN_RE.exec(texts[i]);
    if (m) return Object.assign(out, { status: 'broken', keyword: m[0].trim(), snippet: texts[i].slice(0, 120) });
  }

  // b) 검색 페이지 / c) 기관 첫 화면 (열어 본 뒤 옮겨 간 주소도 봄)
  if (isSearchUrl(url) || isSearchUrl(finalUrl)) return Object.assign(out, { status: 'search' });
  if (isHomeUrl(url) || (finalUrl !== url && isHomeUrl(finalUrl))) return Object.assign(out, { status: 'home' });

  // h) 못 읽음
  const total = nodes.reduce(function (n, t) { return n + t.length; }, 0);
  if (!fetched.nodes || total < MIN_TEXT_CHARS) return Object.assign(out, { status: 'unknown' });

  // d) 정책명 핵심 단어
  const words = nameKeywords(policy.name);
  const text = squash(title + ' ' + nodes.join(' '));
  const hit = words.filter(function (w) { return text.indexOf(squash(w)) !== -1; });
  out.nameMatch = hit.length + '/' + words.length;
  if (words.length && hit.length * 2 < words.length) {
    return Object.assign(out, { status: 'unmatched', missing: words.filter(function (w) { return hit.indexOf(w) === -1; }).slice(0, 5) });
  }

  // e) 나이 범위
  if (policy.minAge != null || policy.maxAge != null) {
    const lo = policy.minAge || 0, hi = policy.maxAge || 200;
    const ranges = findAgeRanges(nodes.join(' '));
    if (ranges.length && !ranges.some(function (r) { return r[0] <= hi && r[1] >= lo; })) {
      return Object.assign(out, { status: 'mismatch_page', ages: '만 ' + ranges[0][0] + '~' + ranges[0][1] + '세' });
    }
  }

  // f) 마감 표시
  const closed = closedMark(nodes);
  if (closed) return Object.assign(out, { status: 'closed_hint' }, closed);

  // g) 확인된 페이지
  const button = nodes.find(function (t) { return t.length <= 20 && APPLY_RE.test(t); });
  return Object.assign(out, button ? { status: 'verified_apply', keyword: button } : { status: 'verified_info' });
}

// 링크 상태 → 가장 좋은 링크 (verified_apply > verified_info, 그 밖은 쓰지 않음)
const ROLE_ORDER = ['apply', 'ref1', 'ref2'];
function pickBest(links) {
  const sorted = (links || []).slice().sort(function (a, b) { return ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role); });
  return sorted.find(function (l) { return l.status === 'verified_apply'; }) || sorted.find(function (l) { return l.status === 'verified_info'; }) || null;
}

module.exports = { judge, pickBest, isSearchUrl, isHomeUrl, nameKeywords, findAgeRanges };
