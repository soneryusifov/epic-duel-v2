// EPIC DUEL relay server: serves the game and relays room messages over WebSocket (/ws).
// Game logic stays host-authoritative in the client; this server only forwards messages.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');

const srv = http.createServer((req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  fs.readFile(INDEX, (e, d) => {
    if (e) { res.statusCode = 500; return res.end('error'); }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(d);
  });
});

const wss = new WebSocketServer({ server: srv, path: '/ws', maxPayload: 16384 });
const rooms = new Map();
let nextId = 1;
const send = (w, o) => { if (w.readyState === 1) w.send(JSON.stringify(o)); };
const peerList = n => [...(rooms.get(n) || [])].map(w => ({ peer: w.id, presence: w.pres[n] || {} }));
const bcastPeers = n => { const l = peerList(n); (rooms.get(n) || new Set()).forEach(w => send(w, { t: 'peers', room: n, peers: l })); };
function leave(w, n) {
  const s = rooms.get(n);
  if (!s || !s.delete(w)) return;
  delete w.pres[n];
  if (!s.size) rooms.delete(n); else bcastPeers(n);
}

wss.on('connection', w => {
  w.id = 'p' + (nextId++); w.pres = {}; w.rooms = new Set(); w.tokens = 40; w.alive = true;
  send(w, { t: 'hi', id: w.id });
  w.on('pong', () => { w.alive = true; });
  const refill = setInterval(() => { w.tokens = Math.min(40, w.tokens + 20); }, 1000);
  w.on('message', b => {
    if (--w.tokens < 0) return; // simple rate limit
    let m; try { m = JSON.parse(b); } catch (e) { return; }
    if (!m || typeof m.room !== 'string' || m.room.length > 48) return;
    const n = m.room;
    if (m.t === 'join') {
      if (w.rooms.size >= 4 || w.rooms.has(n)) return;
      w.rooms.add(n);
      if (!rooms.has(n)) rooms.set(n, new Set());
      if (rooms.get(n).size >= 8) { w.rooms.delete(n); return; }
      rooms.get(n).add(w); bcastPeers(n);
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
// drop dead connections so disconnects are detected
setInterval(() => wss.clients.forEach(w => { if (!w.alive) return w.terminate(); w.alive = false; w.ping(); }), 15000);
srv.listen(PORT, '0.0.0.0', () => console.log('EPIC DUEL on :' + PORT));
