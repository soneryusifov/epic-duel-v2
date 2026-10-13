// EPIC DUEL server: static game + WebSocket room relay (/ws) + accounts (/api/*) + owner dashboard (/admin).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
let Pool = null; try { Pool = require('pg').Pool; } catch (e) {}
const PORT = process.env.PORT || 3000;
const ADMIN = process.env.ADMIN_KEY || '';
const SECRET = process.env.SESSION_SECRET || ADMIN || crypto.randomBytes(32).toString('hex');
const INDEX = path.join(__dirname, 'public', 'index.html');
const db = process.env.DATABASE_URL && Pool ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 }) : null;
const DEF = { al: { dmg: 0, hp: 0, sh: 0, ls: 0, mp: 0, df: 0 }, own: { sword: [], pistol: [], bazooka: [] }, eq: { sword: -1, pistol: -1, bazooka: -1 }, gold: 500, w: 0, l: 0, cls: 'mage' };

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

// ---- save-data validation (structure and ranges only; gold is still client-reported) ----
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
function clean(d) {
  try {
    const al = {}; let t = 0;
    for (const k of ['dmg', 'hp', 'sh', 'ls', 'mp', 'df', 'dm']) { const v = d.al[k] === undefined && (k === 'dm') ? 0 : d.al[k]; if (!int(v, 0, 30)) return null; al[k] = v; t += v; }
    if (t > 30) return null;
    const own = {}, eq = {};
    for (const k of ['sword', 'pistol', 'bazooka']) {
      if (!Array.isArray(d.own[k])) return null;
      own[k] = [...new Set(d.own[k].filter(i => int(i, 0, 9)))];
      if (!int(d.eq[k], -1, 9)) return null;
      eq[k] = d.eq[k] === -1 || own[k].includes(d.eq[k]) ? d.eq[k] : -1;
    }
    // cosmetic gear: 6 slots x 5 designs
    const gr = { own: {}, eq: {} };
    for (const k of ['helmet', 'armor', 'pauldron', 'gloves', 'cape', 'boots']) {
      const go = d.gr && d.gr.own && Array.isArray(d.gr.own[k]) ? [...new Set(d.gr.own[k].filter(i => int(i, 0, 4)))] : [];
      const ge = d.gr && d.gr.eq && int(d.gr.eq[k], -1, 4) ? d.gr.eq[k] : -1;
      gr.own[k] = go; gr.eq[k] = ge === -1 || go.includes(ge) ? ge : -1;
    }
    if (!int(d.gold, 0, 1e9) || !int(d.w, 0, 1e6) || !int(d.l, 0, 1e6)) return null;
    return { al, own, eq, gr, g5: d.g5 === 1 ? 1 : 0, gold: d.gold, w: d.w, l: d.l, cls: ['tank', 'vampire', 'mage', 'warrior'].includes(d.cls) ? d.cls : 'mage' };
  } catch (e) { return null; }
}

// ---- http ----
const body = req => new Promise(res => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 8192) { req.destroy(); res(null); } });
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
    const d = clean(b.data); if (!d) return J(res, 400, { error: 'bad data' });
    await db.query('update players set data=$2, seen=now() where id=$1', [t.id, d]);
    return J(res, 200, { ok: 1 });
  }
  if (p === '/api/register' || p === '/api/login') {
    if (limited(req)) return J(res, 429, { error: 'Too many attempts, wait a minute.' });
    const name = String(b.name || ''), pass = String(b.pass || '');
    if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return J(res, 400, { error: 'Username: 3-16 letters, numbers or _' });
    if (pass.length < 6 || pass.length > 64) return J(res, 400, { error: 'Password must be 6-64 characters.' });
    if (p === '/api/register') {
      const d = clean(b.data) || DEF;
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
    return `<tr><td>${esc(r.name)}</td><td>${esc(d.cls || 'mage')}</td><td>${1 + Math.floor((d.w || 0) / 2)}</td><td>${esc(d.gold ?? '')}</td><td>${d.w || 0}/${d.l || 0}</td><td>${['sword', 'pistol', 'bazooka'].map(x => x + ' ' + ((e[x] ?? -1) < 0 ? 'std' : 'T' + (e[x] + 1))).join(', ')}</td><td>${esc(new Date(r.seen).toISOString().slice(0, 16).replace('T', ' '))}</td></tr>`; }).join('');
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

// ---- WebSocket room relay (unchanged protocol) ----
const wss = new WebSocketServer({ server: srv, path: '/ws', maxPayload: 16384 });
const rooms = new Map(); let nextId = 1;
const send = (w, o) => { if (w.readyState === 1) w.send(JSON.stringify(o)); };
const peerList = n => [...(rooms.get(n) || [])].map(w => ({ peer: w.id, presence: w.pres[n] || {} }));
const bcastPeers = n => { const l = peerList(n); (rooms.get(n) || new Set()).forEach(w => send(w, { t: 'peers', room: n, peers: l })); };
function leave(w, n) { const s = rooms.get(n); if (!s || !s.delete(w)) return; delete w.pres[n]; if (!s.size) rooms.delete(n); else bcastPeers(n); }
wss.on('connection', w => {
  w.id = 'p' + (nextId++); w.pres = {}; w.rooms = new Set(); w.tokens = 40; w.alive = true;
  send(w, { t: 'hi', id: w.id });
  w.on('pong', () => { w.alive = true; });
  const refill = setInterval(() => { w.tokens = Math.min(40, w.tokens + 20); }, 1000);
  w.on('message', b => {
    if (--w.tokens < 0) return;
    let m; try { m = JSON.parse(b); } catch (e) { return; }
    if (!m || typeof m.room !== 'string' || m.room.length > 48) return;
    const n = m.room;
    if (m.t === 'join') {
      if (w.rooms.size >= 4 || w.rooms.has(n)) return;
      if (!rooms.has(n)) rooms.set(n, new Set());
      if (rooms.get(n).size >= 200) return;
      w.rooms.add(n); rooms.get(n).add(w); bcastPeers(n);
    } else if (!w.rooms.has(n)) return;
    else if (m.t === 'leave') { w.rooms.delete(n); leave(w, n); }
    else if (m.t === 'pres' && m.patch && typeof m.patch === 'object') {
      const p = w.pres[n] || (w.pres[n] = {});
      for (const k in m.patch) { if (m.patch[k] === null) delete p[k]; else p[k] = m.patch[k]; }
      if (JSON.stringify(p).length > 2048) { delete w.pres[n]; return; }
      bcastPeers(n);
    } else if (m.t === 'emit' && typeof m.topic === 'string' && m.topic.length < 48) {
      const o = { t: 'msg', room: n, topic: m.topic, data: m.data, peer: w.id };
      rooms.get(n).forEach(x => send(x, o));
    }
  });
  w.on('close', () => { clearInterval(refill); [...w.rooms].forEach(n => leave(w, n)); });
});
setInterval(() => wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; w.ping(); }), 15000);

initDb().catch(e => console.error('db init failed', e.message)).finally(() => srv.listen(PORT, '0.0.0.0', () => console.log('EPIC DUEL on :' + PORT)));
