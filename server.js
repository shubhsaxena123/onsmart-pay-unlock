// OnSmart Pay-to-Unlock server
// - Serves the website (public/index.html)
// - ESP32 locks poll /api/lock/:id/poll to say "I'm online" and pick up unlock commands
// - Your phone's notification helper posts "Received ₹50.13" texts to /api/notify
// - Each payment session gets a unique amount (e.g. 50.13) so the payment can be matched to a lock

const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');

// ---------- CONFIG (set these as environment variables on your host) ----------
const PORT = process.env.PORT || 3000;
const UPI_ID = process.env.UPI_ID || '8273658351@ptsbi';
const PAYEE_NAME = process.env.PAYEE_NAME || 'OnSmart';
const NOTIFY_SECRET = process.env.NOTIFY_SECRET || 'change-me-notify';
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-admin';
// LOCKS format: "code:secret:baseAmount,code:secret:baseAmount"
const LOCKS_ENV = process.env.LOCKS || '5424:lock5424secret:50';
const ONLINE_WINDOW_MS = 15 * 1000;   // lock counts as online if it polled in the last 15 s
const SESSION_TTL_MS = 10 * 60 * 1000; // a payment session is valid for 10 minutes
// -------------------------------------------------------------------------------

const locks = {};
for (const entry of LOCKS_ENV.split(',')) {
  const [id, secret, base] = entry.trim().split(':');
  if (id && secret) locks[id] = { id, secret, base: Number(base || 50), lastSeen: 0, pendingUnlock: null };
}

const sessions = {}; // sessionId -> { id, lockId, amount, status, createdAt, paidAt, payer }

function isOnline(lock) { return Date.now() - lock.lastSeen < ONLINE_WINDOW_MS; }

function expireOld() {
  const now = Date.now();
  for (const s of Object.values(sessions)) {
    if (s.status === 'pending' && now - s.createdAt > SESSION_TTL_MS) s.status = 'expired';
  }
}

// Pick a unique amount like 50.13 that no other pending session is using
function uniqueAmount(base) {
  const used = new Set(Object.values(sessions).filter(s => s.status === 'pending').map(s => s.amount));
  const options = [];
  for (let p = 1; p <= 99; p++) {
    const amt = (Math.floor(base) + p / 100).toFixed(2);
    if (!used.has(amt)) options.push(amt);
  }
  if (!options.length) return null;
  return options[crypto.randomInt(options.length)];
}

function upiLink(amount, lockId) {
  const p = new URLSearchParams({ pa: UPI_ID, pn: PAYEE_NAME, am: amount, cu: 'INR', tn: `Lock ${lockId}` });
  return `upi://pay?${p.toString()}`;
}

function markPaid(session, source) {
  session.status = 'paid';
  session.paidAt = Date.now();
  session.payer = source;
  locks[session.lockId].pendingUnlock = session.id;
  console.log(`PAID  lock=${session.lockId} amount=${session.amount} via ${source}`);
}

