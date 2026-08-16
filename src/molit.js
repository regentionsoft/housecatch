/**
 * 국토교통부 실거래가 공개시스템(rt.molit.go.kr) 조회.
 *
 * 네이버 부동산 API는 서버에서 부르면 429(Rate limit)로 막혀서 시세 근거로 못 쓴다.
 * 대신 국토부 실거래가를 쓴다 — 공식 자료이고 키도 필요 없다.
 *
 *   /data/sido.do            시도 목록
 *   /data/sgg.do             시군구 목록
 *   /pt/xls/ptXlsCSVDown.do  조건에 맞는 실거래 CSV (EUC-KR)
 *
 * 물건 구분(srhThingNo): A=아파트 매매, E=분양/입주권.
 * 미입주 신축은 매매 거래가 없고 분양권만 있으므로 둘 다 본다.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://rt.molit.go.kr';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, 'data', 'molit');
const REGION_PATH = path.join(CACHE_DIR, 'regions.json');

/** 실거래 CSV 캐시 유효기간(일) */
const CACHE_TTL_DAYS = 3;

export const THING = { APT: 'A', PRESALE: 'E' };
export const THING_LABEL = { A: '매매', E: '분양권' };

/* ------------------------------------------------------------------ */

async function post(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: `${BASE}/pt/xls/xls.do?mobileAt=`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
    body,
  });
  if (!res.ok) throw new Error(`POST ${pathname} → HTTP ${res.status}`);
  return res;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 지역 코드                                                           */
/* ------------------------------------------------------------------ */

/**
 * 전국 시군구 코드표.
 * 시도 이름은 행정구역 개편으로 바뀔 수 있어서 하드코딩하지 않고 매번 받아온다.
 * @returns {Promise<Array<{sidoNm:string, sidoCode:string, sggNm:string, sggCode:string}>>}
 */
export async function fetchRegions({ force = false } = {}) {
  if (!force) {
    const cached = await readJson(REGION_PATH);
    if (cached?.length) return cached;
  }

  const sidoList = await (await post('/data/sido.do', '')).json();
  const out = [];

  for (const sido of sidoList) {
    const prefix = sido.signguCode.slice(0, 2);
    const sggList = await (await post('/data/sgg.do', `signguCode=${prefix}`)).json();
    for (const sgg of sggList) {
      out.push({
        sidoNm: sido.ctprvnNm,
        sidoCode: sido.signguCode,
        sggNm: sgg.signguNm,
        sggCode: sgg.signguCode,
      });
    }
  }

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(REGION_PATH, JSON.stringify(out, null, 1), 'utf8');
  return out;
}

/**
 * 시도명에서 짧은 별칭들을 뽑는다.
 * "충청남도" → 충청남, 충남 / "전남광주통합특별시" → 전남, 광주 (통합 시도 대응)
 */
export function sidoAliases(name) {
  const base = name.replace(/(통합특별시|특별자치시|특별자치도|광역시|특별시|자치도|도)$/, '');
  const out = new Set([base, base.slice(0, 2)]);
  for (let i = 0; i + 2 <= base.length; i += 2) out.add(base.slice(i, i + 2));
  out.add(base.replace('충청', '충').replace('경상', '경').replace('전라', '전'));
  return [...out].filter(Boolean);
}

/**
 * 시도 안의 "법정동 → 시군구 코드" 색인.
 *
 * 행정구역이 개편되면(인천 서구 → 검단구·서해구 등) 공고문에 적힌 옛 구 이름으로는
 * 시군구를 찾을 수 없다. 그럴 때 동 이름으로 찾기 위한 색인이다. 시도 단위로 캐시한다.
 *
 * @returns {Promise<Record<string, string[]>>} 동 이름 → 시군구 코드 목록
 */
export async function fetchDongIndex(sidoCode, regions) {
  const file = path.join(CACHE_DIR, `emd-${sidoCode}.json`);
  const cached = await readJson(file);
  if (cached) return cached;

  const index = {};
  for (const r of regions.filter((x) => x.sidoCode === sidoCode)) {
    const body = new URLSearchParams({
      srhThingNo: THING.APT,
      srhDelngSecd: '1',
      srhAddrGbn: '1',
      srhSidoCd: r.sidoCode,
      srhSggCd: r.sggCode,
    });
    try {
      const { emdList = [] } = await (await post('/cmm/ptEmdList.do', body.toString())).json();
      for (const emd of emdList) (index[emd.ladNm] ??= []).push(r.sggCode);
    } catch {
      // 한 구가 실패해도 색인 전체를 버리진 않는다
    }
  }

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(index), 'utf8');
  return index;
}

