// hz.ms — instrument shell. Wires the probe (feed.js) to the engine (signal.js) and runs the pages.
import { Engine } from './signal.js';
import { FONT, setFont, COL } from './palette.js';
import { openFeed } from './feed.js';

const NONE = '----';
const PAGES = ['signal', 'stake', 'tech'];
const ZOOMS = [{ span: 250, label: '250 slots', rot: 0 }, { span: 150, label: '150 slots', rot: -40 }, { span: 350, label: '350 slots', rot: 40 }];
const $ = id => document.getElementById(id);
const fmt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CLS = { agave: 'Agave', fd: 'Firedancer', other: 'other' };
const hms = sec => { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60); return h ? h + ' h ' + String(m).padStart(2, '0') + ' m' : m + ' m'; };
const explorerUrl = (s, addr) => 'https://explorer.solana.com/address/' + addr + (s.key === 'mainnet' ? '' : '?cluster=testnet');
const explorerBlock = (s, slot) => 'https://explorer.solana.com/block/' + slot + (s.key === 'mainnet' ? '' : '?cluster=testnet');

let CFG, SNAP, SRC = {}, settings, eng, feed = null, feedMode = 'off', cv, ctx, W = 0, H = 0, FS = 12, TOPH = 0, BOTH = 0, lastFrame = 0, hover = null;
const state = { src: 'testnet', page: null, zoom: 0, numbers: false, showCh1: true, showCh2: true, running: true, lock: null };
let lastInfo = null;
const CLIENTS = {};

/* ---------- settings ---------- */
function loadSettings() {
  const d = { pollLight: (CFG.poll && CFG.poll.lightSeconds) || 120 };
  const q = new URLSearchParams(location.search);
  if (q.get('ws')) d.wsOverride = q.get('ws');
  if (q.get('rpc')) d.rpcOverride = q.get('rpc');
  return d;
}

/* ---------- sources ---------- */
function buildSources() {
  const s = SNAP.sources, mk = (key, src) => src ? Object.assign({ key, cluster: key }, src) : null;
  SRC = {
    mainnet: mk('mainnet', s.mainnet) || { key: 'mainnet', cluster: 'mainnet', identity: CFG.clusters.mainnet.identity, vote: CFG.clusters.mainnet.vote || null },
    testnet: mk('testnet', s.testnet) || { key: 'testnet', cluster: 'testnet', identity: CFG.clusters.testnet.identity, vote: CFG.clusters.testnet.vote || null }
  };
}
const S = () => SRC[state.src];
const clusterOf = s => CFG.clusters[s.cluster];
const rpcUrl = s => settings.rpcOverride || clusterOf(s).rpc;   // a string or a list of endpoints
const wsUrl = s => settings.wsOverride || clusterOf(s).ws || [].concat(clusterOf(s).rpc).map(u => u.replace(/^https:/, 'wss:'));
let activeWs = null;   // the socket endpoint that is actually delivering

/* ---------- feed ---------- */
function setFeedStatus(st) {
  feedMode = st;
  const t = { live: '', 'live-basic': 'basic', connecting: 'connecting', error: 'reconnecting', paused: 'paused' };
  $('liveText').textContent = t[st] != null ? t[st] : st;
  $('device').dataset.feed = st;
}
async function openSource() {
  if (feed) { feed.close(); feed = null; }
  const s = S(), key = state.src;
  activeWs = null; setLock(null); eng.reset(); eng.nominal = clusterOf(s).slotMs || (s.cluster === 'mainnet' ? 300 : 200); eng.set('dut', s.identity);
  $('nosig').hidden = true;
  setFeedStatus('connecting');
  let clients = CLIENTS[s.cluster] || (window.HZ_CLIENTS && window.HZ_CLIENTS[s.cluster]) || null;
  if (!clients) { try { clients = await fetch('data/clients-' + s.cluster + '.json?v=' + (CFG.v || 0), { cache: 'force-cache' }).then(r => r.json()); CLIENTS[s.cluster] = clients; } catch (e) { clients = null; } }
  if (key !== state.src) return;
  feed = openFeed({ rpc: rpcUrl(s), ws: wsUrl(s), vote: s.vote || null, clients, onEvent: e => { if (e.kind === 'endpoint') { activeWs = e.ws; return; } $('nosig').hidden = true; eng.onEvent(e); },
    onStatus: st => { setFeedStatus(st); if (st === 'error') { $('nosig').hidden = false; $('nosigWhy').textContent = 'the probe could not be reached · retrying'; } } });
}

