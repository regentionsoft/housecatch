/**
 * 청약홈(applyhome.co.kr) 조회 + 파싱 모듈.
 *
 * 사용하는 엔드포인트 (모두 공개 화면에서 쓰는 것과 동일)
 *  - APT잔여세대 분양정보 목록 : POST /ai/aia/selectAPTRemndrLttotPblancListView.do
 *  - 입주자모집공고 상세      : GET  /ai/aia/selectAPTRemndrLttotPblancDetailView.do
 *  - 청약캘린더               : POST /ai/aib/selectSubscrptCalender.do
 *
 * 청약홈은 User-Agent 헤더가 없으면 404를 돌려주므로 항상 붙여서 요청한다.
 */

export const BASE = 'https://www.applyhome.co.kr';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const LIST_URL = `${BASE}/ai/aia/selectAPTRemndrLttotPblancListView.do`;
const DETAIL_URL = `${BASE}/ai/aia/selectAPTRemndrLttotPblancDetailView.do`;
const APT_LIST_URL = `${BASE}/ai/aia/selectAPTLttotPblancListView.do`;
const APT_DETAIL_URL = `${BASE}/ai/aia/selectAPTLttotPblancDetail.do`;
const CALENDAR_URL = `${BASE}/ai/aib/selectSubscrptCalender.do`;
const LIST_REFERER = `${BASE}/ai/aia/selectAPTRemndrLttotPblancListView.do`;

/** 아파트 일반분양(특별공급·1순위·2순위)은 houseSecd 01, 민간사전청약은 09 */
const isApt = (houseSecd) => houseSecd === '01' || houseSecd === '09';

/** 분양구분 코드 (목록 화면 체크박스 값) */
export const KIND_CODES = {
  '02': '무순위(사전)',
  '01': '무순위(사후)',
  '04': '임의공급',
  '03': '불법행위재공급',
};

/** 상세 팝업 딥링크 (GET으로도 열린다). 아파트 일반분양은 별도 화면을 쓴다. */
export function detailUrl({ houseManageNo, pblancNo, houseSecd }) {
  const q = new URLSearchParams({
    houseManageNo: String(houseManageNo),
    pblancNo: String(pblancNo),
    houseSecd: String(houseSecd),
  });
  return `${isApt(houseSecd) ? APT_DETAIL_URL : DETAIL_URL}?${q}`;
}

/* ------------------------------------------------------------------ */
/* HTML 유틸                                                           */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/** 태그를 걷어내고 공백을 정리한 순수 텍스트 */
export function text(html) {
  if (html == null) return '';
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function tdList(rowHtml) {
  return [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1]);
}

/* ------------------------------------------------------------------ */
/* 요청                                                                */
/* ------------------------------------------------------------------ */

