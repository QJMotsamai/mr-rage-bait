export const CHARACTERS = {
  amani: {
    id: 'amani',
    name: 'Amani',
    line: 'The original. Blunt, bored, mildly disappointed in you.',
    avatar: 'amani-blindfold-avatar.png',
    head: 'amani-head.png'
  },
  zola: {
    id: 'zola',
    name: 'Zola',
    line: 'Calm, precise, and quietly unimpressed.',
    avatar: 'zola-avatar.png',
    head: 'zola-head.png'
  },
  neo: {
    id: 'neo',
    name: 'Neo',
    line: 'Dry, fast, and allergic to small talk.',
    avatar: 'neo-avatar.png',
    head: 'neo-head.png'
  }
};

export function normalizeCharacter(value) {
  const key = String(value || '').toLowerCase();
  return CHARACTERS[key] ? key : null;
}

export function resolvedCharacter(user) {
  if (user?.plan === 'pro' && CHARACTERS[user.character]) return user.character;
  return 'amani';
}
