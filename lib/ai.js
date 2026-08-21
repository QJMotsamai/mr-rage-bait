/* ------------------------------------------------------------------
   One place that talks to a model.

   AI_PROVIDER=google      (default) -> Google Gemini directly
   AI_PROVIDER=openrouter            -> OpenRouter, prepaid credits

   Everything else in the app speaks Google's shape. This file
   translates when needed, so switching provider is one env var and
   no code change.
------------------------------------------------------------------- */

export function aiProvider() {
  return String(process.env.AI_PROVIDER || 'google').toLowerCase() === 'openrouter'
    ? 'openrouter' : 'google';
}

export function aiModel() {
  return aiProvider() === 'openrouter'
    ? (process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite')
    : (process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite');
}

export function aiKey() {
  return aiProvider() === 'openrouter'
    ? process.env.OPENROUTER_API_KEY
    : process.env.GEMINI_API_KEY;
}

export function aiReady() {
  return Boolean(aiKey());
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

/**
 * @returns {Promise<{ok:boolean, text?:string, error?:string, status?:number}>}
 */
export async function generate({ system, contents, json = false, maxTokens = 500, temperature = 0.85 }) {
  const key = aiKey();
  if (!key) return { ok: false, status: 503, error: 'The server has no AI key yet.' };

  if (aiProvider() === 'openrouter') {
    const body = {
      model: aiModel(),
      messages: toOpenAI(system, contents),
      temperature,
      max_tokens: maxTokens
    };
    if (json) body.response_format = { type: 'json_object' };
    let response, payload;
    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL || 'https://mr-rage-bait.onrender.com',
          'X-Title': 'Mr Rage Bait'
        },
        body: JSON.stringify(body)
      });
      payload = await response.json();
    } catch (error) {
      return { ok: false, status: 500, error: 'Could not reach OpenRouter.' };
    }
    if (response.status === 429) {
      return { ok: false, status: 429, error: 'I have hit my rate limit. Give it a minute.' };
    }
    if (response.status === 402) {
      return { ok: false, status: 402, error: 'The owner has run out of credits. Nothing personal.' };
    }
    if (!response.ok) {
      return { ok: false, status: 502, error: payload?.error?.message || 'OpenRouter refused that request.' };
    }
    const text = payload?.choices?.[0]?.message?.content;
    const out = typeof text === 'string' ? text.trim()
      : Array.isArray(text) ? text.map((c) => c?.text || '').join('').trim() : '';
    if (!out) return { ok: false, status: 502, error: 'OpenRouter returned no text. Try again.' };
    return { ok: true, text: out };
  }

  // ---- Google Gemini ----
  const generationConfig = { temperature, maxOutputTokens: maxTokens };
  if (json) generationConfig.responseMimeType = 'application/json';
  let response, payload;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(aiModel())}:generateContent?key=${encodeURIComponent(key)}`,
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
    payload = await response.json();
  } catch (error) {
    return { ok: false, status: 500, error: 'Could not reach Gemini.' };
  }
  if (response.status === 429) {
    return { ok: false, status: 429, error: 'I have hit my daily thinking limit. Come back tomorrow, or tell the owner to top up.' };
  }
  if (!response.ok) {
    return { ok: false, status: 502, error: payload?.error?.message || 'Gemini did not accept that request.' };
  }
  const text = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
  if (!text) return { ok: false, status: 502, error: 'Gemini returned no text. Try again.' };
  return { ok: true, text };
}
