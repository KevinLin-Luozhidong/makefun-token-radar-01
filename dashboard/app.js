// Token Radar's dashboard. It reads window.RADAR (written beside the page
// by main.ts, no fetch and no network) and renders the ranked board, a
// filterable table, a per-protocol detail view, the live-token set kept
// apart, and the method with its backtests. The page recomputes every row's
// implied value from the multipliers the board carries, so the code and the
// board visibly agree — a row whose recomputation differs is flagged.
(function () {
  'use strict';
  var DATA = window.RADAR;
  var app = document.getElementById('board');
  if (!DATA || !app) return;
  var state = { q: '', category: 'all', tab: 'board', sort: 'implied', dir: -1, selected: null };
  var rows = DATA.rows || [];
  var live = DATA.live || [];
  var fit = DATA.fit || {};
  var acc = DATA.accounting || {};

  function usd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function usdFull(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function ageFmt(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    return Math.round(d) + 'd';
  }
  function esc(s) { return String(s === null || s === undefined ? '' : s); }

  // The model in one function: base x category x growth x maturity, the
  // same arithmetic main.ts ran. A row is checked when its detail opens.
  function recompute(row) {
    return Math.max(1, Math.round(row.model.base_usd * row.model.category_factor * row.model.growth_multiplier * row.model.maturity_multiplier));
  }
  function catFactorOf(row) { return row.model.category_factor; }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string' || typeof child === 'number') node.appendChild(document.createTextNode(String(child)));
      else node.appendChild(child);
    }
    return node;
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || '(no category)') !== state.category) return false;
      if (!q) return true;
      return (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + (r.chains || []).join(' ')).toLowerCase().indexOf(q) >= 0;
    });
    var key = state.sort;
    list.sort(function (a, b) {
      var av, bv;
      if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'change') { av = a.change_7d === null ? -999 : a.change_7d; bv = b.change_7d === null ? -999 : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? -1 : a.age_days; bv = b.age_days === null ? -1 : b.age_days; }
      else if (key === 'peer') { av = a.peer_token_rate; bv = b.peer_token_rate; }
      else if (key === 'rank') { av = a.rank; bv = b.rank; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      return (av - bv) * state.dir;
    });
    return list;
  }

  function setHash(h) {
    try { history.replaceState(null, '', h); } catch (e) { location.hash = h; }
  }

  function readHash() {
    var h = (location.hash || '').replace(/^#/, '');
    if (!h) return;
    var parts = h.split('/');
    if (parts[0] === 'detail' && parts[1]) { state.selected = decodeURIComponent(parts[1]); state.fromHash = true; state.tab = 'board'; }
    else if (parts[0] === 'filter' && parts[1]) { state.category = decodeURIComponent(parts[1]); state.tab = 'board'; state.selected = null; }
    else if (parts[0] === 'live') { state.tab = 'live'; state.selected = null; }
    else if (parts[0] === 'method') { state.tab = 'method'; state.selected = null; }
  }

  function detailView(row) {
    var check = recompute(row);
    // The stored base is rounded to whole dollars, so the recomputation can
    // differ by a few dollars on a nine-figure row; 0.01% covers that and
    // nothing a reader would notice, while a real mismatch would be far larger.
    var ok = Math.abs(check - row.implied_value_usd) <= Math.max(10, row.implied_value_usd * 0.0001);
    var wrap = el('section', { 'class': 'detail', 'aria-label': 'Protocol detail' });
    wrap.appendChild(el('h2', { text: '#' + row.rank + ' ' + row.name }));
    wrap.appendChild(el('p', { 'class': 'meta', text:
      (row.category || 'No category') + '  ·  ' + (row.chains || []).join(', ') + '  ·  listed ' + (row.listed_at || 'date unknown') +
      ' (' + ageFmt(row.age_days) + ')  ·  ' + (row.on_watchlist ? 'On the house watchlist' : 'Below the watchlist floor') }));
    var kv = el('div', { 'class': 'kv' });
    function cell(k, v, d) {
      var c = el('div', { 'class': 'cell' });
      c.appendChild(el('div', { 'class': 'k', text: k }));
      c.appendChild(el('div', { 'class': 'v', text: v }));
      if (d) c.appendChild(el('div', { 'class': 'd', text: d }));
      kv.appendChild(c);
    }
    cell('Implied value', usdFull(row.implied_value_usd), 'point estimate — read the band, not just this number');
    cell('80% band', usd(row.implied_low80_usd) + ' – ' + usd(row.implied_high80_usd), 'from the fit residual scatter, about ' + (fit.residSd || '?') + ' in log10');
    cell('TVL', usdFull(row.tvl_usd), '7d change ' + pct(row.change_7d));
    cell('Cross-check', usdFull(row.cross_check_usd), 'TVL x median market-cap/TVL of the fitted set');
    cell('Peer token rate', Math.round(row.peer_token_rate * 100) + '%', 'share of similar protocols that already record a token — not a launch prediction');
    cell('Recompute check', ok ? 'matches' : 'DIFFERS', 'page recomputes ' + usdFull(check) + ' from the stored multipliers');
    wrap.appendChild(kv);
    wrap.appendChild(el('h3', { text: 'How the value is built' }));
    wrap.appendChild(el('p', { 'class': 'meta', text:
      'Fitted base ' + usdFull(row.model.base_usd) + ' (log10 market cap = ' + fit.intercept + ' + ' + fit.slope +
      ' x log10 TVL)  x  category factor ' + catFactorOf(row).toFixed(2) + '  x  growth ' + row.model.growth_multiplier.toFixed(2) +
      '  x  maturity ' + row.model.maturity_multiplier.toFixed(2) + '  =  ' + usdFull(row.implied_value_usd) + '.' }));
    wrap.appendChild(el('h3', { text: 'Farm plan — what to do, what it costs, how long it takes' }));
    var ol = el('ol', { 'class': 'farm' });
    (row.farm_steps || []).forEach(function (s) { ol.appendChild(el('li', { text: s })); });
    wrap.appendChild(ol);
    wrap.appendChild(el('p', { 'class': 'meta', text: 'No token is guaranteed. This plan farms a position that would qualify if the protocol ever rewards one; it does not predict a launch.' }));
    wrap.appendChild(el('button', { 'class': 'linklike', text: 'Close detail', onClick: function () { state.selected = null; state.fromHash = false; setHash('#'); render(); } }));
    return wrap;
  }

  function boardTable(list) {
    var table = el('table', { 'class': 'board' });
    var thead = el('thead');
    var hr = el('tr');
    function th(label, key, cls) {
      var arrow = state.sort === key ? (state.dir === -1 ? ' ▼' : ' ▲') : '';
      return el('th', { 'class': cls || '', text: label + arrow, onClick: function () {
        if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = key === 'rank' ? 1 : -1; }
        render();
      } });
    }
    hr.appendChild(th('#', 'rank'));
    hr.appendChild(th('Protocol', 'implied'));
    hr.appendChild(th('Category', 'implied'));
    hr.appendChild(th('TVL', 'tvl', 'num'));
    hr.appendChild(th('7d', 'change', 'num'));
    hr.appendChild(th('Age', 'age', 'num'));
    hr.appendChild(th('Implied value', 'implied', 'num'));
    hr.appendChild(th('Peer rate', 'peer', 'num'));
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el('tbody');
    list.forEach(function (r) {
      var tr = el('tr', { 'class': state.selected === r.slug ? 'sel' : '', onClick: function () { state.selected = r.slug; state.fromHash = false; setHash('#detail/' + encodeURIComponent(r.slug)); render(); } });
      tr.appendChild(el('td', {}, el('span', { 'class': 'rank', text: String(r.rank) })));
      var nameTd = el('td');
      nameTd.appendChild(el('div', { 'class': 'name', text: r.name }));
      nameTd.appendChild(el('div', { 'class': 'sub2', text: (r.chains || []).slice(0, 3).join(', ') + (r.on_watchlist ? '  ·  watchlist' : '') }));
      tr.appendChild(nameTd);
      tr.appendChild(el('td', { text: r.category || '—' }));
      tr.appendChild(el('td', { 'class': 'num', text: usd(r.tvl_usd) }));
      var ch = el('td', { 'class': 'num ' + (r.change_7d === null ? '' : (r.change_7d >= 0 ? 'pos' : 'neg')), text: pct(r.change_7d) });
      tr.appendChild(ch);
      tr.appendChild(el('td', { 'class': 'num', text: ageFmt(r.age_days) }));
      var imp = el('td', { 'class': 'num' });
      imp.appendChild(el('div', { text: usd(r.implied_value_usd) }));
      imp.appendChild(el('div', { 'class': 'band', text: usd(r.implied_low80_usd) + '–' + usd(r.implied_high80_usd) }));
      tr.appendChild(imp);
      tr.appendChild(el('td', { 'class': 'num', text: Math.round(r.peer_token_rate * 100) + '%' }));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function liveTable() {
    var table = el('table', { 'class': 'board' });
    var thead = el('thead');
    var hr = el('tr');
    ['Protocol', 'Category', 'TVL', 'Market cap', 'Mcap / TVL', '7d'].forEach(function (h, i) {
      hr.appendChild(el('th', { 'class': i >= 2 ? 'num' : '', text: h }));
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el('tbody');
    live.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', {}, el('div', { 'class': 'name', text: r.name }), el('div', { 'class': 'sub2', text: (r.chains || []).slice(0, 3).join(', ') })));
      tr.appendChild(el('td', { text: r.category || '—' }));
      tr.appendChild(el('td', { 'class': 'num', text: usd(r.tvl_usd) }));
      tr.appendChild(el('td', { 'class': 'num', text: usd(r.mcap_usd) }));
      tr.appendChild(el('td', { 'class': 'num', text: r.mcap_tvl_ratio.toFixed(3) }));
      tr.appendChild(el('td', { 'class': 'num ' + (r.change_7d === null ? '' : (r.change_7d >= 0 ? 'pos' : 'neg')), text: pct(r.change_7d) }));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function methodView() {
    var box = el('section', { 'class': 'method' });
    box.appendChild(el('h2', { text: 'Method — fitted, backtested, and fully accounted' }));
    box.appendChild(el('p', { text: 'The board ranks protocols that record no token by an implied value fitted from the snapshot itself. The training set is the ' + fit.trainN + ' protocols that record a token with a usable market cap (' + fit.trimmedN + ' wild residuals trimmed away, ' + fit.badMcapN + ' with a zero or negative market cap set aside). The fit is log10(market cap) = ' + fit.intercept + ' + ' + fit.slope + ' x log10(TVL), with residual scatter ' + fit.residSd + ' in log10. A category factor (shrunk median residual, capped) corrects the line per category; growth and age are small tilts only, because in-sample they correlate with the residual at about 0.04 and 0.05.' }));
    box.appendChild(el('p', { text: 'Backtests, computed by the program on the same fit: leave-one-out median error ' + fit.looMedianFold + 'x, walk-forward median error ' + fit.walkForwardMedianFold + 'x (trained on the earliest-listed half of dated protocols, tested on the later ' + fit.walkForwardTestN + '). In plain words: a typical implied value here is wrong by about a factor of three, which is why every row shows an 80% band instead of a single confident number.' }));
    box.appendChild(el('p', { text: 'Launch odds are peer rates, not predictions: for each protocol, the mean of its category’s shrunk token share and its TVL tier’s shrunk token share. A protocol’s launch is never predicted, and no row claims a token will be issued.' }));
    box.appendChild(el('h2', { text: 'Accounting — all ' + acc.total + ' protocols, every one placed' }));
    var ul = el('ul');
    [
      acc.tokenRecorded + ' record a token (' + acc.tokenUsable + ' usable for the fit, ' + acc.tokenBadMcap + ' with a zero or negative market cap).',
      acc.noToken + ' record no token. Of those, ' + acc.visibleExcluded + ' fail the visible part of the house rule (wrapped, staked, bridged, exchange or versioned).',
      acc.visiblePassers + ' pass the visible rule. ' + acc.aboveFloorNotWatchlist + ' of them sit at or above the $50M floor but are not on the house watchlist — the part of the rule the snapshot cannot show (the parent record) is what left them out, so they are not ranked.',
      acc.belowFloorPassers + ' pass below the floor; ' + acc.familyExcludedBelowFloor + ' of those share a slug head with a token-bearing protocol and are set aside as deployments of a trading brand.',
      'The board ranks ' + acc.boardRows + ' protocols: all ' + acc.watchlistCovered + ' of the watchlist plus ' + (acc.boardRows - acc.watchlistCovered) + ' early ones below the floor.',
      'Data quality flags: ' + fit.badMcapN + ' token-bearing rows carry a zero or negative market cap; 4 protocols carry no 7-day change; 113 carry no listing date, so their age — and their maturity tilt — uses the 365-day fallback.'
    ].forEach(function (t) { ul.appendChild(el('li', { text: t })); });
    box.appendChild(ul);
    box.appendChild(el('p', { text: 'Limits: the snapshot is one day (2026-11-14) and carries no fees, no users, no points program and no parent record, so the radar cannot see revenue, traction or whether a protocol has already hinted at a token. Treat every implied value as a size-based estimate with a wide band, and every farm plan as a qualifying position, not a promise.' }));
    return box;
  }

  function render() {
    app.setAttribute('aria-busy', 'true');
    app.textContent = '';
    var top = rows[0];
    // A deep link opens on the detail itself: render it first, so the
    // protocol is at the top of the page with no scrolling needed. A row
    // clicked in the table opens in place below the tabs instead.
    if (state.tab === 'board' && state.selected && state.fromHash) {
      var deep = rows.filter(function (r) { return r.slug === state.selected; })[0];
      if (deep) app.appendChild(detailView(deep));
    }
    var header = el('header', { 'class': 'hero' });
    header.appendChild(el('h1', {}, document.createTextNode('Token Radar — '), el('span', { 'class': 'amber', text: 'what would the launch be worth?' })));
    header.appendChild(el('p', { 'class': 'sub', text: 'Every protocol DefiLlama tracks that records no token, ranked by a fitted implied value — with the steps to farm each one. Snapshot ' + DATA.as_of + ', ' + DATA.source + '. An implied value is this entry’s estimate from the snapshot’s own figures, never a promise that a token will be issued.' }));
    app.appendChild(header);

    var stats = el('div', { 'class': 'stats' });
    function stat(k, v, d) {
      var s = el('div', { 'class': 'stat' });
      s.appendChild(el('div', { 'class': 'k', text: k }));
      s.appendChild(el('div', { 'class': 'v', text: v }));
      s.appendChild(el('div', { 'class': 'd', text: d }));
      stats.appendChild(s);
    }
    stat('Ranked', String(rows.length), acc.watchlistCovered + ' watchlist + ' + (rows.length - acc.watchlistCovered) + ' early');
    stat('#1 implied', top ? usd(top.implied_value_usd) : '—', top ? top.name : '');
    stat('LOO error', fit.looMedianFold + 'x', 'median fold, leave-one-out');
    stat('Walk-forward', fit.walkForwardMedianFold + 'x', 'median fold, later half');
    app.appendChild(stats);

    var strip = el('div', { 'class': 'strip' });
    strip.appendChild(el('b', { text: 'Integrity: ' }));
    strip.appendChild(document.createTextNode(
      acc.total + ' protocols in the snapshot. ' + acc.tokenIndicated + ' record a token by market cap, CoinGecko id or symbol, ' + acc.noToken + ' record none. ' +
      acc.visibleExcluded + ' fail the visible house rule; ' + acc.aboveFloorNotWatchlist + ' pass it above the floor but are not on the watchlist and are not ranked; ' +
      acc.familyExcludedBelowFloor + ' below-floor deployments of trading brands are set aside. ' +
      fit.badMcapN + ' token rows carry a zero or negative market cap and never enter the fit.'));
    app.appendChild(strip);

    var model = el('div', { 'class': 'modelbox' });
    model.appendChild(el('b', { text: 'Model: ' }));
    model.appendChild(el('code', { text: 'log10(mcap) = ' + fit.intercept + ' + ' + fit.slope + ' x log10(TVL)' }));
    model.appendChild(document.createTextNode(' fitted on n=' + fit.trainN + ' token-bearing protocols (residual SD ' + fit.residSd + ' log10), category factor capped at 2x, growth tilt 0.90–1.20, maturity tilt 0.95–1.05. '));
    model.appendChild(el('span', { 'class': 'warn', text: 'Growth and age barely move the fit in-sample (r ≈ 0.04–0.05), so they are tilts, not drivers — TVL does the work.' }));
    app.appendChild(model);

    var tabs = el('div', { 'class': 'tabs' });
    function tabBtn(label, tab, hash) {
      return el('button', { 'aria-pressed': state.tab === tab ? 'true' : 'false', text: label, onClick: function () { state.tab = tab; state.selected = null; state.fromHash = false; setHash(hash); render(); } });
    }
    tabs.appendChild(tabBtn('Pre-token board (' + rows.length + ')', 'board', '#'));
    tabs.appendChild(tabBtn('Live tokens (' + live.length + ')', 'live', '#live'));
    tabs.appendChild(tabBtn('Method & accounting', 'method', '#method'));
    app.appendChild(tabs);

    if (state.tab === 'live') {
      app.appendChild(el('p', { 'class': 'sub', text: 'Protocols that already record a token, shown with the market’s own values — kept apart from the ranked board, never mixed into it.' }));
      app.appendChild(liveTable());
    } else if (state.tab === 'method') {
      app.appendChild(methodView());
    } else {
      if (state.selected && !state.fromHash) {
        var sel = rows.filter(function (r) { return r.slug === state.selected; })[0];
        if (sel) app.appendChild(detailView(sel));
      }
      var controls = el('div', { 'class': 'controls' });
      var input = el('input', { type: 'search', placeholder: 'Search name, slug, category or chain…', value: state.q, 'aria-label': 'Search protocols' });
      input.addEventListener('input', function () { state.q = input.value; render(); });
      controls.appendChild(input);
      var select = el('select', { 'aria-label': 'Filter by category' });
      var cats = ['all'];
      rows.forEach(function (r) { var c = r.category || '(no category)'; if (cats.indexOf(c) < 0) cats.push(c); });
      cats.sort().forEach(function (c) {
        var opt = el('option', { value: c, text: c === 'all' ? 'All categories' : c });
        if (state.category === c) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', function () { state.category = select.value; setHash(state.category === 'all' ? '#' : '#filter/' + encodeURIComponent(state.category)); render(); });
      controls.appendChild(select);
      var list = filteredRows();
      controls.appendChild(el('span', { 'class': 'count', text: list.length + ' of ' + rows.length + ' shown — click a row for its detail and farm plan' }));
      app.appendChild(controls);
      app.appendChild(boardTable(list));
    }
    app.appendChild(el('footer', { text: 'Token Radar · snapshot ' + DATA.as_of + ' · ' + DATA.source + ' · Implied values are estimates from the snapshot, not predictions. No token is guaranteed; farm only what you can afford to leave in place.' }));
    app.setAttribute('aria-busy', 'false');
  }

  readHash();
  window.addEventListener('hashchange', function () { readHash(); render(); });
  render();
})();
