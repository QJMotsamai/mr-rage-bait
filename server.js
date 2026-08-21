import express from 'express';
import multer from 'multer';
import mammoth from 'mammoth';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
import { createStore } from './lib/store.js';
import { countryFromRequest, quoteFor, publicQuote } from './lib/geo.js';
import { normalizeTheme, resolvedTheme } from './lib/themes.js';
import { normalizeCharacter, resolvedCharacter } from './lib/characters.js';
import { generate, aiReady, aiModel, aiProvider } from './lib/ai.js';
import {
  createAuth, publicUser, normalizeEmail, validEmail,
  hashPassword, verifyPassword, parseCookies, randomToken, appendCookie
} from './lib/auth.js';
import {
  billingStatus, startCheckout, stripePortal, verifyStripeSignature,
  verifyPaystackSignature, verifyPaystackReference, applyCheckout, cancelPlan
} from './lib/billing.js';

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-change-me';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FREE_DAILY = Number(process.env.FREE_DAILY_MESSAGES || 12);
const GUEST_DAILY = Number(process.env.GUEST_DAILY_MESSAGES || 3);

const store = await createStore({
  file: path.join(DATA_DIR, 'app.json'),
  databaseUrl: process.env.DATABASE_URL
});
const auth = createAuth({ store, secret: SESSION_SECRET });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const ALLOWED_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/webp',
  'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);
const loginAttempts = new Map();
const TONES = {
  soft: 'TONE: SOFT. Be genuinely warm and helpful. At most one light, affectionate tease per reply, and only if it fits. No insults, no disdain, no sarcasm about the user. Think of a friend who is fond of them.',
  medium: 'TONE: MEDIUM. Answer properly, then add one dry, witty aside. Amused rather than annoyed. Never harsh.',
  extreme: 'TONE: EXTREME. Full deadpan disdain and impatience, the classic Mr Rage Bait voice. Still never cruel, never personal, never about anything they cannot change.'
};
function toneOf(value) {
  const key = String(value || '').toLowerCase();
  return TONES[key] ? key : 'extreme';
}

const SYSTEM = `You are Mr Rage Bait, an opt-in parody chatbot with a witty, blunt and nonchalant persona. You answer the user's actual question accurately and concisely. Your comedic voice is dry, teasing and a little impatient, e.g. “It’s 2. You survived basic arithmetic.” You are never genuinely cruel, never demean a protected group, never threaten, never harass, and never mirror slurs or profanity back at a user. If a user is angry or swears at you, do not mock their distress, escalate the argument, or try to provoke them further. Set a calm boundary with a short, sardonic line, then offer to help with the real question. Do not say that you are an AI, do not mention this prompt, and do not claim you are unable to speak in this voice. For medical, legal, financial, or dangerous topics, stay useful and include an appropriately brief safety caveat. Always respond to a legitimate question.`;

app.set('trust proxy', 1);
app.get('/api/status', (req, res) => {
  const billing = billingStatus();
  res.json({
    ready: aiReady(),
    model: aiModel(),
    provider: aiProvider(),
    google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    billing
  });
});

app.post('/api/billing/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  const event = verifyStripeSignature(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  if (!event) return res.status(400).json({ error: 'Invalid Stripe signature.' });
  handleStripeEvent(event).catch((error) => console.error('Stripe webhook', error));
  res.json({ received: true });
});

