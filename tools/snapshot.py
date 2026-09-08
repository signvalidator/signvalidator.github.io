#!/usr/bin/env python3
"""Regenerate the slow facts from the public RPC. Stdlib only. Run from anywhere: python3 tools/snapshot.py

Writes data/snapshot.json (per cluster: identity, vote account, stake, commission, credits, node, balance)
and data/clients-<cluster>.json (8-char node pubkey prefix → client family a/f/o; the leader colours depend on it).
Four RPC calls per cluster, nothing more. The page refreshes the vote account and balance itself, once a minute."""
import sys, re, json, time, urllib.request, datetime, os

HERE = os.path.dirname(os.path.abspath(__file__)); DATA = os.path.normpath(os.path.join(HERE, '..', 'data'))
CFG = json.load(open(os.path.join(DATA, 'config.json')))

CLIENT_IDS = {0: 'SolanaLabs', 1: 'JitoLabs', 2: 'Frankendancer', 3: 'Agave', 4: 'AgavePaladin', 5: 'Firedancer', 6: 'AgaveBam', 7: 'Sig', 8: 'Rakurai', 9: 'HarmonicFiredancer', 10: 'HarmonicAgave', 11: 'HarmonicFrankendancer', 12: 'FireBAM', 13: 'Raiku'}
def family(name):
    """a = Agave family, f = Firedancer family, o = other — mirrors classOf() in js/palette.js"""
    if re.search(r'fire|franken', name, re.I): return 'f'
    if re.search(r'agave|jito|harmonic|rakurai|raiku|solana|paladin|bam', name, re.I): return 'a'
    return 'o'
def client_name(c):
    """An RPC node older than the client list reports newer ids as Unknown(n); translate the known numbers."""
    if not c: return 'unknown'
    m = re.match(r'^Unknown\((\d+)\)$', c)
    return CLIENT_IDS.get(int(m.group(1)), c) if m else c
def rpc(url, method, params=None, retries=3):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or []}).encode()
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, body, {'content-type': 'application/json', 'user-agent': 'hz.ms-snapshot/1.0'})   # PublicNode rejects the default Python agent
            with urllib.request.urlopen(req, timeout=120) as r:
                j = json.load(r)
            if 'result' in j: time.sleep(0.6); return j['result']
            raise RuntimeError(j.get('error'))
        except Exception:
            if attempt == retries - 1: raise
            time.sleep(2 + attempt * 2)

def node_info(nodes, pk, extra):
    n = nodes.get(pk)
    if not n: return None
    return {'client': n.get('clientId'), 'version': n.get('version'), 'gossip': n.get('gossip'),
            'location': extra.get('location'), 'asn': extra.get('asn'),
            'shred': str(n.get('shredVersion')), 'featureSet': str(n.get('featureSet'))}

def source(url, identity, extra, nodes):
    out = {'identity': identity, 'vote': None, 'stake': None, 'commission': None, 'node': node_info(nodes, identity, extra), 'credits': [], 'epochVoteAccount': None}
    va = rpc(url, 'getVoteAccounts', [{'keepUnstakedDelinquents': True}])
    best = {}
    for v in va['current']:
        for e, c, p in v['epochCredits']: best[e] = max(best.get(e, 0), c - p)
    mine = [v for v in va['current'] + va['delinquent'] if v['nodePubkey'] == identity]
    if mine:
        v = mine[0]
        out.update({'vote': v['votePubkey'], 'stake': v['activatedStake'] / 1e9, 'commission': v['commission'],
                    'lastVote': v['lastVote'], 'epochVoteAccount': v['epochVoteAccount'],
                    'credits': [[e, c - p, best.get(e)] for e, c, p in v['epochCredits']]})
        out['balance'] = rpc(url, 'getBalance', [identity])['value'] / 1e9
    return out

def main():
    snap = {'generatedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'sources': {}}
    for cluster, c in CFG['clusters'].items():
        urls = c['rpc'] if isinstance(c['rpc'], list) else [c['rpc']]
        url = urls[0]
        for u in urls:   # the first endpoint that answers
            try: rpc(u, 'getEpochInfo', []); url = u; break
            except Exception as e: print('snapshot: %s unreachable (%s)' % (u, e), file=sys.stderr)
        nodes = {n['pubkey']: n for n in rpc(url, 'getClusterNodes')}
        with open(os.path.join(DATA, 'clients-%s.json' % cluster), 'w') as f:
            groups = {}
            for pk, n in nodes.items(): groups.setdefault(family(client_name(n.get('clientId'))), []).append(pk[:8])
            json.dump({k: ' '.join(sorted(v)) for k, v in sorted(groups.items())}, f, separators=(',', ':'))   # family letter → 8-char pubkey prefixes
        snap['sources'][cluster] = source(url, c['identity'], c.get('nodeExtra', {}), nodes)
    out = os.path.join(DATA, 'snapshot.json')
    with open(out, 'w') as f: json.dump(snap, f, separators=(',', ':'))
    print('wrote', out, os.path.getsize(out), 'bytes')

if __name__ == '__main__':
    main()
