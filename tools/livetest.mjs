// Drive headless Chromium over CDP against a page for a while: one JSON line of engine state per mark, a screenshot per mark.
//   node tools/livetest.mjs <url> <outdir> [marks=10,30,60,100] [tag=live]
// Prints {"t":10,...} per mark, {"console":...} for page console output, {"exception":...} for uncaught errors;
// exits 1 if the page threw, 2 if Chromium could not be driven.
import { spawn } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const [,, url, outdir, marksArg, tag = 'live'] = process.argv;
if (!url || !outdir) { console.error('usage: node tools/livetest.mjs <url> <outdir> [marks] [tag]'); process.exit(2); }
const marks = (marksArg || '10,30,60,100').split(',').map(Number).filter(n => n > 0).sort((a, b) => a - b);
fs.mkdirSync(outdir, { recursive: true });
const port = 9300 + Math.floor(Math.random() * 500), profile = path.join(os.tmpdir(), `hzms-cdp-${port}`);
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
let exceptions = 0, ws = null;
const out = obj => console.log(JSON.stringify(obj));
const quit = code => { try { ws && ws.close(); } catch (e) {} try { chrome.kill(); } catch (e) {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} process.exit(code); };
const hardStop = setTimeout(() => { out({ error: 'timeout' }); quit(2); }, (marks[marks.length - 1] + 45) * 1000);
try {
  let targets = null;
  for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch (e) { await new Promise(r => setTimeout(r, 300)); } }
  const page = targets && targets.find(t => t.type === 'page');
  if (!page) { out({ error: 'no page target' }); quit(2); }
  ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.consoleAPICalled') out({ console: m.params.type, msg: m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 300) });
    else if (m.method === 'Runtime.exceptionThrown') { exceptions++; out({ exception: m.params.exceptionDetails.text, detail: ((m.params.exceptionDetails.exception || {}).description || '').slice(0, 400) }); }
  };
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url }); const t0 = Date.now();
  const evalJS = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : JSON.stringify(r); };
  await new Promise(r => setTimeout(r, 4000));
  await evalJS(`window.__samp = []; setInterval(() => { const e = window.HZ_ENGINE; if (e) window.__samp.push([performance.now(), e.now()]); }, 50); 'ok'`);
  const STATE = `(() => { const e = window.HZ_ENGINE; if (!e) return JSON.stringify({ engine: false }); const r = e.recent(3000); let holes = 0; for (let i = 1; i < r.length; i++) if (r[i].slot !== r[i-1].slot + 1) holes++;
    const s = window.__samp || []; let negT = 0, maxdT = 0; for (let i = 1; i < s.length; i++) { const dt = s[i][1] - s[i-1][1]; if (dt < 0) negT++; if (dt > maxdT) maxdT = dt; } window.__samp = [];
    const q = sel => { const el = document.querySelector(sel); return el ? el.textContent.trim() : null; };
    return JSON.stringify({ slots: e.slots.size, withFs: r.length, first: r[0] && r[0].slot, last: e.lastSlot, holes, period: e.period(), lagMs: Math.round(e.now() - e.lastFs),
      status: q('#liveText'), vis: document.visibilityState, samples: s.length, negTime: negT, maxTimeStep: Math.round(maxdT),
      votes: r.filter(x => x.voteT !== null).length, conf: r.filter(x => x.conf !== null).length, frozen: r.filter(x => x.frozen !== null).length, completed: r.filter(x => x.completed !== null).length, dead: r.filter(x => x.dead !== null).length,
      leaders: e.leaders.size, clients: e.clients.size, epoch: e.epoch ? e.epoch.n : null,
      fonts: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family).filter((v, i, a) => a.indexOf(v) === i).join('|') }); })()`;
  for (const m of marks) {
    await new Promise(r => setTimeout(r, Math.max(0, t0 + m * 1000 - Date.now())));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result && shot.result.data) fs.writeFileSync(`${outdir}/${tag}-${m}s.png`, Buffer.from(shot.result.data, 'base64'));
    let st; try { st = JSON.parse(await evalJS(STATE)); } catch (e) { st = { parseError: String(e) }; }
    out({ t: m, ...st });
  }
} catch (e) { out({ error: String(e && e.message || e) }); quit(2); }
clearTimeout(hardStop);
quit(exceptions ? 1 : 0);