/* ---------- drawing ---------- */
function resize() {
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  W = r.width; H = r.height; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const fs = FS = parseFloat(getComputedStyle($('screen')).fontSize) || 12;
  const measShown = state.numbers && !matchMedia('(max-width: 560px)').matches;   // css/site.css hides the measurement row on phones at this width
  TOPH = 2.4 * fs; BOTH = 2.2 * fs + (measShown ? 2.8 * fs : 0);
  if (eng) eng.set('padX', Math.round(0.9 * fs));   // the bars' side padding: every label on the canvas starts on the same line
}
function draw() {
  ctx.fillStyle = '#0a100a'; ctx.fillRect(0, 0, W, H);
  const out = eng.draw(ctx, W, H, TOPH, BOTH, state.page ? null : hover);
  const fs = FS;
  ctx.save(); ctx.font = (fs * .8) + 'px ' + FONT; ctx.textAlign = 'right';
  let x = W - (eng.cfg.padX || 8); const leg = [['other', COL.other], ['Firedancer', COL.fd], ['Agave', COL.agave]];
  for (const [n, c] of leg) { ctx.fillStyle = '#8fa07e'; ctx.fillText(n, x, TOPH + fs * 1.15); x -= ctx.measureText(n).width + 6; ctx.fillStyle = 'rgb(' + c + ')'; ctx.fillRect(x - 8, TOPH + fs * .4, 8, 8); x -= 16; }
  if (!state.running) { ctx.textAlign = 'center'; ctx.fillStyle = '#d7e5c6'; ctx.font = (fs * .9) + 'px ' + FONT; ctx.fillText('STOPPED', W / 2, TOPH + fs * 1.3); }
  ctx.restore();
  const box = $('curbox'), i = out && out.info, f = v => v == null ? NONE : Math.round(v) + ' ms';
  lastInfo = i || null;
  if (state.lock && !i) setLock(null);   // the locked slot left the screen: back to hovering
  /* a locked slot keeps its box and gains links: the block and the leader on the Solana explorer */
  const links = i && state.lock ? ' <a href="' + explorerBlock(S(), i.slot) + '" target="_blank" rel="noopener">block ↗</a>' + (i.pk ? '<a href="' + explorerUrl(S(), i.pk) + '" target="_blank" rel="noopener">leader ↗</a>' : '') + '<span class="x" title="Unlock (Esc)">×</span>' : '';
  box.classList.toggle('locked', !!(i && state.lock));
  const who = i => '<b>' + (i.leader || NONE) + '</b> ' + (CLS[i.cls] || i.cls) + (i.mine ? ' · ours' : '');
  if (i) {
    setBox(box, '<span>slot <b>' + fmt(i.slot) + '</b> · ' + who(i) + ' · length <b>' + f(i.period) + '</b> · confirm <b>' + f(i.confirm) + '</b>' + (S().vote ? ' · vote <b>' + (i.vote == null ? 'none' : f(i.vote)) + '</b>' : '') + links + '</span>');
  } else box.hidden = true;
}
function setBox(box, html) { if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; } box.hidden = false; }   // keep the nodes: a link must survive from mousedown to click
function loop(t) {
  requestAnimationFrame(loop);
  if (document.hidden || t - lastFrame < 33) return;
  lastFrame = t;
  if (!state.page) draw();
}

