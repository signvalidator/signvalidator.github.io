#!/usr/bin/env python3
"""Build index.html and js/hz.js from index.tpl.html and the modules. Run tools/snapshot.py first (facts + client maps).

  index.html          the site (GitHub Pages): fetches css/site.css, js/hz.js (the bundle, one versioned URL), data/

Stdlib only. Paths are relative to this file, so it runs from anywhere."""
import json, os, re, sys, time

here = os.path.dirname(os.path.abspath(__file__)); site = os.path.normpath(os.path.join(here, '..'))
P = lambda *a: os.path.join(site, *a)
def read(*a):
    p = P(*a)
    if not os.path.exists(p): sys.exit('build: missing ' + os.path.relpath(p, site))
    return open(p, encoding='utf-8').read()
def load(*a): return json.loads(read(*a))
compact = lambda obj: json.dumps(obj, separators=(',', ':'))

cfg = load('data', 'config.json'); snap = load('data', 'snapshot.json'); tpl = read('index.tpl.html'); css = read('css', 'site.css')
V = str(int(time.time()))
NONE = '----'
MODULES = ['palette', 'signal', 'roll', 'feed', 'scope']   # dependency order: the bundle is one script

# ---------- the static strip: same markup as renderStrip() in js/scope.js, so first paint needs no script ----------
def fmt(n): return '{:,.0f}'.format(n).replace(',', ' ')
def fact(k, v, unit=''):
    if v is None: return '<div class="fact"><span class="k">%s</span><span class="v none">%s</span></div>' % (k, NONE)
    return '<div class="fact"><span class="k">%s</span><span class="v">%s%s</span></div>' % (k, v, ('<small>%s</small>' % unit) if unit else '')
def addr(label, v):
    if not v: return '<div class="addr"><span class="k">%s</span><span class="a none">not created yet</span></div>' % label
    return '<div class="addr"><span class="k">%s</span><span class="a"><code>%s</code><button class="cp" data-copy="%s" title="Copy">copy</button></span></div>' % (label, v, v)
default = cfg.get('defaultSource', 'testnet')
src = snap['sources'].get(default) or snap['sources']['testnet']
node = src.get('node') or {}
cr = src.get('credits') or []; last = cr[-2] if len(cr) > 1 else None
facts = fact('Commission', src.get('commission'), '%') + fact('Active stake', None if src.get('stake') is None else fmt(src['stake']), 'SOL')
facts += fact('Vote credits', ('%.1f' % (100 * last[1] / last[2])) if last and last[2] else None, '% of best')
facts += fact('Client', (node.get('client') or '') + (' ' + node['version'] if node.get('version') else '') if node.get('client') else None)
vote = src.get('vote')
addrs_html = addr('Identity', src['identity']) + addr('Vote account', vote)

# ---------- rendering ----------
def render(config, inline_snapshot=False):
    out = tpl.replace('__V__', V).replace('__CONFIG__', json.dumps(config)).replace('__FACTS__', facts).replace('__ADDRS__', addrs_html)
    tag = ('<script>window.HZ_SNAPSHOT = %s;</script>' % compact(snap)) if inline_snapshot else ''
    out = out.replace('__SNAPSHOT_TAG__', tag)
    left = sorted(set(re.findall(r'__[A-Z_]{2,}__', out)))
    if left: sys.exit('build: unreplaced placeholders in index.tpl.html: ' + ', '.join(left))
    return out

def bundle():
    parts = []
    for m in MODULES:
        s = read('js', m + '.js')
        s = re.sub(r'^import\s[^\n]*?\bfrom\s+[\'"][^\'"]+[\'"];?[ \t]*\n', '', s, flags=re.M)     # import { a } from './b.js';
        s = re.sub(r'^export\s*\{[^}]*\};?[ \t]*\n', '', s, flags=re.M)                            # export { a, b };
        s = re.sub(r'^export\s+(?=(?:const|let|var|function|async|class)\b)', '', s, flags=re.M)  # export const → const
        bad = re.search(r'^\s*(import|export)\b', s, flags=re.M)
        if bad: sys.exit('build: js/%s.js line %d: cannot bundle "%s"' % (m, s[:bad.start()].count('\n') + 1, bad.group(0).strip()))
        parts.append('/* ---- js/%s.js ---- */\n%s' % (m, s.strip('\n')))
    return '\n\n'.join(parts) + '\n'

def slim_js(j):
    """Comment-only lines and indentation dropped; code lines untouched (a trailing // inside a string stays safe)."""
    out, block = [], False
    for line in j.split('\n'):
        t = line.strip()
        if block:
            if '*/' in t: block = False
            continue
        if t.startswith('/*'):
            if '*/' not in t: block = True
            continue
        if not t or t.startswith('//'): continue
        out.append(t)
    return '\n'.join(out) + '\n'
def config_for():
    c = dict(cfg); c['v'] = V; return c

# ---------- outputs ----------
js = bundle()
outputs = []
def write(rel, text):
    with open(P(rel), 'w', encoding='utf-8') as f: f.write(text)
    outputs.append('%s (%d bytes)' % (rel, len(text.encode('utf-8'))))

clients = {k: load('data', 'clients-%s.json' % k) for k in cfg['clusters'] if os.path.exists(P('data', 'clients-%s.json' % k))}
site_doc = render(config_for(), inline_snapshot=True).replace('<script>window.HZ = ', '<script>window.HZ_CLIENTS = %s;</script>\n<script>window.HZ = ' % compact(clients), 1)
write('index.html', site_doc)
write(os.path.join('js', 'hz.js'), slim_js(js) + 'window.hzBoot = boot;\n')   # the bundle: one URL, one version

print('built ' + ', '.join(outputs))
