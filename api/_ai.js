/* =========================================================
   AI(Claude) 공용 도구 — parse-notice.js와 check-period.js가 함께 씀
   - 호출 횟수 제한을 두 기능이 같이 나눠 씀
       같은 IP: 1분에 3번 (두 기능 합쳐서)
       서비스 전체: 한 달에 AI_MONTHLY_CAP번 (환경변수, 없으면 500번)
     ※ 서버 메모리에 세는 가벼운 장치라 서버가 다시 켜지면 0부터 다시 셈 (정확한 월 한도가 필요하면
       Anthropic 콘솔의 월 사용 한도도 함께 걸어 두기)
   - Claude API는 HTTP로 직접 호출 (키는 환경변수 ANTHROPIC_API_KEY에서만 읽음)
   (_로 시작하는 파일이라 Vercel 주소로는 열리지 않음)
   ========================================================= */
'use strict';

const L = require('./_lib');

const MODEL = 'claude-haiku-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
const TIMEOUT_MS = 30 * 1000;
const RATE_MAX = 3;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MSG = '잠시 후 다시 시도해 주세요';
const MONTHLY_MSG = '이번 달 AI 사용 한도를 다 썼어요. 다음 달에 다시 이용해 주세요.';

function monthlyCap() {
  const n = Number(process.env.AI_MONTHLY_CAP);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 500;
}
let monthKey = '', monthCount = 0;

// AI를 부르기 직전에 호출. 막히면 { status, message, retryAfter? }, 통과하면 null (그리고 횟수를 셈)
function gate(req) {
  const month = L.todayKst().slice(0, 7);
  if (month !== monthKey) { monthKey = month; monthCount = 0; }
  if (monthCount >= monthlyCap()) return { status: 429, message: MONTHLY_MSG };
  const wait = L.rateLimit('ai:' + L.clientIp(req), RATE_MAX, RATE_WINDOW_MS);
  if (wait) return { status: 429, message: RATE_MSG, retryAfter: wait };
  monthCount += 1;
  return null;
}
function sendGate(res, blocked) {
  if (blocked.retryAfter) res.setHeader('Retry-After', String(blocked.retryAfter));
  return L.fail(res, blocked.status, blocked.message, blocked.retryAfter ? { retryAfter: blocked.retryAfter } : null);
}

// 돌려주는 값: { ok: true, json } 또는 { ok: false, status, message }
async function askJson(opts) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, status: 500, message: 'AI 설정이 아직 안 돼 있어요. (서버 환경변수 확인 필요)' };
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  let status, data;
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: opts.maxTokens || 4000,
        system: opts.system,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: opts.schema } },
        messages: [{ role: 'user', content: opts.content }],
      }),
    });
    status = res.status;
    data = await res.json().catch(function () { return null; });
  } catch (err) {
    console.error('[' + opts.tag + '] 호출 실패:', err && err.name, err && err.message);
    return { ok: false, status: 504, message: err && err.name === 'AbortError' ? 'AI 응답이 너무 늦어요. 잠시 후 다시 시도해 주세요.' : 'AI 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.' };
  } finally {
    clearTimeout(timer);
  }
  if (status !== 200 || !data) {
    console.error('[' + opts.tag + '] API 오류:', status, data && data.error && data.error.type, data && data.error && data.error.message);
    if (status === 401 || status === 403) return { ok: false, status: 502, message: 'AI 서버 인증에 실패했어요. (서버의 API 키 확인 필요)' };
    if (status === 429 || status === 529) return { ok: false, status: 503, message: 'AI 서버가 바빠요. 잠시 후 다시 시도해 주세요.' };
    return { ok: false, status: 502, message: 'AI가 정리하지 못했어요. 잠시 후 다시 시도해 주세요.' };
  }
  if (data.stop_reason === 'refusal') return { ok: false, status: 422, message: opts.refusalMsg || 'AI가 이 글을 정리하지 않았어요.' };
  if (data.stop_reason === 'max_tokens') return { ok: false, status: 502, message: opts.maxTokensMsg || 'AI 답이 중간에 끊겼어요. 잠시 후 다시 시도해 주세요.' };
  // 생각(thinking) 블록이 먼저 올 수 있어서 text 블록만 읽음
  const textBlock = (data.content || []).find(function (b) { return b && b.type === 'text'; });
  try { return { ok: true, json: JSON.parse(textBlock ? textBlock.text : '') }; }
  catch (e) { return { ok: false, status: 502, message: 'AI 답을 읽지 못했어요. 잠시 후 다시 시도해 주세요.' }; }
}

module.exports = { MODEL, gate, sendGate, askJson, RATE_MSG };
