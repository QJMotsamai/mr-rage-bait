import crypto from 'node:crypto';
import { quoteFor } from './geo.js';

export function billingStatus() {
  const stripe = Boolean(process.env.STRIPE_SECRET_KEY);
  const paystack = Boolean(process.env.PAYSTACK_SECRET_KEY);
  let provider = null;
  if (stripe && paystack) provider = 'auto';
  else if (stripe) provider = 'stripe';
  else if (paystack) provider = 'paystack';
  return { stripe, paystack, provider, ready: stripe || paystack };
}

export function pickProvider(country) {
  const status = billingStatus();
  if (status.provider === 'auto') {
    return ['ZA', 'NG', 'GH', 'KE', 'CI'].includes(country) ? 'paystack' : 'stripe';
  }
  return status.provider;
}

function appUrl() {
  return String(process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function hmac(secret, value, algo = 'sha256') {
  return crypto.createHmac(algo, secret).update(value).digest('hex');
}

function timingEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function stripeForm(path, body) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || 'Stripe request failed.');
  return data;
}

async function paystackRequest(path, body, method = 'POST') {
  const response = await fetch(`https://api.paystack.co/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  if (!response.ok || data.status === false) throw new Error(data?.message || 'Paystack request failed.');
  return data;
}

export async function startCheckout({ user, country, store }) {
  const quote = quoteFor(country);
  const provider = pickProvider(quote.country);
  if (!provider) {
    store.addEvent({
      userId: user.id,
      type: 'checkout_started',
      country: quote.country,
      currency: quote.currency,
      amount: quote.amount,
      provider: 'pending',
      meta: { reason: 'no_provider_configured' }
    });
    return {
      url: null,
      pending: true,
      quote,
      message: 'Your interest is logged. Add a free Paystack secret key to charge this person in their local currency.'
    };
  }

  store.addEvent({
    userId: user.id,
    type: 'checkout_started',
    country: quote.country,
    currency: quote.currency,
    amount: quote.amount,
    provider
  });

  user.country = quote.country || user.country;
  user.currency = quote.currency;
  store.saveUser(user);

  if (provider === 'stripe') {
    const params = {
      mode: 'subscription',
      success_url: `${appUrl()}/?upgraded=1`,
      cancel_url: `${appUrl()}/?checkout=cancel`,
      client_reference_id: user.id,
      'adaptive_pricing[enabled]': 'true',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': quote.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(quote.amount),
      'line_items[0][price_data][recurring][interval]': 'month',
      'line_items[0][price_data][product_data][name]': 'Mr Rage Bait Pro',
      'line_items[0][price_data][product_data][description]': 'Unlimited chat, billed in your local currency.',
      'metadata[userId]': user.id,
      'subscription_data[metadata][userId]': user.id
    };
    if (user.stripeCustomerId) params.customer = user.stripeCustomerId;
    else params.customer_email = user.email;
    const session = await stripeForm('checkout/sessions', params);
    return { url: session.url, pending: false, quote, provider: 'stripe' };
  }

  const init = await paystackRequest('transaction/initialize', {
    email: user.email,
    amount: quote.amount,
    currency: quote.currency,
    callback_url: `${appUrl()}/api/billing/paystack/callback`,
    metadata: {
      userId: user.id,
      plan: 'pro',
      custom_fields: [
        { display_name: 'Product', variable_name: 'product', value: 'Mr Rage Bait Pro' }
      ]
    }
  });
  return { url: init.data.authorization_url, pending: false, quote, provider: 'paystack' };
}

export async function stripePortal(user) {
  if (!user.stripeCustomerId) throw new Error('No Stripe customer on this account yet.');
  const session = await stripeForm('billing_portal/sessions', {
    customer: user.stripeCustomerId,
    return_url: appUrl()
  });
  return session.url;
}

export function verifyStripeSignature(rawBody, signature, secret) {
  if (!signature || !secret) return null;
  const parts = Object.fromEntries(signature.split(',').map((item) => item.split('=')));
  const expected = hmac(secret, `t=${parts.t}.${rawBody}`);
  const candidates = [parts.v1, parts.v0].filter(Boolean);
  if (!candidates.some((item) => timingEqual(item, expected))) return null;
  try { return JSON.parse(rawBody); } catch { return null; }
}

export function verifyPaystackSignature(rawBody, signature) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret || !signature) return false;
  return timingEqual(hmac(secret, rawBody, 'sha512'), signature);
}

export async function verifyPaystackReference(reference) {
  return paystackRequest(`transaction/verify/${encodeURIComponent(reference)}`, null, 'GET');
}

export function applyCheckout({ store, userId, provider, customerId, subscriptionId, country, currency, amount, expiresAt, extendDays, reference }) {
  const user = store.userById(userId);
  if (!user) return null;

  // A single payment reaches us twice: once when the browser returns, and
  // once from the webhook. Credit it only the first time.
  if (reference) {
    const seen = Array.isArray(user.paymentRefs) ? user.paymentRefs : [];
    if (seen.includes(reference)) return user;
    user.paymentRefs = [...seen, reference].slice(-20);
  }

  user.plan = 'pro';
  if (provider === 'stripe') {
    if (customerId) user.stripeCustomerId = customerId;
    if (subscriptionId) user.stripeSubscriptionId = subscriptionId;
  }
  if (provider === 'paystack' && customerId) user.paystackCustomerCode = customerId;
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

export function cancelPlan(store, userId, provider) {
  const user = store.userById(userId);
  if (!user) return null;
  user.plan = 'free';
  if (provider === 'stripe') user.stripeSubscriptionId = null;
  store.saveUser(user);
  store.addEvent({ userId: user.id, type: 'subscription_cancelled', provider: provider || null });
  return user;
}