async function request(url, { method = 'GET', body, json = false } = {}) {
  const headers = {
    'User-Agent': UA,
    Referer: LIST_REFERER,
    'Accept-Language': 'ko-KR,ko;q=0.9',
  };
  if (body && json) headers['Content-Type'] = 'application/json; charset=UTF-8';
  else if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';

  const res = await fetch(url, { method, headers, body });
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}`);
  return json ? res.json() : res.text();
}

/* ------------------------------------------------------------------ */
/* 목록                                                                */
/* ------------------------------------------------------------------ */

/**
 * 잔여세대(무순위·임의공급·불법행위재공급) 목록 한 페이지.
 * @param {{beginPd:string, endPd:string, pageIndex:number, kinds?:string[], area?:string}} opts
 */
export async function fetchListPage({ beginPd, endPd, pageIndex = 1, kinds = [], area = '' }) {
  const body = new URLSearchParams({ beginPd, endPd, pageIndex: String(pageIndex) });
  if (area) body.set('suplyAreaCode', area);
  if (kinds.length) body.set('remndrHshldTyCode', kinds.join(','));

  const html = await request(LIST_URL, { method: 'POST', body: body.toString() });
  return parseListPage(html);
}

export function parseListPage(html) {
  const totalMatch = html.match(/총게시물\s*:\s*<b[^>]*>([\d,]+)<\/b>/);
  const total = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : 0;

  const rows = [...html.matchAll(/<tr\s+data-pbno="([^"]*)"\s+data-hmno="([^"]*)"\s+data-hsecd="([^"]*)"\s+data-honm="([^"]*)">([\s\S]*?)<\/tr>/g)]
    .map(([, pblancNo, houseManageNo, houseSecd, honm, inner]) => {
      const cells = tdList(inner).map(text);
      const [applyStart, applyEnd] = splitPeriod(cells[5]);
      return {
        pblancNo,
        houseManageNo,
        houseSecd,
        area: cells[0] || '',
        kind: cells[1] || '',
        name: decodeEntities(honm) || cells[2] || '',
        developer: cells[3] || '',
        noticeDate: cells[4] || '',
        applyStart,
        applyEnd,
        winnerDate: cells[6] || '',
        isNew: /ic_new\.png/.test(inner),
      };
    });

  return { total, rows };
}

function splitPeriod(s) {
  if (!s) return ['', ''];
  const [a, b] = s.split('~').map((v) => v.trim());
  return [a || '', b || a || ''];
}

/**
 * 기간 내 목록 전체 (페이지를 끝까지 넘겨서 수집).
 * @param {{beginPd:string, endPd:string, kinds?:string[], onProgress?:Function}} opts
 */
export async function fetchList({ beginPd, endPd, kinds = [], onProgress } = {}) {
  const first = await fetchListPage({ beginPd, endPd, pageIndex: 1, kinds });
  const perPage = first.rows.length || 10;
  const pages = Math.max(1, Math.ceil(first.total / perPage));
  const all = [...first.rows];
  onProgress?.({ page: 1, pages, collected: all.length, total: first.total });

  for (let p = 2; p <= pages; p++) {
    const { rows } = await fetchListPage({ beginPd, endPd, pageIndex: p, kinds });
    if (!rows.length) break;
    all.push(...rows);
    onProgress?.({ page: p, pages, collected: all.length, total: first.total });
  }

  // 같은 공고가 여러 페이지에 중복될 수 있어 pblancNo 기준으로 정리
  const byId = new Map();
  for (const row of all) byId.set(`${row.pblancNo}-${row.houseSecd}`, row);
  return { total: first.total, rows: [...byId.values()] };
}

/* ------------------------------------------------------------------ */
/* 아파트 일반분양 목록 (특별공급 · 1순위 · 2순위)                       */
/* ------------------------------------------------------------------ */

/**
 * 분양/임대 구분. 시세차익 비교가 의미 있는 분양주택만 기본으로 본다.
 * 0=분양주택, 1=분양전환 가능임대, 2=분양전환 불가임대
 */
export const APT_RENT_SECD = { SALE: '0' };

export async function fetchAptListPage({ beginPd, endPd, pageIndex = 1, rentSecd = APT_RENT_SECD.SALE }) {
  const body = new URLSearchParams({ beginPd, endPd, pageIndex: String(pageIndex) });
  if (rentSecd) body.set('rentSecd', rentSecd);
  const html = await request(APT_LIST_URL, { method: 'POST', body: body.toString() });
  return parseAptListPage(html);
}

/**
 * 컬럼: 지역 | 주택구분 | 분양/임대 | 주택명 | 시공사 | 문의처 | 모집공고일 | 청약기간 | 당첨자발표 | …
 * 잔여세대 목록과 달리 data-hsecd 가 없다 — 아파트 일반분양이라 houseSecd 는 01 고정.
 */
export function parseAptListPage(html) {
  const totalMatch = html.match(/총게시물\s*:\s*<b[^>]*>([\d,]+)<\/b>/);
  const total = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : 0;

  const rows = [...html.matchAll(/<tr\s+data-pbno="([^"]*)"\s+data-hmno="([^"]*)"\s+data-honm="([^"]*)">([\s\S]*?)<\/tr>/g)]
    .map(([, pblancNo, houseManageNo, honm, inner]) => {
      const cells = tdList(inner).map(text);
      const [applyStart, applyEnd] = splitPeriod(cells[7]);
      return {
        pblancNo,
        houseManageNo,
        houseSecd: '01',
        area: cells[0] || '',
        kind: '아파트 일반분양',
        houseType: cells[1] || '', // 민영 / 국민
        saleType: cells[2] || '', // 분양주택 / 임대
        name: decodeEntities(honm) || cells[3] || '',
        developer: cells[4] || '',
        noticeDate: cells[6] || '',
        applyStart,
        applyEnd,
        winnerDate: cells[8] || '',
        isNew: /ic_new\.png/.test(inner),
      };
    });

  return { total, rows };
}

export async function fetchAptList({ beginPd, endPd, onProgress } = {}) {
  const first = await fetchAptListPage({ beginPd, endPd, pageIndex: 1 });
  const perPage = first.rows.length || 10;
  const pages = Math.max(1, Math.ceil(first.total / perPage));
  const all = [...first.rows];
  onProgress?.({ page: 1, pages, collected: all.length, total: first.total });

  for (let p = 2; p <= pages; p++) {
    const { rows } = await fetchAptListPage({ beginPd, endPd, pageIndex: p });
    if (!rows.length) break;
    all.push(...rows);
    onProgress?.({ page: p, pages, collected: all.length, total: first.total });
  }

  const byId = new Map();
  for (const row of all) byId.set(`${row.pblancNo}-${row.houseSecd}`, row);
  return { total: first.total, rows: [...byId.values()] };
}

/* ------------------------------------------------------------------ */
/* 상세                                                                */
/* ------------------------------------------------------------------ */

export async function fetchDetail({ houseManageNo, pblancNo, houseSecd }) {
  const html = await request(detailUrl({ houseManageNo, pblancNo, houseSecd }));
  return parseDetail(html);
}

export { isApt };

export function parseDetail(html) {
  const out = {
    location: '',
    totalUnits: null,
    tel: '',
    builder: '',
    noticeUrl: '',
    images: [],
    noticeDate: '',
    applyStart: '',
    applyEnd: '',
    winnerDate: '',
    contractStart: '',
    contractEnd: '',
    moveIn: '',
    priceUnit: '',
    stages: [],
    types: [],
    notes: [],
  };

  // 주요정보 (공급위치 / 공급규모)
  for (const [, label, value] of html.matchAll(/<td>\s*(공급위치|공급규모)\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
    const v = text(value);
    if (label === '공급위치') out.location = v;
    else out.totalUnits = toInt(v);
  }

  const tel = html.match(/분양사무실\s*\(([^)]*)\)/);
  if (tel) out.tel = text(tel[1]);

  const notice = html.match(/href="(https:\/\/static\.applyhome\.co\.kr\/ai\/aia\/getAtchmnfl\.do[^"]*)"/);
  if (notice) out.noticeUrl = decodeEntities(notice[1]);

  out.images = [...html.matchAll(/src="(\/ai\/aia\/getAtchmnflOpt\.do[^"]*)"/g)].map(
    (m) => BASE + decodeEntities(m[1]),
  );

  // 청약일정 (th scope="row" 에 rowspan 이 붙는 유형도 있다)
  for (const [, label, value] of html.matchAll(/<th scope="row"[^>]*>([^<]*)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
    const key = text(label);
    const v = text(value);
    if (key === '모집공고일') out.noticeDate = v;
    else if (key === '청약접수' && /\d{4}-\d{2}-\d{2}/.test(v)) [out.applyStart, out.applyEnd] = splitPeriod(v);
    else if (key.startsWith('당첨자')) out.winnerDate = v;
    else if (key === '계약일') [out.contractStart, out.contractEnd] = splitPeriod(v);
  }
  // 아파트 일반분양과 불법행위재공급은 접수일이 단계별로 나뉘어 별도 행에 들어온다.
  // (아파트: 특별공급 / 1순위 / 2순위, 불법행위재공급: 특별공급 / 일반공급)
  // 단계 이름은 바로 앞 칸에 적혀 있다 — 유형별로 "특별공급/1순위/2순위" 도 되고
  // "특별공급/일반공급" 도 되므로, 추측하지 말고 화면에 적힌 값을 그대로 쓴다.
  const STAGE_IDS = 'spSuplyRceptPd|speclSuplyRceptPd|rnk1CrsRceptPd|rnk2CrsRceptPd';
  const stageRow = new RegExp(`<td>\\s*([^<]{1,12}?)\\s*</td>\\s*<td[^>]*id="(${STAGE_IDS})"[^>]*>([\\s\\S]*?)</td>`, 'g');
  for (const [, label, , value] of html.matchAll(stageRow)) {
    const v = text(value);
    if (!/\d{4}-\d{2}-\d{2}/.test(v)) continue; // "-" 로 비어 있는 단계는 건너뛴다
    const [start, end] = splitPeriod(v);
    out.stages.push({ label: text(label), start, end });
  }
  if (out.stages.length && !out.applyStart) {
    out.applyStart = out.stages.reduce((a, s) => (a && a < s.start ? a : s.start), '');
    out.applyEnd = out.stages.reduce((a, s) => (a > (s.end || s.start) ? a : s.end || s.start), '');
  }

  // 주택형별 세대수 — "공급대상" 표 (불법행위재공급 등에서 제공)
  const targetUnits = parseSupplyTargets(sectionAfter(html, '공급대상'));

  // 공급금액 표. 소제목이 유형마다 다르다.
  //   잔여세대   "공급내역 및 입주예정월"
  //   아파트     "공급금액, 2순위 청약금 및 입주예정월"
  const supply = sectionAfterHeading(html, /입주예정월/);
  if (supply) {
    const table = supply.match(/<table[\s\S]*?<\/table>/)?.[0];
    if (table) {
      const headers = tdList(table.match(/<thead[\s\S]*?<\/thead>/)?.[0] ?? '').map(text);
      const roles = headers.map(columnRole);
      if (roles.includes('price')) out.priceUnit = '만원';
      const tbody = table.match(/<tbody[\s\S]*?<\/tbody>/)?.[0] ?? '';

      for (const [, rowHtml] of tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
        const cells = tdList(rowHtml).map(text);
        const name = cells[0];
        if (!name || !/\d/.test(name)) continue;

        const entry = { name, units: targetUnits.get(name) ?? null, price: null };
        cells.forEach((raw, i) => {
          if (!raw) return;
          switch (roles[i]) {
            case 'units': entry.units = toInt(raw); break;
            case 'price': entry.price = toInt(raw); break;
            case 'moveIn': out.moveIn ||= raw; break;
            case 'note': out.notes.push(raw); break;
          }
        });
        out.types.push(entry);
      }
    }
    const moveIn = supply.match(/입주예정월\s*:\s*([\d.\s]+)/);
    if (moveIn) out.moveIn = moveIn[1].trim();
  }

  // 공급내역 표가 없으면 공급대상 표만으로 구성
  if (!out.types.length && targetUnits.size) {
    out.types = [...targetUnits].map(([name, units]) => ({ name, units, price: null }));
  }

  // 시공사 (기타사항 표)
  const etc = sectionAfter(html, '기타사항');
  if (etc) {
    const row = etc.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];
    if (row) out.builder = text(tdList(row)[1] ?? '');
  }

  // 공급규모가 비어 있으면 주택형 합계로 대체
  if (!out.totalUnits && out.types.length) {
    const sum = out.types.reduce((a, t) => a + (t.units ?? 0), 0);
    if (sum) out.totalUnits = sum;
  }

  out.notes = [...new Set(out.notes)];
  return out;
}

/** 소제목(h5) 이후 구간만 잘라낸다 */
function sectionAfter(html, heading) {
  const idx = html.indexOf(`>${heading}<`);
  return idx === -1 ? '' : html.slice(idx);
}

/** 제목 문구가 유형마다 달라질 때, 패턴으로 소제목을 찾아 그 뒤를 자른다 */
function sectionAfterHeading(html, pattern) {
  for (const m of html.matchAll(/<h5[^>]*>([\s\S]*?)<\/h5>/g)) {
    if (pattern.test(text(m[1]))) return html.slice(m.index);
  }
  return '';
}

function columnRole(header) {
  if (!header) return null;
  if (header.includes('공급세대수') || header === '세대수') return 'units';
  if (header.includes('공급금액') || header.includes('분양가')) return 'price';
  if (header.includes('입주예정월')) return 'moveIn';
  if (header.includes('비고')) return 'note';
  return null;
}

/**
 * "공급대상" 표에서 주택형 → 공급세대수(계).
 * 행 구조: [주택구분?] 주택형 | 주택공급면적 | 일반 | 특별 | 계 | 주택관리번호
 */
function parseSupplyTargets(section) {
  const map = new Map();
  if (!section) return map;
  const tbody = section.match(/<table[\s\S]*?<\/table>/)?.[0]?.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];
  if (!tbody) return map;

  for (const [, rowHtml] of tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = tdList(rowHtml).map(text);
    const i = cells.findIndex((c) => /^\d{2,3}\.\d{3,4}/.test(c));
    if (i === -1) continue;
    const total = toInt(cells[i + 4]);
    if (total != null) map.set(cells[i], total);
  }
  return map;
}

function toInt(s) {
  const m = String(s ?? '').replace(/,/g, '').match(/-?\d+/);
  return m ? Number(m[0]) : null;
}

/* ------------------------------------------------------------------ */
/* 청약캘린더 (전체 공급유형 일정)                                      */
/* ------------------------------------------------------------------ */

/** RCEPT_SE → 공급유형명 (청약캘린더 화면의 매핑과 동일) */
export const RCEPT_SE = {
  '01': 'APT 특별공급',
  '02': 'APT 1순위',
  '03': 'APT 2순위',
  '04': '공공지원민간임대',
  '05': '오피스텔/생활숙박시설/도시형생활주택/민간임대',
  '06': '무순위',
  '07': '불법행위재공급',
  '08': '민간사전청약 APT 특별공급',
  '09': '민간사전청약 APT 1순위',
  '10': '민간사전청약 APT 2순위',
  '11': '임의공급',
};

/** 우리가 관심있는 공급유형 (무순위 / 임의공급 / 불법행위재공급) */
export const WATCHED_RCEPT_SE = ['06', '07', '11'];

/** @param {string} yyyymm */
export async function fetchCalendar(yyyymm) {
  const data = await request(CALENDAR_URL, {
    method: 'POST',
    json: true,
    body: JSON.stringify({ inqirePd: yyyymm }),
  });
  return (data.schdulList ?? []).map((s) => ({
    date: s.IN_DATE,
    name: s.HOUSE_NM,
    area: s.SUBSCRPT_AREA_CODE_NM,
    rceptSe: s.RCEPT_SE,
    rceptSeNm: RCEPT_SE[s.RCEPT_SE] ?? s.RCEPT_SE,
    houseSecd: s.HOUSE_SECD,
    pblancNo: String(s.PBLANC_NO),
    houseManageNo: String(s.HOUSE_MANAGE_NO),
    holiday: s.RESTDE_AT === 'Y',
  }));
}
