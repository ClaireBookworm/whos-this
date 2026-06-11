// whos-this — group contact sharing. one file, no accounts, no build step.
// run: node server.js   (PORT env optional, defaults 3000)
const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'whos-this.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    slug        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    admin_token TEXT NOT NULL,
    locked      INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    group_slug  TEXT NOT NULL REFERENCES groups(slug) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    phone       TEXT NOT NULL,
    email       TEXT,
    note        TEXT,
    edit_token  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_members_group ON members(group_slug);
`);

const app = express();
// set TRUST_PROXY=1 when behind a reverse proxy (caddy/nginx/fly) so
// req.ip is the real client, not the proxy — rate limiting depends on it
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));

// ---------- helpers ----------
const SLUG_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function makeSlug() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += SLUG_CHARS[bytes[i] % SLUG_CHARS.length];
  return s;
}
const makeToken = () => crypto.randomBytes(16).toString('hex');

// E.164-ish normalization: assume +1 for bare 10-digit, reject <7 digits.
function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const hasPlus = raw.trim().startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (hasPlus) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return '+' + digits;
}
function prettyPhone(p) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p;
}

function badField(name, max, required) {
  return v => {
    if (v == null || v === '') return required ? `${name} is required` : null;
    if (typeof v !== 'string') return `${name} must be a string`;
    if (v.trim().length === 0 && required) return `${name} is required`;
    if (v.length > max) return `${name} too long (max ${max})`;
    return null;
  };
}
const checkName = badField('name', 100, true);
const checkNote = badField('note', 200, false);
const checkEmail = v => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || v.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
    return 'email looks invalid';
  return null;
};

// vCard 3.0 text escaping per RFC 6350: backslash, semicolon, comma, newline.
function vesc(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}
function buildVcf(group, members) {
  const cards = members.map(m => {
    const full = m.name.trim();
    const sp = full.lastIndexOf(' ');
    const first = sp === -1 ? full : full.slice(0, sp);
    const last = sp === -1 ? '' : full.slice(sp + 1);
    const note = m.note ? `${group.name} · ${m.note}` : group.name;
    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `N:${vesc(last)};${vesc(first)};;;`,
      `FN:${vesc(full)}`,
      `TEL;TYPE=CELL:${m.phone}`,
    ];
    if (m.email) lines.push(`EMAIL:${vesc(m.email)}`);
    lines.push(`NOTE:${vesc(note)}`, 'END:VCARD');
    return lines.join('\r\n');
  });
  return cards.join('\r\n') + '\r\n';
}

// in-memory write rate limit: 20/min/IP
const writeHits = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const arr = (writeHits.get(ip) || []).filter(t => now - t < 60_000);
  if (arr.length >= 20) return res.status(429).json({ error: 'slow down — try again in a minute' });
  arr.push(now);
  writeHits.set(ip, arr);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of writeHits) {
    const live = arr.filter(t => now - t < 60_000);
    if (live.length) writeHits.set(ip, live); else writeHits.delete(ip);
  }
}, 5 * 60_000).unref();

// groups untouched for 12 months get deleted (members cascade)
function purgeStale() {
  const cutoff = Date.now() - 365 * 24 * 3600 * 1000;
  db.prepare(`
    DELETE FROM groups WHERE slug IN (
      SELECT g.slug FROM groups g LEFT JOIN members m ON m.group_slug = g.slug
      GROUP BY g.slug HAVING COALESCE(MAX(m.updated_at), g.created_at) < ?
    )`).run(cutoff);
}
purgeStale();
setInterval(purgeStale, 24 * 3600 * 1000).unref();

const getGroup = db.prepare('SELECT * FROM groups WHERE slug = ?');
const getMembers = db.prepare('SELECT * FROM members WHERE group_slug = ? ORDER BY created_at, id');

// ---------- api ----------
app.post('/api/groups', rateLimit, (req, res) => {
  const err = checkName(req.body?.name);
  if (err) return res.status(400).json({ error: err });
  const name = req.body.name.trim();
  const admin_token = makeToken();
  let slug;
  for (let i = 0; i < 5; i++) {
    slug = makeSlug();
    try {
      db.prepare('INSERT INTO groups (slug, name, admin_token, created_at) VALUES (?,?,?,?)')
        .run(slug, name, admin_token, Date.now());
      return res.json({ slug, admin_token });
    } catch (e) { /* slug collision, retry */ }
  }
  res.status(500).json({ error: 'could not allocate slug' });
});

app.get('/api/groups/:slug', (req, res) => {
  const g = getGroup.get(req.params.slug);
  if (!g) return res.status(404).json({ error: 'no such group' });
  const members = getMembers.all(g.slug).map(m => ({
    id: m.id, name: m.name, phone: m.phone, phone_pretty: prettyPhone(m.phone),
    email: m.email, note: m.note, updated_at: m.updated_at,
  }));
  const updated_at = members.reduce((a, m) => Math.max(a, m.updated_at), g.created_at);
  const body = JSON.stringify({ name: g.name, locked: !!g.locked, count: members.length, updated_at, members });
  const etag = '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 16) + '"';
  res.set('ETag', etag);
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.type('application/json').send(body);
});

app.post('/api/groups/:slug/members', rateLimit, (req, res) => {
  const g = getGroup.get(req.params.slug);
  if (!g) return res.status(404).json({ error: 'no such group' });
  if (g.locked) return res.status(403).json({ error: 'group is locked' });
  const count = db.prepare('SELECT COUNT(*) c FROM members WHERE group_slug = ?').get(g.slug).c;
  if (count >= 500) return res.status(403).json({ error: 'group is full (500 max)' });
  const { name, phone, email, note } = req.body || {};
  const err = checkName(name) || checkEmail(email) || checkNote(note);
  if (err) return res.status(400).json({ error: err });
  const normPhone = normalizePhone(phone || '');
  if (!normPhone) return res.status(400).json({ error: 'phone looks invalid (need at least 7 digits)' });
  const edit_token = makeToken();
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO members (group_slug, name, phone, email, note, edit_token, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(g.slug, name.trim(), normPhone, email || null, note || null, edit_token, now, now);
  res.json({ member_id: info.lastInsertRowid, edit_token });
});

app.put('/api/members/:id', rateLimit, (req, res) => {
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'no such member' });
  const { edit_token, name, phone, email, note } = req.body || {};
  if (edit_token !== m.edit_token) return res.status(403).json({ error: 'bad edit token' });
  const err = checkName(name) || checkEmail(email) || checkNote(note);
  if (err) return res.status(400).json({ error: err });
  const normPhone = normalizePhone(phone || '');
  if (!normPhone) return res.status(400).json({ error: 'phone looks invalid (need at least 7 digits)' });
  db.prepare('UPDATE members SET name=?, phone=?, email=?, note=?, updated_at=? WHERE id=?')
    .run(name.trim(), normPhone, email || null, note || null, Date.now(), m.id);
  res.json({ ok: true });
});

app.delete('/api/members/:id', rateLimit, (req, res) => {
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'no such member' });
  const token = req.body?.token || req.query.token;
  const g = getGroup.get(m.group_slug);
  if (token !== m.edit_token && token !== g.admin_token)
    return res.status(403).json({ error: 'bad token' });
  db.prepare('DELETE FROM members WHERE id = ?').run(m.id);
  res.json({ ok: true });
});

app.post('/api/groups/:slug/lock', rateLimit, (req, res) => {
  const g = getGroup.get(req.params.slug);
  if (!g) return res.status(404).json({ error: 'no such group' });
  if (req.body?.admin_token !== g.admin_token) return res.status(403).json({ error: 'bad admin token' });
  const locked = g.locked ? 0 : 1;
  db.prepare('UPDATE groups SET locked = ? WHERE slug = ?').run(locked, g.slug);
  res.json({ locked: !!locked });
});

// ---------- the product ----------
app.get('/g/:slug/contacts.vcf', (req, res) => {
  const g = getGroup.get(req.params.slug);
  if (!g) return res.status(404).send('no such group');
  const members = getMembers.all(g.slug);
  const safeName = g.name.replace(/[^\w \-]/g, '').trim().replace(/ +/g, '-') || 'contacts';
  res.set('Content-Type', 'text/vcard; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${safeName}.vcf"`);
  res.send(buildVcf(g, members));
});

