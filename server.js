/*
  Radio Buoy 4.0 - IoT collector + live broadcaster
  - POST /api/ingest        base unit uploads JSON (header X-API-Key)
  - GET  /api/stream        Server-Sent Events: every upload is pushed to all open dashboards at once
  - GET  /api/latest        newest snapshot of every unit
  - GET  /api/history/:id   recent points of one unit  (?minutes=60)
  - GET  /api/alerts        recent SOS events
  - GET  /api/health
  - static dashboard from ./public
  Optional broadcast of NEW SOS events: Telegram and/or a webhook (see .env.example).
  Start:  npm install && IOT_KEY=your-key node server.js
*/
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const IOT_KEY = process.env.IOT_KEY || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const WEBHOOK = process.env.SOS_WEBHOOK_URL || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_POINTS = 4000;                    // history kept in memory per unit
const MAX_LOG_BYTES = 20 * 1024 * 1024;     // rotate the on-disk log at 20 MB
const BASE_OFFLINE_MS = 20000;

if (!IOT_KEY || IOT_KEY.startsWith('CHANGE-ME')) {
  console.error('Set IOT_KEY to a long random secret (same value as IOT_KEY in the base unit sketch).');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
const LOG = path.join(DATA_DIR, 'ingest.ndjson');

const units = new Map();        // id -> latest merged record
const history = new Map();      // id -> [{t, ...}]
const alerts = [];              // newest first
const clients = new Set();      // SSE connections
let base = null;                // newest base-unit record (self + toBuoy)
let baseSeen = 0;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

function keyOk(given) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(IOT_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v, n = 24) => (typeof v === 'string' ? v.slice(0, n) : undefined);

function cleanUnit(p, now, via) {
  return {
    id: num(p.id), role: str(p.role, 8), hops: num(p.hops), link: num(p.link),
    alive: !!p.alive, lastSeen: now - 1000 * (num(p.age) || 0), via,
    fix: !!p.fix, lat: num(p.lat), lon: num(p.lon), sats: num(p.sats),
    sos: !!p.sos, reason: str(p.reason, 16) || '', relay: !!p.relay,
    roll: num(p.roll), pitch: num(p.pitch), course: num(p.course), speed: num(p.speed),
    temp: num(p.temp), pres: num(p.pres), alt: num(p.alt), csq: num(p.csq), op: str(p.op, 10),
    heading: num(p.heading),
  };
}

function snapshot() {
  return {
    serverTime: Date.now(),
    base, baseSeen,
    units: [...units.values()].sort((a, b) => a.id - b.id),
  };
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

async function notifySos(u) {
  const where = u.fix ? `https://www.google.com/maps/search/?api=1&query=${u.lat},${u.lon}` : 'no GPS fix';
  let extra = '';
  if (base && base.toBuoy && base.toBuoy.id === u.id) extra = `\nFrom base: bearing ${base.toBuoy.brg}\u00b0, ${base.toBuoy.dist} m`;
  const text = `SOS from unit ${u.id} (${u.role || 'node'}): ${u.reason || 'alert'}\n${where}${extra}`;
  const jobs = [];
  if (TG_TOKEN && TG_CHAT) {
    jobs.push(fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: false }),
    }));
  }
  if (WEBHOOK) {
    jobs.push(fetch(WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'sos', unit: u, toBuoy: base && base.toBuoy, text, time: new Date().toISOString() }),
    }));
  }
  for (const r of await Promise.allSettled(jobs)) if (r.status === 'rejected') console.error('notify failed:', r.reason && r.reason.message);
}

function appendLog(line) {
  fs.appendFile(LOG, line + '\n', (err) => {
    if (err) return console.error('log write failed:', err.message);
    fs.stat(LOG, (e, st) => { if (!e && st.size > MAX_LOG_BYTES) fs.rename(LOG, LOG + '.' + Date.now(), () => {}); });
  });
}

app.post('/api/ingest', (req, res) => {
  if (!keyOk(req.get('X-API-Key'))) return res.status(401).json({ ok: false, error: 'bad key' });
  const b = req.body;
  if (!b || typeof b !== 'object' || !Array.isArray(b.peers) || typeof b.node !== 'number') {
    return res.status(400).json({ ok: false, error: 'bad payload' });
  }
  const now = Date.now();
  baseSeen = now;
  const self = b.self && typeof b.self === 'object' ? b.self : {};
  base = {
    node: b.node, uptime: num(b.uptime), rssi: num(b.rssi), heap: num(b.heap),
    toBuoy: b.toBuoy && typeof b.toBuoy === 'object' ? { id: num(b.toBuoy.id), brg: num(b.toBuoy.brg), dist: num(b.toBuoy.dist) } : null,
  };

  const incoming = [cleanUnit({ ...self, id: b.node, alive: true, age: 0, hops: 0, link: 100 }, now, b.node)];
  for (const p of b.peers.slice(0, 16)) if (num(p.id) !== undefined && p.id !== b.node) incoming.push(cleanUnit(p, now, b.node));

  for (const u of incoming) {
    const before = units.get(u.id);
    const merged = { ...(before || {}), ...Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined)) };
    if (before && before.lat !== undefined && u.lat === undefined) { merged.lat = before.lat; merged.lon = before.lon; } // keep last position
    merged.fix = u.fix;
    merged.sos = u.sos;
    units.set(u.id, merged);

    const h = history.get(u.id) || [];
    h.push({ t: now, lat: merged.lat, lon: merged.lon, temp: merged.temp, pres: merged.pres, alt: merged.alt, link: merged.link, sos: merged.sos, csq: merged.csq });
    if (h.length > MAX_POINTS) h.splice(0, h.length - MAX_POINTS);
    history.set(u.id, h);

    if (u.sos && !(before && before.sos)) {                       // NEW SOS
      const a = { t: now, id: u.id, role: u.role, reason: u.reason, lat: merged.lat, lon: merged.lon, toBuoy: base.toBuoy };
      alerts.unshift(a);
      if (alerts.length > 200) alerts.pop();
      broadcast('alert', a);
      notifySos(merged).catch((e) => console.error(e));
    }
  }
  appendLog(JSON.stringify({ t: now, ...b }));
  broadcast('update', snapshot());
  res.json({ ok: true });
});

app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`retry: 3000\nevent: update\ndata: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
setInterval(() => { for (const r of clients) r.write(': keepalive\n\n'); }, 20000);

app.get('/api/latest', (req, res) => res.json(snapshot()));
app.get('/api/alerts', (req, res) => res.json(alerts));
app.get('/api/history/:id', (req, res) => {
  const mins = Math.min(Math.max(Number(req.query.minutes) || 60, 1), 24 * 60);
  const since = Date.now() - mins * 60000;
  res.json((history.get(Number(req.params.id)) || []).filter((p) => p.t >= since));
});
app.get('/api/health', (req, res) => res.json({ ok: true, baseOnline: Date.now() - baseSeen < BASE_OFFLINE_MS, baseSeen, viewers: clients.size }));

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`Radio Buoy server on :${PORT}  (log: ${LOG})`));