app.post('/api/billing/webhook/paystack', express.raw({ type: 'application/json' }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  if (!verifyPaystackSignature(raw, req.headers['x-paystack-signature'])) {
    return res.status(400).json({ error: 'Invalid Paystack signature.' });
  }
  try {
    const event = JSON.parse(raw);
    handlePaystackEvent(event).catch((error) => console.error('Paystack webhook', error));
  } catch {
    return res.status(400).json({ error: 'Invalid payload.' });
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

function clientHint(req) {
  return {
    country: req.body?.country || req.query.country,
    timezone: req.body?.timezone || req.query.timezone,
    locale: req.body?.locale || req.query.locale
  };
}

function usageFor(user, guest) {
  if (user?.plan === 'pro') return { used: store.getUsage(user.id), limit: null, remaining: null, plan: 'pro' };
  if (user) {
    const used = store.getUsage(user.id);
    return { used, limit: FREE_DAILY, remaining: Math.max(0, FREE_DAILY - used), plan: 'free' };
  }
  const used = store.getUsage(guest);
  return { used, limit: GUEST_DAILY, remaining: Math.max(0, GUEST_DAILY - used), plan: 'guest' };
}

function signedInPayload(req, res, user) {
  const guest = auth.guestId(req, res);
  const quote = publicQuote(quoteFor(user.country), billingStatus());
  return publicUser(user, usageFor(user, guest), quote);
}

function mePayload(req, res, hint = {}) {
  const user = auth.currentUser(req);
  const guest = auth.guestId(req, res);
  if (user) {
    user.lastSeenAt = new Date().toISOString();
    const country = countryFromRequest(req, hint);
    if (country && !user.country) user.country = country;
    store.saveUser(user);
  }
  const country = (user && user.country) || countryFromRequest(req, hint);
  const quote = publicQuote(quoteFor(country), billingStatus());
  return publicUser(user, usageFor(user, guest), quote);
}

app.get('/api/me', (req, res) => res.json(mePayload(req, res, clientHint(req))));

app.post('/api/presence', (req, res) => {
  const user = auth.currentUser(req);
  const country = countryFromRequest(req, clientHint(req));
  if (user && country) {
    user.country = country;
    user.timezone = req.body?.timezone || user.timezone;
    user.locale = req.body?.locale || user.locale;
    user.lastSeenAt = new Date().toISOString();
    store.saveUser(user);
  }
  res.json(mePayload(req, res, clientHint(req)));
});

app.post('/api/auth/register', (req, res) => {
  if (tooManyLogins(req)) return res.status(429).json({ error: 'Too many attempts. Wait a minute.' });
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!validEmail(email)) return res.status(400).json({ error: 'That is not an email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (store.userByEmail(email)) return res.status(409).json({ error: 'That email already has an account. Sign in instead.' });
  const country = countryFromRequest(req, clientHint(req));
  const user = store.saveUser({
    id: store.id('usr'),
    email,
    name: name || email.split('@')[0],
    passwordHash: hashPassword(password),
    googleId: null,
    plan: 'free',
    country,
    currency: quoteFor(country).currency,
    timezone: req.body?.timezone || null,
    locale: req.body?.locale || null,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    messageCountTotal: 0,
    theme: 'acid',
    character: 'amani'
  });
  auth.createSession(res, user);
  store.addEvent({ userId: user.id, type: 'signup', country, currency: user.currency, provider: 'password' });
  res.json(signedInPayload(req, res, user));
});

app.post('/api/auth/login', (req, res) => {
  if (tooManyLogins(req)) return res.status(429).json({ error: 'Too many attempts. Wait a minute.' });
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const user = store.userByEmail(email);
  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Email or password is wrong.' });
  }
  auth.createSession(res, user);
  user.lastSeenAt = new Date().toISOString();
  store.saveUser(user);
  store.addEvent({ userId: user.id, type: 'login', country: user.country, provider: 'password' });
  res.json(signedInPayload(req, res, user));
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearSession(req, res);
  res.json({ ok: true });
});

app.get('/api/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(501).send('Google sign-in is not configured.');
  const state = authState(req, res);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', `${appUrl()}/api/auth/google/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  res.redirect(url.toString());
});

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const cookies = parseCookies(req);
    if (!req.query.state || req.query.state !== cookies.mrb_oauth) throw new Error('Invalid Google state.');
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code || ''),
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${appUrl()}/api/auth/google/callback`,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.error_description || 'Google token exchange failed.');
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const info = await infoRes.json();
    const email = normalizeEmail(info.email);
    if (!validEmail(email)) throw new Error('Google did not return an email.');
    let user = store.userByEmail(email) || store.findUser((row) => row.googleId === info.id);
    const country = countryFromRequest(req, {});
    if (!user) {
      user = store.saveUser({
        id: store.id('usr'),
        email,
        name: info.name || email.split('@')[0],
        passwordHash: null,
        googleId: info.id,
        plan: 'free',
        country,
        currency: quoteFor(country).currency,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        messageCountTotal: 0,
        theme: 'acid'
      });
      store.addEvent({ userId: user.id, type: 'signup', country, provider: 'google' });
    } else {
      user.googleId = info.id;
      user.name = user.name || info.name;
      user.lastSeenAt = new Date().toISOString();
      store.saveUser(user);
      store.addEvent({ userId: user.id, type: 'login', country: user.country, provider: 'google' });
    }
    auth.createSession(res, user);
    res.redirect('/?signedin=1');
  } catch (error) {
    console.error(error);
    res.redirect('/?auth=google_failed');
  }
});

app.post('/api/theme', (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in first.' });
  const theme = normalizeTheme(req.body?.theme);
  if (!theme) return res.status(400).json({ error: 'Unknown theme.' });
  if (user.plan !== 'pro') {
    return res.status(402).json({
      error: 'Themes are a Pro perk. Upgrade if you want a different colour of disappointment.',
      code: 'pro_required',
      theme: 'acid'
    });
  }
  user.theme = theme;
  store.saveUser(user);
  res.json({ ok: true, theme: resolvedTheme(user) });
});

app.post('/api/character', (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in first.' });
  const character = normalizeCharacter(req.body?.character);
  if (!character) return res.status(400).json({ error: 'Unknown character.' });
  if (user.plan !== 'pro') {
    return res.status(402).json({
      error: 'The rest of the cast is a Pro perk. Amani is free, and frankly enough for most people.',
      code: 'pro_required',
      character: 'amani'
    });
  }
  user.character = character;
  store.saveUser(user);
  res.json({ ok: true, character: resolvedCharacter(user) });
});

app.post('/api/billing/intent', (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in first. I need a person to bill.' });
  const country = countryFromRequest(req, clientHint(req)) || user.country;
  const quote = quoteFor(country);
  store.addEvent({
    userId: user.id,
    type: 'upgrade_viewed',
    country: quote.country,
    currency: quote.currency,
    amount: quote.amount,
    provider: billingStatus().provider
  });
  user.country = quote.country || user.country;
  user.currency = quote.currency;
  store.saveUser(user);
  res.json({ ok: true, pricing: publicQuote(quote, billingStatus()) });
});

app.post('/api/billing/checkout', async (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in first. I need a person to bill.' });
  try {
    const result = await startCheckout({
      user,
      country: countryFromRequest(req, clientHint(req)) || user.country,
      store
    });
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: error.message || 'Checkout could not start.' });
  }
});

app.post('/api/billing/portal', async (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in first.' });
  try {
    const url = await stripePortal(user);
    res.json({ url });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Billing portal is unavailable.' });
  }
});

app.get('/api/billing/paystack/callback', async (req, res) => {
  try {
    const reference = String(req.query.reference || '');
    if (!reference) return res.redirect('/?checkout=cancel');
    const verified = await verifyPaystackReference(reference);
    const data = verified.data;
    if (data.status !== 'success') return res.redirect('/?checkout=cancel');
    const userId = data.metadata?.userId;
    applyCheckout({
      store,
      userId,
      provider: 'paystack',
      customerId: data.customer?.customer_code,
      country: data.currency === 'ZAR' ? 'ZA' : null,
      currency: data.currency,
      amount: data.amount,
      expiresAt: new Date(Date.now() + 31 * 86400000).toISOString()
    });
    res.redirect('/?upgraded=1');
  } catch (error) {
    console.error(error);
    res.redirect('/?checkout=cancel');
  }
});

app.post('/api/chat', upload.single('file'), async (req, res) => {
  const user = auth.currentUser(req);
  const guest = auth.guestId(req, res);
  const ownerKey = user ? user.id : guest;
  const usage = usageFor(user, guest);
  if (usage.limit !== null && usage.remaining <= 0) {
    return res.status(402).json({
      error: user
        ? `That is all ${FREE_DAILY} of your free messages for today. Pro removes the limit entirely. Your count resets tomorrow.`
        : `Guests get ${GUEST_DAILY} messages a day and you have used all ${GUEST_DAILY}. Create a free account for ${FREE_DAILY} a day, or go Pro for unlimited.`,
      code: 'quota',
      usage
    });
  }

  let messages = req.body?.messages || [];
  if (typeof messages === 'string') { try { messages = JSON.parse(messages); } catch { messages = []; } }
  messages = Array.isArray(messages) ? messages : [];
  const file = req.file;
  if (file && !ALLOWED_TYPES.has(file.mimetype)) return res.status(400).json({ error: 'Supported attachments: PNG, JPG, WebP, TXT, and DOCX.' });
  const spice = toneOf(req.body?.spice);
  const activity = ['chat', 'rage'].includes(req.body?.activity) ? req.body.activity : 'chat';
  const cleaned = messages
    .filter((m) => m && ['user', 'model'].includes(m.role) && typeof m.text === 'string')
    .slice(-16)
    .map((m) => ({ role: m.role, parts: [{ text: m.text.slice(0, 4000) }] }));
  if (file) {
    const latestUser = [...cleaned].reverse().find((m) => m.role === 'user');
    if (!latestUser) return res.status(400).json({ error: 'Add a message with the attachment.' });
    if (file.mimetype === 'text/plain') latestUser.parts.push({ text: `\n\nAttached file (${file.originalname}):\n${file.buffer.toString('utf8').slice(0, 30000)}` });
    else if (file.mimetype.includes('wordprocessingml')) {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      latestUser.parts.push({ text: `\n\nAttached DOCX (${file.originalname}):\n${result.value.slice(0, 30000)}` });
    } else latestUser.parts.push({ inlineData: { mimeType: file.mimetype, data: file.buffer.toString('base64') } });
  }
  if (!cleaned.length) return res.status(400).json({ error: 'Send a message first.' });
  if (!aiReady()) return res.status(503).json({ error: 'The server has no AI key yet. Add it in Render’s Environment settings, then redeploy.' });

  store.bumpUsage(ownerKey);
  if (user) {
    user.messageCountTotal = (user.messageCountTotal || 0) + 1;
    user.lastSeenAt = new Date().toISOString();
    store.saveUser(user);
  }

  try {
    const result = await generate({
      system: `${SYSTEM}\n\n${TONES[spice]}\n\nCurrent mode: ${activity}. The tone above is a hard upper limit, not a target. For nuanced, serious or complex questions, give the useful answer first and reduce the teasing. Keep replies short and characterful.`,
      contents: cleaned,
      temperature: 0.85,
      maxTokens: 500
    });
    if (!result.ok) {
      store.refundUsage(ownerKey);
      console.error('AI error:', result.error);
      return res.status(result.status || 502).json({ error: result.error });
    }
    res.json({ text: result.text, usage: usageFor(user, guest) });
  } catch (error) {
    store.refundUsage(ownerKey);
    console.error(error);
    res.status(500).json({ error: 'Could not reach the model. Check the server connection and try again.' });
  }
});

const GAME_RULES = {
  balloon: `The user wants you to decide something for them. Reply ONLY with JSON shaped exactly like:
{"intro":"one short deadpan line setting up the choice","options":["answer one","answer two","answer three"]}
Each option must be a genuine, usable answer to their request, at most four words, no numbering, no quotes inside.
The intro must be one sentence, dry and impatient, and must not reveal any of the options.`,
  riddle: `Invent one short, funny, solvable riddle. Reply ONLY with JSON shaped exactly like:
{"question":"the riddle, one or two sentences","options":["option a","option b","option c"],"answer":0,"sting":"one dry line for when they get it right","burn":"one dry line for when they get it wrong"}
"answer" is the 0-based index of the correct option. Options are at most six words each. Keep it playful, never cruel.`
};

app.post('/api/game', async (req, res) => {
  const user = auth.currentUser(req);
  const guest = auth.guestId(req, res);
  const ownerKey = user ? user.id : guest;
  const type = req.body?.type === 'riddle' ? 'riddle' : 'balloon';

  if (type === 'riddle' && user?.plan !== 'pro') {
    return res.status(402).json({
      error: 'Riddles are a Pro toy. Amani does not hand out puzzles to people who have not paid.',
      code: 'pro_required'
    });
  }

  const usage = usageFor(user, guest);
  if (usage.limit !== null && usage.remaining <= 0) {
    return res.status(402).json({
      error: user
        ? `That is all ${FREE_DAILY} of your free messages for today. Pro removes the limit entirely. Your count resets tomorrow.`
        : `Guests get ${GUEST_DAILY} messages a day and you have used all ${GUEST_DAILY}. Create a free account for ${FREE_DAILY} a day, or go Pro for unlimited.`,
      code: 'quota',
      usage
    });
  }
  if (!aiReady()) return res.status(503).json({ error: 'The server has no AI key yet.' });

  const ask = String(req.body?.prompt || '').slice(0, 400).trim();
  if (type === 'balloon' && !ask) return res.status(400).json({ error: 'Ask me to decide something first.' });

  store.bumpUsage(ownerKey);
  try {
    const result = await generate({
      system: `${SYSTEM}\n\n${TONES[toneOf(req.body?.spice)]}\n\n${GAME_RULES[type]}`,
      contents: [{ role: 'user', parts: [{ text: type === 'balloon' ? ask : 'Give me a riddle.' }] }],
      json: true,
      temperature: 1,
      maxTokens: 400
    });
    if (!result.ok) {
      store.refundUsage(ownerKey);
      console.error('AI game error:', result.error);
      return res.status(result.status || 502).json({ error: result.error });
    }
    const raw = result.text;
    let data = null;
    try { data = JSON.parse(raw); } catch { data = null; }

    const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    if (type === 'balloon') {
      const options = Array.isArray(data?.options) ? data.options.map((o) => clean(o, 60)).filter(Boolean).slice(0, 3) : [];
      if (options.length !== 3) {
        store.refundUsage(ownerKey);
        return res.status(502).json({ error: 'That produced nonsense. Try asking again.' });
      }
      return res.json({
        type: 'balloon',
        intro: clean(data.intro, 180) || 'Three options. You get one. Choose.',
        options,
        usage: usageFor(user, guest)
      });
    }
    const options = Array.isArray(data?.options) ? data.options.map((o) => clean(o, 60)).filter(Boolean).slice(0, 3) : [];
    const answer = Number(data?.answer);
    const question = clean(data?.question, 300);
    if (!question || options.length !== 3 || !Number.isInteger(answer) || answer < 0 || answer > 2) {
      store.refundUsage(ownerKey);
      return res.status(502).json({ error: 'The riddle came out broken. Try again.' });
    }
    return res.json({
      type: 'riddle',
      question,
      options,
      answer,
      sting: clean(data.sting, 160) || 'Correct. Do not let it go to your head.',
      burn: clean(data.burn, 160) || 'Wrong. Confidently wrong, which is worse.',
      usage: usageFor(user, guest)
    });
  } catch (error) {
    store.refundUsage(ownerKey);
    console.error(error);
    return res.status(500).json({ error: 'Could not reach the model. Try again.' });
  }
});

app.post('/api/admin/login', (req, res) => {
  if (!process.env.ADMIN_KEY) return res.status(501).json({ error: 'Set ADMIN_KEY first.' });
  if (String(req.body?.key || '') !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Wrong admin key.' });
  auth.grantAdmin(res);
  res.json({ ok: true });
});

app.get('/api/admin/overview', (req, res) => {
  if (!auth.isAdmin(req)) return res.status(401).json({ error: 'Admin sign-in required.' });
  res.json({ ...store.snapshot(), billing: billingStatus(), storage: { mode: store.label, durable: store.durable } });
});

app.get('/api/admin/people', (req, res) => {
  if (!auth.isAdmin(req)) return res.status(401).json({ error: 'Admin sign-in required.' });
  res.json({ people: store.people() });
});

app.post('/api/admin/grant', (req, res) => {
  if (!auth.isAdmin(req)) return res.status(401).json({ error: 'Admin sign-in required.' });
  const email = normalizeEmail(req.body?.email);
  const user = store.userByEmail(email);
  if (!user) return res.status(404).json({ error: 'No account with that email.' });
  user.plan = req.body?.plan === 'free' ? 'free' : 'pro';
  if (user.plan === 'free') user.theme = 'acid';
  if (user.plan === 'pro') user.planExpiresAt = null;
  store.saveUser(user);
  res.json({ ok: true, email: user.email, plan: user.plan });
});

app.get('/privacy', (_, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (_, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mr Rage Bait listening on ${PORT}`);
});

