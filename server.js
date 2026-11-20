'use strict';
/*
 * MovieHub - movie & web series discovery site (no npm packages needed).
 *
 * Where data is saved:
 *   - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set -> your free Upstash database
 *     (use this on free hosting such as Render, where the disk is wiped on every restart)
 *   - not set -> local files in ./data  (fine on your own computer or a VPS with a disk)
 *
 * Run:  node server.js     Admin panel: /admin
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DIR = __dirname;
const DATA = path.join(DIR, 'data');

const REMOTE_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const REMOTE_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const USE_REMOTE = !!(REMOTE_URL && REMOTE_TOKEN);
const ON_HOST = !!(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.KOYEB_APP_NAME ||
  process.env.FLY_APP_NAME || process.env.VERCEL || process.env.DYNO);
const EPHEMERAL_RISK = ON_HOST && !USE_REMOTE; // hosting with a disk that gets wiped, but no database connected

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};
// The only static files the server will ever hand out (nothing else in the folder is reachable).
const STATIC = { '/style.css': 'style.css', '/app.js': 'app.js', '/admin.js': 'admin.js' };

const DEFAULT_CONFIG = {
  siteName: 'MovieHub',
  tagline: 'Discover movies & web series, watch trailers and find where to stream them.',
  contactEmail: '',
  adsenseClient: '',
  slots: { top: '', inline: '', detail: '' }
};

// ======================================================================
//  Storage: in-memory copy (fast reads) + write-through to Upstash or files
// ======================================================================
const KEYS = ['titles', 'config', 'admin', 'secret'];
const store = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dbError(msg, fatal) { const e = new Error('Database error: ' + msg); e.db = true; e.fatal = !!fatal; return e; }

async function redis(cmd) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(REMOTE_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + REMOTE_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
      signal: ctl.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw dbError(data.error || 'HTTP ' + res.status, res.status === 401 || res.status === 403);
    }
    return data.result;
  } catch (e) {
    if (e.db) throw e;
    throw dbError(e.name === 'AbortError' ? 'timed out' : (e.cause && e.cause.code) || e.message);
  } finally { clearTimeout(timer); }
}

async function rawGet(key) {
  if (USE_REMOTE) {
    const v = await redis(['GET', 'moviehub:' + key]);
    if (v == null) return null;
    try { return JSON.parse(v); } catch { throw new Error(`Saved data "${key}" in the database is corrupted`); }
  }
  const file = path.join(DATA, key + '.json');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { return JSON.parse(text); } catch { throw new Error(`Saved file ${file} is corrupted - fix or delete it`); }
}

async function rawSet(key, value) {
  if (USE_REMOTE) { await redis(['SET', 'moviehub:' + key, JSON.stringify(value)]); return; }
  fs.mkdirSync(DATA, { recursive: true });
  const file = path.join(DATA, key + '.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}

// Save first; only update the in-memory copy if the save worked, so memory never disagrees with the database.
async function save(key, value) { await rawSet(key, value); store[key] = value; }

// One admin write at a time (read-modify-write on the titles list must not interleave).
let lock = Promise.resolve();
function exclusive(fn) { const p = lock.then(fn); lock = p.catch(() => {}); return p; }

const readConfig = () => {
  const c = store.config || {};
  return { ...DEFAULT_CONFIG, ...c, slots: { ...DEFAULT_CONFIG.slots, ...(c.slots || {}) } };
};

// ======================================================================
//  Auth
// ======================================================================
let SECRET = '';
const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('hex'), hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function verifyPassword(pw) {
  if (process.env.ADMIN_PASSWORD) return safeEq(pw, process.env.ADMIN_PASSWORD);
  const a = store.admin;
  if (!a) return false;
  const h = crypto.scryptSync(String(pw), Buffer.from(a.salt, 'hex'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(a.hash, 'hex'));
}
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
function makeToken() { const exp = String(Date.now() + 7 * 864e5); return exp + '.' + hmac(exp); }
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function isAuthed(req) {
  const c = parseCookies(req).sid;
  if (!c) return false;
  const [exp, sig] = c.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = hmac(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function sessionCookie(req, token, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

// Login throttle: per client, plus one global cap. The client key is the LAST X-Forwarded-For entry
// (the one added by the hosting proxy); the first entries can be faked by the person sending the request.
const fails = new Map();
function bucket(k) {
  const now = Date.now();
  let b = fails.get(k);
  if (!b || b.reset < now) {
    if (fails.size > 5000) for (const [key, v] of fails) if (v.reset < now) fails.delete(key);
    b = { n: 0, reset: now + 10 * 60e3 };
    fails.set(k, b);
  }
  return b;
}
function clientKey(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket.remoteAddress || 'unknown');
}
const tooManyAttempts = (k) => bucket(k).n >= 8 || bucket('*').n >= 40;
const noteFail = (k) => { bucket(k).n++; bucket('*').n++; };

// ======================================================================
//  Validation
// ======================================================================
const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
function cleanUrl(v) {
  v = s(v, 600);
  if (!v) return '';
  try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; }
}
function ytId(v) {
  v = s(v, 300);
  if (!v) return '';
  if (/^[\w-]{11}$/.test(v)) return v;
  try {
    const u = new URL(v);
    const h = u.hostname.replace(/^(www|m)\./, '');
    if (h === 'youtu.be') { const id = u.pathname.slice(1).split('/')[0]; return /^[\w-]{11}$/.test(id) ? id : ''; }
    if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
      const q = u.searchParams.get('v');
      if (q && /^[\w-]{11}$/.test(q)) return q;
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch { /* not a URL */ }
  return '';
}
function cleanTitle(b) {
  const name = s(b.name, 150);
  if (!name) return { error: 'Title name is required' };
  const type = b.type === 'series' ? 'series' : 'movie';
  let year = parseInt(b.year, 10);
  if (!(year >= 1888 && year <= 2100)) year = null;
  let rating = parseFloat(b.rating);
  rating = rating >= 0 && rating <= 10 ? Math.round(rating * 10) / 10 : null;
  const genres = (Array.isArray(b.genres) ? b.genres : String(b.genres || '').split(','))
    .map((g) => s(g, 30)).filter(Boolean).slice(0, 6);
  const watch = (Array.isArray(b.watch) ? b.watch : []).slice(0, 6)
    .map((w) => ({ platform: s(w && w.platform, 40), url: cleanUrl(w && w.url) }))
    .filter((w) => w.platform && w.url);
  const youtube = ytId(b.youtube);
  if (b.youtube && !youtube) return { error: 'YouTube link is not valid' };
  return {
    name, type, year, rating, genres, watch, youtube,
    language: s(b.language, 40),
    description: s(b.description, 1500),
    poster: cleanUrl(b.poster),
    inReels: !!b.inReels && !!youtube,
    featured: !!b.featured
  };
}