// ---------- pages ----------
const CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { font: 17px/1.5 -apple-system, system-ui, sans-serif; background: #f4f2ee; color: #1b1b1b;
         max-width: 540px; margin: 0 auto; padding: 20px 16px 60px; }
  h1 { font-size: 26px; margin: 12px 0 4px; overflow-wrap: anywhere; }
  .muted { color: #777; font-size: 14px; }
  .card { background: #fff; border-radius: 14px; padding: 16px; margin: 14px 0;
          box-shadow: 0 1px 3px rgba(0,0,0,.07); }
  input, textarea { width: 100%; font: inherit; padding: 11px 12px; margin: 5px 0 12px;
          border: 1.5px solid #ccc; border-radius: 10px; background: #fafafa; }
  input:focus, textarea:focus { outline: none; border-color: #2c6e49; }
  label { font-size: 14px; font-weight: 600; }
  button { font: inherit; font-weight: 600; border: 0; border-radius: 12px; cursor: pointer;
           padding: 13px 16px; width: 100%; }
  .primary { background: #2c6e49; color: #fff; }
  .big { background: #1b4332; color: #fff; font-size: 19px; padding: 17px; }
  .ghost { background: #eee; color: #333; margin-top: 8px; }
  .danger { background: none; color: #b3261e; width: auto; padding: 4px 8px; font-size: 14px; }
  ul { list-style: none; padding: 0; }
  li { display: flex; justify-content: space-between; align-items: center; gap: 8px;
       padding: 10px 2px; border-bottom: 1px solid #eee; }
  li:last-child { border-bottom: 0; }
  .phone { color: #555; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .linkbox { background: #f0f7f2; border: 1.5px dashed #2c6e49; border-radius: 10px;
             padding: 10px 12px; font-size: 15px; overflow-wrap: anywhere; margin: 8px 0; }
  .warn { background: #fff8e6; border-radius: 10px; padding: 10px 12px; font-size: 14px; margin: 8px 0; }
  footer { margin-top: 40px; font-size: 12.5px; color: #999; text-align: center; }
  .hidden { display: none; }
  .err { color: #b3261e; font-size: 14px; min-height: 1.3em; }
`;

const HOME_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>who's this?</title><style>${CSS}</style></head><body>
<h1>who's this? 📇</h1>
<p class="muted">make a group, share one link, everyone adds their number, anyone downloads all contacts as one file.</p>
<div class="card" id="create">
  <label for="gname">group name</label>
  <input id="gname" placeholder="ski trip 2026" maxlength="100" autofocus>
  <button class="primary" id="go">create group</button>
  <p class="err" id="err"></p>
</div>
<div class="card hidden" id="done">
  <p><strong>share this link</strong> — anyone with it can add themselves &amp; download:</p>
  <div class="linkbox" id="sharelink"></div>
  <button class="primary" id="copy">copy share link</button>
  <p style="margin-top:16px"><strong>admin link</strong> — lets you lock the group &amp; remove entries:</p>
  <div class="linkbox" id="adminlink"></div>
  <div class="warn">⚠️ save the admin link now — it's shown only this once.</div>
  <button class="ghost" id="open">open group page</button>
</div>
<footer>no accounts. groups untouched for 12 months are deleted automatically.</footer>
<script>
var $ = function(id){ return document.getElementById(id); };
$('go').onclick = function(){
  var name = $('gname').value.trim();
  if (!name) { $('err').textContent = 'give it a name'; return; }
  fetch('/api/groups', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:name}) })
  .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error); return j; }); })
  .then(function(j){
    var share = location.origin + '/g/' + j.slug;
    $('sharelink').textContent = share;
    $('adminlink').textContent = share + '?admin=' + j.admin_token;
    $('create').classList.add('hidden'); $('done').classList.remove('hidden');
    $('copy').onclick = function(){ navigator.clipboard.writeText(share)
      .then(function(){ $('copy').textContent = 'copied ✓'; }); };
    $('open').onclick = function(){ location.href = share; };
  })
  .catch(function(e){ $('err').textContent = e.message; });
};
$('gname').addEventListener('keydown', function(e){ if (e.key === 'Enter') $('go').click(); });
</script></body></html>`;

function groupHtml(slug) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>who's this?</title><style>${CSS}</style></head><body>
<h1 id="gname">…</h1>
<p class="muted"><span id="count">0</span> people · <span id="lockstate"></span></p>
<div class="card">
  <a id="dl" href="/g/${slug}/contacts.vcf" style="text-decoration:none">
    <button class="big">⬇️ download all contacts (.vcf)</button></a>
  <p class="muted" style="text-align:center;margin-top:8px">updated <span id="rel">—</span></p>
</div>
<div class="card"><ul id="list"></ul></div>
<div class="card" id="formcard">
  <h2 id="formtitle" style="font-size:19px;margin-bottom:8px">add my info</h2>
  <button class="ghost hidden" id="pickbtn" style="margin:0 0 14px">📇 fill from my contact card</button>
  <label>name</label><input id="f_name" maxlength="100" autocomplete="name">
  <label>phone</label><input id="f_phone" type="tel" autocomplete="tel" placeholder="(555) 123-4567">
  <label>email <span class="muted">(optional)</span></label><input id="f_email" type="email" autocomplete="email">
  <label>note <span class="muted">(optional)</span></label><input id="f_note" maxlength="200" placeholder="met at the conference">
  <button class="primary" id="save">add me to the list</button>
  <button class="ghost hidden" id="remove">remove my entry</button>
  <p class="err" id="err"></p>
</div>
<div class="card hidden" id="lockedcard">🔒 this group is locked — no new entries.</div>
<div class="card hidden" id="admincard">
  <strong>admin</strong>
  <button class="ghost" id="locktoggle">…</button>
</div>
<footer>no accounts. groups untouched for 12 months are deleted automatically.</footer>
<script>
var SLUG = ${JSON.stringify(slug)};
var $ = function(id){ return document.getElementById(id); };
var admin = new URLSearchParams(location.search).get('admin');
var saved = null;
try { saved = JSON.parse(localStorage.getItem('whosthis:' + SLUG)); } catch (e) {}
var etag = null, data = null;

function relTime(ms) {
  var s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}
function render() {
  $('gname').textContent = data.name;
  document.title = data.name + ' — who\\'s this?';
  $('count').textContent = data.count;
  $('lockstate').textContent = data.locked ? 'locked 🔒' : 'open';
  $('rel').textContent = relTime(data.updated_at);
  var ul = $('list'); ul.innerHTML = '';
  if (!data.members.length) {
    var li = document.createElement('li');
    li.className = 'muted'; li.textContent = 'nobody yet — be the first!';
    ul.appendChild(li);
  }
  data.members.forEach(function(m){
    var li = document.createElement('li');
    var nm = document.createElement('span'); nm.textContent = m.name + (saved && saved.id === m.id ? ' (you)' : '');
    var ph = document.createElement('span'); ph.className = 'phone'; ph.textContent = m.phone_pretty;
    li.appendChild(nm); li.appendChild(ph);
    if (admin) {
      var x = document.createElement('button'); x.className = 'danger'; x.textContent = '✕';
      x.onclick = function(){
        if (!confirm('remove ' + m.name + '?')) return;
        api('/api/members/' + m.id, 'DELETE', {token: admin}).then(force);
      };
      li.appendChild(x);
    }
    ul.appendChild(li);
  });
  var mine = saved && data.members.find(function(m){ return m.id === saved.id; });
  if (saved && !mine) { localStorage.removeItem('whosthis:' + SLUG); saved = null; }
  if (mine) {
    $('formtitle').textContent = 'edit my info';
    $('save').textContent = 'save changes';
    $('remove').classList.remove('hidden');
    if (document.activeElement.tagName !== 'INPUT') {
      $('f_name').value = mine.name; $('f_phone').value = mine.phone_pretty;
      $('f_email').value = mine.email || ''; $('f_note').value = mine.note || '';
    }
  }
  $('formcard').classList.toggle('hidden', data.locked && !mine);
  $('lockedcard').classList.toggle('hidden', !data.locked);
  if (admin) {
    $('admincard').classList.remove('hidden');
    $('locktoggle').textContent = data.locked ? 'unlock group' : 'lock group (stop new entries)';
  }
}
function api(url, method, body) {
  return fetch(url, { method: method, headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body) })
  .then(function(r){ return r.json().then(function(j){ if (!r.ok) throw new Error(j.error || r.status); return j; }); });
}
function load() {
  fetch('/api/groups/' + SLUG, { headers: etag ? {'If-None-Match': etag} : {} })
  .then(function(r){
    if (r.status === 304) return null;
    if (r.status === 404) { document.body.innerHTML = '<h1>group not found</h1><p class="muted">it may have expired (12 months untouched) or the link is wrong.</p>'; return null; }
    etag = r.headers.get('ETag');
    return r.json();
  })
  .then(function(j){ if (j) { data = j; render(); } else if (data) $('rel').textContent = relTime(data.updated_at); })
  .catch(function(){});
}
function force(){ etag = null; load(); }
$('save').onclick = function(){
  $('err').textContent = '';
  var body = { name: $('f_name').value.trim(), phone: $('f_phone').value.trim(),
               email: $('f_email').value.trim(), note: $('f_note').value.trim() };
  var p;
  if (saved) { body.edit_token = saved.token; p = api('/api/members/' + saved.id, 'PUT', body); }
  else p = api('/api/groups/' + SLUG + '/members', 'POST', body).then(function(j){
    saved = { id: j.member_id, token: j.edit_token };
    localStorage.setItem('whosthis:' + SLUG, JSON.stringify(saved));
  });
  p.then(force).catch(function(e){ $('err').textContent = e.message; });
};
$('remove').onclick = function(){
  if (!saved || !confirm('remove your entry from this group?')) return;
  api('/api/members/' + saved.id, 'DELETE', {token: saved.token}).then(function(){
    localStorage.removeItem('whosthis:' + SLUG); saved = null;
    $('formtitle').textContent = 'add my info'; $('save').textContent = 'add me to the list';
    $('remove').classList.add('hidden');
    $('f_name').value = $('f_phone').value = $('f_email').value = $('f_note').value = '';
    force();
  }).catch(function(e){ $('err').textContent = e.message; });
};
// Contact Picker API (iOS Safari 14.5+, Android Chrome): user taps the
// button, picks their own card from the native sheet, form gets prefilled.
// Browsers don't allow reading contacts without that explicit pick.
if ('contacts' in navigator && 'select' in navigator.contacts) {
  $('pickbtn').classList.remove('hidden');
  $('pickbtn').onclick = function(){
    navigator.contacts.select(['name','tel','email'], {multiple:false})
    .then(function(list){
      var c = list && list[0];
      if (!c) return;
      if (c.name && c.name.length) $('f_name').value = c.name[0];
      if (c.tel && c.tel.length) $('f_phone').value = c.tel[0];
      if (c.email && c.email.length) $('f_email').value = c.email[0];
    })
    .catch(function(){ /* user cancelled the picker */ });
  };
}
$('locktoggle').onclick = function(){
  api('/api/groups/' + SLUG + '/lock', 'POST', {admin_token: admin}).then(force)
  .catch(function(e){ alert(e.message); });
};
load();
setInterval(load, 30000);
</script></body></html>`;
}

app.get('/', (_req, res) => res.type('html').send(HOME_HTML));
app.get('/g/:slug', (req, res) => {
  if (!getGroup.get(req.params.slug)) return res.status(404).type('html')
    .send('<h1>group not found</h1><p>it may have expired (groups untouched for 12 months are deleted) or the link is wrong.</p>');
  res.type('html').send(groupHtml(req.params.slug));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`whos-this listening on http://localhost:${PORT}`));
