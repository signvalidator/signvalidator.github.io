// hz.ms — Roll view: two lanes, one point per slot, newest at the right, sliding left with the clock.
// x is time: every slot sits at the moment its first shred reached the probe, so the trace moves at constant speed
// and a slow or missing slot shows as a wider or empty step, never as a shake of the whole screen.
import { COL, CH2, FONT } from './palette.js';

export function drawRoll(E, ctx, W, H, topH, botH, hoverX) {
  const T = E.period(), nowT = E.now(), spanMs = E.spanMs();
  const fs = Math.max(9, Math.min(13, W / 90));
  const padX = E.cfg.padX || 8, G = Math.ceil(padX + fs * 3.3);                                           // left gutter: y labels and lane tags live here, the plot starts at G
  const right = W * 0.965, x = t => right - (nowT - t) / spanMs * (right - G);
  const laneH = Math.max(5, Math.round(fs * .6)), axisH = fs * 1.5, tickH = fs * .55;
  const plotTop = topH + fs * 1.4, plotBot = H - botH - axisH - laneH - fs * .9, gap = fs * 2.2;
  const h1 = (plotBot - plotTop - gap) * 0.56, l1 = { top: plotTop, bot: plotTop + h1 }, l2 = { top: plotTop + h1 + gap, bot: plotBot - tickH - fs * .4 };
  /* slots inside the window, plus a few before it: the smoothing at the left edge is settled and a run enters from the edge instead of popping in */
  const t0 = nowT - spanMs - 6 * T, slots = E.recent(1400).filter(s => s.fs >= t0 && s.fs <= nowT);
  const nextFs = s => { const n = E.slots.get(s.slot + 1); return n && n.fs !== null && n.fs > s.fs ? n.fs : null; };
  const endOf = s => { const n = nextFs(s); return n !== null ? n : Math.min(nowT, s.fs + T * 1.5); };
  const stepFor = t => t > 1600 ? 500 : t > 800 ? 200 : t > 400 ? 100 : 50;
  const fixed = (lane, top) => ({ top, step: stepFor(top), y: ms => lane.bot - (lane.bot - lane.top) * Math.min(1.05, ms / top) });
  /* Fixed scales in slot units, like a scope's volts per division: lane 1 spans two slot times,
     lane 2 three. Cutoffs straight from the protocol: lane 1 at the slot time, lane 2 at the two-slot vote credit grace. */
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
  /* a series with glow and an area fill, drawn per continuous run; each point carries the colour of the slot's leader client */
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
    /* live only: the window fills from the right for the first minute; say so instead of leaving the reader to wonder */
    const oldest = slots.length ? slots[0] : null, filled = oldest ? (nowT - oldest.fs) / spanMs : 0;
    if (oldest && filled < 0.995) { ctx.fillStyle = '#6f7f60'; ctx.textAlign = 'left'; ctx.fillText('filling · ' + Math.round(filled * 100) + ' %', G + 6, l1.bot - fs * .3); }
  }
  if (E.cfg.showCh2) {
    /* votes are sparse; each landed vote is a lollipop: a stem from the lane floor up to how late it landed, and a dot */
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
  /* leader lane: who led each slot, by client colour, each block as wide as the slot really lasted; our own slots ticked white */
  const laneY = plotBot + fs * .5;
  for (const s of slots) {
    const x0 = x(s.fs), x1 = x(endOf(s)); if (x1 < G) continue;
    ctx.fillStyle = 'rgba(' + (COL[E.classFor(s.slot)] || COL.other) + ',.7)'; ctx.fillRect(x0, laneY, Math.max(1, x1 - x0 - (x1 - x0 > 3 ? 1 : 0)), laneH);
    if (E.isMine(s.slot)) { ctx.fillStyle = '#ffffff'; ctx.fillRect(x0, laneY - 3, Math.max(1, x1 - x0), 2); }
  }
  ctx.restore();                                                             // end of the clipped plot
  tags.push(['leader', laneY + laneH - 1]);
  ctx.fillStyle = '#8fa07e'; ctx.textAlign = 'left'; for (const [txt, yy] of tags) ctx.fillText(txt, padX, yy);
  /* time axis: one label per division, seconds before now; the unit once, at the left */
  ctx.fillStyle = '#6f7f60'; ctx.textAlign = 'center';
  const div = spanMs / 10, dec = Math.abs(div / 1000 - Math.round(div / 1000)) < 0.06 ? 0 : 1;   // one decimal only when a division is not a round second
  ctx.save(); ctx.strokeStyle = 'rgba(215,229,198,.09)'; ctx.setLineDash([1.5, 3.5]); ctx.beginPath();
  for (let i = 1; i < 10; i++) { const gx = Math.round(x(nowT - (10 - i) * div)) + .5; ctx.moveTo(gx, topH); ctx.lineTo(gx, plotBot + fs * .3); }
  ctx.stroke(); ctx.restore();   // the graticule sits on the divisions it labels
  for (let i = 1; i < 10; i++) ctx.fillText('−' + ((10 - i) * div / 1000).toFixed(dec) + (i === 1 ? ' s' : ''), x(nowT - (10 - i) * div), H - botH - 4);   // the unit once, on the first tick
  ctx.fillText('now', right, H - botH - 4);
  ctx.strokeStyle = 'rgba(215,229,198,.3)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(Math.round(right) + .5, topH); ctx.lineTo(Math.round(right) + .5, plotBot + fs * .3); ctx.stroke(); ctx.setLineDash([]);
  /* hover: the slot that was open at the hovered moment */
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
