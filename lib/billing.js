import crypto from 'node:crypto';
import { quoteFor } from './geo.js';

/* ------------------------------------------------------------------
   Payments: Yoco only.

   Flow (Checkout API):
     1. startCheckout()     -> POST /api/checkouts, user pays on Yoco's page
     2. Yoco webhook        -> POST /api/billing/webhook/yoco (payment.succeeded)
                              signature-verified, credits the 30-day pass
     3. Browser returns     -> /?upgraded=pending and the front-end polls /api/me
                              until the webhook lands (usually < 2s)

   There is no subscription. A payment buys 30 days, stacked on any
   days the user still has, and renewing is just buying another pass.
------------------------------------------------------------------- */

export const PASS_DAYS = 30;

export function billingStatus() {
  const yoco = Boolean(process.env.YOCO_SECRET_KEY);
  return { yoco, provider: yoco ? 'yoco' : null, ready: yoco };
}

function appUrl() {
  return String(process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function timingEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function yocoRequest(path, body, method = 'POST') {
  const response = await fetch(`https://payments.yoco.com/api/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.YOCO_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `Yoco request failed (${response.status}).`;
    throw new Error(message);
  }
  return data;
}

export async function startCheckout({ user, store }) {
  const quote = quoteFor(user.country);
  const status = billingStatus();
  if (!status.ready) {
    store.addEvent({
      userId: user.id,
      type: 'checkout_started',
      country: quote.country || user.country,
      currency: quote.currency,
      amount: quote.amount,
      provider: 'pending',
      meta: { reason: 'no_provider_configured' }
    });
    return {
      url: null,
      pending: true,
      quote,
      message: 'Your interest is logged. Add a free Yoco secret key to turn this into a real checkout.'
    };
  }

  const checkout = await yocoRequest('checkouts', {
    amount: quote.amount,
    currency: quote.currency,
    successUrl: `${appUrl()}/?upgraded=pending`,
    cancelUrl: `${appUrl()}/?checkout=cancel`,
    failureUrl: `${appUrl()}/?checkout=failed`,
    metadata: { userId: user.id, plan: `pro-${PASS_DAYS}d` },
    clientReferenceId: user.id
  });

  // Remember which checkouts belong to this user so a webhook with no
  // readable metadata can still be matched back to them.
  user.yocoCheckouts = [...(user.yocoCheckouts || []), checkout.id].filter(Boolean).slice(-10);
  user.currency = quote.currency;
  store.saveUser(user);

  store.addEvent({
    userId: user.id,
    type: 'checkout_started',
    country: quote.country || user.country,
    currency: quote.currency,
    amount: quote.amount,
    provider: 'yoco'
  });

  return { url: checkout.redirectUrl, pending: false, quote, provider: 'yoco' };
}

/**
 * Verify a Yoco webhook exactly the way their docs specify:
 * HMAC-SHA256 over "{webhook-id}.{webhook-timestamp}.{rawBody}",
 * base64-encoded, key = the whsec_ secret with its prefix stripped.
 * The timestamp check (3 minutes) blocks replay attacks.
 *
 * @returns the parsed event, or null if it fails verification.
 */
export function verifyYocoSignature(rawBody, headers = {}) {
  const secret = process.env.YOCO_WEBHOOK_SECRET;
  const id = headers['webhook-id'];
  const timestamp = Number(headers['webhook-timestamp']);
  const signature = headers['webhook-signature'];
  if (!secret || !id || !timestamp || !signature) return null;
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 180) return null;

  let secretBytes;
  try {
    secretBytes = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  } catch {
    return null;
  }
  const expected = crypto
    .createHmac('sha256', secretBytes)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');

  const candidates = String(signature)
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^v\d+,/, ''));
  if (!candidates.some((candidate) => timingEqual(candidate, expected))) return null;

  try { return JSON.parse(rawBody); } catch { return null; }
}

/**
 * Match a Yoco payment back to one of our users. Prefers the metadata
 * we set at checkout creation; falls back to the checkout-id map we
 * keep on the user record.
 */
export function userForYocoPayment(store, payment) {
  const meta = payment?.metadata || {};
  if (meta.userId) {
    const direct = store.userById(String(meta.userId));
    if (direct) return direct;
  }
  const checkoutId = meta.checkoutId || payment?.checkoutId || null;
  if (!checkoutId) return null;
  return store.findUser((user) => Array.isArray(user.yocoCheckouts) && user.yocoCheckouts.includes(checkoutId));
}

export function applyCheckout({ store, userId, provider, country, currency, amount, expiresAt, extendDays = PASS_DAYS, reference }) {
  const user = store.userById(userId);
  if (!user) return null;

  // One payment reaches us at most twice (webhook + anything else).
  // Credit it only the first time.
  if (reference) {
    const seen = Array.isArray(user.paymentRefs) ? user.paymentRefs : [];
    if (seen.includes(reference)) return user;
    user.paymentRefs = [...seen, reference].slice(-20);
  }

  user.plan = 'pro';
  if (country) user.country = country;
  if (currency) user.currency = currency;
  if (extendDays) {
    // If they still have days left, add to them instead of wiping them.
    const now = Date.now();
    const current = user.planExpiresAt ? Date.parse(user.planExpiresAt) : 0;
    const base = Number.isFinite(current) && current > now ? current : now;
    user.planExpiresAt = new Date(base + extendDays * 86400000).toISOString();
  } else {
    user.planExpiresAt = expiresAt || null;
  }
  store.saveUser(user);
  store.addEvent({
    userId: user.id,
    type: 'checkout_completed',
    country: country || user.country,
    currency: currency || user.currency,
    amount: amount || null,
    provider
  });
  return user;
}