/* ------------------------------------------------------------------ */
/* 실거래 CSV                                                          */
/* ------------------------------------------------------------------ */

/** 따옴표 안의 쉼표까지 처리하는 최소 CSV 파서 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const num = (s) => {
  const v = Number(String(s ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(v) ? v : null;
};

/**
 * 실거래 CSV를 거래 배열로. 물건 구분에 따라 컬럼이 다르므로 헤더 이름으로 찾는다.
 * @returns {Array<{dong:string, complex:string, area:number, price:number, date:string, floor:string, canceled:boolean}>}
 */
export function parseTradeCsv(text) {
  const lines = text.split(/\r?\n/);
  const headIdx = lines.findIndex((l) => l.startsWith('"NO"'));
  if (headIdx === -1) return [];

  const head = parseCsvLine(lines[headIdx]);
  const col = (...names) => head.findIndex((h) => names.some((n) => h.startsWith(n)));
  const iAddr = col('시군구');
  const iName = col('단지명');
  const iArea = col('전용면적');
  const iPrice = col('거래금액');
  const iYm = col('계약년월');
  const iDay = col('계약일');
  const iFloor = col('층');
  const iCancel = col('해제사유발생일');
  const iBuilt = col('건축년도');

  const out = [];
  for (const line of lines.slice(headIdx + 1)) {
    if (!line.startsWith('"')) continue;
    const c = parseCsvLine(line);
    const price = num(c[iPrice]);
    const area = num(c[iArea]);
    if (!price || !area) continue;

    const ym = String(c[iYm] ?? '').trim();
    const day = String(c[iDay] ?? '').trim().padStart(2, '0');
    out.push({
      dong: (c[iAddr] ?? '').trim().split(/\s+/).pop() ?? '',
      complex: (c[iName] ?? '').trim(),
      area,
      price,
      date: ym.length === 6 ? `${ym.slice(0, 4)}-${ym.slice(4)}-${day}` : '',
      floor: (c[iFloor] ?? '').trim(),
      builtYear: iBuilt === -1 ? null : num(c[iBuilt]),
      canceled: iCancel !== -1 && (c[iCancel] ?? '-').trim() !== '-',
    });
  }
  return out;
}

/**
 * 한 시군구의 실거래 내역. 결과는 디스크에 캐시한다.
 * @param {{thing:string, region:object, from:string, to:string}} opts
 */
export async function fetchTrades({ thing, region, from, to }) {
  const key = `${region.sggCode}-${thing}-${from}-${to}`.replace(/[^\w-]/g, '');
  const file = path.join(CACHE_DIR, `${key}.json`);

  const cached = await readJson(file);
  if (cached && Date.now() - cached.at < CACHE_TTL_DAYS * 86400_000) return cached.trades;

  const body = new URLSearchParams({
    srhThingNo: thing,
    srhDelngSecd: '1', // 매매
    srhAddrGbn: '1', // 지번주소
    srhLfstsSecd: '1',
    srhSidoCd: region.sidoCode,
    srhSggCd: region.sggCode,
    srhFromDt: from,
    srhToDt: to,
    sidoNm: region.sidoNm,
    sggNm: region.sggNm,
    emdNm: '',
    loadNm: '',
    areaNm: '',
    hsmpNm: '',
    mobileAt: '',
  });

  const res = await post('/pt/xls/ptXlsCSVDown.do', body.toString());
  // 조건이 잘못되면 CSV 대신 JSON 에러를 돌려준다 (예: 조회 범위 1년 초과)
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    const { error } = await res.json();
    throw new Error(String(error ?? '알 수 없는 오류').replace(/\n/g, ' '));
  }

  const csv = new TextDecoder('euc-kr').decode(await res.arrayBuffer());
  const trades = parseTradeCsv(csv).filter((t) => !t.canceled);

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify({ at: Date.now(), trades }), 'utf8');
  return trades;
}
