import crypto from 'node:crypto';

const COOKIE = 'mrb_session';
const GUEST = 'mrb_guest';
const ADMIN = 'mrb_admin';
const MONTH = 30 * 24 * 60 * 60;

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

export function appendCookie(res, name, value, { maxAge = MONTH, httpOnly = true, clear = false } = {}) {
  const secure = String(process.env.APP_URL || '').startsWith('https');
  const parts = [`${name}=${clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  parts.push(clear ? 'Max-Age=0' : `Max-Age=${maxAge}`);
  const current = res.getHeader('Set-Cookie');
  const next = current ? [].concat(current, parts.join('; ')) : parts.join('; ');
  res.setHeader('Set-Cookie', next);
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const next = crypto.scryptSync(password, salt, 32);
  const prev = Buffer.from(hash, 'hex');
  if (prev.length !== next.length) return false;
  return crypto.timingSafeEqual(prev, next);
}

export function sign(value, secret) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function unsign(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}

export function createAuth({ store, secret }) {
  function guestId(req, res) {
    const cookies = parseCookies(req);
    if (cookies[GUEST] && /^gst_[a-f0-9]+$/.test(cookies[GUEST])) return cookies[GUEST];
    const id = `gst_${crypto.randomBytes(12).toString('hex')}`;
    appendCookie(res, GUEST, id, { maxAge: 180 * 24 * 60 * 60 });
    return id;
  }

  function currentUser(req) {
    const token = parseCookies(req)[COOKIE];
    if (!token) return null;
    const session = store.sessionByHash(hashToken(token));
    if (!session) return null;
    const user = store.userById(session.userId);
    if (!user) return null;
    if (user.plan === 'pro' && user.planExpiresAt && Date.parse(user.planExpiresAt) < Date.now()) {
      user.plan = 'free';
      user.theme = 'acid';
      user.stripeSubscriptionId = user.stripeSubscriptionId || null;
      store.saveUser(user);
    }
    return user;
  }

  function createSession(res, user) {
    const token = randomToken();
    store.saveSession({
      hash: hashToken(token),
      userId: user.id,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + MONTH * 1000
    });
    appendCookie(res, COOKIE, token);
    return token;
  }

  function clearSession(req, res) {
    const token = parseCookies(req)[COOKIE];
    if (token) store.deleteSessionByHash(hashToken(token));
    appendCookie(res, COOKIE, '', { clear: true });
  }

  function isAdmin(req) {
    const key = process.env.ADMIN_KEY;
    if (!key) return false;
    const cookies = parseCookies(req);
    const header = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (header && header === key) return true;
    const payload = unsign(cookies[ADMIN], secret);
    return Boolean(payload && payload.admin === true && payload.exp > Date.now());
  }

  function grantAdmin(res) {
    appendCookie(res, ADMIN, sign({ admin: true, exp: Date.now() + 12 * 60 * 60 * 1000 }, secret), { maxAge: 12 * 60 * 60 });
  }

  return { guestId, currentUser, createSession, clearSession, isAdmin, grantAdmin };
}

export function publicUser(user, usage, quote) {
  if (!user) {
    return {
      signedIn: false,
      plan: 'guest',
      theme: 'acid',
      usage,
      pricing: quote
    };
  }
  const pro = user.plan === 'pro';
  return {
    signedIn: true,
    id: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan,
    theme: pro ? (user.theme || 'acid') : 'acid',
    country: user.country || null,
    currency: user.currency || quote.currency,
    usage,
    pricing: quote
  };
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
