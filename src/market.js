/**
 * 분양가(공급금액) ↔ 실거래 시세 비교.
 *
 * 같은 단지 · 같은 전용면적 거래가 있으면 그걸 쓰고, 없으면 단계적으로 범위를 넓힌다.
 *   1) 같은 단지, 같은 평형   (±0.6㎡)
 *   2) 같은 단지, 비슷한 평형 (±10%)
 *   3) 같은 동,   비슷한 평형 (±7%)
 *   4) 같은 시군구, 비슷한 평형 (±7%)
 * 어느 단계에서 나온 값인지 화면에 같이 보여줘서, 느슨한 비교인지 바로 알 수 있게 한다.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { downloadCount, fetchDongIndex, fetchRegions, fetchTrades, sidoAliases, THING } from './molit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 계산이 끝난 시세 결과만 따로 저장한다.
 *
 * 국토부는 해외 IP를 막아서 GitHub Actions 에서는 실거래를 받을 수 없다. 실거래 원본 캐시는
 * 50MB가 넘어 저장소에 둘 수도 없다. 그래서 국내에서 돌린 결과(수백 KB)만 커밋해 두고,
 * 서버에 못 붙는 환경에서는 이 파일로 시세를 채운다.
 */
export const SNAPSHOT_PATH = path.join(ROOT, 'data', 'market-snapshot.json');

/** 실거래를 며칠치 볼지. 국토부가 조회 범위를 최대 1년으로 제한한다. */
const WINDOW_DAYS = 364;
/** 중앙값을 낼 때 쓸 최근 거래 개수 */
const MAX_SAMPLES = 20;

export const MATCH_LEVELS = {
  exact: { label: '같은 단지 · 같은 평형', rank: 1 },
  sameComplex: { label: '같은 단지 · 비슷한 평형', rank: 2 },
  sameDong: { label: '같은 동 · 비슷한 평형', rank: 3 },
  sameSgg: { label: '같은 시군구 · 비슷한 평형', rank: 4 },
};

/* ------------------------------------------------------------------ */
/* 지역 찾기                                                           */
/* ------------------------------------------------------------------ */

/** 단지명 비교용 정규화 — 괄호/공백/차수를 걷어낸다 */
export function normName(s) {
  return String(s ?? '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\d+\s*차\s*$/, '')
    .replace(/[\s·ㆍ,]/g, '')
    .toLowerCase();
}

function sameComplex(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (x.length < 4 || y.length < 4) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** 주소 문자열에서 법정동을 뽑는다. "…검단신도시 AA32BL(마전동)" → 마전동 */
export function dongOf(location) {
  const hits = [...String(location ?? '').matchAll(/([가-힣]{1,6}(?:동|읍|면))(?=[\s\d,()]|$)/g)].map((m) => m[1]);
  if (!hits.length) return '';
  // 괄호 안에 적힌 동이 있으면 그게 실제 법정동인 경우가 많다
  const inParen = String(location).match(/\(([^)]*?([가-힣]{1,6}(?:동|읍|면)))[^)]*\)/);
  return inParen ? inParen[2] : hits[hits.length - 1];
}

/**
 * 청약홈 공급지역(area) + 공급위치(location)로 국토부 시군구를 찾는다.
 *
 * 시군구 이름이 통째로 들어맞으면 그 하나만 쓰고, "화성시 동탄구"처럼 시가 구로 쪼개진
 * 경우에는 앞 토큰("화성시")만 맞는 구들을 전부 돌려준다 — 어느 구인지 주소만으로는
 * 알 수 없어서 후보 전체의 실거래를 합쳐 본다.
 *
 * @returns {Array} 후보 시군구 (없으면 빈 배열)
 */
export function resolveRegions(item, regions) {
  const loc = item.location || '';
  if (!loc) return [];

  const candidates = regions.filter((r) => sidoAliases(r.sidoNm).some((a) => a === item.area || a.includes(item.area)));
  const pool = candidates.length ? candidates : regions;

  const full = pool.filter((r) => r.sggNm.split(/\s+/).every((t) => hasToken(loc, t)));
  if (full.length) {
    // 토큰이 많을수록 구체적인 매칭 — "고양시 덕양구" > "고양시"
    const best = Math.max(...full.map((r) => r.sggNm.split(/\s+/).length));
    return full.filter((r) => r.sggNm.split(/\s+/).length === best);
  }

  return pool.filter((r) => {
    const [head, ...rest] = r.sggNm.split(/\s+/);
    return rest.length > 0 && hasToken(loc, head);
  });
}

