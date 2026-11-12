/* =========================================================
   관리 기록 복원 링크 (send-plan.js가 만들고, restore-plan.js가 읽음)
   - 메일의 [관리 화면 열기] = /manage.html?d=<압축한 관리 기록>&sig=<서명>
   - 다른 브라우저(폰 사파리 등)에서 열어도 링크만으로 관리 화면을 되살림
   - 담는 것: 정책번호, 정책 스냅샷(정책명·기관·신청 링크·요약·신청 기간), 신청일,
             단계 날짜(직접 입력·안내 문자에서 찾은 날짜·추가 일정), 완료 체크 상태, 제출 서류 체크,
             받는 사람 이메일 — 단, 이메일은 AES-256-GCM으로 암호화해서 넣음 (링크 글자만 봐서는 주소가 안 보임)
   - 담지 않는 것: 설문 답(나이·소득 등) — 아래 cleanRecord가 허용한 항목만 통과
   - 서명은 캘린더 링크와 같은 ICS_SIGN_SECRET을 쓰되 앞에 "plan-v1."을 붙여 서로 바꿔 쓸 수 없게 함
   - 이메일 암호화 키는 ICS_SIGN_SECRET에서 HKDF로 따로 만든 키 (서명 키와 다른 용도로 분리)
   (_로 시작하는 파일이라 Vercel 주소로는 열리지 않음)
   ========================================================= */
'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const L = require('./_lib');

const MAX_LINK_CHARS = 6000;   // 링크 전체 길이 한도 (넘으면 완료 체크를 빼고, 그래도 넘으면 기본 링크)
const MAX_D_CHARS = 6000;
const SIG_CHARS = 32;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const YM_RE = /^\d{4}-\d{2}$/;
const STATUS = ['상시', '모집중', '기간 확인 필요'];

// ----- 관리 기록 정리: 허용한 항목만, 길이 제한 -----
function cleanRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const plcyNo = String(r.plcyNo || '');
  const plcyNm = L.oneLine(r.plcyNm, 120);
  if (!/^[0-9A-Za-z-]{1,40}$/.test(plcyNo) || !plcyNm || !L.isYmd(r.appliedAt)) return null;
  const out = { plcyNo: plcyNo, plcyNm: plcyNm, appliedAt: r.appliedAt };

  // 완료 체크 상태
  if (r.steps && typeof r.steps === 'object') {
    const steps = {};
    Object.keys(r.steps).slice(0, 30).forEach(function (id) {
      const s = r.steps[id];
      if (!ID_RE.test(id) || !s || typeof s !== 'object') return;
      const c = {};
      if (s.done === true) c.done = true;
      if (Array.isArray(s.doneMonths)) {
        const months = s.doneMonths.filter(function (m) { return typeof m === 'string' && YM_RE.test(m); }).slice(-24);
        if (months.length) c.doneMonths = months;
      }
      if (L.isYmd(s.lastCheckedAt)) c.lastCheckedAt = s.lastCheckedAt;
      if (Object.keys(c).length) steps[id] = c;
    });
    if (Object.keys(steps).length) out.steps = steps;
  }
  // 직접 입력한 날짜 (서류 제출 기한, 결과 발표일)
  if (r.customDates && typeof r.customDates === 'object') {
    const cd = {};
    ['docDeadline', 'resultDate'].forEach(function (k) { if (L.isYmd(r.customDates[k])) cd[k] = r.customDates[k]; });
    if (Object.keys(cd).length) out.customDates = cd;
  }
  // 단계 날짜 (안내 문자에서 찾아 저장한 날짜)
  if (r.stepDates && typeof r.stepDates === 'object') {
    const sd = {};
    Object.keys(r.stepDates).slice(0, 20).forEach(function (id) { if (ID_RE.test(id) && L.isYmd(r.stepDates[id])) sd[id] = r.stepDates[id]; });
    if (Object.keys(sd).length) out.stepDates = sd;
  }
  // 날짜의 근거 문장
  if (r.dateEvidence && typeof r.dateEvidence === 'object') {
    const ev = {};
    Object.keys(r.dateEvidence).slice(0, 20).forEach(function (id) {
      const t = L.oneLine(r.dateEvidence[id], 300);
      if (ID_RE.test(id) && t) ev[id] = t;
    });
    if (Object.keys(ev).length) out.dateEvidence = ev;
  }
  // 안내 문자에서 "새 단계로 추가"한 일정
  if (Array.isArray(r.extraSteps)) {
    const ex = r.extraSteps.slice(0, 10).map(function (x) {
      if (!x || !ID_RE.test(String(x.id || '')) || !L.isYmd(x.date)) return null;
      const title = L.oneLine(x.title, 40);
      return title ? { id: x.id, title: title, date: x.date, evidence: L.oneLine(x.evidence, 300) } : null;
    }).filter(Boolean);
    if (ex.length) out.extraSteps = ex;
  }
  // 제출 서류 체크 (체크한 서류 이름 목록)
  if (Array.isArray(r.docChecked)) {
    const docs = [];
    r.docChecked.slice(0, 15).forEach(function (t) {
      const s = L.oneLine(t, 90);
      if (s && docs.indexOf(s) === -1) docs.push(s);
    });
    if (docs.length) out.docChecked = docs;
  }
  // 정책 스냅샷 (정책명·기관·신청 링크·요약·신청 기간)
  if (r.snapshot && typeof r.snapshot === 'object') {
    const s = r.snapshot, snap = { plcyNm: L.oneLine(s.plcyNm, 120) || plcyNm };
    const org = L.oneLine(s.operInstCdNm, 80); if (org) snap.operInstCdNm = org;
    const ap = L.safeUrl(s.aplyUrlAddr); if (ap) snap.aplyUrlAddr = ap;
    const rf = L.safeUrl(s.refUrlAddr1); if (rf) snap.refUrlAddr1 = rf;
    const ex = L.oneLine(s.plcyExplnCn, 300); if (ex) snap.plcyExplnCn = ex;
    if (/^\d{8}\s*~\s*\d{8}$/.test(String(s.aplyYmd || '').trim())) snap.aplyYmd = String(s.aplyYmd).trim();
    if (STATUS.indexOf(s.status) !== -1) snap.status = s.status;
    if (L.isYmd(s.aplyEndDate)) snap.aplyEndDate = s.aplyEndDate;
    out.snapshot = snap;
  }
  return out;
}

