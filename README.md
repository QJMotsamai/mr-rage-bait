<div align="center">
  <img src="assets/mr-rage-bait-logo.svg" alt="Mr Rage Bait" width="720" />

  <p><strong>A character-led Gemini chatbot with dry humour, a hard limit on patience, and optional Pro themes.</strong></p>

  <p>
    <a href="https://mr-rage-bait.onrender.com/">Live demo</a>
    ·
    <a href="https://www.linkedin.com/in/qj-motsamai-955596421">LinkedIn</a>
    ·
    <a href="https://youtube.com/@qjmotsamai">YouTube</a>
    ·
    <a href="https://mr-rage-bait.onrender.com/privacy">Privacy</a>
    ·
    <a href="https://mr-rage-bait.onrender.com/terms">Terms</a>
  </p>

  <p>
    <img alt="Node.js" src="https://img.shields.io/badge/Node.js-20+-3C873A?style=flat-square" />
    <img alt="Gemini" src="https://img.shields.io/badge/AI-Google%20Gemini-8E75B2?style=flat-square" />
    <img alt="Paystack" src="https://img.shields.io/badge/Payments-Paystack-00C3F7?style=flat-square" />
    <img alt="Postgres" src="https://img.shields.io/badge/Data-PostgreSQL-336791?style=flat-square" />
  </p>
</div>

---

## What it is

**Mr Rage Bait** is an opt-in parody chatbot. It answers the actual question first, then adds deadpan commentary. Never cruel, never a slur, never punching down — it sets a dry boundary and gets back to being useful.

> “Ask your question. Make it worth the processing power.”

Behind the character sits a complete small product: accounts, a daily free allowance, local-currency checkout, three themes, a privacy policy, and an owner's view of who is actually willing to pay.

Built by **QJ MOTSAMAI**.

## Product

| Free | Pro |
| --- | --- |
| The full Amani chat | Unlimited messages |
| Rage Me / Rage Refund | All three themes |
| Attachments — image, TXT, DOCX | Billed in your own currency |
| Acid Noir theme | |

<img src="assets/themes.svg" alt="Acid Noir, Red Alert, and Midnight Blue theme previews" />

- **Acid Noir** — black + lime. The default. Everyone starts here.
- **Red Alert** — black + red. Pro only.
- **Midnight Blue** — graphite + electric blue. Pro only.

## Stack

| Layer | Choice |
| --- | --- |
| App | Node.js + Express, vanilla HTML/CSS/JS — no build step |
| AI | Google Gemini |
| Payments | Paystack — no monthly fee, works for a South African sole proprietor |
| Data | PostgreSQL, with a JSON-file fallback for local work |
| Host | Render |

No front-end framework and no bundler. The whole client is four static pages.

## How it works

The browser never sees a key. Every Gemini call is proxied by the server, so `GEMINI_API_KEY` stays server-side.

Sessions are random tokens; only a SHA-256 hash is stored. Passwords use `scrypt` with a per-user salt and are compared in constant time.

Payment webhooks are verified before they are trusted — the raw body is checked against an HMAC signature, so a forged "they paid" request is rejected.

State lives in Postgres but is cached in memory and written back on change, which keeps every read instant and the whole storage layer swappable. If the database is unreachable the app logs it, falls back to local storage, and stays online rather than crashing.

## How money moves

1. A guest gets a few messages. Signing in raises the daily allowance.
2. Opening Upgrade records **interested**. Starting checkout records **willing**.
3. Paystack charges in the visitor's local currency — ZAR for South Africa.
4. A verified webhook marks them **paying** and unlocks unlimited chat and the themes.

If no payment key is configured, upgrade clicks still record willingness — so demand is measurable before the money is switched on.

## License and ownership

Copyright © 2026 **QJ MOTSAMAI**. All rights reserved.

This repository is publicly viewable for portfolio and demonstration purposes. It is **not open source**. See [LICENSE](LICENSE).
