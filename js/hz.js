const BY_ID = { 0: 'agave', 1: 'agave', 2: 'fd', 3: 'agave', 4: 'agave', 5: 'fd', 6: 'agave', 7: 'other', 8: 'agave', 9: 'fd', 10: 'agave', 11: 'fd', 12: 'fd', 13: 'agave' };
const LETTER = { a: 'agave', f: 'fd', o: 'other' };
const classOf = id => { if (!id) return 'other'; if (LETTER[id]) return LETTER[id]; const m = /^Unknown\((\d+)\)$/.exec(id); if (m) return BY_ID[+m[1]] || 'other'; return /fire|franken/i.test(id) ? 'fd' : /agave|jito|harmonic|rakurai|raiku|solana|paladin|bam/i.test(id) ? 'agave' : 'other'; };
const COL = { agave: '232,196,77', fd: '255,128,92', other: '150,156,164' };
const CH2 = '79,195,227';
let FONT = 'Plex, monospace';
function setFont(f) { FONT = f; }   // the shell passes the page's --mono so canvas text matches the CSS
class Engine {
constructor(nominalMs) {
this.nominal = nominalMs || 400;
this.cfg = { span: 250, showCh1: true, showCh2: true, dut: null, padX: 8, lock: null };
this.slots = new Map(); this.leaders = new Map(); this.clients = new Map();
this.running = true; this.frozenAt = null; this.lastSlot = 0; this.lastFs = 0; this.lastRoot = 0; this.epoch = null;
this.byClass = { agave: [0, 0], fd: [0, 0], other: [0, 0] }; this.slotMs = null; this.held = [];
this.off = null; this.offAt = 0;
}
reset() { this.slots.clear(); this.lastSlot = 0; this.lastFs = 0; this.lastRoot = 0; this.byClass = { agave: [0, 0], fd: [0, 0], other: [0, 0] }; this.off = null; this.slotMs = null; this.held = []; this.epoch = null; this.leaders.clear(); this.clients.clear(); this.cfg.lock = null; }   // a new source starts clean
set(k, v) { this.cfg[k] = v; }
stop() { this.running = false; this.frozenAt = this.now(); }
run() { this.running = true; this.frozenAt = null; const h = this.held; this.held = []; for (const ev of h) this.onEvent(ev); }
clock(t) {
const pn = performance.now(), o = t - pn;
if (this.off === null) this.off = o; else { this.off -= (pn - this.offAt) / 1000; if (o > this.off) this.off = o; }
this.offAt = pn;
}
now() { return this.running || this.frozenAt === null ? performance.now() + (this.off === null ? 0 : this.off) : this.frozenAt; }
unit() { return this.slotMs || this.nominal; }
spanMs() { return this.cfg.span * this.unit(); }
classFor(slot) { const pk = this.leaders.get(slot); return pk ? (this.clients.get(pk.slice(0, 8)) || 'other') : 'other'; }
isMine(slot) { const pk = this.leaders.get(slot); return !!pk && pk === this.cfg.dut; }
shown() { const lim = this.running ? Infinity : this.frozenAt; return Array.from(this.slots.values()).filter(s => s.fs !== null && s.fs <= lim); }
recent(n) { return this.shown().sort((a, b) => a.slot - b.slot).slice(-n); }
period() {
const r = this.recent(65), p = []; for (let i = 1; i < r.length; i++) if (r[i].slot === r[i - 1].slot + 1 && r[i].fs > r[i - 1].fs) p.push(r[i].fs - r[i - 1].fs);
if (p.length < 4) return this.nominal; const s = p.sort((a, b) => a - b); return s[s.length >> 1];
}
onEvent(ev) {
if (ev.kind === 'leaders') { ev.list.forEach((pk, i) => this.leaders.set(ev.start + i, pk)); if (this.leaders.size > 20000) for (const k of Array.from(this.leaders.keys()).slice(0, 5000)) this.leaders.delete(k); return; }
if (ev.kind === 'clients') { for (const fam in ev.map) for (const k of ev.map[fam].split(' ')) if (k) this.clients.set(k, classOf(fam)); return; }   // { a: 'prefix prefix …', f: …, o: … }
if (ev.kind === 'epoch') { this.epoch = ev; return; }
if (ev.kind === 'slotTime') { this.slotMs = ev.ms; return; }   // the cluster's slot duration, from the SIMD-0525 gates
if (!this.running && (ev.kind === 'slot' || ev.kind === 'vote')) { this.held.push(ev); if (this.held.length > 60000) this.held.shift(); return; }
if (ev.kind === 'vote') return this.onVote(ev);
if (ev.kind !== 'slot') return;
this.clock(ev.t);
if (ev.type === 'root') { this.lastRoot = Math.max(this.lastRoot, ev.slot); return; }
let s = this.slots.get(ev.slot);
if (!s) { s = { slot: ev.slot, fs: null, completed: null, frozen: null, conf: null, dead: null, voteT: null, voteLat: null }; this.slots.set(ev.slot, s); if (this.slots.size > 1400) this.slots.delete(this.slots.keys().next().value); }
if (ev.type === 'firstShredReceived' || (ev.basic && s.fs === null)) { s.fs = ev.t; if (ev.slot > this.lastSlot) { this.lastSlot = ev.slot; this.lastFs = ev.t; } this.byClass[this.classFor(ev.slot)][0]++; }
else if (ev.type === 'completed') s.completed = ev.t; else if (ev.type === 'frozen') s.frozen = ev.t; else if (ev.type === 'optimisticConfirmation') s.conf = ev.t; else if (ev.type === 'dead') s.dead = ev.t;
}
onVote(v) {
const s = this.slots.get(v.voted), landed = this.slots.get(v.landed);
if (!s || s.fs === null) return;
s.voteT = landed && landed.fs !== null ? landed.fs : v.t; s.voteLat = v.latency;   // the event's own time: held votes are applied later
this.byClass[this.classFor(v.voted)][1]++;
}
periodOf(s) {
const n = this.slots.get(s.slot + 1), n2 = this.slots.get(s.slot + 2);
if (!n || n.fs === null || n.fs <= s.fs) return null;
if (n2 && n2.fs !== null && n2.fs < n.fs) return null;
return n.fs - s.fs;
}
draw(ctx, W, H, topH, botH, hover) { return drawRoll(this, ctx, W, H, topH, botH, hover ? hover.x : null); }
measure() {
const r = this.recent(256), per = [], rep = [], con = []; let dead = 0;
for (let i = 0; i < r.length; i++) { const s = r[i], n = r[i + 1]; if (n && n.slot === s.slot + 1) per.push(n.fs - s.fs); if (s.frozen !== null) rep.push(s.frozen - s.fs); if (s.conf !== null) con.push(s.conf - s.fs); if (s.dead !== null) dead++; }
const med = a => { if (!a.length) return null; const s = a.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
const mean = a => a.length ? a.reduce((p, q) => p + q, 0) / a.length : null;
const pm = mean(per), sd = pm ? Math.sqrt(mean(per.map(x => (x - pm) * (x - pm)))) : null;
const voted = r.filter(s => s.voteT !== null), lat = voted.map(s => s.voteT - s.fs), latS = voted.map(s => s.voteLat);
const lastVoted = voted.length ? voted[voted.length - 1].slot : null;
const window = lastVoted ? r.filter(s => s.slot <= lastVoted && s.slot > lastVoted - 256) : [];
return { periodMs: pm, periodSd: sd, hz: pm ? 1000 / pm : null, replayMs: med(rep), confirmMs: med(con), rootLag: this.lastSlot && this.lastRoot ? this.lastSlot - this.lastRoot : null,
dead, samples: r.length, voteLatMs: med(lat), voteLatSlots: med(latS), landing: window.length ? voted.filter(s => s.slot > lastVoted - 256).length / window.length : null, slot: this.lastSlot, byClass: this.byClass };
}
}
function drawRoll(E, ctx, W, H, topH, botH, hoverX) {
const T = E.period(), nowT = E.now(), spanMs = E.spanMs();
const fs = Math.max(9, Math.min(13, W / 90));
const padX = E.cfg.padX || 8, G = Math.ceil(padX + fs * 3.3);                                           // left gutter: y labels and lane tags live here, the plot starts at G
const right = W * 0.965, x = t => right - (nowT - t) / spanMs * (right - G);
const laneH = Math.max(5, Math.round(fs * .6)), axisH = fs * 1.5, tickH = fs * .55;
const plotTop = topH + fs * 1.4, plotBot = H - botH - axisH - laneH - fs * .9, gap = fs * 2.2;
const h1 = (plotBot - plotTop - gap) * 0.56, l1 = { top: plotTop, bot: plotTop + h1 }, l2 = { top: plotTop + h1 + gap, bot: plotBot - tickH - fs * .4 };
const t0 = nowT - spanMs - 6 * T, slots = E.recent(1400).filter(s => s.fs >= t0 && s.fs <= nowT);
const nextFs = s => { const n = E.slots.get(s.slot + 1); return n && n.fs !== null && n.fs > s.fs ? n.fs : null; };
const endOf = s => { const n = nextFs(s); return n !== null ? n : Math.min(nowT, s.fs + T * 1.5); };
const stepFor = t => t > 1600 ? 500 : t > 800 ? 200 : t > 400 ? 100 : 50;
const fixed = (lane, top) => ({ top, step: stepFor(top), y: ms => lane.bot - (lane.bot - lane.top) * Math.min(1.05, ms / top) });
const unit = E.unit();
const cut1 = unit, cut2 = unit * 2;
const S1 = fixed(l1, unit * 2), S2 = fixed(l2, unit * 3);
ctx.save(); ctx.font = (fs * .85) + 'px ' + FONT;
const grid = (S, lane, title, color) => {
ctx.strokeStyle = '#1a2217'; ctx.lineWidth = 1; ctx.fillStyle = '#6f7f60'; ctx.textAlign = 'left';
for (let ms = 0; ms <= S.top; ms += S.step) { const yy = Math.round(S.y(ms)) + .5; ctx.beginPath(); ctx.moveTo(G, yy); ctx.lineTo(W, yy); ctx.stroke(); }
ctx.textAlign = 'right'; for (let ms = S.step; ms < S.top; ms += S.step) ctx.fillText(String(ms), G - 5, Math.round(S.y(ms)) + fs * .35); ctx.textAlign = 'left';
ctx.fillStyle = color; ctx.fillText(title, padX, lane.top + fs * .2);
};
grid(S1, l1, '1 · slot length · ms', 'rgba(' + COL.agave + ',.9)');
grid(S2, l2, '2 · vote landing · ms after the slot opened', 'rgba(' + CH2 + ',.9)');
const cutLine = (S, ms) => { if (ms === null || ms >= S.top) return; const yy = Math.round(S.y(ms)) + .5; ctx.save(); ctx.setLineDash([2, 4]); ctx.strokeStyle = 'rgba(255,150,130,.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(G, yy); ctx.lineTo(right, yy); ctx.stroke(); ctx.restore(); };
cutLine(S1, cut1); cutLine(S2, cut2);
const tags = [];                                                          // lane tags, drawn in the gutter after the clipped plot
ctx.save(); ctx.beginPath(); ctx.rect(G, topH, W - G, H - topH - botH); ctx.clip();
const series = (pts, base, w, fallbackRgb) => {
const runs = []; let run = [];
for (const p of pts) { if (p === null) { if (run.length) runs.push(run); run = []; continue; } if (run.length && run[run.length - 1][2] !== p[2]) { run.push(p); runs.push(run); run = [p]; } else run.push(p); }
if (run.length) runs.push(run);
for (const r of runs) {
const rgb = r[0][2] || fallbackRgb;
if (r.length > 1) {
let top = Infinity; for (const p of r) if (p[1] < top) top = p[1];
const g = ctx.createLinearGradient(0, top, 0, base); g.addColorStop(0, 'rgba(' + rgb + ',.20)'); g.addColorStop(1, 'rgba(' + rgb + ',.02)');
ctx.beginPath(); ctx.moveTo(r[0][0], base); for (const p of r) ctx.lineTo(p[0], p[1]); ctx.lineTo(r[r.length - 1][0], base); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
}
const path = () => { ctx.beginPath(); r.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); if (r.length === 1) ctx.lineTo(r[0][0] + .1, r[0][1]); };
ctx.lineJoin = 'round'; ctx.lineCap = 'round';
path(); ctx.strokeStyle = 'rgba(' + rgb + ',.16)'; ctx.lineWidth = w * 3.2; ctx.shadowBlur = 0; ctx.stroke();      // soft halo
path(); ctx.strokeStyle = 'rgba(' + rgb + ',.97)'; ctx.lineWidth = w; ctx.shadowColor = 'rgb(' + rgb + ')'; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0;   // bright core
}
};
const dot = (px, py, rgb, r, blur) => { ctx.fillStyle = 'rgb(' + rgb + ')'; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = blur; ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; };
if (E.cfg.showCh1) {
const pts = []; let prev = null, prevFs = -Infinity, win4 = [];
for (const s of slots) {
const v = E.periodOf(s);
if (v === null) { if (prev !== null) pts.push(null); prev = null; win4 = []; continue; }
if (prev !== null && s.slot !== prev + 1) { pts.push(null); win4 = []; }
if (s.fs <= prevFs) { pts.push(null); win4 = []; prev = s.slot; continue; }   // received out of order: no point, no backwards line
let y; if (v > 2.5 * T) { y = v; win4 = []; } else { win4.push(v); if (win4.length > 4) win4.shift(); y = win4.reduce((a, b) => a + b, 0) / win4.length; }   // a skipped or very slow slot stays one honest spike instead of a smear over four
pts.push([x(s.fs), S1.y(y), COL[E.classFor(s.slot)] || COL.other]); prev = s.slot; prevFs = s.fs;
}
series(pts, l1.bot, 1.8, COL.agave);
const last = pts.filter(Boolean).pop(); if (last && E.running) dot(last[0], last[1], last[2], 2.8, 16);   // the beam
const oldest = slots.length ? slots[0] : null, filled = oldest ? (nowT - oldest.fs) / spanMs : 0;
if (oldest && filled < 0.995) { ctx.fillStyle = '#6f7f60'; ctx.textAlign = 'left'; ctx.fillText('filling · ' + Math.round(filled * 100) + ' %', G + 6, l1.bot - fs * .3); }
}
if (E.cfg.showCh2) {
let newest = null;
for (const s of slots) {
if (s.voteT === null || s.voteT > nowT) continue;
const px = x(s.fs), py = S2.y(s.voteT - s.fs); if (px < G - 2) continue;
ctx.fillStyle = 'rgba(' + CH2 + ',.35)'; ctx.fillRect(Math.round(px) - .5, py, 1.2, l2.bot - py);
dot(px, py, CH2, 2.2, 8);
if (!newest || s.slot > newest.slot) newest = s;
}
if (newest && E.running) dot(x(newest.fs), S2.y(newest.voteT - newest.fs), '150,230,255', 3, 16);
const ty = l2.bot + fs * .4; ctx.fillStyle = 'rgba(' + CH2 + ',.85)';
for (const s of slots) if (s.voteT !== null && s.voteT <= nowT) { const x0 = x(s.fs), x1 = x(endOf(s)); if (x1 >= G) ctx.fillRect(x0, ty, Math.max(1, x1 - x0 - .5), tickH); }
tags.push(['votes', ty + tickH - 1]);
}
const laneY = plotBot + fs * .5;
for (const s of slots) {
const x0 = x(s.fs), x1 = x(endOf(s)); if (x1 < G) continue;
ctx.fillStyle = 'rgba(' + (COL[E.classFor(s.slot)] || COL.other) + ',.7)'; ctx.fillRect(x0, laneY, Math.max(1, x1 - x0 - (x1 - x0 > 3 ? 1 : 0)), laneH);
if (E.isMine(s.slot)) { ctx.fillStyle = '#ffffff'; ctx.fillRect(x0, laneY - 3, Math.max(1, x1 - x0), 2); }
}
ctx.restore();                                                             // end of the clipped plot
tags.push(['leader', laneY + laneH - 1]);
ctx.fillStyle = '#8fa07e'; ctx.textAlign = 'left'; for (const [txt, yy] of tags) ctx.fillText(txt, padX, yy);
ctx.fillStyle = '#6f7f60'; ctx.textAlign = 'center';
const div = spanMs / 10, dec = Math.abs(div / 1000 - Math.round(div / 1000)) < 0.06 ? 0 : 1;   // one decimal only when a division is not a round second
ctx.save(); ctx.strokeStyle = 'rgba(215,229,198,.09)'; ctx.setLineDash([1.5, 3.5]); ctx.beginPath();
for (let i = 1; i < 10; i++) { const gx = Math.round(x(nowT - (10 - i) * div)) + .5; ctx.moveTo(gx, topH); ctx.lineTo(gx, plotBot + fs * .3); }
ctx.stroke(); ctx.restore();   // the graticule sits on the divisions it labels
for (let i = 1; i < 10; i++) ctx.fillText('−' + ((10 - i) * div / 1000).toFixed(dec) + (i === 1 ? ' s' : ''), x(nowT - (10 - i) * div), H - botH - 4);   // the unit once, on the first tick
ctx.fillText('now', right, H - botH - 4);
ctx.strokeStyle = 'rgba(215,229,198,.3)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(Math.round(right) + .5, topH); ctx.lineTo(Math.round(right) + .5, plotBot + fs * .3); ctx.stroke(); ctx.setLineDash([]);
let info = null;
if ((hoverX === null || hoverX === undefined) && E.cfg.lock) { const ls = E.slots.get(E.cfg.lock); if (ls && ls.fs !== null) hoverX = x(ls.fs) + 1; }   // a locked slot reads like a hovered one
if (hoverX !== null && hoverX !== undefined) {
const th = hoverX < G ? -Infinity : nowT - (right - hoverX) / (right - G) * spanMs; let s = null;
for (const c of slots) { if (c.fs <= th) s = c; else break; }
if (s && th - s.fs <= endOf(s) - s.fs + 1) {
const xx = Math.round(x(s.fs)) + .5; ctx.strokeStyle = 'rgba(215,229,198,.5)'; ctx.beginPath(); ctx.moveTo(xx, topH); ctx.lineTo(xx, plotBot + fs * .3); ctx.stroke();
const n = nextFs(s), pk = E.leaders.get(s.slot);
info = { slot: s.slot, pk: pk || null, cls: E.classFor(s.slot), leader: pk ? pk.slice(0, 6) + '…' + pk.slice(-4) : null, period: n !== null ? n - s.fs : null, replay: s.frozen !== null ? s.frozen - s.fs : null, confirm: s.conf !== null ? s.conf - s.fs : null, vote: s.voteT !== null ? s.voteT - s.fs : null, voteLat: s.voteLat, dead: s.dead !== null, mine: E.isMine(s.slot) };
}
}
ctx.restore();
return { info };
}
const SILENCE_MS = 15000;     // open socket, no slot event for this long → reconnect (public RPC sockets go quiet)
const OPEN_MS = 8000;         // socket open, nothing ever arrived → reconnect (subscription silently failed)
const HIDDEN_MS = 30000;      // tab hidden for this long → close the socket; reconnect the moment it is visible again
const LEADERS_CHUNK = 4000, LEADERS_AHEAD = 1000, HTTP_RETRY_MS = 10000, RPC_TIMEOUT_MS = 12000;
function openFeed(o) {
let closed = false;
const emit = ev => { if (!closed) o.onEvent(ev); }, status = s => { if (!closed && o.onStatus) o.onStatus(s); };
let sock = null, retry = 0, silentOpens = 0, hiddenPaused = false, lastEventAt = 0;
let lastVoteSlot = 0, clockOff = null, clockAt = 0;
let epoch = null, epochBusy = false, epochRetryAt = 0;          // { n, slots, firstSlot }
let leadersEnd = 0, leadersBusy = false, leadersRetryAt = 0;    // slots < leadersEnd have been delivered
const timers = { retry: null, hidden: null, silence: null, open: null };
const rpcList = [].concat(o.rpc), wsList = [].concat(o.ws); let rpcAt = 0, wsAt = 0;
async function rpcOnce(url, method, params) {
const ac = typeof AbortController === 'function' ? new AbortController() : null, tm = ac && setTimeout(() => ac.abort(), RPC_TIMEOUT_MS);
try {
const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }), signal: ac ? ac.signal : undefined });
const j = await r.json(); if (j.error) throw new Error(j.error.message || method); return j.result;
} finally { if (tm) clearTimeout(tm); }
}
async function rpc(method, params) {
let err = null;
for (let k = 0; k < rpcList.length; k++) {
const i = (rpcAt + k) % rpcList.length;
try { const res = await rpcOnce(rpcList[i], method, params); rpcAt = i; return res; }
catch (e) { err = e; if (e && e.name === 'AbortError' && closed) throw e; }
}
throw err;
}
function sampleClock(t) {
const o2 = t - Date.now(), now = performance.now();
if (clockOff === null) clockOff = o2; else { clockOff -= (now - clockAt) * 0.001; if (o2 > clockOff) clockOff = o2; }
clockAt = now;
}
const epochEnd = () => epoch ? epoch.firstSlot + epoch.slots - 1 : null;
async function refreshEpoch(hintSlot) {
if (epochBusy || closed || performance.now() < epochRetryAt) return;
epochBusy = true;
try {
const ep = await rpc('getEpochInfo');
epoch = { n: ep.epoch, slots: ep.slotsInEpoch, firstSlot: ep.absoluteSlot - ep.slotIndex };
emit({ kind: 'epoch', n: epoch.n, slots: epoch.slots, firstSlot: epoch.firstSlot });
leadersRetryAt = 0;                                                    // a new epoch makes a previously unknown schedule known
leadersFor(Math.max(hintSlot || 0, ep.absoluteSlot - 8));          // colours for the first slots, before the first shred arrives
readSlotTime(ep);
} catch (e) { epochRetryAt = performance.now() + HTTP_RETRY_MS; if (!closed && !(e && e.name === 'AbortError')) console.warn('epoch', e && e.message || e); }
finally { epochBusy = false; }
}
const SLOT_GATES = ['iBRL5RuWhw4yqaAZu96RUULHckHTZAoe2b77qaV38JZ', 'iBRLL3k18HST852F1Mf3Lv83waTNQmmqvKDxvYGwQFL', 'iBRLMc81UjRa8fn8A6eE8bJTnRbgQoPTynM51akENCV', 'iBRLjhJnkmDZgNoZRDMW11d8ZV7HvsL3vAyRjZB5npW'];   // 350, 300, 250, 200 ms
let slotTimeFor = -1, slotTimeRetryAt = 0;
async function readSlotTime(ep) {
if (slotTimeFor === ep.epoch || closed || performance.now() < slotTimeRetryAt) return;
slotTimeFor = ep.epoch;
try {
const res = await rpc('getMultipleAccounts', [SLOT_GATES, { encoding: 'base64' }]);
const first = ep.absoluteSlot - ep.slotIndex, epochOf = slot => ep.epoch + Math.floor((slot - first) / ep.slotsInEpoch);
let steps = 0;
for (const a of (res && res.value) || []) {
if (!a || !a.data || !a.data[0]) break;
const b = Uint8Array.from(atob(a.data[0]), c => c.charCodeAt(0)); if (b[0] !== 1) break;
let at = 0; for (let i = 8; i >= 1; i--) at = at * 256 + b[i];
if (epochOf(at) + 1 > ep.epoch) break;
steps++;
}
emit({ kind: 'slotTime', ms: 400 - 50 * steps });
} catch (e) { slotTimeFor = -1; slotTimeRetryAt = performance.now() + HTTP_RETRY_MS; if (!closed && !(e && e.name === 'AbortError')) console.warn('slot time', e && e.message || e); }
}
async function leadersFor(slot) {
if (leadersBusy || closed || slot + LEADERS_AHEAD < leadersEnd || performance.now() < leadersRetryAt) return;
leadersBusy = true;
try {
const start = Math.max(slot, leadersEnd);
let limit = LEADERS_CHUNK;
if (epoch) limit = Math.min(limit, epoch.firstSlot + 2 * epoch.slots - start);
if (limit <= 0) { leadersRetryAt = performance.now() + HTTP_RETRY_MS; return; }
let list;
try { list = await rpc('getSlotLeaders', [start, limit]); }
catch (e) {
const end = epochEnd();                                                      // range crossed into a schedule the node does not have yet
if (end !== null && start <= end && end - start + 1 < limit) list = await rpc('getSlotLeaders', [start, end - start + 1]);
else throw e;
}
if (list && list.length) { leadersEnd = start + list.length; emit({ kind: 'leaders', start, list }); }
} catch (e) { leadersRetryAt = performance.now() + HTTP_RETRY_MS; if (!closed && !(e && e.name === 'AbortError')) console.warn('leaders', e && e.message || e); }
finally { leadersBusy = false; }
}
function handleVote(v) {
const info = v.value && v.value.data && v.value.data.parsed && v.value.data.parsed.info; if (!info || !info.votes || !info.votes.length) return;
const newest = info.votes[info.votes.length - 1]; if (newest.slot === lastVoteSlot) return;
lastVoteSlot = newest.slot;
emit({ kind: 'vote', landed: v.context.slot, voted: newest.slot, latency: newest.latency != null ? newest.latency : v.context.slot - newest.slot, t: Date.now() + (clockOff || 0) });
}
function onSlot(slot) {
lastEventAt = performance.now();
clearTimeout(timers.silence);
timers.silence = setTimeout(() => { if (sock && performance.now() - lastEventAt >= SILENCE_MS - 100) { console.warn('probe silent, reconnecting'); drop(sock); } }, SILENCE_MS);
leadersFor(slot);
const end = epochEnd(); if (end !== null && slot > end) refreshEpoch(slot);
if (slotTimeFor === -1 && epoch) readSlotTime({ epoch: epoch.n, slotsInEpoch: epoch.slots, absoluteSlot: slot, slotIndex: slot - epoch.firstSlot });
}
const drop = s => { try { s.close(); } catch (e) {} };
function connect() {
if (closed || sock || hiddenPaused) return;
status('connecting');
let s;
const wsUrl = wsList[wsAt % wsList.length];
try { s = new WebSocket(wsUrl); } catch (e) { wsAt++; return scheduleRetry(); }
sock = s;
let gotAny = false, basic = silentOpens >= 2;      // after two silent opens, ask for the simpler subscription instead
clearTimeout(timers.open);
timers.open = setTimeout(() => { if (sock === s && !gotAny) { silentOpens++; drop(s); } }, OPEN_MS);   // silent: onclose moves to the next endpoint
s.onopen = () => {
if (sock !== s) return;
s.send(JSON.stringify({ jsonrpc: '2.0', id: basic ? 3 : 1, method: basic ? 'slotSubscribe' : 'slotsUpdatesSubscribe' }));
if (o.vote) s.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'accountSubscribe', params: [o.vote, { encoding: 'jsonParsed', commitment: 'processed' }] }));
if (o.clients) emit({ kind: 'clients', map: o.clients });
refreshEpoch(0);
};
s.onmessage = e => {
if (sock !== s) return;
let m; try { m = JSON.parse(e.data); } catch (err) { return; }
if (m.id !== undefined) {
if (m.error && m.id === 1) { basic = true; s.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'slotSubscribe' })); }   // richer method unavailable here
return;
}
if (m.method === 'slotsUpdatesNotification') {
const r = m.params.result, t = r.timestamp || Date.now();
if (!gotAny) { gotAny = true; retry = 0; silentOpens = 0; status('live'); emit({ kind: 'endpoint', ws: wsUrl }); }
emit({ kind: 'slot', slot: r.slot, type: r.type, t });
if (r.type === 'firstShredReceived') { if (r.timestamp) sampleClock(r.timestamp); onSlot(r.slot); }
} else if (m.method === 'slotNotification') {
const r = m.params.result;
if (!gotAny) { gotAny = true; retry = 0; silentOpens = 0; status('live-basic'); emit({ kind: 'endpoint', ws: wsUrl }); }
emit({ kind: 'slot', slot: r.slot, type: 'frozen', t: Date.now(), basic: true });
onSlot(r.slot);
} else if (m.method === 'accountNotification') handleVote(m.params.result);
};
s.onerror = () => { /* onclose follows */ };
s.onclose = () => {
clearTimeout(timers.open); clearTimeout(timers.silence);
if (sock !== s) return;                       // closed on purpose (source switched, tab hidden)
sock = null;
if (!closed && !hiddenPaused) { if (!gotAny) wsAt++; status('error'); scheduleRetry(); }   // a socket that never delivered: next endpoint
};
}
function scheduleRetry() {
if (closed || hiddenPaused) return;
retry++;
clearTimeout(timers.retry);
timers.retry = setTimeout(() => { timers.retry = null; connect(); }, retry === 1 ? 250 : Math.min(15000, 500 * Math.pow(2, retry)));   // a dropped live socket comes back at once, then 2 s, 4 s … 15 s
}
const onVis = () => {
if (document.hidden) {
clearTimeout(timers.hidden);
timers.hidden = setTimeout(() => {
hiddenPaused = true;
clearTimeout(timers.retry); timers.retry = null; clearTimeout(timers.silence); clearTimeout(timers.open);
if (sock) { const s = sock; sock = null; drop(s); }
status('paused');
}, HIDDEN_MS);
} else {
clearTimeout(timers.hidden);
if (hiddenPaused) { hiddenPaused = false; retry = 0; connect(); }
else if (!sock && !closed && !timers.retry) connect();
}
};
document.addEventListener('visibilitychange', onVis);
if (document.hidden) onVis();
connect();
return { close() { closed = true; document.removeEventListener('visibilitychange', onVis); for (const k in timers) clearTimeout(timers[k]); if (sock) { const s = sock; sock = null; drop(s); } } };
}
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
function loadSettings() {
const d = { pollLight: (CFG.poll && CFG.poll.lightSeconds) || 120 };
const q = new URLSearchParams(location.search);
if (q.get('ws')) d.wsOverride = q.get('ws');
if (q.get('rpc')) d.rpcOverride = q.get('rpc');
return d;
}
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
function setZoom(i) {
if (i !== undefined) state.zoom = i;
const z = ZOOMS[state.zoom];
eng.set('span', z.span);
$('knob').style.setProperty('--rot', z.rot + 'deg'); $('tbVal').textContent = z.label;
}
function setLock(slot) { state.lock = slot; eng.set('lock', slot); if (slot) hover = null; }
function setRunning(r) { state.running = r; r ? eng.run() : eng.stop(); $('kRun').setAttribute('aria-pressed', String(r)); }
const HOME_GROUP = 1;
let cur = null;                                    // { g, i } or null when no cursor is shown
function groups() {
return [Array.from(document.querySelectorAll('.key[data-menu]')),
[$('kRun'), $('kMeasure'), $('kCh1'), $('kCh2')], Array.from(document.querySelectorAll('.key[data-src]')).concat([$('knob')])].filter(g => g.length && g[0]);
}
const layoutOf = gs => gs.map(g => g.map(k => !k.disabled));
function moveCursor(cur, key, layout) {
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
document.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; b.blur(); if (b.closest('.panel') && (b.classList.contains('key') || b.classList.contains('knob'))) cursorTo(b); });
window.addEventListener('pointerdown', () => { try { window.focus(); } catch (err) {} }, { passive: true });
}
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
async function boot(opts) {
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
window.hzBoot = boot;