/* ---------- readouts ---------- */
const cell = (k, v) => '<span class="m"><span class="k">' + k + '</span><span class="v">' + v + '</span></span>';
function readouts() {
  const s = S(), m = eng.measure();
  $('slotText').innerHTML = m.slot ? 'slot <b>' + fmt(m.slot) + '</b>' : '';
  if (eng.epoch && m.slot) { const idx = m.slot - eng.epoch.firstSlot, n = eng.epoch.slots, left = (n - idx) / (m.hz || 1000 / eng.unit()); $('epText').innerHTML = 'epoch ' + eng.epoch.n + ' <b>' + (100 * idx / n).toFixed(1) + '%</b><span class="wide"> · ends in <b>' + hms(left) + '</b></span>'; }
  else $('epText').innerHTML = '';
  $('clkText').innerHTML = m.hz ? 'clk <b>' + m.hz.toFixed(3) + ' Hz</b> <b>' + m.periodMs.toFixed(1) + ' ms</b>' : '';
  const winMs = eng.spanMs();
  $('b1').innerHTML = '<b class="c1">1</b> slot length';
  $('b2').innerHTML = '<b class="c2">2</b> vote landing' + (s.vote ? '' : ' <span class="dim">· no vote account</span>');
  $('b3').innerHTML = (winMs / 10000).toFixed(1) + ' s/div';
  refreshPage();
  const el = $('meas'); el.hidden = !state.numbers || !!state.page; if (el.hidden) return;
  const f = (x, d, u) => x == null ? NONE : x.toFixed(d) + (u || '');
  el.innerHTML = cell('Frequency', f(m.hz, 3, ' Hz')) + cell('Slot length', m.periodMs == null ? NONE : m.periodMs.toFixed(0) + ' ±' + (m.periodSd || 0).toFixed(0) + ' ms') +
    cell('Time to confirm', f(m.confirmMs, 0, ' ms')) + cell('Dead slots', m.samples ? m.dead + ' of ' + m.samples : NONE) +
    cell('Vote latency', m.voteLatMs == null ? NONE : m.voteLatSlots + ' slot' + (m.voteLatSlots === 1 ? '' : 's') + ' · ' + m.voteLatMs.toFixed(0) + ' ms') +
    cell('Votes landed', m.landing == null ? NONE : (100 * m.landing).toFixed(0) + ' % of slots');
}
function applySource() {
  const s = S();
  $('srcText').textContent = s.cluster === 'mainnet' ? 'Mainnet' : 'Testnet';
  document.querySelectorAll('.key[data-src]').forEach(k => k.setAttribute('aria-pressed', String(k.dataset.src === state.src)));
  renderStrip(); renderPage(); setZoom();
  openSource();
}
const fact = (k, v, unit) => '<div class="fact"><span class="k">' + k + '</span>' + (v == null ? '<span class="v none">' + NONE + '</span>' : '<span class="v">' + v + (unit ? '<small>' + unit + '</small>' : '') + '</span>') + '</div>';
const addr = (label, v) => '<div class="addr"><span class="k">' + label + '</span>' + (v ? '<span class="a"><code>' + v + '</code><button class="cp" data-copy="' + v + '" title="Copy">copy</button></span>' : '<span class="a none">not created yet</span>') + '</div>';
function renderStrip() {
  const s = S(), node = s.node || {}, cr = s.credits && s.credits.length > 1 ? s.credits[s.credits.length - 2] : null;
  $('facts').innerHTML = fact('Commission', s.commission == null ? null : s.commission, '%') + fact('Active stake', s.stake == null ? null : fmt(s.stake), 'SOL') +
    fact('Vote credits', cr && cr[2] ? (100 * cr[1] / cr[2]).toFixed(1) : null, '% of best') + fact('Client', node.client ? node.client + (node.version ? ' ' + node.version : '') : null);
  $('addrs').innerHTML = addr('Identity', s.identity) + addr('Vote account', s.vote);
}

