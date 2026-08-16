/**
 * 청약홈에서 무순위 / 임의공급 / 불법행위재공급 물량을 긁어와 data/latest.json 으로 저장.
 *
 *   node src/scrape.js               기본 범위 (3개월 전 ~ 다음 달)
 *   node src/scrape.js 202601 202609 직접 범위 지정 (최대 12개월)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detailUrl, fetchDetail, fetchList, KIND_CODES } from './applyhome.js';
import { enrichWithMarket } from './market.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const LATEST_PATH = path.join(DATA_DIR, 'latest.json');
const CACHE_PATH = path.join(DATA_DIR, 'detail-cache.json');

/** 상세 정보를 며칠까지 캐시할지 (접수가 끝난 공고는 더 이상 바뀌지 않는다) */
const CACHE_TTL_DAYS = 14;
/** 상세 조회 동시 실행 수 — 청약홈에 부담 주지 않을 정도로 */
const CONCURRENCY = 4;

/* ------------------------------------------------------------------ */

export function defaultRange(now = new Date()) {
  const begin = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { beginPd: yyyymm(begin), endPd: yyyymm(end) };
}

function yyyymm(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ */

/**
 * 목록 + 상세를 합쳐 하나의 데이터셋으로.
 * @param {{beginPd?:string, endPd?:string, log?:Function}} opts
 */
export async function scrape({ beginPd, endPd, log = () => {} } = {}) {
  const range = beginPd && endPd ? { beginPd, endPd } : defaultRange();
  log(`조회 기간 ${range.beginPd} ~ ${range.endPd}`);

  const { rows, total } = await fetchList({
    ...range,
    kinds: Object.keys(KIND_CODES),
    onProgress: (p) => log(`  목록 ${p.page}/${p.pages} (${p.collected}/${p.total}건)`),
  });
  log(`목록 ${rows.length}건 수집`);

  const cache = await readJson(CACHE_PATH, {});
  const todayStr = today();
  let fetched = 0;

  const items = await mapLimit(rows, CONCURRENCY, async (row) => {
    const key = `${row.pblancNo}-${row.houseSecd}`;
    const cached = cache[key];
    const stale =
      !cached ||
      // 접수가 아직 안 끝난 공고는 매번 다시 확인
      (row.applyEnd && row.applyEnd >= todayStr) ||
      daysBetween(cached.fetchedAt, todayStr) > CACHE_TTL_DAYS;

    let detail = cached?.detail;
    if (stale) {
      try {
        detail = await fetchDetail(row);
        cache[key] = { fetchedAt: todayStr, detail };
        fetched++;
        if (fetched % 10 === 0) log(`  상세 ${fetched}건 조회`);
      } catch (err) {
        log(`  ! 상세 실패 ${row.name}: ${err.message}`);
        detail = detail ?? null;
      }
    }

    return merge(row, detail);
  });

  log(`상세 ${fetched}건 새로 조회 (나머지는 캐시)`);

  if (fetched) {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify(cache), 'utf8');
  }

  // 국토부 실거래가로 시세/시세차익 붙이기 (실패해도 목록 자체는 살린다)
  if (process.env.SKIP_MARKET !== '1') {
    try {
      await enrichWithMarket(items, { log });
    } catch (err) {
      log(`! 시세 비교 건너뜀: ${err.message}`);
    }
  }

  items.sort(byApplyStartDesc);

  return {
    generatedAt: new Date().toISOString(),
    range,
    source: 'https://www.applyhome.co.kr/ai/aia/selectAPTRemndrLttotPblancListView.do',
    marketSource: 'https://rt.molit.go.kr/',
    counts: summarize(items, todayStr),
    items,
  };
}

function merge(row, detail) {
  const d = detail ?? {};
  return {
    id: `${row.pblancNo}-${row.houseSecd}`,
    pblancNo: row.pblancNo,
    houseManageNo: row.houseManageNo,
    houseSecd: row.houseSecd,
    kind: row.kind,
    area: row.area,
    name: row.name.trim(),
    developer: row.developer,
    builder: d.builder ?? '',
    noticeDate: row.noticeDate || d.noticeDate || '',
    applyStart: row.applyStart || d.applyStart || '',
    applyEnd: row.applyEnd || d.applyEnd || '',
    winnerDate: row.winnerDate || d.winnerDate || '',
    contractStart: d.contractStart ?? '',
    contractEnd: d.contractEnd ?? '',
    moveIn: d.moveIn ?? '',
    location: d.location ?? '',
    totalUnits: d.totalUnits ?? null,
    priceUnit: d.priceUnit ?? '',
    // 시세 정보를 붙일 때 상세 캐시를 오염시키지 않도록 복사해서 넘긴다
    types: (d.types ?? []).map((t) => ({ ...t })),
    notes: d.notes ?? [],
    tel: d.tel ?? '',
    noticeUrl: d.noticeUrl ?? '',
    image: d.images?.[0] ?? '',
    detailUrl: detailUrl(row),
    isNew: row.isNew,
    hasDetail: Boolean(detail),
  };
}

function byApplyStartDesc(a, b) {
  return (b.applyStart || '').localeCompare(a.applyStart || '') || a.name.localeCompare(b.name);
}

function summarize(items, todayStr) {
  const c = { total: items.length, units: 0, open: 0, openUnits: 0, upcoming: 0, upcomingUnits: 0, closed: 0 };
  for (const it of items) {
    const units = it.totalUnits ?? 0;
    c.units += units;
    if (it.applyStart && it.applyStart > todayStr) {
      c.upcoming++;
      c.upcomingUnits += units;
    } else if (it.applyEnd && it.applyEnd >= todayStr) {
      c.open++;
      c.openUnits += units;
    } else {
      c.closed++;
    }
  }
  return c;
}

function daysBetween(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs(Date.parse(b) - Date.parse(a)) / 86400000;
}

/* ------------------------------------------------------------------ */

export async function saveDataset(dataset) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(LATEST_PATH, JSON.stringify(dataset, null, 2), 'utf8');
}

/** 수집 후 data/latest.json 까지 저장하는 헬퍼 (서버/CLI 공용) */
export async function refresh({ beginPd, endPd, log = () => {} } = {}) {
  const dataset = await scrape({ beginPd, endPd, log });
  await saveDataset(dataset);
  return dataset;
}

/* CLI ---------------------------------------------------------------- */

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const [beginPd, endPd] = process.argv.slice(2);
  const dataset = await refresh({ beginPd, endPd, log: (m) => console.log(m) });
  const { counts } = dataset;
  console.log(
    `\n저장 완료 → data/latest.json` +
      `\n  전체 ${counts.total}건 / ${counts.units.toLocaleString()}세대` +
      `\n  접수중 ${counts.open}건(${counts.openUnits.toLocaleString()}세대)` +
      ` · 접수예정 ${counts.upcoming}건(${counts.upcomingUnits.toLocaleString()}세대)` +
      ` · 마감 ${counts.closed}건`,
  );
}
