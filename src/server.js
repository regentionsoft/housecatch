/**
 * houseCatch 로컬 서버.
 *
 *   npm start            → http://localhost:4173
 *   PORT=8080 npm start  → 포트 변경
 *
 * 라우트
 *   GET  /            정적 파일 (public/)
 *   GET  /api/data    저장된 data/latest.json (없으면 즉시 수집)
 *   POST /api/refresh 청약홈에서 다시 수집 후 반환
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LATEST_PATH, refresh } from './scrape.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 4173);
/** 자동 갱신 주기(분). 0이면 끔. */
const AUTO_REFRESH_MIN = Number(process.env.AUTO_REFRESH_MIN ?? 60);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

let refreshing = null;

async function readLatest() {
  try {
    return JSON.parse(await readFile(LATEST_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/** 동시에 여러 번 눌러도 수집은 한 번만 */
function runRefresh() {
  if (!refreshing) {
    refreshing = refresh({ log: (m) => console.log(`  ${m}`) }).finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const sendJson = (res, status, data) =>
  send(res, status, JSON.stringify(data), { 'Content-Type': MIME['.json'] });

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    send(res, 200, body, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  } catch {
    send(res, 404, 'Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  try {
    if (url.pathname === '/api/data') {
      let data = await readLatest();
      if (!data) {
        console.log('저장된 데이터가 없어 청약홈에서 처음 수집합니다…');
        data = await runRefresh();
      }
      return sendJson(res, 200, data);
    }

    if (url.pathname === '/api/refresh') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST만 지원합니다' });
      console.log('새로고침 요청 →');
      return sendJson(res, 200, await runRefresh());
    }

    return serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  houseCatch → http://localhost:${PORT}\n`);
  if (AUTO_REFRESH_MIN > 0) {
    console.log(`  ${AUTO_REFRESH_MIN}분마다 자동 갱신 (끄려면 AUTO_REFRESH_MIN=0)\n`);
    setInterval(() => {
      console.log('자동 갱신…');
      runRefresh().catch((e) => console.error('자동 갱신 실패:', e.message));
    }, AUTO_REFRESH_MIN * 60_000).unref?.();
  }
});
