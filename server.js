cat > ~/Downloads/omnichat/server.js << 'ENDOFFILE'
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const MODELS = {
  'claude-sonnet-4-5':       { provider: 'anthropic', label: 'Claude Sonnet 4.5',    paid: true },
  'claude-haiku-3-5':        { provider: 'anthropic', label: 'Claude Haiku 3.5',     paid: true },
  'gpt-4o':                  { provider: 'openai',    label: 'GPT-4o',               paid: true },
  'gpt-4o-mini':             { provider: 'openai',    label: 'GPT-4o Mini',          paid: true },
  'gemini-2.0-flash':        { provider: 'gemini',    label: 'Gemini 2.0 Flash',     paid: false },
  'gemini-1.5-pro':          { provider: 'gemini',    label: 'Gemini 1.5 Pro',       paid: false },
  'llama3-70b-8192':         { provider: 'groq',      label: 'Llama 3 70B (Groq)',   paid: false },
  'llama3-8b-8192':          { provider: 'groq',      label: 'Llama 3 8B (Groq)',    paid: false },
  'gemma2-9b-it':            { provider: 'groq',      label: 'Gemma 2 9B (Groq)',    paid: false },
  'meta-llama/llama-3.1-8b-instruct:free':   { provider: 'openrouter', label: 'Llama 3.1 8B (free)',   paid: false },
  'google/gemma-3-12b-it:free':              { provider: 'openrouter', label: 'Gemma 3 12B (free)',    paid: false },
  'mistralai/mistral-7b-instruct:free':      { provider: 'openrouter', label: 'Mistral 7B (free)',     paid: false },
};

app.get('/api/models', (req, res) => {
  const list = Object.entries(MODELS).map(([id, info]) => ({
    id, label: info.label, provider: info.provider, paid: info.paid, available: hasKey(info.provider),
  }));
  res.json(list);
});

function hasKey(provider) {
  switch (provider) {
    case 'anthropic':   return !!process.env.ANTHROPIC_API_KEY;
    case 'openai':      return !!process.env.OPENAI_API_KEY;
    case 'gemini':      return !!process.env.GEMINI_API_KEY;
    case 'groq':        return !!process.env.GROQ_API_KEY;
    case 'openrouter':  return !!process.env.OPENROUTER_API_KEY;
    default:            return false;
  }
}

app.post('/api/chat', async (req, res) => {
  const { model, messages, system } = req.body;
  if (!model || !messages) return res.status(400).json({ error: 'model e messages são obrigatórios' });
  const info = MODELS[model];
  if (!info) return res.status(400).json({ error: 'Modelo desconhecido: ' + model });
  if (!hasKey(info.provider)) return res.status(401).json({ error: `Configure a chave de API para ${info.provider} no arquivo .env` });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    switch (info.provider) {
      case 'anthropic': await streamAnthropic(model, messages, system, res); break;
      case 'openai':    await streamOpenAI(model, messages, system, res); break;
      case 'gemini':    await streamGemini(model, messages, system, res); break;
      case 'groq':      await streamOpenAICompat(model, messages, system, res, 'https://api.groq.com/openai/v1', process.env.GROQ_API_KEY); break;
      case 'openrouter':await streamOpenAICompat(model, messages, system, res, 'https://openrouter.ai/api/v1', process.env.OPENROUTER_API_KEY); break;
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

async function streamAnthropic(model, messages, system, res) {
  const body = { model, max_tokens: 4096, stream: true, messages };
  if (system) body.system = system;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const err = await r.text(); throw new Error(`Anthropic: ${r.status} ${err}`); }
  for await (const chunk of r.body) {
    const lines = chunk.toString().split('\n').filter(l => l.startsWith('data:'));
    for (const line of lines) {
      const data = line.slice(5).trim();
      if (data === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
      try {
        const json = JSON.parse(data);
        if (json.type === 'content_block_delta' && json.delta?.text) res.write(`data: ${JSON.stringify({ text: json.delta.text })}\n\n`);
        if (json.type === 'message_stop') res.write('data: [DONE]\n\n');
      } catch {}
    }
  }
  res.end();
}

async function streamOpenAI(model, messages, system, res) {
  await streamOpenAICompat(model, messages, system, res, 'https://api.openai.com/v1', process.env.OPENAI_API_KEY);
}

async function streamOpenAICompat(model, messages, system, res, baseUrl, apiKey) {
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'OmniChat' },
    body: JSON.stringify({ model, messages: msgs, stream: true }),
  });
  if (!r.ok) { const err = await r.text(); throw new Error(`${baseUrl}: ${r.status} ${err}`); }
  for await (const chunk of r.body) {
    const lines = chunk.toString().split('\n').filter(l => l.startsWith('data:'));
    for (const line of lines) {
      const data = line.slice(5).trim();
      if (data === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
      try {
        const json = JSON.parse(data);
        const text = json.choices?.[0]?.delta?.content;
        if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
      } catch {}
    }
  }
  res.end();
}

async function streamGemini(model, messages, system, res) {
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${process.env.GEMINI_API_KEY}&alt=sse`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { const err = await r.text(); throw new Error(`Gemini: ${r.status} ${err}`); }
  for await (const chunk of r.body) {
    const lines = chunk.toString().split('\n').filter(l => l.startsWith('data:'));
    for (const line of lines) {
      const data = line.slice(5).trim();
      try {
        const json = JSON.parse(data);
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
      } catch {}
    }
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 OmniChat rodando em http://localhost:${PORT}\n`);
  ['anthropic', 'openai', 'gemini', 'groq', 'openrouter'].forEach(p => console.log(`  ${hasKey(p) ? '✅' : '❌'} ${p}`));
});
ENDOFFILE