const app = express();
app.use(express.json());
app.use(express.text({ type: 'text/*' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Website API ----------

// Start a payment for a lock code
app.post('/api/session', async (req, res) => {
  expireOld();
  const lockId = String(req.body.lockId || '').trim();
  const lock = locks[lockId];
  if (!lock) return res.status(404).json({ error: 'No lock with that code.' });
  if (!isOnline(lock)) return res.status(409).json({ error: 'This lock is offline right now. Try again in a minute.' });
  if (lock.pendingUnlock) return res.status(409).json({ error: 'This lock is already being unlocked.' });

  // cancel any older pending session for this lock
  for (const s of Object.values(sessions)) if (s.lockId === lockId && s.status === 'pending') s.status = 'cancelled';

  const amount = uniqueAmount(lock.base);
  if (!amount) return res.status(503).json({ error: 'Too many payments in progress. Try again shortly.' });

  const id = crypto.randomBytes(8).toString('hex');
  sessions[id] = { id, lockId, amount, status: 'pending', createdAt: Date.now() };
  const link = upiLink(amount, lockId);
  const qr = await QRCode.toDataURL(link, { margin: 1, width: 260 });
  console.log(`NEW   lock=${lockId} amount=${amount} session=${id}`);
  res.json({ sessionId: id, lockId, amount, upiLink: link, qr, expiresInSec: SESSION_TTL_MS / 1000 });
});

// Website polls this to show progress
app.get('/api/session/:id', (req, res) => {
  expireOld();
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json({ status: s.status, amount: s.amount, lockId: s.lockId });
});

// ---------- ESP32 API (plain text, easy to parse on the ESP32) ----------

app.get('/api/lock/:id/poll', (req, res) => {
  const lock = locks[req.params.id];
  if (!lock || req.get('X-Lock-Key') !== lock.secret) return res.status(403).type('text').send('DENIED');
  lock.lastSeen = Date.now();
  res.type('text').send(lock.pendingUnlock ? 'UNLOCK' : 'NONE');
});

app.post('/api/lock/:id/ack', (req, res) => {
  const lock = locks[req.params.id];
  if (!lock || req.get('X-Lock-Key') !== lock.secret) return res.status(403).type('text').send('DENIED');
  lock.lastSeen = Date.now();
  const s = sessions[lock.pendingUnlock];
  if (s) s.status = 'unlocked';
  console.log(`OPEN  lock=${lock.id}`);
  lock.pendingUnlock = null;
  res.type('text').send('OK');
});

// ---------- Notification helper on YOUR phone ----------
// Accepts JSON {key, text}, form fields, or ?key=...&text=...
app.all('/api/notify', (req, res) => {
  expireOld();
  const body = typeof req.body === 'object' && req.body ? req.body : {};
  const key = body.key || req.query.key || req.get('X-Notify-Key');
  let text = body.text || req.query.text || (typeof req.body === 'string' ? req.body : '');
  if (key !== NOTIFY_SECRET) return res.status(403).json({ ok: false, error: 'bad key' });
  text = String(text);
  console.log(`NOTE  ${text.replace(/\s+/g, ' ').slice(0, 160)}`);

  // Only incoming money: "received", "credited", "added"
  if (!/received|credited|added|deposited/i.test(text)) return res.json({ ok: true, matched: false, reason: 'not an incoming payment' });

  const m = text.match(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!m) return res.json({ ok: true, matched: false, reason: 'no amount found' });
  const amount = Number(m[1].replace(/,/g, '')).toFixed(2);

  const s = Object.values(sessions).find(x => x.status === 'pending' && x.amount === amount);
  if (!s) return res.json({ ok: true, matched: false, amount, reason: 'no pending session with this amount' });
  markPaid(s, 'notification');
  res.json({ ok: true, matched: true, amount, lockId: s.lockId });
});

// ---------- Admin (for demos / manual override) ----------

app.get('/api/admin/state', (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'bad key' });
  expireOld();
  res.json({
    locks: Object.values(locks).map(l => ({ id: l.id, online: isOnline(l), lastSeenSecAgo: l.lastSeen ? Math.round((Date.now() - l.lastSeen) / 1000) : null, pendingUnlock: !!l.pendingUnlock })),
    sessions: Object.values(sessions).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30),
  });
});

app.post('/api/admin/mark-paid', (req, res) => {
  if ((req.body.key || req.query.key) !== ADMIN_KEY) return res.status(403).json({ error: 'bad key' });
  const s = sessions[req.body.sessionId];
  if (!s || s.status !== 'pending') return res.status(400).json({ error: 'No pending session with that id' });
  markPaid(s, 'admin');
  res.json({ ok: true });
});

app.post('/api/admin/unlock', (req, res) => {
  if ((req.body.key || req.query.key) !== ADMIN_KEY) return res.status(403).json({ error: 'bad key' });
  const lock = locks[req.body.lockId];
  if (!lock) return res.status(404).json({ error: 'No such lock' });
  lock.pendingUnlock = 'admin-' + Date.now();
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`OnSmart server on http://localhost:${PORT}  locks: ${Object.keys(locks).join(', ')}`));