/* ---------- pages ---------- */
const delegateCmd = s => 'solana create-stake-account stake.json <AMOUNT_SOL>\nsolana delegate-stake stake.json ' + (s.vote || '<VOTE_ACCOUNT>');
function pages() {
  const s = S(), node = s.node || {}, m = eng.measure(), bc = m.byClass || {};
  const under = (n, k) => bc[k] && bc[k][0] ? [n, bc[k][1] + ' of ' + bc[k][0] + ' slots · ' + Math.round(100 * bc[k][1] / bc[k][0]) + ' %'] : null;
  return {
    stake: { title: 'Stake',
      rows: [['Identity', s.identity], ['Vote account', s.vote], ['Cluster', s.cluster], ['Commission', s.commission == null ? null : s.commission + ' %'],
             ['Active stake', s.stake == null ? null : fmt(s.stake) + ' SOL'], ['Last vote', s.lastVote == null ? null : fmt(s.lastVote)]],
      code: delegateCmd(s), note: 'Paste the vote account into a wallet\'s staking screen, or use the CLI.',
      keys: [{ t: 'Copy vote acct', copy: s.vote }, { t: 'Copy identity', copy: s.identity }, { t: 'Copy CLI steps', copy: delegateCmd(s) }, s.vote ? { t: 'Explorer ↗', open: explorerUrl(s, s.vote) } : null, { t: 'Close', close: true }] },
    tech: { title: 'Tech',
      rows: [['Client', node.client], ['Version', node.version], ['Gossip', node.gossip], ['Location', node.location], ['Network', node.asn], ['Shred version', node.shred], ['Feature set', node.featureSet],
             ['Balance', s.balance == null ? null : s.balance.toFixed(3) + ' SOL'], ['Epoch stakes', s.epochVoteAccount == null ? null : (s.epochVoteAccount ? 'yes' : 'no · Agave leaders drop its votes')],
             ['Root lag', m.rootLag == null ? null : m.rootLag + ' slots'], ['Replay', m.replayMs == null ? null : Math.round(m.replayMs) + ' ms'],
             under('Votes · Agave', 'agave'), under('Votes · Firedancer', 'fd'), under('Votes · other', 'other'),
             ['Probe', (activeWs || [].concat(wsUrl(s))[0]) + (feedMode.startsWith('live') ? '' : ' · ' + (feedMode === 'error' ? 'reconnecting' : feedMode))],
             feedMode === 'live' ? ['Method', 'slotsUpdatesSubscribe + accountSubscribe · one socket'] : feedMode === 'live-basic' ? ['Method', 'slotSubscribe · client-side timestamps'] : null].filter(Boolean),
      note: 'Add ?ws=ws://localhost:8900 to the address to probe your own node.',
      keys: [{ t: 'Copy gossip', copy: node.gossip }, { t: 'Copy identity', copy: s.identity }, { t: 'Explorer ↗', open: explorerUrl(s, s.identity) }, null, { t: 'Close', close: true }] }
  };
}
function renderPage() {
  const p = state.page ? pages()[state.page] : null, pageEl = $('page');
  document.querySelectorAll('.key[data-menu]').forEach(k => k.setAttribute('aria-pressed', String(k.dataset.menu === state.page)));
  if (!p) { pageEl.hidden = true; pageEl.innerHTML = ''; return; }
  let html = '<div class="pg"><h3>' + p.title + '</h3>';
  if (p.rows) { html += '<div class="rows">'; for (const r of p.rows) html += '<div class="k">' + esc(r[0]) + '</div>' + (r[1] == null ? '<div class="v none">' + NONE + '</div>' : '<div class="v">' + esc(r[1]) + '</div>'); html += '</div>'; }
  if (p.code) html += '<div class="code">' + esc(p.code) + '</div>';
  if (p.note) html += '<div class="note">' + esc(p.note) + '</div>';
  html += '</div><div class="sk">';
  p.keys.forEach((k, i) => { if (!k) { html += '<div class="lab none"></div>'; return; } const dis = !k.copy && !k.close && !k.open; html += '<button class="lab' + (dis ? ' dis' : '') + '" data-i="' + i + '"' + (dis ? ' disabled' : '') + '>' + esc(k.t) + '</button>'; });
  pageEl.innerHTML = html + '</div>'; pageEl.hidden = false;
}
function refreshPage() {   // live rows are updated in place: the side keys are not re-created, so a click is never lost
  const p = state.page ? pages()[state.page] : null; if (!p || !p.rows) return;
  const vs = $('page').querySelectorAll('.rows .v');
  if (vs.length !== p.rows.length) return renderPage();
  p.rows.forEach((r, i) => { const v = vs[i], t = r[1] == null ? NONE : String(r[1]); v.classList.toggle('none', r[1] == null); if (v.textContent !== t) v.textContent = t; });
}
function softkey(i) {
  if (!state.page) return; const k = pages()[state.page].keys[i]; if (!k) return;
  if (k.close) return setPage('signal');
  if (k.open) return window.open(k.open, '_blank', 'noopener');
  if (k.copy) copyText(k.copy, i);
}
function setPage(name) { state.page = name === 'signal' ? null : name; $('curbox').hidden = true; renderPage(); readouts(); }
function copyText(s, i) {
  const done = ok => { const lab = $('page').querySelector('.lab[data-i="' + i + '"]'); if (!lab) return; const t = lab.textContent; lab.textContent = ok ? 'Copied' : 'Copy failed'; lab.classList.toggle('ok', ok); setTimeout(() => { lab.textContent = t; lab.classList.remove('ok'); }, 1400); };
  try { navigator.clipboard.writeText(s).then(() => done(true), () => done(fallbackCopy(s))); } catch (e) { done(fallbackCopy(s)); }
}
function fallbackCopy(s) { try { const ta = document.createElement('textarea'); ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch (e) { return false; } }

/* ---------- controls ---------- */
function setZoom(i) {
  if (i !== undefined) state.zoom = i;
  const z = ZOOMS[state.zoom];
  eng.set('span', z.span);
  $('knob').style.setProperty('--rot', z.rot + 'deg'); $('tbVal').textContent = z.label;
}
function setLock(slot) { state.lock = slot; eng.set('lock', slot); if (slot) hover = null; }
function setRunning(r) { state.running = r; r ? eng.run() : eng.stop(); $('kRun').setAttribute('aria-pressed', String(r)); }

/* ---------- keyboard cursor: every key on the panel is reachable with the arrows ---------- */
/* groups top to bottom: pages, display, source with the zoom knob. ↑ ↓ change group, ← → move inside it, Enter presses. */
const HOME_GROUP = 1;
let cur = null;                                    // { g, i } or null when no cursor is shown
function groups() {
  return [Array.from(document.querySelectorAll('.key[data-menu]')),
    [$('kRun'), $('kMeasure'), $('kCh1'), $('kCh2')], Array.from(document.querySelectorAll('.key[data-src]')).concat([$('knob')])].filter(g => g.length && g[0]);
}
const layoutOf = gs => gs.map(g => g.map(k => !k.disabled));
/* pure: next cursor for an arrow key; layout is an array of arrays of "enabled" flags; disabled keys and empty groups are skipped */
export function moveCursor(cur, key, layout) {
  const G = layout.length, live = g => layout[g].some(Boolean);
  const nearest = (g, i) => { const row = layout[g]; i = Math.max(0, Math.min(row.length - 1, i)); if (row[i]) return i; for (let d = 1; d < row.length; d++) { if (row[i - d]) return i - d; if (row[i + d]) return i + d; } return i; };
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const dir = key === 'ArrowDown' ? 1 : -1; let g = cur ? cur.g : (dir > 0 ? -1 : G);
    for (let n = 0; n < G; n++) { g = (g + dir + G) % G; if (live(g)) return { g, i: nearest(g, cur ? cur.i : 0) }; }
    return cur;
  }
  if ((key === 'ArrowLeft' || key === 'ArrowRight') && cur) {
    const row = layout[cur.g], n = row.length, dir = key === 'ArrowRight' ? 1 : -1; let i = cur.i;
    for (let k = 0; k < n; k++) { i = (i + dir + n) % n; if (row[i]) return { g: cur.g, i }; }
    return cur;
  }
  return cur;
}
function paintCursor() {
  document.querySelectorAll('.kb').forEach(k => k.classList.remove('kb'));
  if (!cur) return;
  const gs = groups(), lay = layoutOf(gs); if (!gs[cur.g]) { cur = null; return; }
  if (!lay[cur.g][cur.i]) { const m = moveCursor({ g: cur.g, i: cur.i }, 'ArrowRight', lay); cur = lay[cur.g].some(Boolean) ? m : moveCursor(cur, 'ArrowDown', lay); }
  const el = gs[cur.g] && gs[cur.g][cur.i]; if (el) el.classList.add('kb');
}
function cursorTo(el) { const gs = groups(); for (let g = 0; g < gs.length; g++) { const i = gs[g].indexOf(el); if (i >= 0) { cur = { g, i }; paintCursor(); return; } } }
function pressCursor() { const gs = groups(); const el = cur && gs[cur.g] && gs[cur.g][cur.i]; if (el) el.click(); }
function onKey(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === 'Escape') { e.preventDefault(); if (state.page) setPage('signal'); else if (state.lock) setLock(null); else { cur = null; paintCursor(); } return; }
  if (k === ' ') { e.preventDefault(); setRunning(!state.running); return; }
  if (k === 'Enter') { if (cur) { e.preventDefault(); pressCursor(); } return; }
  if (state.page && /^[1-5]$/.test(k)) { e.preventDefault(); softkey(+k - 1); return; }
  if (k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'ArrowLeft' && k !== 'ArrowRight') return;
  e.preventDefault();
  const gs = groups(), lay = layoutOf(gs);
  if (!cur && (k === 'ArrowLeft' || k === 'ArrowRight')) { cur = { g: HOME_GROUP, i: 0 }; paintCursor(); return; }
  cur = moveCursor(cur, k, lay); paintCursor();
}
function wireInput() {
  window.addEventListener('wheel', e => {
    if (e.target.closest && e.target.closest('.knob')) { e.preventDefault(); const n = ZOOMS.length; setZoom((state.zoom + (e.deltaY > 0 ? 1 : n - 1)) % n); return; }
  }, { passive: false });
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', e => { if (e.key === ' ') e.preventDefault(); });
  // a clicked button must not keep focus, or the space bar re-clicks it instead of pausing; a click also moves the cursor there
  document.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; b.blur(); if (b.closest('.panel') && (b.classList.contains('key') || b.classList.contains('knob'))) cursorTo(b); });
  window.addEventListener('pointerdown', () => { try { window.focus(); } catch (err) {} }, { passive: true });
}

