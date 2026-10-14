// EPIC DUEL server: static game + WebSocket room relay (/ws) + accounts (/api/*) + owner dashboard (/admin).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const POW = require('./power.js');
const RULES = require('./rules.js'); // per class: skill id -> [mana, cooldown, target kind] (generated from the game) // the SAME file the game page embeds: level curve, skill points and Power Rating are computed here, never taken from the client
let Pool = null; try { Pool = require('pg').Pool; } catch (e) {}
const PORT = process.env.PORT || 3000;
const ADMIN = process.env.ADMIN_KEY || '';
const SECRET = process.env.SESSION_SECRET || ADMIN || crypto.randomBytes(32).toString('hex');
const INDEX = path.join(__dirname, 'public', 'index.html');
const db = process.env.DATABASE_URL && Pool ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false }, max: 5 }) : null;
const DEF = { al: { dmg: 0, hp: 0, sh: 0, ls: 0, mp: 0, df: 0 }, own: { sword: [], pistol: [], bazooka: [] }, eq: { sword: -1, pistol: -1, bazooka: -1 }, gold: 0, w: 0, l: 0, xp: 0, cls: 'mage' };
const { levelOf, ptsOf, powerCalc, cleanUp } = POW;
const CLASSES = ['tank', 'warrior', 'mage', 'vampire', 'elf', 'support', 'assassin', 'ninja', 'engineer', 'paladin', 'dragon', 'necro', 'monk', 'pirate', 'chrono'];
const ALK = ['dmg', 'dx', 'hp', 'sh', 'ls', 'mp', 'df', 'dm'], GSL = ['helmet', 'armor', 'pauldron', 'gloves', 'cape', 'boots'], WK = ['sword', 'pistol', 'bazooka'];
const MODEN = { '1v1': [1, 1], '2v2': [2, 2], '3v3': [3, 3], '1v3': [1, 3], '1v4': [1, 4], '2v5': [2, 5] };
const zal = () => ({ dmg: 0, dx: 0, hp: 0, sh: 0, ls: 0, mp: 0, df: 0, dm: 0 });

async function initDb() {
  if (!db) { console.log('No DATABASE_URL: accounts disabled'); return; }
  await db.query(`create table if not exists players(id serial primary key, name text not null, pass text not null, data jsonb not null default '{}', created timestamptz not null default now(), seen timestamptz not null default now())`);
  await db.query('create unique index if not exists players_lname on players(lower(name))');
}

