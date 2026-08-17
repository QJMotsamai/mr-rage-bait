<div align="center">
  <img src="assets/mr-rage-bait-logo.svg" alt="Mr Rage Bait" width="720" />

  <p><strong>A sharp, character-led Gemini chatbot with an extreme parody persona.</strong></p>

  <p>
    <a href="https://mr-rage-bait.onrender.com/">Live demo</a> ·
    <a href="https://www.linkedin.com/in/qj-motsamai-955596421">LinkedIn</a> ·
    <a href="https://youtube.com/@qjmotsamai">YouTube</a>
  </p>
</div>

---

## Meet Mr Rage Bait

**Mr Rage Bait** is a web-based AI character experience that combines direct Gemini-powered conversation with a stylised character interface, dry humour, and deliberately unnecessary attitude.

It is designed as an **opt-in parody experience**: useful answers first, then the character’s deadpan commentary. The product does not expose the Gemini key to the browser and keeps API requests behind a server-side endpoint.

> “Ask your question. Make it worth the processing power.”

## Built by QJ MOTSAMAI

Mr Rage Bait was conceived, designed, and built by **QJ MOTSAMAI**.

- **LinkedIn:** [QJ Motsamai](https://www.linkedin.com/in/qj-motsamai-955596421)
- **YouTube:** [@qjmotsamai](https://youtube.com/@qjmotsamai)
- **Live product:** [mr-rage-bait.onrender.com](https://mr-rage-bait.onrender.com/)

## Highlights

- Character-led chat UI featuring **Amani**
- Gemini-powered server-side chat
- Extreme-mode parody persona
- `⚡ Rage Me` prompt generator
- `↺ Rage Refund` conversation reset
- Attachment-ready chat interface for supported images and documents
- Responsive mobile-first design
- Render deployment configuration included

## Stack

| Layer | Technology |
| --- | --- |
| Frontend | HTML, CSS, JavaScript |
| Backend | Node.js + Express |
| AI | Google Gemini API |
| File parsing | Multer + Mammoth |
| Hosting | Render |

## Run locally

### 1. Install dependencies

```bash
npm install
```

### 2. Create a `.env` file

```bash
GEMINI_API_KEY=your_google_ai_studio_key
GEMINI_MODEL=gemini-3.1-flash-lite
```

### 3. Start the app

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Deploy on Render

1. Fork or deploy this repository through Render.
2. Add `GEMINI_API_KEY` under the Render service’s **Environment Variables**.
3. Optional: set `GEMINI_MODEL` to `gemini-3.1-flash-lite`.
4. Deploy.

**Never commit API keys to GitHub.**

## License and ownership

Copyright © 2026 **QJ MOTSAMAI**. All rights reserved.

This repository is publicly viewable for portfolio and demonstration purposes. It is **not open source** and no permission is granted to copy, redistribute, commercialise, or create derivative works from this code, design, brand, or character assets without written permission from QJ Motsamai.

See [LICENSE](LICENSE) for the full terms.
