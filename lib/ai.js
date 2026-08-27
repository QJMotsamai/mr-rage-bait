/* ------------------------------------------------------------------
   One place that talks to a model.

   The chain:
     1. Groq  (main)      — GROQ_API_KEY, free tier, very fast.
     2. Google Gemini     — GEMINI_API_KEY, the safety net.

   AI_PROVIDER=auto (default) -> Groq first, Google catches failures
   AI_PROVIDER=groq           -> Groq only
   AI_PROVIDER=google         -> Google only (the old behaviour)

   Two kinds of requests skip Groq entirely, because spending a
   network hop on a guaranteed failure helps nobody:
     - image attachments  (the free Groq text models have no vision)
     - very large prompts (a big document can eat Groq's small
       tokens-per-minute budget in one request)

   Everything else in the app speaks Google's "contents" shape; this
   file translates when needed, so switching the chain is env vars
   and no code change.
------------------------------------------------------------------- */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const HEAVY_TEXT_CHARS = 9000; // ~3k tokens: past this, Groq's TPM budget hurts

export function groqReady() {
  return Boolean(process.env.GROQ_API_KEY);
}

export function googleReady() {
  return Boolean(process.env.GEMINI_API_KEY);
}

export function aiProvider() {
  const picked = String(process.env.AI_PROVIDER || 'auto').toLowerCase();
  if (picked === 'google') return 'google';
  if (picked === 'groq') return 'groq';
  return groqReady() ? 'groq' : 'google';
}

export function aiChain() {
  const chain = [];
  if (groqReady()) chain.push('groq');
  if (googleReady()) chain.push('google');
  return chain.length ? chain : [aiProvider()];
}

export function aiModel() {
  return aiProvider() === 'groq'
    ? (process.env.GROQ_MODEL || 'llama-3.1-8b-instant')
    : (process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite');
}

export function aiKey() {
  return aiProvider() === 'groq'
    ? process.env.GROQ_API_KEY
    : process.env.GEMINI_API_KEY;
}

export function aiReady() {
  return groqReady() || googleReady();
}

/* Google "contents" -> OpenAI "messages" */
function toOpenAI(system, contents) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const row of contents) {
    const role = row.role === 'model' ? 'assistant' : 'user';
    const parts = Array.isArray(row.parts) ? row.parts : [];
    const onlyText = parts.every((p) => typeof p.text === 'string');
    if (onlyText) {
      messages.push({ role, content: parts.map((p) => p.text).join('\n') });
      continue;
    }
    const content = [];
    for (const p of parts) {
      if (typeof p.text === 'string') {
        content.push({ type: 'text', text: p.text });
      } else if (p.inlineData) {
        const uri = `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`;
        if (String(p.inlineData.mimeType).startsWith('image/')) {
          content.push({ type: 'image_url', image_url: { url: uri } });
        }
        // Non-image binaries are not accepted by this app, so nothing else to map.
      }
    }
    messages.push({ role, content });
  }
  return messages;
}

function contentsHaveImage(contents) {
  return contents.some((row) => (row.parts || []).some((p) => p.inlineData));
}

function contentsAreHeavy(contents) {
  const chars = contents.reduce(
    (sum, row) => sum + (row.parts || []).reduce((n, p) => n + (typeof p.text === 'string' ? p.text.length : 0), 0),
    0
  );
  return chars > HEAVY_TEXT_CHARS;
}

/** Which providers should this specific request try, in order? */
function orderFor(contents) {
  const forced = String(process.env.AI_PROVIDER || 'auto').toLowerCase();
  if (forced === 'google') return googleReady() ? ['google'] : [];
  if (forced === 'groq') return groqReady() ? ['groq'] : [];

  const chain = aiChain();
  const image = contentsHaveImage(contents);
  const heavy = contentsAreHeavy(contents);
  if ((image || (heavy && googleReady())) && chain.includes('google')) {
    return ['google'];
  }
  return chain;
}

/**
 * @returns {Promise<{ok:boolean, text?:string, error?:string, status?:number, provider?:string}>}
 */
export async function generate({ system, contents, json = false, maxTokens = 500, temperature = 0.85 }) {
  const order = orderFor(contents);
  if (!order.length) return { ok: false, status: 503, error: 'The server has no AI key yet.' };

  let last = null;
  for (const provider of order) {
    const result = provider === 'groq'
      ? await viaGroq({ system, contents, json, maxTokens, temperature })
      : await viaGoogle({ system, contents, json, maxTokens, temperature });
    if (result.ok) return { ...result, provider };
    last = result;
    // Only fall through on "this provider is unavailable / refused" style
    // failures. Anything the model actually said is a real answer.
    if (result.status === 502 && result.said) return result;
  }
  return last;
}

async function viaGroq({ system, contents, json, maxTokens, temperature }) {
  const body = {
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    messages: toOpenAI(system, contents),
    temperature,
    max_tokens: maxTokens
  };
  if (json) body.response_format = { type: 'json_object' };
  let response, payload;
  try {
    response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    payload = await response.json().catch(() => null);
  } catch (error) {
    return { ok: false, status: 500, error: 'Could not reach Groq.' };
  }
  if (response.status === 429) {
    return { ok: false, status: 429, error: 'Groq rate limit hit. Trying the backup brain.' };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: 502, error: 'The Groq key was refused. Tell the owner to check GROQ_API_KEY.' };
  }
  if (!response.ok) {
    return { ok: false, status: 502, error: payload?.error?.message || 'Groq refused that request.' };
  }
  const text = payload?.choices?.[0]?.message?.content;
  const out = typeof text === 'string' ? text.trim()
    : Array.isArray(text) ? text.map((c) => c?.text || '').join('').trim() : '';
  if (!out) return { ok: false, status: 502, error: 'Groq returned no text. Try again.' };
  return { ok: true, text: out };
}

async function viaGoogle({ system, contents, json, maxTokens, temperature }) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  if (!key) return { ok: false, status: 503, error: 'The server has no Gemini key yet.' };

  const generationConfig = { temperature, maxOutputTokens: maxTokens };
  if (json) generationConfig.responseMimeType = 'application/json';
  let response, payload;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig
        })
      }
    );
    payload = await response.json().catch(() => null);
  } catch (error) {
    return { ok: false, status: 500, error: 'Could not reach Gemini.' };
  }
  if (response.status === 429) {
    return { ok: false, status: 429, error: 'I have hit my daily thinking limit. Come back tomorrow, or tell the owner to top up.' };
  }
  if (/no longer available|not found|is not supported/i.test(payload?.error?.message || '')) {
    return { ok: false, status: 502, error: 'The owner is pointing me at a model that no longer exists. Tell them to change GEMINI_MODEL.' };
  }
  if (!response.ok) {
    return { ok: false, status: 502, error: payload?.error?.message || 'Gemini did not accept that request.' };
  }
  const text = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
  if (!text) return { ok: false, status: 502, error: 'Gemini returned no text. Try again.' };
  return { ok: true, text };
}
