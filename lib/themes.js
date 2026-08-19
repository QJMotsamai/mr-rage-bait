export const THEMES = {
  acid: {
    id: 'acid',
    name: 'Acid Noir',
    line: 'Black and lime. The original bad mood.'
  },
  alert: {
    id: 'alert',
    name: 'Red Alert',
    line: 'Black and red. For when lime was too polite.'
  },
  midnight: {
    id: 'midnight',
    name: 'Midnight Blue',
    line: 'Graphite and electric blue. Still impatient. Colder.'
  },
  rose: {
    id: 'rose',
    name: 'Rose Riot',
    line: 'Black and hot pink. Loud, and still not friendly.'
  },
  volt: {
    id: 'volt',
    name: 'High Voltage',
    line: 'Black and yellow. Hazard tape as a lifestyle.'
  }
};

export function normalizeTheme(value) {
  const key = String(value || '').toLowerCase();
  return THEMES[key] ? key : null;
}

export function resolvedTheme(user) {
  if (user?.plan === 'pro' && THEMES[user.theme]) return user.theme;
  return 'acid';
}
