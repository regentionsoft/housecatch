/* houseCatch — 청약홈 잔여세대(무순위 · 임의공급 · 불법행위재공급) 대시보드 */
(() => {
  'use strict';

  /* ---------------------------------------------------------------- */
  /* 상수                                                              */
  /* ---------------------------------------------------------------- */

  const KINDS = [
    { id: 'post', label: '무순위(사후)', match: (k) => k.includes('사후'), c: 'var(--k-post)', soft: 'var(--k-post-soft)' },
    { id: 'pre', label: '무순위(사전)', match: (k) => k.includes('사전'), c: 'var(--k-pre)', soft: 'var(--k-pre-soft)' },
    { id: 'random', label: '임의공급', match: (k) => k.includes('임의'), c: 'var(--k-random)', soft: 'var(--k-random-soft)' },
    { id: 'illegal', label: '불법행위재공급', match: (k) => k.includes('불법'), c: 'var(--k-illegal)', soft: 'var(--k-illegal-soft)' },
    { id: 'apt', label: '아파트 일반분양', match: (k) => k.includes('일반분양'), c: 'var(--k-apt)', soft: 'var(--k-apt-soft)' },
  ];
  const FALLBACK_KIND = { id: 'etc', label: '기타', c: 'var(--closed)', soft: 'var(--closed-soft)' };

  const STATUSES = {
    open: { label: '접수중', c: 'var(--open)', soft: 'var(--open-soft)' },
    upcoming: { label: '접수예정', c: 'var(--upcoming)', soft: 'var(--upcoming-soft)' },
    closed: { label: '마감', c: 'var(--closed)', soft: 'var(--closed-soft)' },
  };

  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  const PY = 3.305785; // 1평 = 3.3058㎡

  /* ---------------------------------------------------------------- */
  /* 상태                                                              */
  /* ---------------------------------------------------------------- */

  const LS = 'housecatch:v1';
  const state = Object.assign(
    {
      status: 'all',
      kinds: [],
      areas: [],
      q: '',
      sort: 'soon',
      minUnits: 0,
      basis: 'all',
      favOnly: false,
      view: 'card',
      calMonth: null,
      theme: null,
    },
    load(),
  );
  let favs = new Set(load('housecatch:favs') ?? []);
  let dataset = null;
  let items = [];

  function load(key = LS) {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null');
    } catch {
      return null;
    }
  }
  function save() {
    try {
      localStorage.setItem(LS, JSON.stringify(state));
      localStorage.setItem('housecatch:favs', JSON.stringify([...favs]));
    } catch { /* 시크릿 모드 등 */ }
  }

  /* ---------------------------------------------------------------- */
  /* 유틸                                                              */
  /* ---------------------------------------------------------------- */

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : String(k));
    return n;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function todayStr(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const TODAY = todayStr();

  function parseDate(s) {
    if (!s) return null;
    const [y, m, d] = s.split('-').map(Number);
    return y ? new Date(y, m - 1, d) : null;
  }
  function fmtDate(s, withDow = true) {
    const d = parseDate(s);
    if (!d) return '-';
    const base = `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    return withDow ? `${base}(${DOW[d.getDay()]})` : base;
  }
  function fmtPeriod(a, b) {
    if (!a) return '-';
    if (!b || a === b) return fmtDate(a);
    return `${fmtDate(a)} ~ ${fmtDate(b)}`;
  }
  function daysFrom(target) {
    const t = parseDate(target);
    if (!t) return null;
    return Math.round((t - parseDate(TODAY)) / 86400000);
  }
  /** 만원 단위 금액 → "5억 700만" */
  function fmtPrice(manwon) {
    if (manwon == null) return null;
    const eok = Math.floor(manwon / 10000);
    const rest = manwon % 10000;
    if (!eok) return `${rest.toLocaleString()}만`;
    return rest ? `${eok}억 ${rest.toLocaleString()}만` : `${eok}억`;
  }
  function fmtPriceShort(manwon) {
    if (manwon == null) return null;
    return manwon >= 10000 ? `${(manwon / 10000).toFixed(2).replace(/\.?0+$/, '')}억` : `${manwon.toLocaleString()}만`;
  }
  /** 시세차익은 부호를 붙여서 */
  function fmtGain(manwon) {
    if (manwon == null) return '-';
    return `${manwon >= 0 ? '+' : '−'}${fmtPrice(Math.abs(manwon))}`;
  }
  const gainColor = (g) => (g == null ? 'var(--text-3)' : g >= 0 ? 'var(--up)' : 'var(--down)');
  /** 다른 단지와 견줄 때 어떤 성격의 물건을 썼는지 */
  const VINTAGE_LABEL = { presale: '분양권 실거래', recent: '준공 8년 내', old: '구축 실거래' };

  /** 어느 정도로 비슷한 물건과 비교한 값인지 */
  function basisText(mk) {
    const vintage = VINTAGE_LABEL[mk.vintage];
    return `${mk.levelLabel}${vintage ? ` · ${vintage}` : ''} · ${mk.samples}건${mk.latest ? ` · ${mk.latest}` : ''}`;
  }
  const naverUrl = (name) => `https://m.land.naver.com/search/result/${encodeURIComponent(name)}`;
  /** "084.9900B" → { m2: 84.99, tag: "B" } */
  function parseType(name) {
    const m2 = parseFloat(name);
    const tag = (String(name).match(/[A-Za-z가-힣]+$/) || [''])[0];
    return { m2: Number.isFinite(m2) ? m2 : null, tag };
  }
  function typeLabel(name) {
    const { m2, tag } = parseType(name);
    if (m2 == null) return name;
    return `${m2.toFixed(2).replace(/\.?0+$/, '')}㎡${tag ? ' ' + tag : ''}`;
  }

  /** 카드에 짧게 넣으려고 줄인 단계 이름 */
  const STAGE_SHORT = { 특별공급: '특공', 일반공급: '일반' };
  const stageLabel = (s) => STAGE_SHORT[s.label] ?? s.label;

  /** 아직 안 지난(또는 오늘 진행 중인) 첫 단계 */
  function nextStage(it) {
    return (it.stages ?? []).find((s) => (s.end || s.start) >= TODAY) ?? null;
  }

  function statusOf(it) {
    if (it.applyStart && it.applyStart > TODAY) return 'upcoming';
    if (it.applyEnd && it.applyEnd >= TODAY) return 'open';
    if (!it.applyStart && !it.applyEnd) return 'closed';
    return 'closed';
  }
  function kindOf(it) {
    return KINDS.find((k) => k.match(it.kind || '')) ?? FALLBACK_KIND;
  }
  function minPrice(it) {
    const ps = it.types.map((t) => t.price).filter((p) => p != null);
    return ps.length ? Math.min(...ps) : null;
  }

  /* ---------------------------------------------------------------- */
  /* 데이터 로드                                                       */
  /* ---------------------------------------------------------------- */

  async function loadData({ refresh = false } = {}) {
    if (window.__HOUSECATCH__ && !refresh) return window.__HOUSECATCH__;
    const res = await fetch(refresh ? 'api/refresh' : 'api/data', { method: refresh ? 'POST' : 'GET' });
    if (!res.ok) throw new Error(`데이터를 불러오지 못했습니다 (HTTP ${res.status})`);
    return res.json();
  }

  function hydrate(d) {
    dataset = d;
    items = (d.items ?? []).map((it) => ({
      ...it,
      _status: statusOf(it),
      _kind: kindOf(it),
      _minPrice: minPrice(it),
      _search: `${it.name} ${it.area} ${it.developer} ${it.location} ${it.kind}`.toLowerCase(),
    }));
    if (!state.calMonth) {
      const anchor = items.find((i) => i._status !== 'closed')?.applyStart ?? TODAY;
      state.calMonth = anchor.slice(0, 7);
    }
  }

  /* ---------------------------------------------------------------- */
  /* 필터 / 정렬                                                       */
  /* ---------------------------------------------------------------- */

  function visible() {
    const q = state.q.trim().toLowerCase();
    const out = items.filter((it) => {
      if (state.status !== 'all' && it._status !== state.status) return false;
      if (state.kinds.length && !state.kinds.includes(it._kind.id)) return false;
      if (state.areas.length && !state.areas.includes(it.area)) return false;
      if (state.minUnits && (it.totalUnits ?? 0) < state.minUnits) return false;
      if (state.favOnly && !favs.has(it.id)) return false;
      if (state.basis === 'gain' && it.market?.gain == null) return false;
      if (state.basis === 'tight' && !['exact', 'sameComplex'].includes(it.market?.level)) return false;
      if (q && !it._search.includes(q)) return false;
      return true;
    });
    return sortItems(out);
  }

  const STATUS_RANK = { open: 0, upcoming: 1, closed: 2 };
  function sortItems(list) {
    const by = {
      soon: (a, b) =>
        STATUS_RANK[a._status] - STATUS_RANK[b._status] ||
        (a._status === 'closed'
          ? (b.applyEnd || '').localeCompare(a.applyEnd || '')
          : (a.applyEnd || '9').localeCompare(b.applyEnd || '9')),
      notice: (a, b) => (b.noticeDate || '').localeCompare(a.noticeDate || ''),
      units: (a, b) => (b.totalUnits ?? 0) - (a.totalUnits ?? 0),
      gain: (a, b) => (b.market?.gain ?? -Infinity) - (a.market?.gain ?? -Infinity),
      price: (a, b) => (a._minPrice ?? Infinity) - (b._minPrice ?? Infinity),
      area: (a, b) => a.area.localeCompare(b.area, 'ko') || (b.applyStart || '').localeCompare(a.applyStart || ''),
    };
    return [...list].sort(by[state.sort] ?? by.soon);
  }

  /* ---------------------------------------------------------------- */
  /* 렌더 — 요약                                                       */
  /* ---------------------------------------------------------------- */

  function renderStats() {
    const open = items.filter((i) => i._status === 'open');
    const upcoming = items.filter((i) => i._status === 'upcoming');
    const week = upcoming.filter((i) => daysFrom(i.applyStart) <= 7);
    const units = (arr) => arr.reduce((a, i) => a + (i.totalUnits ?? 0), 0);

    const tiles = [
      {
        label: '지금 접수중',
        value: open.length,
        sub: `${units(open).toLocaleString()}세대 모집`,
        color: 'var(--open)',
        live: true,
      },
      {
        label: '접수 예정',
        value: upcoming.length,
        sub: `${units(upcoming).toLocaleString()}세대 · 7일 내 ${week.length}건`,
        color: 'var(--upcoming)',
      },
      {
        label: '수집 물량',
        value: items.length,
        sub: `${units(items).toLocaleString()}세대 / ${dataset.range.beginPd.slice(4)}월~${dataset.range.endPd.slice(4)}월`,
        color: 'var(--accent)',
      },
      {
        label: '가장 임박한 청약',
        value: nextLabel(open, upcoming),
        sub: nextSub(open, upcoming),
        color: 'var(--warn)',
        small: true,
      },
    ];

    const box = $('#stats');
    box.replaceChildren(
      ...tiles.map((t) => {
        const node = el('div', { className: 'stat' });
        node.style.setProperty('--sc', t.color);
        node.append(
          el(
            'div',
            { className: 'stat-label' },
            t.live ? Object.assign(el('span', { className: 'dot live' }), { style: `color:${t.color}` }) : null,
            t.label,
          ),
          el('div', { className: 'stat-value', style: t.small ? 'font-size:19px' : '' }, t.value),
          el('div', { className: 'stat-sub' }, t.sub),
        );
        return node;
      }),
    );
  }

  function nextTarget(open, upcoming) {
    const openSoon = [...open].sort((a, b) => (a.applyEnd || '').localeCompare(b.applyEnd || ''))[0];
    const up = [...upcoming].sort((a, b) => (a.applyStart || '').localeCompare(b.applyStart || ''))[0];
    if (openSoon) return { it: openSoon, kind: 'end', d: daysFrom(openSoon.applyEnd) };
    if (up) return { it: up, kind: 'start', d: daysFrom(up.applyStart) };
    return null;
  }
  function nextLabel(open, upcoming) {
    const t = nextTarget(open, upcoming);
    if (!t) return '없음';
    if (t.kind === 'end') return t.d === 0 ? '오늘 마감' : `마감 D-${t.d}`;
    return t.d === 0 ? '오늘 시작' : `D-${t.d}`;
  }
  function nextSub(open, upcoming) {
    const t = nextTarget(open, upcoming);
    if (!t) return '예정된 청약이 없어요';
    return `${t.it.name} · ${t.it.totalUnits ?? '-'}세대`;
  }

  /* ---------------------------------------------------------------- */
  /* 렌더 — 컨트롤                                                     */
  /* ---------------------------------------------------------------- */

  function renderControls() {
    // 상태 세그먼트
    const counts = { all: items.length, open: 0, upcoming: 0, closed: 0 };
    for (const it of items) counts[it._status]++;
    const segs = [
      ['all', '전체'],
      ['open', '접수중'],
      ['upcoming', '접수예정'],
      ['closed', '마감'],
    ];
    $('#status-seg').replaceChildren(
      ...segs.map(([id, label]) => {
        const b = el('button', { type: 'button', role: 'tab', onclick: () => set({ status: id }) }, label, el('b', {}, counts[id]));
        b.setAttribute('aria-selected', String(state.status === id));
        return b;
      }),
    );

    // 구분 칩
    const kindCount = new Map();
    for (const it of items) kindCount.set(it._kind.id, (kindCount.get(it._kind.id) ?? 0) + 1);
    $('#kind-chips').replaceChildren(
      ...KINDS.filter((k) => kindCount.has(k.id)).map((k) => {
        const on = state.kinds.includes(k.id);
        const b = el('button', { className: 'chip', type: 'button', onclick: () => toggle('kinds', k.id) }, k.label, el('b', {}, kindCount.get(k.id)));
        b.style.setProperty('--c', k.c);
        b.style.setProperty('--c-soft', k.soft);
        b.setAttribute('aria-pressed', String(on));
        return b;
      }),
    );

    // 지역 칩
    const areaCount = new Map();
    for (const it of items) areaCount.set(it.area, (areaCount.get(it.area) ?? 0) + 1);
    const areas = [...areaCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
    $('#area-chips').replaceChildren(
      ...areas.map(([area, n]) => {
        const b = el('button', { className: 'chip', type: 'button', onclick: () => toggle('areas', area) }, area, el('b', {}, n));
        b.setAttribute('aria-pressed', String(state.areas.includes(area)));
        return b;
      }),
    );

    $('#q').value = state.q;
    $('#sort').value = state.sort;
    $('#basis').value = state.basis;
    $('#minUnits').value = String(state.minUnits);
    $('#fav-only').setAttribute('aria-pressed', String(state.favOnly));
    $('#fav-only').textContent = `⭐ 찜만${favs.size ? ` (${favs.size})` : ''}`;
    for (const b of $('#view-tabs').children) b.setAttribute('aria-selected', String(b.dataset.view === state.view));
  }

  function set(patch) {
    Object.assign(state, patch);
    save();
    render();
  }
  function toggle(key, value) {
    const arr = state[key];
    set({ [key]: arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value] });
  }

  /* ---------------------------------------------------------------- */
  /* 렌더 — 카드                                                       */
  /* ---------------------------------------------------------------- */

  function card(it) {
    const st = STATUSES[it._status];
    const k = it._kind;
    const node = el('article', { className: `card${it._status === 'closed' ? ' is-closed' : ''}`, tabIndex: 0 });
    node.style.setProperty('--c', k.c);
    node.style.setProperty('--c-soft', k.soft);
    node.style.setProperty('--s', st.c);
    node.style.setProperty('--s-soft', st.soft);
    node.onclick = (e) => {
      if (e.target.closest('a, .fav')) return;
      openDetail(it);
    };
    node.onkeydown = (e) => {
      if (e.key === 'Enter') openDetail(it);
    };

    // 상단 배지
    const dday = ddayText(it);
    const favBtn = el('button', { className: 'fav', type: 'button', title: '찜하기' }, '⭐');
    favBtn.setAttribute('aria-pressed', String(favs.has(it.id)));
    favBtn.onclick = (e) => {
      e.stopPropagation();
      favs.has(it.id) ? favs.delete(it.id) : favs.add(it.id);
      save();
      render();
    };

    node.append(
      el(
        'div',
        { className: 'card-top' },
        el('span', { className: 'badge badge-status' }, dday),
        el('span', { className: 'badge badge-kind' }, k.label),
        el('span', { className: 'badge badge-area' }, it.area),
        it.isNew ? el('span', { className: 'badge badge-new' }, 'NEW') : null,
        favBtn,
      ),
      el('h3', { className: 'card-title' }, it.name),
      el('p', { className: 'card-loc', title: it.location }, it.location || it.developer || ''),
    );

    // 물량 + 시세차익
    const price = it._minPrice;
    const mk = it.market;
    const gain = mk?.gain ?? null;

    const rightMetric = el('div', { className: 'metric right' });
    if (gain != null) {
      rightMetric.append(
        el('span', { className: 'metric-label' }, '예상 시세차익'),
        el(
          'span',
          { className: 'metric-value', style: `color:${gainColor(gain)}` },
          fmtGain(gain),
          el('em', { style: `color:${gainColor(gain)}` }, `${gain >= 0 ? '+' : ''}${mk.gainPct}%`),
        ),
      );
    } else if (mk) {
      rightMetric.append(
        el('span', { className: 'metric-label' }, '주변 실거래 시세'),
        el('span', { className: 'metric-value' }, fmtPrice(mk.price)),
      );
    } else {
      rightMetric.append(
        el('span', { className: 'metric-label' }, price != null ? '최저 분양가' : '분양가'),
        el('span', { className: 'metric-value' }, price != null ? fmtPrice(price) : '공고문 참조'),
      );
    }

    node.append(
      el(
        'div',
        { className: 'card-metrics' },
        el(
          'div',
          { className: 'metric' },
          el('span', { className: 'metric-label' }, '공급 물량'),
          el('span', { className: 'metric-value' }, (it.totalUnits ?? 0).toLocaleString(), el('em', {}, '세대')),
        ),
        rightMetric,
      ),
    );

    // 대표 주택형 기준 분양가 → 시세 비교와, 그 값이 어디서 나왔는지
    if (mk) {
      node.append(
        el(
          'div',
          { className: 'compare' },
          el(
            'div',
            { className: 'compare-line' },
            el('span', { className: 'muted' }, typeLabel(mk.typeName)),
            mk.basePrice != null
              ? el('b', {}, `분양가 ${fmtPrice(mk.basePrice)}`)
              : el('b', { className: 'muted' }, '분양가 미공개'),
            el('span', { className: 'arrow' }, '→'),
            el('b', { style: `color:${gain != null ? gainColor(gain) : 'inherit'}` }, `시세 ${fmtPrice(mk.price)}`),
          ),
          el('div', { className: `basis lv-${mk.level}${mk.vintage === 'old' ? ' basis-old' : ''}` }, basisText(mk)),
        ),
      );
    }

    // 주택형 분포 막대
    const total = it.types.reduce((a, t) => a + (t.units ?? 0), 0) || 1;
    if (it.types.length) {
      const bar = el('div', { className: 'bar' });
      it.types.forEach((t, i) => {
        const seg = el('span', { title: `${typeLabel(t.name)} · ${t.units}세대` });
        seg.style.flex = `0 0 ${((t.units ?? 0) / total) * 100}%`;
        seg.style.setProperty('--o', String(1 - Math.min(i, 5) * 0.13));
        bar.append(seg);
      });
      node.append(bar);

      const shown = it.types.slice(0, 4);
      node.append(
        el(
          'div',
          { className: 'types' },
          ...shown.map((t) =>
            el(
              'span',
              { className: 'type' },
              typeLabel(t.name),
              el('i', {}, `${t.units ?? '-'}세대`),
              t.price != null ? el('u', {}, fmtPriceShort(t.price)) : null,
            ),
          ),
          it.types.length > shown.length ? el('span', { className: 'type more' }, `+${it.types.length - shown.length}`) : null,
        ),
      );
    }

    // 일정
    const upcoming = nextStage(it);
    const scheduleLines = it.stages?.length
      ? it.stages.map((s) =>
          el(
            'div',
            { className: `dline${s === upcoming ? ' hot' : ''}` },
            el('span', {}, stageLabel(s)),
            el('b', {}, fmtPeriod(s.start, s.end)),
          ),
        )
      : [el('div', { className: 'dline hot' }, el('span', {}, '청약'), el('b', {}, fmtPeriod(it.applyStart, it.applyEnd)))];

    node.append(
      el(
        'div',
        { className: 'card-dates' },
        ...scheduleLines,
        el('div', { className: 'dline' }, el('span', {}, '발표'), el('b', {}, fmtDate(it.winnerDate))),
        it.stages?.length
          ? null
          : el('div', { className: 'dline' }, el('span', {}, '계약'), el('b', {}, it.contractStart ? fmtPeriod(it.contractStart, it.contractEnd) : '-')),
        el('div', { className: 'dline' }, el('span', {}, '입주'), el('b', {}, it.moveIn || '-')),
      ),
    );

    node.append(
      el(
        'div',
        { className: 'card-foot' },
        it.noticeUrl
          ? el('a', { className: 'link primary', href: it.noticeUrl, target: '_blank', rel: 'noreferrer' }, '모집공고문')
          : null,
        el('a', { className: 'link', href: it.detailUrl, target: '_blank', rel: 'noreferrer' }, '청약홈'),
        el('a', { className: 'link', href: naverUrl(it.name), target: '_blank', rel: 'noreferrer' }, '네이버 시세'),
      ),
    );

    return node;
  }

  function ddayText(it) {
    // 단계가 나뉜 공고(특별공급·1순위·2순위)는 코앞의 단계를 기준으로 알려준다
    const stage = it._status === 'closed' ? null : nextStage(it);
    if (stage) {
      const d = daysFrom(stage.start);
      if (d > 0) return `${stageLabel(stage)} D-${d}`;
      const left = daysFrom(stage.end || stage.start);
      return left === 0 ? `${stageLabel(stage)} 오늘` : `${stageLabel(stage)} 진행중`;
    }
    if (it._status === 'upcoming') {
      const d = daysFrom(it.applyStart);
      return d === 0 ? '오늘 시작' : `접수까지 D-${d}`;
    }
    if (it._status === 'open') {
      const d = daysFrom(it.applyEnd);
      return d === 0 ? '오늘 마감' : `마감 D-${d}`;
    }
    const d = daysFrom(it.applyEnd);
    return d == null ? '마감' : `마감 ${Math.abs(d)}일 전`;
  }

  /* ---------------------------------------------------------------- */
  /* 렌더 — 표                                                         */
  /* ---------------------------------------------------------------- */

  function renderTable(list) {
    const tbody = $('#tbl tbody');
    tbody.replaceChildren(
      ...list.map((it) => {
        const tr = el('tr');
        tr.onclick = (e) => {
          if (e.target.closest('a')) return;
          openDetail(it);
        };
        const st = STATUSES[it._status];
        const badge = el('span', { className: 'badge badge-status' }, st.label);
        badge.style.setProperty('--s', st.c);
        badge.style.setProperty('--s-soft', st.soft);
        const kindBadge = el('span', { className: 'badge badge-kind' }, it._kind.label);
        kindBadge.style.setProperty('--c', it._kind.c);
        kindBadge.style.setProperty('--c-soft', it._kind.soft);
        tr.append(
          el('td', {}, badge),
          el('td', {}, kindBadge),
          el('td', { className: 'muted' }, it.area),
          el('td', { className: 'name' }, it.name),
          el('td', { className: 'num' }, `${(it.totalUnits ?? 0).toLocaleString()}세대`),
          el('td', { className: 'num' }, it._minPrice != null ? fmtPrice(it._minPrice) : '-'),
          el('td', { className: 'num' }, it.market ? fmtPrice(it.market.price) : '-'),
          el(
            'td',
            { className: 'num', style: `color:${gainColor(it.market?.gain ?? null)}` },
            it.market?.gain != null ? `${fmtGain(it.market.gain)} (${it.market.gainPct}%)` : '-',
          ),
          el('td', { className: 'muted' }, it.market ? it.market.levelLabel : '-'),
          el('td', { className: 'muted' }, fmtPeriod(it.applyStart, it.applyEnd)),
          el('td', { className: 'muted' }, fmtDate(it.winnerDate, false)),
          el('td', { className: 'muted' }, it.moveIn || '-'),
          el(
            'td',
            {},
            it.noticeUrl ? el('a', { className: 'link', href: it.noticeUrl, target: '_blank', rel: 'noreferrer' }, '공고문') : null,
          ),
        );
        return tr;
      }),
    );
  }

  /* ---------------------------------------------------------------- */
  /* 렌더 — 캘린더                                                     */
  /* ---------------------------------------------------------------- */

  function renderCalendar(list) {
    const [y, m] = state.calMonth.split('-').map(Number);
    $('#cal-title').textContent = `${y}년 ${m}월`;

    // 날짜 → 해당일에 청약접수가 열려 있는 물량
    const byDay = new Map();
    const put = (key, entry) => {
      if (!key.startsWith(state.calMonth)) return;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(entry);
    };
    const spread = (from, to, entry) => {
      const start = parseDate(from);
      const end = parseDate(to || from);
      if (!start) return;
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) put(todayStr(d), entry);
    };
    for (const it of list) {
      // 특별공급·1순위·2순위처럼 단계가 나뉜 공고는 날짜마다 어느 단계인지 같이 보여준다
      if (it.stages?.length) for (const st of it.stages) spread(st.start, st.end, { it, stage: st });
      else spread(it.applyStart, it.applyEnd, { it, stage: null });
    }

    const first = new Date(y, m - 1, 1);
    const gridStart = new Date(first);
    gridStart.setDate(1 - first.getDay());
    const cells = [];

    for (let i = 0; i < 7; i++) {
      cells.push(el('div', { className: `cal-dow${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}` }, DOW[i]));
    }

    const daysInMonth = new Date(y, m, 0).getDate();
    const weeks = Math.ceil((first.getDay() + daysInMonth) / 7);

    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      const key = todayStr(d);
      const out = d.getMonth() !== m - 1;
      const cell = el('div', { className: `cal-cell${out ? ' out' : ''}${key === TODAY ? ' today' : ''}` });
      const dowCls = d.getDay() === 0 ? ' sun' : d.getDay() === 6 ? ' sat' : '';
      cell.append(el('div', { className: `cal-day${dowCls}` }, d.getDate()));

      const list_ = byDay.get(key) ?? [];
      for (const { it, stage } of list_.slice(0, 3)) {
        const b = el(
          'button',
          { className: 'cal-item', type: 'button', title: `${it.name}${stage ? ` · ${stage.label}` : ''} · ${it.totalUnits ?? '-'}세대` },
          el('u', {}, stage ? stageLabel(stage) : `${it.totalUnits ?? '-'}`),
          it.name,
        );
        b.style.setProperty('--c', it._kind.c);
        b.style.setProperty('--c-soft', it._kind.soft);
        b.onclick = () => openDetail(it);
        cell.append(b);
      }
      if (list_.length > 3) {
        const more = el('button', { className: 'cal-more', type: 'button' }, `+${list_.length - 3}건 더`);
        more.onclick = () => openDayList(key, list_);
        cell.append(more);
      }
      cells.push(cell);
    }

    $('#cal').replaceChildren(el('div', { className: 'cal-grid' }, ...cells));
  }

  function shiftMonth(delta) {
    const [y, m] = state.calMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    set({ calMonth: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` });
  }

  /* ---------------------------------------------------------------- */
  /* 상세 시트                                                         */
  /* ---------------------------------------------------------------- */

  function openDetail(it) {
    const dlg = $('#detail');
    const st = STATUSES[it._status];
    const totalUnits = it.types.reduce((a, t) => a + (t.units ?? 0), 0);

    const head = el('div', { className: 'sheet-head' });
    const badges = el('div', { className: 'card-top', style: 'padding:0' });
    const b1 = el('span', { className: 'badge badge-status' }, `${st.label} · ${ddayText(it)}`);
    b1.style.setProperty('--s', st.c);
    b1.style.setProperty('--s-soft', st.soft);
    const b2 = el('span', { className: 'badge badge-kind' }, it._kind.label);
    b2.style.setProperty('--c', it._kind.c);
    b2.style.setProperty('--c-soft', it._kind.soft);
    badges.append(b1, b2, el('span', { className: 'badge badge-area' }, it.area));
    head.append(
      badges,
      el('h3', {}, it.name),
      el('p', {}, it.location || '-'),
      el('button', { className: 'sheet-close', type: 'button', onclick: () => dlg.close() }, '✕'),
    );

    const kv = el(
      'dl',
      { className: 'kv' },
      el('dt', {}, '시행사'), el('dd', {}, it.developer || '-'),
      el('dt', {}, '모집공고일'), el('dd', {}, it.noticeDate || '-'),
      ...(it.stages?.length
        ? it.stages.flatMap((st) => [
            el('dt', {}, st.label),
            el('dd', {}, `${st.start}${st.end && st.end !== st.start ? ` ~ ${st.end}` : ''}`),
          ])
        : [el('dt', {}, '청약접수'), el('dd', {}, `${it.applyStart || '-'}${it.applyEnd && it.applyEnd !== it.applyStart ? ` ~ ${it.applyEnd}` : ''}`)]),
      el('dt', {}, '당첨자발표'), el('dd', {}, it.winnerDate || '-'),
      el('dt', {}, '계약일'), el('dd', {}, it.contractStart ? `${it.contractStart}${it.contractEnd && it.contractEnd !== it.contractStart ? ` ~ ${it.contractEnd}` : ''}` : '-'),
      el('dt', {}, '입주예정'), el('dd', {}, it.moveIn || '-'),
      el('dt', {}, '문의'), el('dd', {}, it.tel || '-'),
    );

    const body = el('div', { className: 'sheet-body' });
    if (it.image) body.append(el('img', { className: 'sheet-banner', src: it.image, alt: '', loading: 'lazy' }));
    body.append(kv);

    if (it.types.length) {
      const hasPrice = it.types.some((t) => t.price != null);
      const hasMarket = it.types.some((t) => t.market != null);
      const cols = 2 + (hasPrice ? 1 : 0) + (hasMarket ? 2 : 0);
      body.append(
        el('h4', {}, `공급 내역 (총 ${totalUnits.toLocaleString()}세대)`),
        el(
          'table',
          { className: 'mini-tbl' },
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', {}, '주택형(전용)'),
              el('th', {}, '세대수'),
              hasPrice ? el('th', {}, '분양가') : null,
              hasMarket ? el('th', {}, '실거래 시세') : null,
              hasMarket ? el('th', {}, '차익') : null,
            ),
          ),
          el(
            'tbody',
            {},
            ...it.types.map((t) => {
              const { m2 } = parseType(t.name);
              return el(
                'tr',
                {},
                el('td', {}, `${typeLabel(t.name)}${m2 ? ` · ${(m2 / PY).toFixed(1)}평` : ''}`),
                el('td', {}, `${(t.units ?? 0).toLocaleString()}`),
                hasPrice ? el('td', {}, t.price != null ? fmtPrice(t.price) : '-') : null,
                hasMarket ? el('td', {}, t.market != null ? fmtPrice(t.market) : '-') : null,
                hasMarket
                  ? el('td', { style: `color:${gainColor(t.gain ?? null)}` }, t.gain != null ? fmtGain(t.gain) : '-')
                  : null,
              );
            }),
          ),
          el(
            'tfoot',
            {},
            el(
              'tr',
              {},
              el('td', {}, '합계'),
              el('td', {}, totalUnits.toLocaleString()),
              ...Array.from({ length: cols - 2 }, () => el('td', {}, '')),
            ),
          ),
        ),
      );

      if (it.market) {
        body.append(
          el(
            'div',
            { className: 'note basis-note' },
            el('b', {}, `시세 근거 — ${it.market.levelLabel}${VINTAGE_LABEL[it.market.vintage] ? ` · ${VINTAGE_LABEL[it.market.vintage]}` : ''}`),
            `\n${it.market.region} · 최근 1년 실거래 ${it.market.samples}건 (${fmtPrice(it.market.low)} ~ ${fmtPrice(it.market.high)}, 중앙값 ${fmtPrice(it.market.price)})`,
            it.market.ref ? `\n비교 대상: ${it.market.ref}${it.market.presaleShare ? ` · 분양권 거래 ${it.market.presaleShare}%` : ''}` : '',
            it.market.vintage === 'old'
              ? '\n주변에 분양권이나 신축 거래가 없어 구축 실거래와 비교했습니다. 신축 분양가와는 성격이 달라 차익이 실제보다 크게 벌어져 보일 수 있어요.'
              : '',
            '\n국토교통부 실거래가 기준이라 네이버 부동산 호가와는 차이가 있을 수 있어요.',
          ),
        );
      }
    }

    for (const n of it.notes) body.append(el('div', { className: 'note' }, n));

    body.append(
      el(
        'div',
        { className: 'sheet-actions' },
        it.noticeUrl ? el('a', { className: 'link primary', href: it.noticeUrl, target: '_blank', rel: 'noreferrer' }, '모집공고문 PDF') : null,
        el('a', { className: 'link', href: it.detailUrl, target: '_blank', rel: 'noreferrer' }, '청약홈 상세'),
        el('a', { className: 'link', href: naverUrl(it.name), target: '_blank', rel: 'noreferrer' }, '네이버 부동산'),
        el(
          'a',
          {
            className: 'link',
            href: `https://map.naver.com/p/search/${encodeURIComponent(it.location || it.name)}`,
            target: '_blank',
            rel: 'noreferrer',
          },
          '지도에서 보기',
        ),
      ),
    );

    $('#detail-body').replaceChildren(head, body);
    dlg.showModal();
  }

  function openDayList(key, list) {
    const dlg = $('#detail');
    const head = el('div', { className: 'sheet-head' });
    head.append(
      el('h3', {}, `${key} 청약`),
      el('p', {}, `${list.length}건 · ${list.reduce((a, e) => a + (e.it.totalUnits ?? 0), 0).toLocaleString()}세대`),
      el('button', { className: 'sheet-close', type: 'button', onclick: () => dlg.close() }, '✕'),
    );
    const body = el('div', { className: 'sheet-body' });
    for (const { it, stage } of list) {
      const row = el(
        'button',
        { className: 'cal-item', type: 'button', style: 'margin-bottom:6px;padding:8px 10px;font-size:13px' },
        el('u', {}, stage ? `${stage.label} · ${it.totalUnits ?? '-'}세대` : `${it.totalUnits ?? '-'}세대`),
        it.name,
      );
      row.style.setProperty('--c', it._kind.c);
      row.style.setProperty('--c-soft', it._kind.soft);
      row.onclick = () => openDetail(it);
      body.append(row);
    }
    $('#detail-body').replaceChildren(head, body);
    dlg.showModal();
  }

  /* ---------------------------------------------------------------- */
  /* 메인 렌더                                                         */
  /* ---------------------------------------------------------------- */

  function render() {
    if (!dataset) return;
    renderStats();
    renderControls();

    const list = visible();
    $('#result-count').textContent = `${list.length}건 · ${list.reduce((a, i) => a + (i.totalUnits ?? 0), 0).toLocaleString()}세대`;

    $('#view-card').hidden = state.view !== 'card';
    $('#view-calendar').hidden = state.view !== 'calendar';
    $('#view-table').hidden = state.view !== 'table';
    $('#empty').hidden = list.length > 0 || state.view === 'calendar';

    if (state.view === 'card') $('#cards').replaceChildren(...list.map(card));
    else if (state.view === 'table') renderTable(list);
    else renderCalendar(list);

    const d = new Date(dataset.generatedAt);
    const stamp = $('#stamp');
    stamp.textContent = `기준 ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (dataset.marketAsOf) {
      const m = new Date(dataset.marketAsOf);
      stamp.title = `물량·일정 ${d.toLocaleString('ko-KR')}\n시세 ${m.toLocaleDateString('ko-KR')} 수집`;
      const days = Math.floor((d - m) / 86400000);
      if (days >= 1) stamp.textContent += ` · 시세 ${days}일 전`;
    }
  }

  /* ---------------------------------------------------------------- */
  /* 이벤트 바인딩                                                     */
  /* ---------------------------------------------------------------- */

  /** 사용자가 고른 값 > 호스트가 찍어둔 값 > OS 설정 */
  function applyTheme() {
    const host = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme =
      state.theme ?? host ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }

  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), ms);
  }

  function bind() {
    $('#btn-theme').onclick = () => {
      state.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      save();
      applyTheme();
    };

    $('#btn-refresh').onclick = async () => {
      if (window.__HOUSECATCH__) {
        toast('저장된 스냅샷이에요 — 기준 시각은 오른쪽 위를 봐주세요');
        return;
      }
      const btn = $('#btn-refresh');
      btn.disabled = true;
      btn.querySelector('svg').classList.add('spin');
      $('#progress').hidden = false;
      try {
        hydrate(await loadData({ refresh: true }));
        render();
        toast('청약홈에서 최신 물량을 받아왔어요');
      } catch (err) {
        toast(`새로고침 실패: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.querySelector('svg').classList.remove('spin');
        $('#progress').hidden = true;
      }
    };

    let qTimer;
    $('#q').oninput = (e) => {
      clearTimeout(qTimer);
      const v = e.target.value;
      qTimer = setTimeout(() => set({ q: v }), 160);
    };
    $('#sort').onchange = (e) => set({ sort: e.target.value });
    $('#basis').onchange = (e) => set({ basis: e.target.value });
    $('#minUnits').onchange = (e) => set({ minUnits: Number(e.target.value) });
    $('#fav-only').onclick = () => set({ favOnly: !state.favOnly });
    const reset = () =>
      set({ status: 'all', kinds: [], areas: [], q: '', minUnits: 0, favOnly: false, sort: 'soon', basis: 'all' });
    $('#reset').onclick = reset;
    $('#empty-reset').onclick = reset;

    for (const b of $('#view-tabs').children) b.onclick = () => set({ view: b.dataset.view });

    $('#cal-prev').onclick = () => shiftMonth(-1);
    $('#cal-next').onclick = () => shiftMonth(1);
    $('#cal-today').onclick = () => set({ calMonth: TODAY.slice(0, 7) });

    $('#detail').onclick = (e) => {
      if (e.target.id === 'detail') $('#detail').close();
    };

    addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== $('#q')) {
        e.preventDefault();
        $('#q').focus();
      }
    });
  }

  /* ---------------------------------------------------------------- */

  async function main() {
    applyTheme();
    bind();
    $('#cards').replaceChildren(...Array.from({ length: 6 }, () => el('div', { className: 'skeleton' })));
    try {
      hydrate(await loadData());
      render();
    } catch (err) {
      $('#cards').replaceChildren(
        el('div', { className: 'empty' }, el('p', {}, `데이터를 불러오지 못했습니다. ${err.message}`)),
      );
    }
  }

  main();
})();
