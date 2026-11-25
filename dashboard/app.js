/* Token Launch Radar — the page. No framework, no network, no build step: one script over window.RADAR,
   the dataset main.ts writes beside dashboard/. Every figure on screen comes from that dataset, which is
   the same board.json the gate reads. */

(function () {
  'use strict';

  var R = window.RADAR;
  if (!R || !R.rows) {
    document.getElementById('board').innerHTML = '<p class="empty">data.js is missing: run main.ts to write it beside dashboard/.</p>';
    return;
  }

  var state = { tab: 'pre', q: '', cat: '', chain: '', sort: 'rank', p: null };

  // ---------------------------------------------------------------- formatting

  // Three significant digits at every magnitude, so a reader can recompute a column from what is shown.
  function usd(n) {
    if (n === null || n === undefined) return '—';
    var a = Math.abs(n);
    function sig(x, unit) {
      var d = x >= 100 ? 0 : x >= 10 ? 1 : 2;
      return '$' + x.toFixed(d) + unit;
    }
    if (a >= 1e12) return sig(n / 1e12, 'T');
    if (a >= 1e9) return sig(n / 1e9, 'B');
    if (a >= 1e6) return sig(n / 1e6, 'M');
    if (a >= 1e3) return sig(n / 1e3, 'K');
    return '$' + Math.round(n);
  }

  function pct(n) {
    if (n === null || n === undefined) return '—';
    return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(2) + '%';
  }

  function age(days) {
    if (days === null || days === undefined) return '—';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    if (days >= 30) return Math.round(days / 30) + 'mo';
    return days + 'd';
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function el(id) { return document.getElementById(id); }

  // A rank is zero-padded to the width of the board, never to a fixed two digits.
  function pad(n) {
    var w = String(R.rows.length).length;
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  // ---------------------------------------------------------------- filters

  var cats = [];
  var chains = [];
  var seenC = {}, seenCh = {};
  R.rows.forEach(function (r) {
    if (r.category && !seenC[r.category]) { seenC[r.category] = 1; cats.push(r.category); }
    r.chains.forEach(function (c) { if (!seenCh[c]) { seenCh[c] = 1; chains.push(c); } });
  });
  cats.sort();
  chains.sort();

  function fill(select, values, all) {
    var html = '<option value="">' + all + '</option>';
    values.forEach(function (v) { html += '<option value="' + esc(v) + '">' + esc(v) + '</option>'; });
    select.innerHTML = html;
  }

  function tabRows() {
    if (state.tab === 'watch') return R.rows.filter(function (r) { return r.watchlist; });
    if (state.tab === 'hot') return R.rows.filter(function (r) { return r.launch_pressure >= R.stats.hot_threshold; });
    return R.rows;
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return tabRows().filter(function (r) {
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (q) {
        var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function sorted(rows) {
    var out = rows.slice();
    var s = state.sort;
    out.sort(function (a, b) {
      if (s === 'pressure') return b.launch_pressure - a.launch_pressure || a.rank - b.rank;
      if (s === 'multiple') return b.multiple - a.multiple || a.rank - b.rank;
      if (s === 'tvl') return b.tvl_usd - a.tvl_usd || a.rank - b.rank;
      if (s === 'change') return (b.change_7d === null ? -1e9 : b.change_7d) - (a.change_7d === null ? -1e9 : a.change_7d);
      if (s === 'age') return (b.age_days === null ? -1 : b.age_days) - (a.age_days === null ? -1 : a.age_days);
      if (s === 'name') return a.name.localeCompare(b.name);
      return a.rank - b.rank;
    });
    return out;
  }

  // ---------------------------------------------------------------- header, stats, tabs

  function renderStats() {
    var s = R.stats;
    var tiles = [
      { k: 'protocols in the snapshot', v: String(s.protocols), s: 'DefiLlama, ' + R.as_of, cls: '' },
      { k: 'pre-token candidates', v: String(s.pretoken), s: 'of ' + (s.pretoken + s.set_aside) + ' that record no token; ' + s.set_aside + ' are bridged or staked forms', cls: '' },
      { k: 'implied value on the board', v: usd(s.implied_total), s: 'sum of ' + s.rows + ' rows · median ' + usd(s.implied_median), cls: 'accent' },
      { k: 'watchlist covered', v: s.watchlist_covered + '/' + s.watchlist, s: 'every slug the house kept, by construction', cls: 'accent' },
      { k: 'hot launches', v: String(s.hot), s: 'launch pressure ' + s.hot_threshold + ' and up', cls: 'warn' }
    ];
    el('stats').innerHTML = tiles.map(function (t) {
      return '<div class="stat ' + t.cls + '"><div class="k">' + esc(t.k) + '</div><div class="v">' + esc(t.v) + '</div><div class="s">' + esc(t.s) + '</div></div>';
    }).join('');
    el('meta-date').textContent = R.as_of;
    el('meta-model').textContent = R.model.version;
    el('meta-watch').textContent = s.watchlist_covered + '/' + s.watchlist;
    el('n-pre').textContent = String(R.rows.length);
    el('n-watch').textContent = String(s.watchlist);
    el('n-hot').textContent = String(s.hot);
    el('n-live').textContent = String(s.live_shown);
    el('hot-thresh').textContent = String(s.hot_threshold);
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === state.tab);
    });
  }

  // ---------------------------------------------------------------- the board

  var COLS = [
    { key: 'rank', label: '#', cls: 'left' },
    { key: 'name', label: 'protocol', cls: 'left' },
    { key: 'tvl', label: 'TVL', cls: 'r' },
    { key: 'change', label: '7-day change', cls: 'r' },
    { key: 'age', label: 'no token for', cls: 'r' },
    { key: 'pressure', label: 'launch pressure', cls: 'r' },
    { key: 'multiple', label: '× TVL', cls: 'r' },
    { key: 'value', label: 'implied value', cls: 'r' }
  ];

  function renderHead() {
    el('head').innerHTML = '<tr>' + COLS.map(function (c) {
      var on = c.key === 'value' ? state.sort === 'rank' : c.key !== 'rank' && state.sort === c.key;
      return '<th class="' + c.cls + (on ? ' sorted' : '') + '" data-sort="' + c.key + '">' + esc(c.label) + '</th>';
    }).join('') + '</tr>';
  }

  function pressureBar(p) {
    var hot = R.stats.hot_threshold;
    var cls = p >= hot ? '' : p >= hot * 0.7 ? 'mid' : 'low';
    return '<div class="bar"><div class="track"><div class="fill ' + cls + '" style="width:' + Math.max(3, p) + '%"></div></div><span class="num">' + p + '</span></div>';
  }

  function renderBoard() {
    var rows = sorted(filtered());
    renderHead();
    var html = rows.map(function (r) {
      var cls = 'row' + (state.p === r.slug ? ' on' : '');
      var chg = r.change_7d === null ? 'flat' : r.change_7d > 0 ? 'up' : r.change_7d < 0 ? 'down' : 'flat';
      var meta = (r.category || 'unclassified') + ' · ' + r.chains.slice(0, 2).join(', ') + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '');
      return '<tr class="' + cls + '" data-slug="' + esc(r.slug) + '">' +
        '<td class="rank">' + pad(r.rank) + '</td>' +
        '<td><div class="pname">' + (r.watchlist ? '<span class="dot" title="on the watchlist"></span>' : '') +
          '<span class="nm">' + esc(r.name) + '</span>' + (r.watchlist ? '<span class="wtag">watch</span>' : '') + '</div>' +
          '<div class="pmeta">' + esc(meta) + '</div></td>' +
        '<td class="r tvl">' + usd(r.tvl_usd) + '</td>' +
        '<td class="r chg ' + chg + '">' + pct(r.change_7d) + '</td>' +
        '<td class="r ten">' + age(r.age_days) + '</td>' +
        '<td class="r">' + pressureBar(r.launch_pressure) + '</td>' +
        '<td class="r ten">' + r.multiple.toFixed(2) + '×</td>' +
        '<td class="r imp">' + usd(r.implied_value_usd) + '<small>' + r.peer_multiple.toFixed(3) + ' × ' + r.momentum_multiplier.toFixed(3) + ' × ' + r.tenure_multiplier.toFixed(3) + '</small></td>' +
        '</tr>';
    }).join('');

    if (state.tab === 'live') {
      renderLive();
      return;
    }
    el('table').hidden = false;
    el('body').innerHTML = html;
    el('empty').hidden = rows.length > 0;

    var total = rows.reduce(function (n, r) { return n + r.implied_value_usd; }, 0);
    el('foot').innerHTML =
      '<b>' + rows.length + ' protocol' + (rows.length === 1 ? '' : 's') + '</b> shown · ' +
      usd(total) + ' of implied value · bridged, wrapped and staked forms of a coin that already trades are not ranked · implied = TVL × the median market-cap/TVL multiple of the same category\'s ' +
      'live tokens (' + R.calibration.instruments + ' instruments, market median ' + R.calibration.market.multiple.toFixed(2) + '×) × 7-day momentum × tenure<br>' +
      'snapshot ' + esc(R.as_of) + ' · ' + esc(R.source) + ' · a board\'s implied value is this radar\'s own claim, never a promise that a token is issued';
  }

  function renderLive() {
    el('table').hidden = true;
    el('empty').hidden = true;
    var q = state.q.trim().toLowerCase();
    var rows = R.live.filter(function (r) {
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var body = rows.map(function (r, i) {
      var chg = r.change_7d === null ? 'flat' : r.change_7d > 0 ? 'up' : 'down';
      return '<tr class="row" data-slug="' + esc(r.slug) + '">' +
        '<td class="rank">' + pad(i + 1) + '</td>' +
        '<td><div class="pname"><span class="nm">' + esc(r.name) + '</span></div><div class="pmeta">' + esc(r.category || 'unclassified') + ' · ' + esc(r.chains.slice(0, 3).join(', ')) + '</div></td>' +
        '<td class="r tvl">' + usd(r.tvl_usd) + '</td>' +
        '<td class="r chg ' + chg + '">' + pct(r.change_7d) + '</td>' +
        '<td class="r ten">—</td><td class="r ten">—</td>' +
        '<td class="r ten">' + (r.multiple === null ? '—' : r.multiple.toFixed(2) + '×') + '</td>' +
        '<td class="r imp">' + usd(r.mcap_usd) + '<small>market cap, not a model</small></td>' +
        '</tr>';
    }).join('');

    var note = document.getElementById('livenote');
    if (!note) {
      note = document.createElement('div');
      note.className = 'livenote';
      note.id = 'livenote';
      el('board').insertBefore(note, el('table'));
    } else {
      note.hidden = false;
    }
    note.innerHTML = '<b>The ' + rows.length + ' largest of the ' + R.stats.live + ' protocols whose token already trades.</b> Their value is the market\'s, so they are kept out of the ranking and shown here for contrast only: ' +
      'what a coin trades at today, against what the board says a pre-token protocol would be worth. The ' + R.stats.pretoken + ' rows on the other tabs record no token at all.';

    el('head').innerHTML = '<tr>' + [
      ['#', 'left'], ['protocol', 'left'], ['TVL', 'r'], ['7-day change', 'r'], ['no token for', 'r'], ['launch pressure', 'r'], ['mcap / TVL', 'r'], ['market cap', 'r']
    ].map(function (c) { return '<th class="' + c[1] + '">' + esc(c[0]) + '</th>'; }).join('') + '</tr>';
    el('body').innerHTML = body;
    el('foot').innerHTML = '<b>' + rows.length + ' live protocols</b> · sorted by market cap · these are the comparables the value model is calibrated on, category by category';
  }

  // ---------------------------------------------------------------- applied filters

  function renderApplied(rows) {
    var box = el('applied');
    var chips = [];
    var tabNames = { watch: 'Watchlist only', hot: 'Hot ≥' + R.stats.hot_threshold, live: 'Already trading' };
    if (state.tab !== 'pre') chips.push(['tab', tabNames[state.tab] || state.tab]);
    if (state.cat) chips.push(['cat', 'Category: ' + state.cat]);
    if (state.chain) chips.push(['chain', 'Chain: ' + state.chain]);
    if (state.q.trim()) chips.push(['q', 'Search: “' + state.q.trim() + '”']);

    var head = chips.length === 0
      ? '<span class="tagline">' + (state.tab === 'live' ? 'live tokens' : 'all pre-token protocols') + '</span>' +
        '<span class="quiet">no filter</span>'
      : '<span class="tagline">filtered</span>' + chips.map(function (c) {
          return '<span class="fchip">' + esc(c[1]) + '<button data-drop="' + c[0] + '" aria-label="remove filter">×</button></span>';
        }).join('');

    var count = chips.length === 0
      ? '<span class="count"><b>' + rows.length + '</b> rows</span>'
      : '<span class="count"><b>' + rows.length + '</b> of ' + tabRows().length + ' match</span>';
    box.hidden = false;
    box.innerHTML = head + count +
      '<span class="legend"><i class="dot-i"></i> watchlist' +
      '<i class="bar-i"></i> launch pressure 0–100' +
      '<i class="txt-i">× TVL = peer × momentum × tenure</i>' +
      '<i class="txt-i">click a row for the farm plan</i></span>';
  }

  // ---------------------------------------------------------------- detail view

  function splitStep(text) {
    var m = text.match(/^(.*?)\s*Cost:\s*(.*?)\s*Time:\s*(.*)$/);
    if (!m) return { body: text, cost: '', time: '' };
    return { body: m[1], cost: m[2], time: m[3] };
  }

  function factor(label, value, fill, cls) {
    return '<div class="factor"><span class="k">' + esc(label) + '</span>' +
      '<div class="track"><div class="fill ' + (cls || '') + '" style="width:' + Math.max(2, Math.min(100, fill)) + '%"></div></div>' +
      '<span class="v">' + esc(value) + '</span></div>';
  }

  function renderDetail() {
    var box = el('detail');
    var r = null;
    for (var i = 0; i < R.rows.length; i++) if (R.rows[i].slug === state.p) r = R.rows[i];
    if (!r) {
      box.classList.remove('open');
      box.setAttribute('aria-hidden', 'true');
      box.innerHTML = '';
      el('scrim').hidden = true;
      document.body.classList.remove('detail-open');
      return;
    }
    var basis = r.peer_basis === 'category';
    var steps = r.farm_steps.map(function (s) {
      var p = splitStep(s);
      return '<li>' + esc(p.body) + '<span class="cost">Cost: ' + esc(p.cost) + ' <span class="t">· Time: ' + esc(p.time) + '</span></span></li>';
    }).join('');
    var yrs = r.age_days === null ? 'unknown' : (r.age_days / 365).toFixed(1) + ' years';

    box.innerHTML =
      '<div class="dhead">' +
        '<div class="r">rank ' + r.rank + ' of ' + R.rows.length + (r.watchlist ? ' · on the watchlist' : ' · below the floor, found early') + '</div>' +
        '<h2>' + esc(r.name) + '</h2>' +
        '<div class="sub">' + esc(r.category || 'unclassified') + ' · ' + esc(r.chains.join(', ')) + ' · tracked since ' + esc(r.listed_at || 'an unknown day') + '</div>' +
        '<button class="dclose" id="dclose" aria-label="close">×</button>' +
      '</div>' +
      '<div class="dbody">' +
        '<div class="bigval"><span class="v">' + usd(r.implied_value_usd) + '</span><span class="u">implied value at launch · ' + r.multiple.toFixed(2) + '× its TVL</span></div>' +
        '<div class="formula">' +
          '<b>' + usd(r.tvl_usd) + '</b> TVL <span class="op">×</span> <b>' + r.peer_multiple.toFixed(3) + '</b> peer multiple ' +
          '<span class="op">×</span> <b>' + r.momentum_multiplier.toFixed(3) + '</b> momentum <span class="op">×</span> <b>' + r.tenure_multiplier.toFixed(3) + '</b> tenure ' +
          '<span class="op">=</span> <b>' + usd(r.implied_value_usd) + '</b><br>' +
          '<span class="op">peer multiple</span> = median market cap ÷ TVL of the ' + r.peer_samples + ' live ' + (basis ? esc(r.category) : 'protocols market-wide') + ' tokens in this snapshot<br>' +
          '<span class="op">momentum</span> = 1 + 7-day change × 0.30, held 0.85–1.45× · <span class="op">tenure</span> = 0.72 + min(years unlaunched, 3) ÷ 3 × 0.28' +
        '</div>' +
        '<div class="factors">' +
          factor('peer multiple', r.peer_multiple.toFixed(2) + '×', (r.peer_multiple / 2) * 100, 'mint') +
          factor('7-day momentum', r.momentum_multiplier.toFixed(2) + '×', ((r.momentum_multiplier - 0.85) / 0.6) * 100, '') +
          factor('tenure', r.tenure_multiplier.toFixed(2) + '×', ((r.tenure_multiplier - 0.72) / 0.28) * 100, '') +
          factor('launch pressure', r.launch_pressure + '/100', r.launch_pressure, 'mint') +
        '</div>' +
        '<div class="grid2">' +
          '<div class="cell"><span class="k">TVL today</span><span class="v">' + usd(r.tvl_usd) + '</span></div>' +
          '<div class="cell"><span class="k">7-day change</span><span class="v">' + pct(r.change_7d) + '</span></div>' +
          '<div class="cell"><span class="k">no token for</span><span class="v">' + age(r.age_days) + '</span></div>' +
          '<div class="cell"><span class="k">implied / TVL</span><span class="v">' + r.multiple.toFixed(2) + '×</span></div>' +
          '<div class="cell"><span class="k">category peers</span><span class="v">' + r.peer_samples + '</span></div>' +
          '<div class="cell"><span class="k">chains</span><span class="v">' + r.chains.length + '</span></div>' +
        '</div>' +
        '<h3 class="sec">how to farm it</h3>' +
        '<div class="budget">' +
          '<span><b>' + usd(r.plan.capital_usd) + '</b> capital, locked ' + r.plan.days + ' days</span>' +
          '<span><b>$' + r.plan.gas_low_usd + '–' + r.plan.gas_high_usd + '</b> of gas over ' + r.plan.weeks + ' weeks</span>' +
          '<span><b>' + r.plan.minutes + ' min</b> of hands-on time</span>' +
        '</div>' +
        '<ol class="plan">' + steps + '</ol>' +
        '<p class="note">' + esc(r.name) + ' records no token in DefiLlama\'s data, which is not proof it has none. It has held ' + usd(r.tvl_usd) + ' of TVL for ' + yrs +
          ', and this radar prices a launch at ' + usd(r.implied_value_usd) + ' if that record stays as it is. Farm with money you can leave in place.</p>' +
      '</div>';
    box.classList.add('open');
    box.setAttribute('aria-hidden', 'false');
    el('scrim').hidden = false;
    document.body.classList.add('detail-open');
    var close = el('dclose');
    if (close) close.addEventListener('click', function () { closeDetail(); });
  }

  function openDetail(slug) {
    state.p = slug;
    renderDetail();
    renderBoard();
  }

  function closeDetail() {
    state.p = null;
    renderDetail();
    renderBoard();
  }

  // ---------------------------------------------------------------- events

  el('q').addEventListener('input', function (e) { state.q = e.target.value; paint(); });
  el('cat').addEventListener('change', function (e) { state.cat = e.target.value; paint(); });
  el('chain').addEventListener('change', function (e) { state.chain = e.target.value; paint(); });
  el('sort').addEventListener('change', function (e) { state.sort = e.target.value; paint(); });

  el('clear').addEventListener('click', function () {
    state.q = ''; state.cat = ''; state.chain = ''; state.sort = 'rank'; state.tab = 'pre';
    el('q').value = ''; el('cat').value = ''; el('chain').value = ''; el('sort').value = 'rank';
    paint();
  });

  el('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tab]');
    if (!b) return;
    state.tab = b.getAttribute('data-tab');
    paint();
  });

  el('applied').addEventListener('click', function (e) {
    var b = e.target.closest('[data-drop]');
    if (!b) return;
    var which = b.getAttribute('data-drop');
    if (which === 'tab') state.tab = 'pre';
    if (which === 'cat') { state.cat = ''; el('cat').value = ''; }
    if (which === 'chain') { state.chain = ''; el('chain').value = ''; }
    if (which === 'q') { state.q = ''; el('q').value = ''; }
    paint();
  });

  el('body').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (!tr) return;
    if (state.tab === 'live') return;
    openDetail(tr.getAttribute('data-slug'));
  });

  el('scrim').addEventListener('click', closeDetail);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.p) { closeDetail(); return; }
    if (e.key === '/' && e.target !== el('q')) { e.preventDefault(); el('q').focus(); }
  });

  // ---------------------------------------------------------------- paint

  function paint() {
    renderStats();
    renderBoard();
    renderApplied(sorted(filtered()));
    if (state.p) renderDetail();
  }

  // ---------------------------------------------------------------- boot

  fill(el('cat'), cats, 'all categories');
  fill(el('chain'), chains, 'all chains');

  // A hash seeds the view, so a screenshot or a shared link opens the same screen:
  //   #p=<slug>            the detail view
  //   #cat=Lending&hot=1   a filtered board
  (function seed() {
    var raw = (window.location.hash || '').replace(/^#/, '');
    if (!raw) return;
    var parts = raw.split('&');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      var k = decodeURIComponent(kv[0] || '');
      var v = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
      if (k === 'p') state.p = v;
      if (k === 'cat') state.cat = v;
      if (k === 'chain') state.chain = v;
      if (k === 'q') state.q = v;
      if (k === 'sort') state.sort = v;
      if (k === 'tab') state.tab = v;
      if (k === 'hot' && v === '1') state.tab = 'hot';
    }
    if (state.cat) el('cat').value = state.cat;
    if (state.chain) el('chain').value = state.chain;
    if (state.q) el('q').value = state.q;
    if (state.sort) el('sort').value = state.sort;
  })();

  paint();
  document.getElementById('board').setAttribute('aria-busy', 'false');
})();
