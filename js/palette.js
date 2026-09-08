// hz.ms — shared palette: client families and channel colours.
// Client families. Names come from getClusterNodes; an RPC node older than the client list reports newer ids as
// "Unknown(n)", so the numeric ids of agave's ClientId enum are mapped too (0 SolanaLabs, 1 JitoLabs, 2 Frankendancer,
// 3 Agave, 4 AgavePaladin, 5 Firedancer, 6 AgaveBam, 7 Sig, 8 Rakurai, 9 HarmonicFiredancer, 10 HarmonicAgave,
// 11 HarmonicFrankendancer, 12 FireBAM, 13 Raiku). Sig is its own client and stays "other".
const BY_ID = { 0: 'agave', 1: 'agave', 2: 'fd', 3: 'agave', 4: 'agave', 5: 'fd', 6: 'agave', 7: 'other', 8: 'agave', 9: 'fd', 10: 'agave', 11: 'fd', 12: 'fd', 13: 'agave' };
const LETTER = { a: 'agave', f: 'fd', o: 'other' };
export const classOf = id => { if (!id) return 'other'; if (LETTER[id]) return LETTER[id]; const m = /^Unknown\((\d+)\)$/.exec(id); if (m) return BY_ID[+m[1]] || 'other'; return /fire|franken/i.test(id) ? 'fd' : /agave|jito|harmonic|rakurai|raiku|solana|paladin|bam/i.test(id) ? 'agave' : 'other'; };
export const COL = { agave: '232,196,77', fd: '255,128,92', other: '150,156,164' };
export const CH2 = '79,195,227';
export let FONT = 'Plex, monospace';
export function setFont(f) { FONT = f; }   // the shell passes the page's --mono so canvas text matches the CSS