// Render sends SIGTERM before every redeploy and spin-down.
// Save anything still in memory before the process disappears.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    try { await store.close(); console.log('[store] saved before shutdown'); }
    catch (error) { console.error('[store] shutdown save failed:', error.message); }
    process.exit(0);
  });
}

function appUrl() {
  return String(process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
}

function authState(req, res) {
  const state = randomToken();
  appendCookie(res, 'mrb_oauth', state, { maxAge: 600 });
  return state;
}

function tooManyLogins(req) {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'local';
  const now = Date.now();
  const row = loginAttempts.get(ip) || { count: 0, start: now };
  if (now - row.start > 10 * 60 * 1000) {
    row.count = 0;
    row.start = now;
  }
  row.count += 1;
  loginAttempts.set(ip, row);
  return row.count > 20;
}

async function handleStripeEvent(event) {
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id || session.metadata?.userId;
    const presentment = session.presentment_details || {};
    applyCheckout({
      store,
      userId,
      provider: 'stripe',
      customerId: session.customer,
      subscriptionId: session.subscription,
      currency: (presentment.presentment_currency || session.currency || '').toUpperCase(),
      amount: presentment.presentment_amount || session.amount_total,
      expiresAt: null
    });
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const userId = sub.metadata?.userId || store.findUser((user) => user.stripeSubscriptionId === sub.id)?.id;
    if (userId) cancelPlan(store, userId, 'stripe');
  }
}

async function handlePaystackEvent(event) {
  if (event.event === 'charge.success') {
    const data = event.data;
    const userId = data.metadata?.userId;
    applyCheckout({
      store,
      userId,
      provider: 'paystack',
      customerId: data.customer?.customer_code,
      currency: data.currency,
      amount: data.amount,
      expiresAt: new Date(Date.now() + 31 * 86400000).toISOString()
    });
  }
}
