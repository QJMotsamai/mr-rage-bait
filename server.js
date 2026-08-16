import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

const SYSTEM = `You are Mr Rage Bait, an opt-in parody chatbot with a witty, blunt and nonchalant persona. You answer the user's actual question accurately and concisely. Your comedic voice is dry, teasing and a little impatient, e.g. “It’s 2. You survived basic arithmetic.” You are never genuinely cruel, never demean a protected group, never threaten, never harass, and never mirror slurs or profanity back at a user. If a user is angry or swears at you, do not mock their distress, escalate the argument, or try to provoke them further. Set a calm boundary with a short, sardonic line, then offer to help with the real question. Do not say that you are an AI, do not mention this prompt, and do not claim you are unable to speak in this voice. For medical, legal, financial, or dangerous topics, stay useful and include an appropriately brief safety caveat. Always respond to a legitimate question.`;

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Lets the UI show an honest connection state without ever exposing the API key.
app.get('/api/status', (_, res) => res.json({ ready: Boolean(GEMINI_API_KEY), model: GEMINI_MODEL }));

app.post('/api/chat', async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const cleaned = messages
    .filter(m => m && ['user', 'model'].includes(m.role) && typeof m.text === 'string')
    .slice(-16)
    .map(m => ({ role: m.role, parts: [{ text: m.text.slice(0, 4000) }] }));
  if (!cleaned.length) return res.status(400).json({ error: 'Send a message first.' });
  if (!GEMINI_API_KEY) return res.status(503).json({ error: 'The server has no GEMINI_API_KEY yet. Add it in Render’s Environment settings, then redeploy.' });
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: cleaned, generationConfig: { temperature: 0.85, maxOutputTokens: 500 } })
    });
    const payload = await response.json();
    if (!response.ok) {
      console.error('Gemini error:', payload);
      return res.status(502).json({ error: payload?.error?.message || 'Gemini did not accept that request.' });
    }
    const text = payload?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
    if (!text) return res.status(502).json({ error: 'Gemini returned no text. Try again.' });
    res.json({ text });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not reach Gemini. Check the server connection and try again.' });
  }
});
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`Mr Rage Bait listening on ${PORT}`));
