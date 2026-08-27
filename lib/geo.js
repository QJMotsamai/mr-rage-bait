/* ------------------------------------------------------------------
   Pricing.

   One price for everyone: R35 once-off for a 30-day Pro pass.
   Yoco (the payment processor) only settles in rand, and this is a
   South-African-first product, so the old per-country price table is
   gone. International cards still work — the user's bank does the
   conversion — but the charge itself is always R35 ZAR.

   Country detection is still here: it is harmless, feeds the owner's
   admin view, and pre-fills user.country for analytics.
------------------------------------------------------------------- */

const CURRENCY = 'ZAR';
const BASE_AMOUNT = 3500; // R35.00, in cents
const INTERVAL_DAYS = 30;

const TZ_COUNTRY = {
  'Africa/Johannesburg': 'ZA',
  'Africa/Maseru': 'LS',
  'Africa/Mbabane': 'SZ',
  'Africa/Windhoek': 'NA',
  'Africa/Lagos': 'NG',
  'Africa/Accra': 'GH',
  'Africa/Nairobi': 'KE',
  'Africa/Cairo': 'EG',
  'Africa/Casablanca': 'MA',
  'Europe/London': 'GB',
  'Europe/Dublin': 'IE',
  'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE',
  'Europe/Amsterdam': 'NL',
  'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT',
  'Europe/Lisbon': 'PT',
  'America/New_York': 'US',
  'America/Chicago': 'US',
  'America/Denver': 'US',
  'America/Los_Angeles': 'US',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
  'Australia/Sydney': 'AU',
  'Australia/Melbourne': 'AU',
  'Asia/Kolkata': 'IN',
  'Asia/Calcutta': 'IN'
};

const LANG_COUNTRY = {
  'en-ZA': 'ZA', 'af-ZA': 'ZA', 'zu-ZA': 'ZA', 'xh-ZA': 'ZA',
  'en-GB': 'GB', 'en-US': 'US', 'en-NG': 'NG', 'en-KE': 'KE',
  'en-GH': 'GH', 'en-AU': 'AU', 'en-CA': 'CA', 'en-IN': 'IN',
  'fr-FR': 'FR', 'de-DE': 'DE', 'nl-NL': 'NL', 'es-ES': 'ES', 'it-IT': 'IT'
};

export function countryFromRequest(req, hint = {}) {
  const header = String(
    req.headers['cf-ipcountry'] ||
    req.headers['x-vercel-ip-country'] ||
    req.headers['x-country-code'] ||
    ''
  ).toUpperCase();
  if (header && header !== 'XX' && header.length === 2) return header;
  if (hint.country && /^[A-Z]{2}$/.test(hint.country)) return hint.country;
  if (hint.timezone && TZ_COUNTRY[hint.timezone]) return TZ_COUNTRY[hint.timezone];
  const locale = String(hint.locale || req.headers['accept-language'] || '').split(',')[0].trim();
  if (LANG_COUNTRY[locale]) return LANG_COUNTRY[locale];
  const langCountry = locale.toUpperCase().match(/-([A-Z]{2})\b/);
  if (langCountry) return langCountry[1];
  return null;
}

function envAmount() {
  const raw = process.env.PRICE_ZAR;
  if (!raw) return null;
  const amount = Number(raw);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function quoteFor(country) {
  const amount = envAmount() || BASE_AMOUNT;
  return {
    country: country || null,
    currency: CURRENCY,
    amount,
    label: formatLabel(CURRENCY, amount),
    interval: `${INTERVAL_DAYS} days`,
    days: INTERVAL_DAYS
  };
}

export function formatLabel(currency, amount) {
  // Whole rands read like the marketing copy does: "R35", not "R 35.00".
  if (currency === 'ZAR' && amount % 100 === 0) return `R${amount / 100}`;
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol'
    }).format(amount / 100);
  } catch {
    return `${amount / 100} ${currency}`;
  }
}

export function publicQuote(quote, billing) {
  return {
    country: quote.country,
    currency: quote.currency,
    amount: quote.amount,
    label: quote.label,
    interval: quote.interval,
    days: quote.days,
    provider: billing.provider,
    ready: billing.ready
  };
}