// ======================================================================
//  HTTP helpers
// ======================================================================
function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...headers
  });
  res.end(body);
}
const json = (res, data, status = 200, headers = {}) =>
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 100 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const baseUrl = (req) => `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;

function serveFile(res, name, noindex) {
  fs.readFile(path.join(DIR, name), (err, buf) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    const headers = { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' };
    if (noindex) { headers['X-Robots-Tag'] = 'noindex'; headers['Cache-Control'] = 'no-store'; }
    send(res, 200, buf, headers);
  });
}

let INDEX_HTML = '';
function indexPage(req, title) {
  const cfg = readConfig();
  const base = baseUrl(req);
  let meta;
  if (title) {
    const desc = title.description ? title.description.slice(0, 160) : `${title.name} - details, trailer and where to watch.`;
    const url = `${base}/title/${title.id}`;
    meta = `<title>${esc(title.name)}${title.year ? ' (' + title.year + ')' : ''} - ${esc(cfg.siteName)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:title" content="${esc(title.name)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
${title.poster ? `<meta property="og:image" content="${esc(title.poster)}">` : ''}`;
  } else {
    meta = `<title>${esc(cfg.siteName)} - Movies & Web Series</title>
<meta name="description" content="${esc(cfg.tagline)}">
<link rel="canonical" href="${esc(base + '/')}">
<meta property="og:title" content="${esc(cfg.siteName)}">
<meta property="og:description" content="${esc(cfg.tagline)}">`;
  }
  return INDEX_HTML.replace('<!--META-->', meta);
}

// ======================================================================
//  API
// ======================================================================
async function api(req, res, p) {
  const m = req.method;
  const ck = clientKey(req);

  if (p === '/api/config' && m === 'GET') {
    const { siteName, tagline, contactEmail, adsenseClient, slots } = readConfig();
    return json(res, { siteName, tagline, contactEmail, adsenseClient, slots });
  }
  if (p === '/api/titles' && m === 'GET') {
    return json(res, [...store.titles].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
  }
  if (p === '/api/admin/me' && m === 'GET') {
    return json(res, {
      authed: isAuthed(req), passwordFromEnv: !!process.env.ADMIN_PASSWORD,
      storage: USE_REMOTE ? 'cloud' : 'local', ephemeralRisk: EPHEMERAL_RISK
    });
  }

  if (p === '/api/admin/login' && m === 'POST') {
    if (tooManyAttempts(ck)) return json(res, { error: 'Too many attempts. Try again in 10 minutes.' }, 429);
    const b = await readBody(req);
    if (!verifyPassword(s(b.password, 200))) { noteFail(ck); return json(res, { error: 'Wrong password' }, 401); }
    return json(res, { ok: true }, 200, { 'Set-Cookie': sessionCookie(req, makeToken(), 7 * 86400) });
  }
  if (p === '/api/admin/logout' && m === 'POST') {
    return json(res, { ok: true }, 200, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  // ---- everything below needs login ----
  if (!isAuthed(req)) return json(res, { error: 'Login required' }, 401);
  if (m !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
    return json(res, { error: 'JSON required' }, 415);
  }

  if (p === '/api/admin/config' && m === 'GET') return json(res, readConfig());
  if (p === '/api/admin/config' && m === 'PUT') {
    const b = await readBody(req);
    const client = s(b.adsenseClient, 40);
    if (client && !/^ca-pub-\d{10,20}$/.test(client)) return json(res, { error: 'AdSense Publisher ID looks like ca-pub-1234567890123456' }, 400);
    const slots = {};
    for (const k of ['top', 'inline', 'detail']) {
      const v = s(b.slots && b.slots[k], 30);
      if (v && !/^\d{6,20}$/.test(v)) return json(res, { error: `Ad slot "${k}" must be digits only` }, 400);
      slots[k] = v;
    }
    const email = s(b.contactEmail, 120);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, { error: 'Contact email is not valid' }, 400);
    const cfg = {
      siteName: s(b.siteName, 60) || DEFAULT_CONFIG.siteName,
      tagline: s(b.tagline, 200) || DEFAULT_CONFIG.tagline,
      contactEmail: email, adsenseClient: client, slots
    };
    await exclusive(() => save('config', cfg));
    return json(res, cfg);
  }
  if (p === '/api/admin/password' && m === 'POST') {
    if (process.env.ADMIN_PASSWORD) return json(res, { error: 'Password is set by the ADMIN_PASSWORD environment variable' }, 400);
    const b = await readBody(req);
    if (!verifyPassword(s(b.current, 200))) return json(res, { error: 'Current password is wrong' }, 401);
    const np = s(b.next, 200);
    if (np.length < 8) return json(res, { error: 'New password must be at least 8 characters' }, 400);
    await exclusive(async () => {
      await save('admin', hashPassword(np));
      const fresh = crypto.randomBytes(32).toString('hex'); // logs out every other session
      await save('secret', { value: fresh });
      SECRET = fresh;
    });
    return json(res, { ok: true }, 200, { 'Set-Cookie': sessionCookie(req, makeToken(), 7 * 86400) });
  }

  if (p === '/api/titles' && m === 'POST') {
    const c = cleanTitle(await readBody(req));
    if (c.error) return json(res, { error: c.error }, 400);
    const item = { id: crypto.randomBytes(5).toString('hex'), createdAt: Date.now(), ...c };
    await exclusive(() => save('titles', [...store.titles, item]));
    return json(res, item, 201);
  }
  const mm = p.match(/^\/api\/titles\/([\w-]+)$/);
  if (mm && (m === 'PUT' || m === 'DELETE')) {
    if (!store.titles.some((t) => t.id === mm[1])) return json(res, { error: 'Not found' }, 404);
    if (m === 'PUT') {
      const c = cleanTitle(await readBody(req));
      if (c.error) return json(res, { error: c.error }, 400);
      return exclusive(async () => {
        const i = store.titles.findIndex((t) => t.id === mm[1]);
        if (i < 0) return json(res, { error: 'Not found' }, 404);
        const next = [...store.titles];
        next[i] = { ...next[i], ...c };
        await save('titles', next);
        return json(res, next[i]);
      });
    }
    return exclusive(async () => {
      await save('titles', store.titles.filter((t) => t.id !== mm[1]));
      return json(res, { ok: true });
    });
  }
  return json(res, { error: 'Not found' }, 404);
}

// ======================================================================
//  Server
// ======================================================================
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(u.pathname);

    if (p.startsWith('/api/')) return await api(req, res, p);

    if (p === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    if (p === '/favicon.ico') return send(res, 204, '');
    if (p === '/ads.txt') {
      const c = readConfig().adsenseClient;
      const body = c ? `google.com, ${c.replace('ca-', '')}, DIRECT, f08c47fec0942fa0\n` : '# Set your AdSense Publisher ID in the admin panel\n';
      return send(res, 200, body, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (p === '/robots.txt') {
      return send(res, 200, `User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: ${baseUrl(req)}/sitemap.xml\n`, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (p === '/sitemap.xml') {
      const base = baseUrl(req);
      const urls = [`<url><loc>${esc(base)}/</loc></url>`, ...store.titles.map((t) => `<url><loc>${esc(base)}/title/${t.id}</loc></url>`)];
      return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`, { 'Content-Type': 'application/xml; charset=utf-8' });
    }
    if (p === '/' || p === '/index.html') {
      return send(res, 200, indexPage(req), { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    }
    const tm = p.match(/^\/title\/([\w-]+)\/?$/);
    if (tm) {
      const t = store.titles.find((x) => x.id === tm[1]);
      if (!t) return send(res, 404, indexPage(req), { 'Content-Type': MIME['.html'] });
      return send(res, 200, indexPage(req, t), { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    }
    if (p === '/admin') return serveFile(res, 'admin.html', true);
    if (p === '/privacy') return serveFile(res, 'privacy.html');
    if (Object.prototype.hasOwnProperty.call(STATIC, p)) return serveFile(res, STATIC[p]);
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  } catch (e) {
    const status = e.db ? 503 : /too large/.test(e.message) ? 413 : /bad json|URI/.test(e.message) ? 400 : 500;
    if (status >= 500) console.error(e.message);
    const msg = e.db ? 'Could not reach the database. Nothing was saved - please try again.' : status === 500 ? 'Server error' : e.message;
    return json(res, { error: msg }, status);
  }
});

// ======================================================================
//  Start-up: load everything BEFORE accepting visitors
// ======================================================================
async function init() {
  if ((REMOTE_URL && !REMOTE_TOKEN) || (!REMOTE_URL && REMOTE_TOKEN)) {
    throw new Error('Set BOTH UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or neither, to use local files).');
  }
  if (USE_REMOTE && !/^https:\/\//i.test(REMOTE_URL)) {
    throw new Error('UPSTASH_REDIS_REST_URL must start with https:// (copy the REST URL, not the redis:// one).');
  }
  INDEX_HTML = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

  let loaded;
  for (let attempt = 1; ; attempt++) {
    try { loaded = await Promise.all(KEYS.map(rawGet)); break; }
    catch (e) {
      if (!e.db || e.fatal || attempt >= 5) throw e;
      console.log(`Database not reachable (${e.message}). Retrying (${attempt}/4)...`);
      await sleep(1500 * attempt);
    }
  }
  KEYS.forEach((k, i) => { store[k] = loaded[i]; });

  // Only create defaults when the database answered "nothing there yet" - never on an error.
  if (store.titles === null) await save('titles', []);
  else if (!Array.isArray(store.titles)) throw new Error('Saved titles are not a list - database content looks wrong');
  if (store.config === null) await save('config', DEFAULT_CONFIG);
  if (!store.secret || !store.secret.value) await save('secret', { value: crypto.randomBytes(32).toString('hex') });
  SECRET = store.secret.value;

  if (!process.env.ADMIN_PASSWORD && !store.admin) {
    const pw = crypto.randomBytes(9).toString('base64url');
    await save('admin', hashPassword(pw));
    console.log('\n==============================================');
    console.log(' FIRST RUN - your admin password is:  ' + pw);
    console.log(' Login at /admin and change it after login.');
    console.log('==============================================\n');
  }
}

init().then(() => {
  server.listen(PORT, () => {
    console.log(`MovieHub running on port ${PORT}  (admin: /admin)`);
    console.log('Storage: ' + (USE_REMOTE ? 'Upstash cloud database' : 'local files in ./data'));
    if (EPHEMERAL_RISK) {
      console.log('\n!!! WARNING: this host wipes its disk on restart and no database is connected.');
      console.log('!!! Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN or your titles will disappear.\n');
    }
  });
}).catch((e) => {
  console.error('\nStart-up failed: ' + e.message + '\n');
  process.exit(1);
});
