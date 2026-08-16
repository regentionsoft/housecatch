/**
 * 시세를 새로 수집해서 공개 사이트에 반영한다.
 *
 *   npm run publish
 *
 * 국토부 실거래가는 해외 IP를 막아서 GitHub Actions 안에서는 못 받는다.
 * 그래서 시세는 국내(이 컴퓨터)에서 계산해 data/market-snapshot.json 으로 커밋하고,
 * GitHub Actions 는 매일 청약홈 물량·일정만 새로 받아 그 스냅샷과 합쳐 배포한다.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { refresh } from './scrape.js';

const run = promisify(execFile);

async function git(...args) {
  const { stdout } = await run('git', args);
  return stdout.trim();
}

const dataset = await refresh({ log: (m) => console.log(m) });

if (!dataset.marketAsOf) {
  console.error('\n시세를 못 받았습니다. 국토부 일일 다운로드 한도(100건)일 수 있으니 내일 다시 시도해 주세요.');
  process.exit(1);
}

const withMarket = dataset.items.filter((i) => i.market).length;
console.log(`\n시세 ${withMarket}/${dataset.items.length}건 · ${dataset.marketAsOf.slice(0, 10)} 기준`);

if (!(await git('status', '--porcelain', 'data/market-snapshot.json'))) {
  console.log('시세 스냅샷에 바뀐 내용이 없습니다. 푸시할 것이 없어요.');
  process.exit(0);
}

await git('add', 'data/market-snapshot.json');
await git('commit', '-m', `시세 스냅샷 갱신 (${dataset.marketAsOf.slice(0, 10)} · ${withMarket}건)`);
await git('push', 'origin', 'HEAD');

const remote = await git('remote', 'get-url', 'origin');
const repo = remote.replace(/.*github\.com[:/]/, '').replace(/\.git$/, '');
console.log(`\n푸시 완료 → GitHub Actions 가 사이트를 다시 만듭니다.`);
console.log(`  진행 상황: https://github.com/${repo}/actions`);
