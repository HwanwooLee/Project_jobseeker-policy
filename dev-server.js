/* =========================================================
   로컬 테스트용 서버 — 화면 파일 + api 폴더의 서버 기능을 함께 실행
   실행: npm run dev  →  http://localhost:8000
   - .env의 키를 읽어서 api 함수에 넘겨줌 (키는 화면에 보내지 않음)
   - 배포(Vercel)에서는 이 파일을 쓰지 않음. Vercel이 같은 일을 대신 함
   ========================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8000;
const MAX_API_BODY = 64 * 1024;

// ----- .env 읽기 (이미 있는 환경변수는 덮어쓰지 않음) -----
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return [];
  const names = [];
  fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).forEach(function (line) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) return;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    names.push(m[1]);
  });
  return names;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
};
// 화면으로 내보내지 않는 것: 숨김 파일(.env 등), 패키지, 서버 코드, 수집 스크립트
const BLOCKED = /(^|\/)\.|(^|\/)(node_modules|api|scripts)(\/|$)|\.py$|^(dev-server\.js|package(-lock)?\.json)$/;

// ----- api: /api/이름 → api/이름.js -----
const handlers = {};
function apiHandler(name) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const file = path.join(ROOT, 'api', name + '.js');
  if (!fs.existsSync(file)) return null;
  if (!handlers[name]) handlers[name] = require(file);
  return handlers[name];
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_API_BODY) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

async function handleApi(req, res, name) {
  const handler = apiHandler(name);
  if (!handler) { res.statusCode = 404; res.end('Not found'); return; }
  try {
    const raw = await readBody(req);
    // Vercel처럼 JSON이면 미리 읽어서 req.body로
    req.body = raw && /json/i.test(req.headers['content-type'] || '') ? (function () { try { return JSON.parse(raw); } catch (e) { return raw; } })() : raw;
    await handler(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = err.message === 'too_large' ? 413 : 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, message: err.message === 'too_large' ? '보낸 내용이 너무 커요.' : '서버 오류가 났어요.' }));
    }
    if (err.message !== 'too_large') console.error('[dev-server]', err);
  }
}

// ----- 화면 파일 -----
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  const relNorm = path.relative(ROOT, file).split(path.sep).join('/');
  if (!file.startsWith(ROOT + path.sep) || BLOCKED.test(relNorm)) { res.statusCode = 404; res.end('Not found'); return; }
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) { res.statusCode = 404; res.end('Not found'); return; }
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(function (req, res) {
  let urlPath;
  try { urlPath = new URL(req.url, 'http://localhost').pathname; } catch (e) { res.statusCode = 400; res.end(); return; }
  const m = /^\/api\/([^/]+)\/?$/.exec(urlPath);
  if (m) return handleApi(req, res, m[1]);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return; }
  serveStatic(req, res, urlPath);
});

const loaded = loadEnv();
server.listen(PORT, '127.0.0.1', function () {
  console.log('\n  놓치지 마! 로컬 서버가 켜졌어요 → http://localhost:' + PORT);
  console.log('  읽은 환경변수: ' + (loaded.length ? loaded.join(', ') : '(없음 — .env 확인)'));
  console.log('  끄려면 Ctrl + C\n');
});
