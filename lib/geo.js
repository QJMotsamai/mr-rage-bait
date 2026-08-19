const PRICES = {
  ZAR: { amount: 8900, label: 'R89', name: 'South African rand' },
  USD: { amount: 499, label: '$4.99', name: 'US dollar' },
  EUR: { amount: 449, label: '€4.49', name: 'Euro' },
  GBP: { amount: 399, label: '£3.99', name: 'British pound' },
  NGN: { amount: 750000, label: '₦7,500', name: 'Nigerian naira' },
  KES: { amount: 65000, label: 'KSh 650', name: 'Kenyan shilling' },
  GHS: { amount: 7500, label: 'GH₵75', name: 'Ghanaian cedi' },
  AUD: { amount: 799, label: 'A$7.99', name: 'Australian dollar' },
  CAD: { amount: 699, label: 'C$6.99', name: 'Canadian dollar' },
  INR: { amount: 39900, label: '₹399', name: 'Indian rupee' }
};

const COUNTRY_CURRENCY = {
  ZA: 'ZAR', LS: 'ZAR', SZ: 'ZAR', NA: 'ZAR',
  US: 'USD', PR: 'USD',
  GB: 'GBP',
  NG: 'NGN',
  KE: 'KES',
  GH: 'GHS',
  AU: 'AUD',
  CA: 'CAD',
  IN: 'INR',
  IE: 'EUR', FR: 'EUR', DE: 'EUR', NL: 'EUR', ES: 'EUR', IT: 'EUR',
  PT: 'EUR', BE: 'EUR', AT: 'EUR', FI: 'EUR', GR: 'EUR', SK: 'EUR',
  SI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', LU: 'EUR', MT: 'EUR', CY: 'EUR'
};

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

function envAmount(currency) {
  const raw = process.env[`PRICE_${currency}`];
  if (!raw) return null;
  const amount = Number(raw);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

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

export function quoteFor(country) {
  const currency = COUNTRY_CURRENCY[country] || 'USD';
  const base = PRICES[currency] || PRICES.USD;
  const amount = envAmount(currency) || base.amount;
  const label = formatLabel(currency, amount);
  return {
    country: country || null,
    currency,
    amount,
    label,
    interval: 'month',
    name: base.name
  };
}

export function formatLabel(currency, amount) {
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
    chargedInLocalCurrency: true,
    provider: billing.provider,
    ready: billing.ready
  };
}
