/* =========================================================
   POST /api/restore-plan — 메일의 [관리 화면 열기] 링크로 관리 기록 되살리기
   받는 값: { d, sig }  (manage.html 주소에 붙어 온 값)
   서명(ICS_SIGN_SECRET)이 맞으면 { ok: true, record, email } / 틀리면 400
   record에는 설문 답이 들어 있지 않음 (api/_plan.js의 cleanRecord 참고)
   email은 링크 안에 암호화돼 있던 받는 사람 주소를 풀어서 돌려줌 (링크를 가진 사람만 알 수 있음)
   ========================================================= */
'use strict';

const L = require('./_lib');
const PLAN = require('./_plan');

const MAX_BODY_BYTES = 16 * 1024;
const RATE_MAX = 30;                 // 같은 IP 1분에 30번까지 (마구 두드려 보는 것 방지)
const RATE_WINDOW_MS = 60 * 1000;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return L.fail(res, 405, 'POST 요청만 받을 수 있어요.');

  const got = L.getBody(req, MAX_BODY_BYTES);
  if (got.error) return L.fail(res, 400, '링크가 올바르지 않아요.');

  const secret = process.env.ICS_SIGN_SECRET;
  if (!secret) return L.fail(res, 500, '기록 복원 설정이 아직 안 돼 있어요. (서버 환경변수 확인 필요)');

  const wait = L.rateLimit('restore:' + L.clientIp(req), RATE_MAX, RATE_WINDOW_MS);
  if (wait) return L.fail(res, 429, '잠시 후 다시 시도해 주세요', { retryAfter: wait });

  const result = PLAN.readManageLink(got.body.d, got.body.sig, secret);
  if (result.error) return L.fail(res, 400, '링크가 올바르지 않아요. 메일의 [관리 화면 열기]를 그대로 눌러 주세요.');
  // email: 링크에 암호화돼 들어 있던 받는 사람 주소 (화면 입력칸을 채우는 데만 씀, 풀지 못하면 null)
  return L.send(res, 200, { ok: true, record: result.record, email: result.email || null });
};