// ---- auth helpers ----
const b64 = b => Buffer.from(b).toString('base64url');
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const mkTok = u => { const p = b64(JSON.stringify({ id: u.id, name: u.name, exp: Date.now() + 30 * 864e5 })); return p + '.' + sign(p); };
function readTok(h) {
  const t = (h.authorization || '').replace(/^Bearer /, ''); const [p, s] = t.split('.'); if (!p || !s) return null;
  const a = Buffer.from(sign(p)), b = Buffer.from(s); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url')); return o.exp > Date.now() ? o : null; } catch (e) { return null; }
}
const hashPw = (p, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(p, salt, 32).toString('hex');
const checkPw = (p, st) => { const [s, h] = st.split(':'); const x = crypto.scryptSync(p, s, 32), y = Buffer.from(h, 'hex'); return y.length === x.length && crypto.timingSafeEqual(x, y); };

// ---- save-data validation ----
// Structure, ranges and skill-point budgets are enforced; XP/gold growth between two saves is rate-limited (see growth()).
// Gold and XP are still produced by the client (the match itself is not simulated on the server) - see README notes.
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const fitAl = (al0, cap) => { // validate one allocation; if it exceeds the budget, trim it (cheating gains nothing) instead of rejecting the save
  const al = zal(); let t = 0;
  for (const k of ALK) { const v = al0 && al0[k] === undefined ? 0 : al0 && al0[k]; if (!int(v, 0, 149)) return null; al[k] = v; t += v; }
  for (const k of ['df', 'dm', 'ls', 'mp', 'hp', 'dx', 'dmg', 'sh']) { if (t <= cap) break; const d = Math.min(al[k], t - cap); al[k] -= d; t -= d; }
  return al;
};
function clean(d, prev) {
  try {
    if (!d || typeof d !== 'object') return null;
    const cls = CLASSES.includes(d.cls) ? d.cls : 'mage', ch = {};
    const legacyXp = int(d.xp, 0, 1e9) ? d.xp : (d.w | 0) * 100 + (d.l | 0) * 25;
    for (const k of CLASSES) { // per-class characters (v15). Old saves have a single xp/al: it becomes the character of the selected class.
      let c = d.ch && d.ch[k], xp = 0, al0 = zal();
      if (c) { if (!int(c.xp, 0, 1e9)) return null; xp = c.xp; al0 = c.al; } else if (!d.ch && k === cls) { xp = legacyXp; al0 = d.al; }
      const al = fitAl(al0, ptsOf(levelOf(xp))); if (!al) return null; ch[k] = { xp, al };
    }
    const own = {}, eq = {};
    for (const k of WK) {
      if (!d.own || !Array.isArray(d.own[k])) return null;
      own[k] = [...new Set(d.own[k].filter(i => int(i, 0, 9)))];
      if (!d.eq || !int(d.eq[k], -1, 9)) return null;
      eq[k] = d.eq[k] === -1 || own[k].includes(d.eq[k]) ? d.eq[k] : -1;
    }
    const gr = { own: {}, eq: {} }; // cosmetic gear: 6 slots x 10 designs
    for (const k of GSL) {
      const go = d.gr && d.gr.own && Array.isArray(d.gr.own[k]) ? [...new Set(d.gr.own[k].filter(i => int(i, 0, 9)))] : [];
      const ge = d.gr && d.gr.eq && int(d.gr.eq[k], -1, 9) ? d.gr.eq[k] : -1;
      gr.own[k] = go; gr.eq[k] = ge === -1 || go.includes(ge) ? ge : -1;
    }
    if (!int(d.gold, 0, 1e9) || !int(d.w, 0, 1e6) || !int(d.l, 0, 1e6)) return null;
    const out = { ch, chm: 1, up: cleanUp(d.up), own, eq, gr, g5: d.g5 === 1 ? 1 : 0, gold: d.gold, w: d.w, l: d.l, cls, xp: ch[cls].xp, al: ch[cls].al, wm: d.wm && typeof d.wm === 'object' ? { pistol: d.wm.pistol ? 1 : 0, bazooka: d.wm.bazooka ? 1 : 0 } : { pistol: 0, bazooka: 0 } };
    return prev ? growth(out, prev) : out;
  } catch (e) { return null; }
}
// Anti-inflation: between two saves a character may gain at most XP_BASE + XP_RATE/s of XP, and gold at most G_BASE + G_RATE/s
// (a real match yields ~30-250 XP and ~30-125 gold, minutes apart). Excess is clamped to the previous value + allowance.
const XP_BASE = 900, XP_RATE = 8, G_BASE = 3000, G_RATE = 15;
function growth(n, p) {
  if (!p || !p.ch || !p.seen) return n;
  const dt = Math.max(0, (Date.now() - p.seen) / 1000), ax = XP_BASE + XP_RATE * dt, ag = G_BASE + G_RATE * dt;
  for (const k of CLASSES) { const po = p.ch[k] ? p.ch[k].xp : 0; if (n.ch[k].xp > po + ax) { n.ch[k].xp = Math.floor(po + ax); n.ch[k].al = fitAl(n.ch[k].al, ptsOf(levelOf(n.ch[k].xp))); } }
  if (n.gold > (p.gold | 0) + ag) n.gold = Math.floor((p.gold | 0) + ag);
  n.xp = n.ch[n.cls].xp; n.al = n.ch[n.cls].al; return n;
}

// ---- http ----
const body = req => new Promise(res => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 32768) { req.destroy(); res(null); } });
  req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch (e) { res(null); } });
});
const J = (r, c, o) => { r.statusCode = c; r.setHeader('Content-Type', 'application/json'); r.end(JSON.stringify(o)); };
const hits = new Map(); setInterval(() => hits.clear(), 60000);
const limited = req => { const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > 12; };

