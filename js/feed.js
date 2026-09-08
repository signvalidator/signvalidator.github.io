// hz.ms — the probe. One WebSocket, no polling: slotsUpdatesSubscribe pushes every pipeline stage of every slot
// with a millisecond timestamp from the RPC node; accountSubscribe on the vote account pushes every landed vote.
// Falls back to slotSubscribe (client-side timestamps) if the richer method is unavailable. Reconnects for ever.
// The only HTTP calls are getEpochInfo and the SIMD-0525 slot-time gates (once per epoch) and getSlotLeaders
// (one 4000-slot chunk at a time, ahead of the roll).
const SILENCE_MS = 15000;     // open socket, no slot event for this long → reconnect (public RPC sockets go quiet)
const OPEN_MS = 8000;         // socket open, nothing ever arrived → reconnect (subscription silently failed)
const HIDDEN_MS = 30000;      // tab hidden for this long → close the socket; reconnect the moment it is visible again
const LEADERS_CHUNK = 4000, LEADERS_AHEAD = 1000, HTTP_RETRY_MS = 10000, RPC_TIMEOUT_MS = 12000;

export function openFeed(o) {
  // o: { rpc, ws, vote, clients, onEvent, onStatus } — rpc and ws may be lists: the next one is tried when one fails
  let closed = false;
  /* nothing leaves a closed feed: a reply that lands after close() must not reach the next source's engine */
  const emit = ev => { if (!closed) o.onEvent(ev); }, status = s => { if (!closed && o.onStatus) o.onStatus(s); };

  /* ---------- live ---------- */
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
  /* RPC-node clock minus ours. Network delay can only make a sample smaller, so track the maximum; a slow decay (1 ms/s) lets it follow drift. */
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
  /* The cluster's slot time is a protocol setting: SIMD-0525 lowers it in 50 ms steps, each behind a feature gate. A gate's
     account holds Option<u64> activated_at (1 tag byte + u64 LE); the step takes effect at the epoch after the activation slot.
     Read once per epoch. */
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
  /* leaders for [slot, slot + LEADERS_CHUNK), fetched ahead of the roll. Schedules exist for this epoch and the next only. */
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
