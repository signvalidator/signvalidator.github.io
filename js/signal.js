// hz.ms — the engine. Keeps the last ~1400 slots with their pipeline stage times, the device-under-test's landed votes,
// and draws them as a slow roll: one point per slot, the newest at the right edge, sliding left at the chain's own pace.
import { classOf, COL } from './palette.js';
import { drawRoll } from './roll.js';

export class Engine {
  constructor(nominalMs) {
    this.nominal = nominalMs || 400;
    this.cfg = { span: 250, showCh1: true, showCh2: true, dut: null, padX: 8, lock: null };
    this.slots = new Map(); this.leaders = new Map(); this.clients = new Map();
    this.running = true; this.frozenAt = null; this.lastSlot = 0; this.lastFs = 0; this.lastRoot = 0; this.epoch = null;
    this.byClass = { agave: [0, 0], fd: [0, 0], other: [0, 0] }; this.slotMs = null; this.held = [];
    /* clock: off = (probe clock) − performance.now(). Network delay only makes a measured offset smaller, so the running
       maximum is the best estimate; it decays 1 ms per second so a drifting clock is still followed. now() never goes back. */
    this.off = null; this.offAt = 0;
  }
  reset() { this.slots.clear(); this.lastSlot = 0; this.lastFs = 0; this.lastRoot = 0; this.byClass = { agave: [0, 0], fd: [0, 0], other: [0, 0] }; this.off = null; this.slotMs = null; this.held = []; this.epoch = null; this.leaders.clear(); this.clients.clear(); this.cfg.lock = null; }   // a new source starts clean
  set(k, v) { this.cfg[k] = v; }
  /* STOP freezes the acquisition, not just the clock: events that arrive while stopped are held and applied on RUN, so
     nothing new appears on screen and nothing is lost either */
  stop() { this.running = false; this.frozenAt = this.now(); }
  run() { this.running = true; this.frozenAt = null; const h = this.held; this.held = []; for (const ev of h) this.onEvent(ev); }
  clock(t) {
    const pn = performance.now(), o = t - pn;
    if (this.off === null) this.off = o; else { this.off -= (pn - this.offAt) / 1000; if (o > this.off) this.off = o; }
    this.offAt = pn;
  }
  now() { return this.running || this.frozenAt === null ? performance.now() + (this.off === null ? 0 : this.off) : this.frozenAt; }
  /* the scale unit: the cluster's slot time from the SIMD-0525 gates once read, the configured protocol value before that. Never a measurement, so nothing on screen rescales. */
  unit() { return this.slotMs || this.nominal; }
  spanMs() { return this.cfg.span * this.unit(); }
  /* client maps are keyed by the first 8 characters of the node pubkey (compact; collisions are astronomically unlikely) */
  classFor(slot) { const pk = this.leaders.get(slot); return pk ? (this.clients.get(pk.slice(0, 8)) || 'other') : 'other'; }
  isMine(slot) { const pk = this.leaders.get(slot); return !!pk && pk === this.cfg.dut; }
  /* slots with a first-shred time; while stopped, only those that had opened when the picture froze */
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
  /* slot length = next slot's first shred minus this one's. A slot the probe received late (repair) carries a timestamp out of
     order with its neighbours; its length and the length of the slot before it are unknown rather than negative or inflated. */
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