/**
 * 시군구 이름이 다른 이름 안에 묻혀 있는 걸 매칭으로 세지 않는다.
 * "경기도 남양주시 오남읍" 에서 그냥 문자열 포함으로 찾으면 "양주시" 까지 걸려서
 * 남양주 물량이 양주시 실거래와 비교돼 버린다.
 */
function hasToken(text, token) {
  return new RegExp(`(?<![가-힣])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text);
}

/* ------------------------------------------------------------------ */
/* 시세 추정                                                           */
/* ------------------------------------------------------------------ */

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function recent(trades) {
  return [...trades].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, MAX_SAMPLES);
}

function summarize(matched, level, vintage) {
  const picked = recent(matched);
  const prices = picked.map((t) => t.price);
  return {
    level,
    levelLabel: MATCH_LEVELS[level].label,
    vintage,
    price: median(prices),
    low: Math.min(...prices),
    high: Math.max(...prices),
    samples: picked.length,
    latest: picked[0]?.date ?? '',
    ref: picked[0] ? `${picked[0].complex} ${picked[0].area.toFixed(2)}㎡` : '',
    presaleShare: Math.round((picked.filter((t) => t.kind === 'presale').length / picked.length) * 100),
  };
}

/**
 * 전용면적 하나에 대한 시세.
 * @param {{name:string, area:number}} target 청약 물량의 단지명/전용면적
 * @param {Array} trades 해당 시군구 거래 (kind: 'apt' | 'presale')
 * @param {string} dong 법정동
 */
/**
 * 다른 단지와 비교할 때는 성격이 비슷한 거래만 남긴다.
 * 분양권 거래가 있으면 그것만, 없으면 최근에 지어진 아파트만 — 신축 분양가를
 * 20년 된 구축 매매가와 견주면 차익이 엉뚱하게 나온다.
 */
function comparable(matched, year = new Date().getFullYear()) {
  const presale = matched.filter((t) => t.kind === 'presale');
  if (presale.length) return { trades: presale, vintage: 'presale' };
  const recent = matched.filter((t) => t.builtYear && t.builtYear >= year - 8);
  if (recent.length) return { trades: recent, vintage: 'recent' };
  // 신축도 분양권도 없으면 구축과 견줄 수밖에 없다 — 화면에 그렇다고 밝힌다
  return { trades: matched, vintage: 'old' };
}

export const VINTAGE_LABEL = {
  presale: '분양권 실거래',
  recent: '준공 8년 이내',
  old: '구축 실거래 기준',
};

export function estimatePrice(target, trades, dong) {
  const { name, area } = target;
  if (!area) return null;

  const near = (t, ratio) => Math.abs(t.area - area) <= area * ratio;
  const tiers = [
    // 같은 단지면 연식·입지가 같으니 거래를 그대로 쓴다
    ['exact', (t) => sameComplex(t.complex, name) && Math.abs(t.area - area) <= 0.6, false],
    ['sameComplex', (t) => sameComplex(t.complex, name) && near(t, 0.1), false],
    ['sameDong', (t) => dong && t.dong === dong && near(t, 0.07), true],
    ['sameSgg', (t) => near(t, 0.07), true],
  ];

  for (const [level, test, restrict] of tiers) {
    const matched = trades.filter(test);
    if (!matched.length) continue;
    if (!restrict) return summarize(matched, level, null);
    const { trades: picked, vintage } = comparable(matched);
    return summarize(picked, level, vintage);
  }
  return null;
}

/* ------------------------------------------------------------------ */

/** toISOString 은 UTC 라 하루씩 밀린다. 로컬 기준으로 찍는다. */
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function windowRange(now = new Date()) {
  const from = new Date(now);
  from.setDate(from.getDate() - WINDOW_DAYS);
  return { from: ymd(from), to: ymd(now) };
}

/** "084.9900B" → 84.99 */
function areaOf(typeName) {
  const v = parseFloat(typeName);
  return Number.isFinite(v) ? v : null;
}

/**
 * 물량 목록에 시세/시세차익을 붙인다. 실패해도 나머지는 그대로 둔다.
 * @param {Array} items scrape() 가 만든 항목들
 * @param {{log?:Function, concurrency?:number}} opts
 */
export async function enrichWithMarket(items, { log = () => {}, concurrency = 2 } = {}) {
  const regions = await fetchRegions();
  const range = windowRange();

  // 1) 항목마다 후보 시군구를 정하고, 시군구 목록을 유일하게 모은다
  const perItem = new Map();
  const needed = new Map();
  const unresolved = [];
  for (const it of items) {
    const found = resolveRegions(it, regions);
    if (!found.length) {
      if (dongOf(it.location)) unresolved.push(it);
      continue;
    }
    perItem.set(it, found);
    for (const r of found) needed.set(r.sggCode, r);
  }

  // 구 이름이 바뀐 지역(예: 인천 서구 → 검단구·서해구)은 법정동으로 다시 찾는다
  if (unresolved.length) {
    const resolvedByDong = await resolveByDong(unresolved, regions, log);
    for (const [it, found] of resolvedByDong) {
      perItem.set(it, found);
      for (const r of found) needed.set(r.sggCode, r);
    }
  }

  log(`시세 비교 대상 ${needed.size}개 시군구 · ${perItem.size}건 (${range.from} ~ ${range.to} 실거래)`);

  // 2) 시군구별 실거래를 한 번씩만 받는다.
  //    하루 내려받기 한도가 있어서, 아직 접수가 남은 물량이 있는 지역부터 처리한다.
  const today = new Date().toISOString().slice(0, 10);
  const urgency = new Map();
  for (const [it, found] of perItem) {
    const live = it.applyEnd >= today ? 2 : 1;
    for (const r of found) urgency.set(r.sggCode, Math.max(urgency.get(r.sggCode) ?? 0, live));
  }

  const byRegion = new Map();
  const entries = [...needed.values()].sort(
    (a, b) => (urgency.get(b.sggCode) ?? 0) - (urgency.get(a.sggCode) ?? 0),
  );
  let done = 0;
  let cursor = 0;
  let skipped = 0;

  const worker = async () => {
    while (cursor < entries.length) {
      const region = entries[cursor++];
      try {
        const [apt, presale] = await Promise.all([
          fetchTrades({ thing: THING.APT, region, ...range }),
          fetchTrades({ thing: THING.PRESALE, region, ...range }),
        ]);
        byRegion.set(region.sggCode, [
          ...apt.map((t) => ({ ...t, kind: 'apt' })),
          ...presale.map((t) => ({ ...t, kind: 'presale' })),
        ]);
      } catch (err) {
        if (!skipped++) log(`  실거래 조회 중단: ${err.message} (남은 지역은 캐시/기존 값 사용)`);
      }
      done++;
      if (done % 20 === 0) log(`  실거래 ${done}/${entries.length} 시군구`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));

  // 3) 항목별로 후보 시군구의 거래를 합쳐 시세를 매긴다
  for (const [it, found] of perItem) {
    const trades = found.flatMap((r) => byRegion.get(r.sggCode) ?? []);
    if (trades.length) applyMarket(it, trades, found);
  }

  const withMarket = items.filter((i) => i.market).length;
  log(`시세 매칭 ${withMarket}/${items.length}건 (실거래 ${downloadCount()}건 내려받음${skipped ? `, ${skipped}개 지역 건너뜀` : ''})`);
  if (!withMarket) throw new Error('시세를 하나도 매칭하지 못했습니다');
  return items;
}

/* ------------------------------------------------------------------ */
/* 시세 결과 스냅샷                                                     */
/* ------------------------------------------------------------------ */

/**
 * 이번에 계산된 시세를 저장한다. 하루 한도 때문에 일부 지역을 건너뛰었을 수 있으므로
 * 기존 스냅샷 위에 덮어쓴다 — 이번에 못 구한 항목의 지난 값을 날리지 않는다.
 */
export async function saveMarketSnapshot(items) {
  let entries = {};
  try {
    entries = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8')).entries ?? {};
  } catch { /* 첫 실행 */ }

  for (const it of items) {
    if (!it.market) continue;
    entries[it.id] = {
      market: it.market,
      types: it.types.map((t) => ({ name: t.name, market: t.market ?? null, gain: t.gain ?? null })),
    };
  }

  const payload = { asOf: new Date().toISOString(), count: Object.keys(entries).length, entries };
  await mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true });
  await writeFile(SNAPSHOT_PATH, JSON.stringify(payload), 'utf8');
  return payload;
}

/**
 * 저장해 둔 시세 결과를 물량 목록에 다시 붙인다.
 * 스냅샷 이후 새로 올라온 공고는 시세 없이 남는다 — 없는 걸 지어내지 않는다.
 */
export async function applyMarketSnapshot(items, { log = () => {} } = {}) {
  let snap;
  try {
    snap = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  } catch {
    log('저장된 시세 스냅샷이 없어 시세 없이 진행합니다');
    return null;
  }

  let applied = 0;
  for (const it of items) {
    if (it.market) continue; // 이번에 직접 계산한 값이 우선
    const hit = snap.entries[it.id];
    if (!hit) continue;
    it.market = hit.market;
    const byName = new Map(hit.types.map((t) => [t.name, t]));
    for (const type of it.types) {
      const t = byName.get(type.name);
      if (!t) continue;
      type.market = t.market;
      type.gain = t.gain;
    }
    applied++;
  }
  if (applied) log(`저장된 시세로 ${applied}건 보충 (${snap.asOf.slice(0, 10)} 기준)`);
  return { asOf: snap.asOf, applied };
}

/** 법정동 이름으로 시군구를 되찾는다 (시도 단위 색인을 필요한 시도만 받는다) */
async function resolveByDong(items, regions, log) {
  const bySido = new Map();
  for (const it of items) {
    const sido = regions.find((r) => sidoAliases(r.sidoNm).some((a) => a === it.area || a.includes(it.area)));
    if (!sido) continue;
    if (!bySido.has(sido.sidoCode)) bySido.set(sido.sidoCode, []);
    bySido.get(sido.sidoCode).push(it);
  }

  const out = new Map();
  for (const [sidoCode, group] of bySido) {
    let index;
    try {
      index = await fetchDongIndex(sidoCode, regions);
    } catch (err) {
      log(`  ! 법정동 색인 실패(${sidoCode}): ${err.message}`);
      continue;
    }
    for (const it of group) {
      const codes = index[dongOf(it.location)];
      if (!codes?.length) continue;
      out.set(it, codes.map((c) => regions.find((r) => r.sggCode === c)).filter(Boolean));
    }
  }
  return out;
}

/**
 * 카드에 크게 띄우는 값은 "대표 주택형" 하나로 통일한다.
 * 최저 분양가와 다른 평형의 시세를 섞어 보여주면 분양가·시세·차익이 서로 안 맞는다.
 * 대표는 분양가와 시세가 모두 있는 주택형 중 세대수가 가장 많은 것.
 */
function applyMarket(item, trades, foundRegions) {
  const dong = dongOf(item.location);
  const estimates = new Map();

  for (const type of item.types) {
    const est = estimatePrice({ name: item.name, area: areaOf(type.name) }, trades, dong);
    type.market = est ? est.price : null;
    type.marketLevel = est ? est.level : null;
    if (!est) continue;
    estimates.set(type, est);
    if (type.price != null) type.gain = est.price - type.price;
  }
  if (!estimates.size) return;

  const byUnits = (a, b) => (b[0].units ?? 0) - (a[0].units ?? 0);
  const withPrice = [...estimates].filter(([t]) => t.price != null).sort(byUnits);
  const [type, est] = withPrice[0] ?? [...estimates].sort(byUnits)[0];

  const r0 = foundRegions[0];
  const regionNm =
    foundRegions.length > 1
      ? `${r0.sidoNm} ${r0.sggNm.split(/\s+/)[0]}`
      : `${r0.sidoNm} ${r0.sggNm}${dong ? ` ${dong}` : ''}`;

  const gain = type.price != null ? est.price - type.price : null;
  item.market = {
    region: regionNm,
    level: est.level,
    levelLabel: MATCH_LEVELS[est.level].label,
    vintage: est.vintage ?? null,
    typeName: type.name,
    basePrice: type.price ?? null,
    price: est.price,
    low: est.low,
    high: est.high,
    samples: est.samples,
    latest: est.latest,
    ref: est.ref,
    presaleShare: est.presaleShare,
    gain,
    gainPct: gain != null && type.price ? Math.round((gain / type.price) * 1000) / 10 : null,
  };
}
