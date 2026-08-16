/**
 * 데이터가 통째로 박힌 단일 HTML 파일을 만든다.
 * 서버 없이 파일만 열어도 되고, 폰으로 보내서 봐도 된다.
 *
 *   npm run build:static
 *     → dist/housecatch-snapshot.html   (그대로 열면 되는 완성 파일)
 *     → dist/housecatch-artifact.html   (Artifact 로 올릴 때 쓰는 body 조각)
 *
 * data/latest.json 이 없으면 먼저 수집한다.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LATEST_PATH, refresh } from './scrape.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const DIST = path.join(ROOT, 'dist');

async function loadDataset() {
  try {
    return JSON.parse(await readFile(LATEST_PATH, 'utf8'));
  } catch {
    console.log('data/latest.json 이 없어 먼저 수집합니다…');
    return refresh({ log: (m) => console.log(`  ${m}`) });
  }
}

function stamp(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const dataset = await loadDataset();
const [html, css, js] = await Promise.all([
  readFile(path.join(PUBLIC, 'index.html'), 'utf8'),
  readFile(path.join(PUBLIC, 'styles.css'), 'utf8'),
  readFile(path.join(PUBLIC, 'app.js'), 'utf8'),
]);

// </script> 가 문자열 안에 들어가면 파서가 끊기므로 이스케이프
const payload = JSON.stringify(dataset).replace(/</g, '\\u003c');

const body = html
  .slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'))
  .replace(
    '<script src="app.js"></script>',
    `<script>window.__HOUSECATCH__ = ${payload};</script>\n<script>\n${js}\n</script>`,
  )
  .trim();

const title = `houseCatch — 무순위·임의공급·불법행위재공급 (${stamp(dataset.generatedAt)} 기준)`;

const standalone = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8F%A0%3C/text%3E%3C/svg%3E" />
<style>
${css}
</style>
</head>
<body>
${body}
</body>
</html>
`;

const fragment = `<title>houseCatch</title>
<style>
${css}
</style>
${body}
`;

await mkdir(DIST, { recursive: true });
await writeFile(path.join(DIST, 'housecatch-snapshot.html'), standalone, 'utf8');
await writeFile(path.join(DIST, 'housecatch-artifact.html'), fragment, 'utf8');

const kb = (s) => `${Math.round(Buffer.byteLength(s) / 1024)}KB`;
console.log(
  `dist/housecatch-snapshot.html  ${kb(standalone)}\n` +
    `dist/housecatch-artifact.html  ${kb(fragment)}\n` +
    `  ${dataset.items.length}건 · ${stamp(dataset.generatedAt)} 기준`,
);