/* ---------- facts refresh (slow, HTTP) ---------- */
async function refreshFacts() {
  const s = S(); if (!s.vote || document.hidden) return;
  try {
    const urls = [].concat(rpcUrl(s));
    const post = async (m, p) => { let err; for (const url of urls) { try { const j = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }).then(r => r.json()); if (j.error) throw new Error(j.error.message); return j.result; } catch (e) { err = e; } } throw err; };   // endpoint list: the next one when one fails
    const va = await post('getVoteAccounts', [{ votePubkey: s.vote, keepUnstakedDelinquents: true }]);
    const v = (va.current.concat(va.delinquent))[0];
    if (v) { const best = {}; for (const e of s.credits || []) if (e[2]) best[e[0]] = e[2]; Object.assign(s, { stake: v.activatedStake / 1e9, commission: v.commission, lastVote: v.lastVote, epochVoteAccount: v.epochVoteAccount, credits: v.epochCredits.map(([e, c, p]) => [e, c - p, best[e] || null]) }); }
    const bal = await post('getBalance', [s.identity]); s.balance = bal.value / 1e9;
    renderStrip(); refreshPage();
  } catch (e) { /* facts are optional */ }
}

/* ---------- boot ---------- */
export async function boot(opts) {
  CFG = opts.config;
  SNAP = opts.snapshot || await fetch(opts.snapshotUrl, { cache: 'no-cache' }).then(r => r.json()).catch(() => ({ sources: {} }));   // no facts, but the probe still runs
  settings = loadSettings(); buildSources();
  const q = new URLSearchParams(location.search);
  state.src = SRC[q.get('src')] ? q.get('src') : (CFG.defaultSource || 'testnet');
  cv = $('cv'); ctx = cv.getContext('2d');
  { const f = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(); if (f) setFont(f); }
  eng = new Engine(400); window.HZ_ENGINE = eng;
  const TITLES = { stake: 'Addresses and how to delegate', tech: 'Client, node, probe, diagnostics',
    kRun: 'Run or stop (space)', kMeasure: 'Measurement row', kCh1: 'Show or hide channel 1', kCh2: 'Show or hide channel 2',
    mainnet: 'Mainnet-beta' + (SRC.mainnet.vote ? '' : ' · no vote account yet'), testnet: 'Testnet' + (SRC.testnet.vote ? '' : ' · no vote account yet') };
  document.querySelectorAll('.key').forEach(k => { const t = TITLES[k.dataset.menu || k.dataset.src || k.id]; if (t) k.title = t; });
  $('knob').title = 'Window: click, scroll or ← →';
  document.querySelectorAll('.key[data-menu]').forEach(k => k.addEventListener('click', () => setPage(state.page === k.dataset.menu ? 'signal' : k.dataset.menu)));
  document.querySelectorAll('.key[data-src]').forEach(k => k.addEventListener('click', () => { state.src = k.dataset.src; applySource(); }));
  $('kRun').addEventListener('click', () => setRunning(!state.running));
  $('kMeasure').addEventListener('click', function () { state.numbers = !state.numbers; this.setAttribute('aria-pressed', String(state.numbers)); resize(); readouts(); });
  $('kCh1').addEventListener('click', function () { state.showCh1 = !state.showCh1; eng.set('showCh1', state.showCh1); this.setAttribute('aria-pressed', String(state.showCh1)); });
  $('kCh2').addEventListener('click', function () { state.showCh2 = !state.showCh2; eng.set('showCh2', state.showCh2); this.setAttribute('aria-pressed', String(state.showCh2)); });
  $('knob').addEventListener('click', () => setZoom((state.zoom + 1) % ZOOMS.length));
  $('softkeys').addEventListener('click', e => { const b = e.target.closest('.softkey'); if (b) softkey(+b.dataset.i); });
  $('page').addEventListener('click', e => { const b = e.target.closest('.lab'); if (b && !b.disabled) softkey(+b.dataset.i); });
  $('screen').addEventListener('mousemove', e => { if (state.lock) { hover = null; return; } const r = cv.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top; hover = (y < TOPH || y > H - BOTH) ? null : { x, y }; });
  /* click on a slot: lock it (the box stays, with explorer links); click again, ×, or Escape unlocks */
  $('screen').addEventListener('click', e => {
    if (state.page) return;
    if (e.target.closest('.curbox')) { if (e.target.classList.contains('x')) setLock(null); return; }
    if (state.lock) { setLock(null); return; }
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;   // a tap has no hover before it: read the slot under the click first
    if (y >= TOPH && y <= H - BOTH) { hover = { x, y }; draw(); }
    if (lastInfo) setLock(lastInfo.slot);
  });
  $('screen').addEventListener('mouseleave', () => { hover = null; });
  document.querySelector('.strip').addEventListener('click', e => { const b = e.target.closest('.cp'); if (!b) return; const txt = b.dataset.copy, t = b.textContent; const done = ok => { b.textContent = ok ? 'copied' : 'failed'; setTimeout(() => { b.textContent = t; }, 1400); }; try { navigator.clipboard.writeText(txt).then(() => done(true), () => done(fallbackCopy(txt))); } catch (err) { done(fallbackCopy(txt)); } });
  wireInput();
  new ResizeObserver(resize).observe($('screen'));
  resize();
  applySource();
  if (PAGES.includes(q.get('page'))) setPage(q.get('page'));
  requestAnimationFrame(loop);
  setInterval(readouts, 500);
  setInterval(refreshFacts, Math.max(60, settings.pollLight) * 1000);
  document.documentElement.classList.add('ready');
}