async function api(req, res, u) {
  if (!db) return J(res, 503, { error: 'Accounts are not configured on this server.' });
  const p = u.pathname;
  if (p === '/api/me' && req.method === 'GET') {
    const t = readTok(req.headers); if (!t) return J(res, 401, { error: 'login' });
    const r = await db.query('select name,data from players where id=$1', [t.id]);
    if (!r.rows[0]) return J(res, 401, { error: 'login' });
    return J(res, 200, { name: r.rows[0].name, data: r.rows[0].data });
  }
  if (req.method !== 'POST') return J(res, 405, { error: 'method' });
  const b = await body(req); if (!b) return J(res, 400, { error: 'bad request' });
  if (p === '/api/save') {
    const t = readTok(req.headers); if (!t) return J(res, 401, { error: 'login' });
    const r0 = await db.query('select data,seen from players where id=$1', [t.id]); const pr = r0.rows[0];
    let prev = null; if (pr && pr.data && pr.data.ch) prev = { ch: pr.data.ch, gold: pr.data.gold, seen: new Date(pr.seen).getTime() };
    const d = clean(b.data, prev); if (!d) return J(res, 400, { error: 'bad data' });
    await db.query('update players set data=$2, seen=now() where id=$1', [t.id, d]);
    return J(res, 200, { ok: 1 });
  }
  if (p === '/api/register' || p === '/api/login') {
    if (limited(req)) return J(res, 429, { error: 'Too many attempts, wait a minute.' });
    const name = String(b.name || ''), pass = String(b.pass || '');
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return J(res, 400, { error: 'Username: 3-16 letters, numbers or _' });
    if (pass.length < 6 || pass.length > 64) return J(res, 400, { error: 'Password must be 6-64 characters.' });
    if (p === '/api/register') {
      const d = clean(b.data) || clean(DEF); // a brand-new account always starts from a complete, validated save (so XP/gold growth limits apply from the first save)
      try {
        const r = await db.query('insert into players(name,pass,data) values($1,$2,$3) returning id,name', [name, hashPw(pass), d]);
        return J(res, 200, { token: mkTok(r.rows[0]), name, data: d });
      } catch (e) { return e.code === '23505' ? J(res, 409, { error: 'That username is taken.' }) : J(res, 500, { error: 'server error' }); }
    }
    const r = await db.query('select id,name,pass,data from players where lower(name)=lower($1)', [name]); const row = r.rows[0];
    if (!row || !checkPw(pass, row.pass)) return J(res, 401, { error: 'Wrong username or password.' });
    await db.query('update players set seen=now() where id=$1', [row.id]);
    return J(res, 200, { token: mkTok(row), name: row.name, data: row.data });
  }
  J(res, 404, { error: 'not found' });
}

async function admin(req, res, u) {
  const k = u.searchParams.get('key') || '';
  const ok = ADMIN && k.length === ADMIN.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN));
  if (!ok) { res.statusCode = 403; return res.end('Forbidden'); }
  let rows = [], tot = 0;
  if (db) { rows = (await db.query('select name,data,seen from players order by seen desc limit 500')).rows; tot = (await db.query('select count(*) from players')).rows[0].count; }
  const esc = s => String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
  const tr = rows.map(r => { const d = r.data || {}, e = d.eq || {};
    return `<tr><td>${esc(r.name)}</td><td>${esc(d.cls || 'mage')}</td><td>${levelOf(d.ch && d.ch[d.cls || 'mage'] ? d.ch[d.cls || 'mage'].xp : Number.isInteger(d.xp) ? d.xp : (d.w || 0) * 100 + (d.l || 0) * 25)}</td><td>${esc(d.gold ?? '')}</td><td>${d.w || 0}/${d.l || 0}</td><td>${['sword', 'pistol', 'bazooka'].map(x => x + ' ' + ((e[x] ?? -1) < 0 ? 'std' : 'T' + (e[x] + 1))).join(', ')}</td><td>${esc(new Date(r.seen).toISOString().slice(0, 16).replace('T', ' '))}</td></tr>`; }).join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>EPIC DUEL admin</title><style>body{font:14px system-ui;background:#0b1128;color:#e6f6ff;padding:12px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #2a3b66;padding:6px;text-align:left}</style><h2>EPIC DUEL admin</h2><p>Connected now: <b>${wss.clients.size}</b> &middot; Registered players: <b>${tot}</b></p><table><tr><th>Name</th><th>Class</th><th>Level</th><th>Gold</th><th>W/L</th><th>Equipment</th><th>Last seen (UTC)</th></tr>${tr}</table>`);
}

const srv = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/health') return res.end('ok');
    if (u.pathname === '/admin') return await admin(req, res, u);
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    fs.readFile(INDEX, (e, d) => {
      if (e) { res.statusCode = 500; return res.end('error'); }
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(d);
    });
  } catch (e) { console.error(e); if (!res.headersSent) J(res, 500, { error: 'server error' }); }
});

