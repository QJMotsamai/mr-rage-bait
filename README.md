# Mr Rage Bait
![Mr Rage Bait logo](assets/mr-rage-bait-logo.svg)

**Built by QJ MOTSAMAI.**

A deployable 3D-avatar chatbot with an opt-in sharp, deadpan parody tone. It is designed for playful banter, not escalating or targeting people who are genuinely upset. The browser talks only to this app's `/api/chat` endpoint; the Gemini key remains on the server.

> **Cost note**: Render's free web service and Gemini's free quota are subject to each provider's limits and changes. They are suitable for a personal prototype, not a "free forever" guarantee. A custom domain also costs money.

## Run locally

1. Install Node 20+.
2. Copy `.env.example` to `.env` and put in a Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey).
3. Run:

```bash
npm install
set -a; source .env; set +a
npm start
```

Open `http://localhost:3000`.

## Deploy to Render

1. Create a new empty GitHub repository called `mr-rage-bait`.
2. Push this folder using the commands below.
3. In Render, choose **New → Blueprint**, connect the repository, and select it. Render will read `render.yaml`.
4. Add a secret environment variable named `GEMINI_API_KEY` with your key. Do **not** add it to GitHub.
5. Deploy. Render supplies the public URL.

## GitHub commands

```bash
cd mr-rage-bait
git init
git add .
git commit -m "Build Mr Rage Bait chatbot"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/mr-rage-bait.git
git push -u origin main
```

## Change the personality

Edit the `SYSTEM` constant in `server.js`. Keep the answer-quality instruction early in the prompt: personality should not replace a helpful answer.