// ----- 이메일 암호화 (AES-256-GCM) -----
// 키: ICS_SIGN_SECRET에서 HKDF로 만든 32바이트 (서명과는 다른 용도의 키)
// 결과: base64url(IV 12바이트 + 인증 태그 16바이트 + 암호문) — IV가 매번 달라서 같은 주소도 링크마다 다르게 보임
function emailKey(secret) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(secret), 'utf8'), Buffer.from('dontmiss-manage-link', 'utf8'), Buffer.from('email-v1', 'utf8'), 32));
}
function encryptEmail(email, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', emailKey(secret), iv);
  const ct = Buffer.concat([cipher.update(email, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}
// 풀지 못하면(위조·키 다름) null
function decryptEmail(token, secret) {
  try {
    const b = Buffer.from(String(token || ''), 'base64url');
    if (b.length < 12 + 16 + 3) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', emailKey(secret), b.subarray(0, 12));
    decipher.setAuthTag(b.subarray(12, 28));
    const email = Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString('utf8');
    return L.isEmail(email) ? email : null;
  } catch (e) { return null; }
}

// ----- 압축 · 서명 -----
function sign(d, secret) {
  return crypto.createHmac('sha256', secret).update('plan-v1.' + d).digest('base64url').slice(0, SIG_CHARS);
}
function pack(record, encEmail) {
  const obj = { v: 1, r: record };
  if (encEmail) obj.e = encEmail;
  return zlib.deflateRawSync(Buffer.from(JSON.stringify(obj), 'utf8'), { level: 9 }).toString('base64url');
}

// [관리 화면 열기] 링크: 전체 → (6,000자 넘으면) 서류 체크 빼고 → 완료 체크도 빼고 → (그래도 넘으면) 기본 링크
// email: 받는 사람 주소 (암호화해서 넣음, 없으면 생략)
// 돌려주는 값: { url, level: 'full' | 'no-docs' | 'no-checks' | 'basic' }
function makeManageLink(base, record, secret, email) {
  if (!base) return { url: '', level: 'basic' };
  const basic = { url: base + '/manage.html', level: 'basic' };
  const clean = cleanRecord(record);
  if (!clean || !secret) return basic;
  const enc = L.isEmail(email) ? encryptEmail(email, secret) : '';
  const tries = [{ rec: clean, level: 'full' }];
  let cur = clean;
  if (cur.docChecked) {
    cur = Object.assign({}, cur); delete cur.docChecked;
    tries.push({ rec: cur, level: 'no-docs' });
  }
  if (cur.steps) {
    cur = Object.assign({}, cur); delete cur.steps;
    tries.push({ rec: cur, level: 'no-checks' });
  }
  for (let i = 0; i < tries.length; i++) {
    const d = pack(tries[i].rec, enc);
    const url = base + '/manage.html?d=' + d + '&sig=' + sign(d, secret);
    if (d.length <= MAX_D_CHARS && url.length <= MAX_LINK_CHARS) return { url: url, level: tries[i].level };
  }
  return basic;
}

// 돌려주는 값: { record, email } 또는 { error: 'bad_sig' | 'bad_data' }  (email은 풀지 못하면 null)
function readManageLink(d, sig, secret) {
  d = String(d || ''); sig = String(sig || '');
  if (!d || d.length > MAX_D_CHARS || !/^[A-Za-z0-9_-]+$/.test(d)) return { error: 'bad_data' };
  const expected = Buffer.from(sign(d, secret));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { error: 'bad_sig' };
  let obj;
  try {
    obj = JSON.parse(zlib.inflateRawSync(Buffer.from(d, 'base64url'), { maxOutputLength: 64 * 1024 }).toString('utf8'));
  } catch (e) { return { error: 'bad_data' }; }
  const record = obj && obj.v === 1 ? cleanRecord(obj.r) : null;
  if (!record) return { error: 'bad_data' };
  return { record: record, email: obj.e ? decryptEmail(obj.e, secret) : null };
}

module.exports = { cleanRecord, makeManageLink, readManageLink, MAX_LINK_CHARS };