// ---- account-backed checks (the socket may announce a login token with {t:'auth'}; guests without one are only checked against the generic rules) ----
async function acct(w) {
  if (!db || !w.uid) return null;
  if (w.acc && Date.now() - w.acc.t < 3000) return w.acc.d;
  const r = await db.query('select data from players where id=$1', [w.uid]); const d = r.rows[0] ? r.rows[0].data : null;
  w.acc = { t: Date.now(), d }; return d;
}
// A fighter's build must be affordable for the account: level of that class' character, skill-point budget of that level, owned weapons/gear, upgrade levels.
function specAcct(s, d) {
  if (!d || !d.ch || !d.ch[s.cls]) return 'unknown character';
  const L = levelOf(d.ch[s.cls].xp);
  if (s.lv > L) return 'level ' + s.lv + ' is higher than your ' + s.cls + ' level ' + L;
  let t = 0; for (const k of ALK) t += s.al[k]; if (t > ptsOf(L)) return 'too many skill points for level ' + L;
  for (const k of WK) { const o = d.own && d.own[k]; if (s.wt[k] !== -1 && !(Array.isArray(o) && o.includes(s.wt[k]))) return 'weapon not owned'; }
  if (s.gr) for (const k of GSL) { const o = d.gr && d.gr.own && d.gr.own[k]; if (s.gr[k] !== -1 && !(Array.isArray(o) && o.includes(s.gr[k]))) return 'gear not owned'; }
  const au = cleanUp(d.up); if (s.up) for (const k of WK) for (let i = 0; i < 3; i++) if (s.up[k][i] > au[k][i]) return 'upgrade level too high';
  return null;
}
const canon = o => JSON.stringify(o, (k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v);
const rspec = new Map(); // room -> { peerId: validated spec }
// ---- WebSocket room relay + battle-message validation ----
// The duel itself is still host-authoritative (the host's browser runs the combat engine and the guest replays it).
// The server now (a) computes the Power Rating itself, (b) validates every payload shape, (c) enforces roles and turn order for
// 'act' messages. It does NOT re-simulate combat; a modified HOST client could still cheat inside its own room (see README).
const wss = new WebSocketServer({ server: srv, path: '/ws', maxPayload: 16384 });
const rooms = new Map(); let nextId = 1;
const send = (w, o) => { if (w.held) { if (w.q && w.q.length < 400) w.q.push(o); } else if (w.readyState === 1) w.send(JSON.stringify(o)); };
const bySid = new Map(), HOLD = +process.env.EDHOLD || 35000; // session id -> newest socket; a dropped duellist keeps its seat for HOLD ms
const peerList = n => [...(rooms.get(n) || [])].map(w => ({ peer: w.id, presence: w.pres[n] || {} }));
const bcastPeers = n => { const l = peerList(n); (rooms.get(n) || new Set()).forEach(w => send(w, { t: 'peers', room: n, peers: l })); };
const early = new Map(), bat = new Map(); // room -> { host, roles:[...], mode, cur:-1, turnOpen:false, n:0 }
function leave(w, n) { const s = rooms.get(n); if (!s || !s.delete(w)) return; delete w.pres[n]; const b = bat.get(n); if (b && (b.host === w.id || b.guest === w.id)) bat.delete(n); if (!s.size) { rooms.delete(n); bat.delete(n); early.delete(n); rspec.delete(n); } else bcastPeers(n); }

const isObj = o => o && typeof o === 'object' && !Array.isArray(o);
const specOk = s => { // same rules as the game's okSpec, plus the skill-point budget for the claimed level
  if (!isObj(s) || !isObj(s.al) || !isObj(s.wt)) return false;
  if (!int(s.lv, 1, 100) || !CLASSES.includes(s.cls)) return false;
  let t = 0; for (const k of ALK) { const v = s.al[k]; if (!int(v, 0, 149)) return false; t += v; }
  if (t > ptsOf(s.lv)) return false;
  if (!WK.every(k => int(s.wt[k], -1, 9))) return false;
  if (s.gr !== undefined && !(isObj(s.gr) && GSL.every(k => int(s.gr[k], -1, 9)))) return false;
  if (s.up !== undefined && !(isObj(s.up) && WK.every(k => Array.isArray(s.up[k]) && s.up[k].length === 3 && s.up[k].every(v => int(v, 0, POW.UPM))))) return false;
  return true;
};
const specPw = s => powerCalc({ cls: s.cls, al: s.al, wt: s.wt, gr: s.gr, up: s.up });
function presOk(p) { // the lobby card: server computes the rating from the validated build and overwrites whatever the client sent
  if (!isObj(p.a) || !CLASSES.includes(p.c) || !Array.isArray(p.g) || p.g.length !== 6 || !p.g.every(v => int(v, -1, 9)) || !Array.isArray(p.w) || p.w.length !== 3 || !p.w.every(v => int(v, -1, 9)) || !Array.isArray(p.u) || p.u.length !== 9 || !p.u.every(v => int(v, 0, POW.UPM))) return false;
  let t = 0; for (const k of ALK) { const v = p.a[k] === undefined ? 0 : p.a[k]; if (!int(v, 0, 149)) return false; t += v; }
  if (t > ptsOf(100)) return false;
  return true;
}
function stampPres(p) {
  if (!presOk(p)) { p.pw = 0; p.bad = 1; return; }
  delete p.bad;
  const gr = {}; GSL.forEach((k, i) => gr[k] = p.g[i]); const up = {}; WK.forEach((k, i) => up[k] = p.u.slice(i * 3, i * 3 + 3));
  const wt = { sword: p.w[0], pistol: p.w[1], bazooka: p.w[2] };
  p.pw = Math.min(99999, powerCalc({ cls: p.c, al: p.a, wt, gr, up }));
  if (!int(p.l, 1, 100)) p.l = 1; // the level shown is capped to the legal range (exact level is not in the presence packet)
}
const rej = (w, room, topic, why) => { send(w, { t: 'rej', room, topic, why }); };
const TOPICS = new Set(['hello', 'setup', 'spec', 'ready', 'start', 'turn', 'play', 'act', 'forfeit', 'chal', 'cncl', 'decl']);
// returns the (possibly rewritten) data or undefined to drop the message
async function checkEmit(w, n, m) {
  const t = m.topic, d = m.data, b = bat.get(n);
  switch (t) {
    case 'hello': case 'ready': case 'forfeit': return isObj(d) || d === undefined ? (d || {}) : undefined;
    case 'setup': return isObj(d) && d.mode in MODEN && (d.side === 'ally' || d.side === 'enemy') ? { mode: d.mode, side: d.side } : undefined;
    case 'chal': case 'cncl': case 'decl': return isObj(d) && JSON.stringify(d).length < 400 ? d : undefined;
    case 'spec': {
      if (!specOk(d)) return rej(w, n, 'spec', 'invalid build');
      const why = specAcct(d, await acct(w)); if (w.uid && db && why) return rej(w, n, 'spec', why);
      const o = Object.assign({}, d, { pw: specPw(d) }); const rs = rspec.get(n) || {}; rs[w.id] = canon(Object.assign({}, d)); rspec.set(n, rs); return o;
    }
    case 'start': { // host announces the roster; validated incl. team sizes of the asymmetric modes and every fighter's budget
      if (!isObj(d) || !Array.isArray(d.s) || !Array.isArray(d.t) || !Array.isArray(d.r) || !(d.mode in MODEN)) return;
      const k = d.s.length; if (k < 2 || k > 7 || d.t.length !== k || d.r.length !== k) return;
      if (!d.s.every(specOk) || !d.t.every(x => x === 0 || x === 1) || !d.r.every(x => x === 'h' || x === 'g' || x === 'a')) return;
      if (d.r.filter(x => x === 'h').length !== 1 || d.r.filter(x => x === 'g').length !== 1) return;
      if (d.t.filter(x => x === 0).length !== MODEN[d.mode][0] || d.t.filter(x => x === 1).length !== MODEN[d.mode][1]) return;
      if (b && b.host !== w.id) return; // only the room's host may (re)announce the match
      { // the guest's build must be exactly the one the guest sent (and the server validated); the host's own build is checked against the host's account
        const gi = d.r.indexOf('g'), hi = d.r.indexOf('h'), rs = rspec.get(n) || {}, other = [...(rooms.get(n) || [])].find(x => x !== w);
        const gs = Object.assign({}, d.s[gi]); delete gs.pw;
        if (!other || rs[other.id] !== canon(gs)) return rej(w, n, 'start', 'guest build does not match what the guest sent');
        const why = specAcct(d.s[hi], await acct(w)); if (w.uid && db && why) return rej(w, n, 'start', why);
      }
      const nb = { host: w.id, guest: null, roles: d.r.slice(), mode: d.mode, cur: -1, open: false, n: 0, cls: d.s.map(x => x.cls), team: d.t.slice(), snap: null };
      const st = early.get(n); early.delete(n); // the host's engine emits turn #1 a few ms before 'start': apply it now
      if (st && st.host === w.id && int(st.i, 0, k - 1)) { nb.cur = st.i; nb.n = st.n; nb.snap = st.s; nb.open = nb.roles[st.i] === 'g'; }
      bat.set(n, nb); return d;
    }
    case 'turn': { // host: a new fighter's turn begins (snapshot attached). Opens exactly one guest action for guest-controlled fighters.
      if (!b && isObj(d) && int(d.i, 0, 6) && int(d.n, 0, 1e6)) { early.set(n, { host: w.id, i: d.i, n: d.n, s: Array.isArray(d.s) ? d.s : null }); return; }
      if (!b || b.host !== w.id || !isObj(d) || !int(d.i, 0, b.roles.length - 1) || !int(d.n, 0, 1e6) || !Array.isArray(d.s) || d.s.length !== b.roles.length) return;
      b.cur = d.i; b.n = d.n; b.snap = d.s; b.open = b.roles[d.i] === 'g'; return d;
    }
    case 'play': { // host: the result of one action, with the RNG log. Closes the turn.
      if (!b || b.host !== w.id || !isObj(d) || !int(d.a, 0, b.roles.length - 1) || !int(d.n, 0, 1e6)) return;
      b.open = false; return d;
    }
    case 'act': { // guest -> host: choose a skill. Only from the non-host peer, only on the guest fighter's turn, once per turn.
      if (!b || b.host === w.id || !b.open || b.roles[b.cur] !== 'g') return;
      if (!isObj(d) || typeof d.id !== 'string' || !/^[a-z0-9_]{1,16}$/.test(d.id) || !int(d.tg, -1, b.roles.length - 1) || (d.m !== undefined && d.m !== 0 && d.m !== 1)) return;
      { // the skill must belong to the fighter's class, and the host's own snapshot of that fighter must allow it (alive, mana, cooldown, ammo, legal target)
        const rule = (RULES[b.cls[b.cur]] || {})[d.id]; if (!rule) return rej(w, n, 'act', 'skill not available to this class');
        const row = b.snap && b.snap[b.cur];
        if (row) {
          if (!row[5]) return rej(w, n, 'act', 'fighter is down');
          if (row[2] < rule[0]) return rej(w, n, 'act', 'not enough mana');
          if ((row[13] && row[13][d.id] > 0) || (d.id === 'pistol' && row[3] > 0) || (d.id === 'bazooka' && row[4] > 0)) return rej(w, n, 'act', 'skill on cooldown');
          if ((d.id === 'pistol' && row[7] <= 0) || (d.id === 'bazooka' && row[8] <= 0)) return rej(w, n, 'act', 'out of ammo');
          const tr = b.snap[d.tg];
          if (rule[2] === 'one' && !(d.tg >= 0 && tr && tr[5] && b.team[d.tg] !== b.team[b.cur])) return rej(w, n, 'act', 'target must be a living enemy');
          if (rule[2] === 'revive' && !(d.tg >= 0 && tr && !tr[5] && b.team[d.tg] === b.team[b.cur])) return rej(w, n, 'act', 'target must be a fallen ally');
        }
      }
      b.open = false; b.guest = w.id; return { id: d.id, tg: d.tg, m: d.m ? 1 : 0 };
    }
  }
}
async function handle(w, m) {
  if (m.t === 'sid') { // a client announces its stable session id: if an older socket of the same session exists (dropped or zombie), take over its identity, rooms and queued messages
    if (typeof m.sid !== 'string' || !/^[a-z0-9]{8,40}$/.test(m.sid)) return;
    const old = bySid.get(m.sid); bySid.set(m.sid, w); w.sid = m.sid;
    if (old && old !== w) {
      clearTimeout(old.holdT); w.id = old.id; w.pres = old.pres; const rs = [...old.rooms]; old.rooms = new Set(); const q = old.q || []; old.q = null; old.held = false;
      try { old.terminate(); } catch (e) {}
      send(w, { t: 'hi', id: w.id });
      rs.forEach(n => { const set = rooms.get(n); if (set) { set.delete(old); set.add(w); } w.rooms.add(n); });
      q.forEach(o => send(w, o));
      rs.forEach(n => { (rooms.get(n) || new Set()).forEach(x => x !== w && send(x, { t: 'back', room: n, peer: w.id })); bcastPeers(n); });
    }
    return;
  }
  if (m.t === 'auth') { const t = typeof m.token === 'string' && m.token.length < 600 ? readTok({ authorization: 'Bearer ' + m.token }) : null; w.uid = t ? t.id : null; w.acc = null; return; }
  if (typeof m.room !== 'string' || m.room.length > 48) return;
  const n = m.room;
  if (m.t === 'join') {
    if (w.rooms.size >= 4 || w.rooms.has(n)) return;
    if (!rooms.has(n)) rooms.set(n, new Set());
    if (rooms.get(n).size >= (n === 'lobby' ? 200 : 2)) return; // duel rooms hold exactly the two duellists
    w.rooms.add(n); rooms.get(n).add(w); bcastPeers(n);
  } else if (!w.rooms.has(n)) return;
  else if (m.t === 'leave') { w.rooms.delete(n); leave(w, n); }
  else if (m.t === 'pres' && isObj(m.patch)) {
    const p = w.pres[n] || (w.pres[n] = {});
    for (const k in m.patch) { if (m.patch[k] === null) delete p[k]; else p[k] = m.patch[k]; }
    if (JSON.stringify(p).length > 2048) { delete w.pres[n]; return; }
    if (p.c !== undefined || p.pw !== undefined) stampPres(p);
    bcastPeers(n);
  } else if (m.t === 'emit' && typeof m.topic === 'string' && TOPICS.has(m.topic)) {
    const data = await checkEmit(w, n, m); if (data === undefined) { if (process.env.EDDEBUG) console.log('DROP', m.topic, JSON.stringify(m.data).slice(0, 200)); return; }
    if (!rooms.has(n) || !rooms.get(n).has(w)) return;
    const o = { t: 'msg', room: n, topic: m.topic, data, peer: w.id };
    rooms.get(n).forEach(x => send(x, o));
  }
}
wss.on('connection', w => {
  w.id = 'p' + (nextId++); w.pres = {}; w.rooms = new Set(); w.tokens = 40; w.alive = true;
  send(w, { t: 'hi', id: w.id });
  w.on('pong', () => { w.alive = true; });
  const refill = setInterval(() => { w.tokens = Math.min(40, w.tokens + 20); }, 1000);
  w.on('message', b => {
    if (--w.tokens < 0) return;
    let m; try { m = JSON.parse(b); } catch (e) { return; }
    if (!isObj(m)) return;
    w.chain = (w.chain || Promise.resolve()).then(() => handle(w, m)).catch(e => console.error('ws', e.message)); // per-socket FIFO: async account checks never reorder messages
  });
  w.on('close', () => {
    clearInterval(refill);
    if (w.sid && bySid.get(w.sid) !== w) return; // a newer socket of this session already took over
    const live = [...w.rooms].filter(n => n !== 'lobby' && bat.has(n));
    if (w.sid && live.length) { // a duel is running: keep the seat for HOLD ms so a short network drop does not end the match
      [...w.rooms].forEach(n => { if (!live.includes(n)) leave(w, n); });
      w.rooms = new Set(live); w.held = true; w.q = [];
      live.forEach(n => (rooms.get(n) || new Set()).forEach(x => x !== w && send(x, { t: 'away', room: n, peer: w.id })));
      w.holdT = setTimeout(() => { if (bySid.get(w.sid) === w) bySid.delete(w.sid); w.held = false; [...w.rooms].forEach(n => leave(w, n)); }, HOLD);
    } else { if (w.sid && bySid.get(w.sid) === w) bySid.delete(w.sid); [...w.rooms].forEach(n => leave(w, n)); }
  });
});
setInterval(() => wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; w.ping(); }), 15000);

initDb().catch(e => console.error('db init failed', e.message)).finally(() => srv.listen(PORT, '0.0.0.0', () => console.log('EPIC DUEL on :' + PORT)));
