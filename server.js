import express from 'express';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './knowledgeBase.js';
import {
  addMessage,
  getHistoryForClaude,
  isPaused,
  setPaused,
  listConversations,
  getConversation,
} from './storage.js';

dotenv.config();

const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  ANTHROPIC_API_KEY,
  INBOX_USER = 'admin',
  INBOX_PASSWORD = 'troque-esta-senha',
  PORT = 3000,
} = process.env;

if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !VERIFY_TOKEN || !ANTHROPIC_API_KEY) {
  console.warn('Aviso: alguma variável de ambiente está faltando. Confira o arquivo .env.');
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ───────────────────────── WEBHOOK (WhatsApp) ─────────────────────────

// 1) Verificação do webhook — a Meta chama esse GET quando você configura a URL no painel.
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2) Recebimento de mensagens do WhatsApp
app.post('/webhook', async (req, res) => {
  // Responde rápido pra Meta não reenviar o mesmo evento
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message || message.type !== 'text') return;

    const from = message.from; // número de quem mandou (formato internacional, sem "+")
    const text = message.text.body;

    addMessage(from, 'user', text);

    // Se a conversa estiver pausada (alguém da equipe assumiu manualmente),
    // o bot só guarda a mensagem e não responde sozinho.
    if (isPaused(from)) {
      console.log(`Conversa com ${from} está pausada — aguardando resposta humana.`);
      return;
    }

    const reply = await askClaude(from);
    addMessage(from, 'bot', reply);
    await sendWhatsAppMessage(from, reply);
  } catch (err) {
    console.error('Erro ao processar mensagem recebida:', err);
  }
});

async function askClaude(phone) {
  const history = getHistoryForClaude(phone);
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: history,
    });
    const text = response.content?.[0]?.text?.trim();
    return text || 'Desculpa, não consegui entender agora. Pode reformular sua pergunta?';
  } catch (err) {
    console.error('Erro ao chamar a API da Anthropic:', err);
    return 'Tivemos um probleminha técnico aqui. Pode tentar de novo em instantes?';
  }
}

async function sendWhatsAppMessage(to, body) {
  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Erro ao enviar mensagem pelo WhatsApp:', response.status, errorText);
  }
}

// ───────────────────────── CAIXA DE ENTRADA (painel manual) ─────────────────────────
// Protegida por usuário/senha (defina INBOX_USER e INBOX_PASSWORD no .env).

function inboxAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const [scheme, encoded] = authHeader.split(' ');

  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const sepIndex = decoded.indexOf(':');
    const user = decoded.slice(0, sepIndex);
    const pass = decoded.slice(sepIndex + 1);

    if (user === INBOX_USER && pass === INBOX_PASSWORD) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Caixa de entrada 6Tem"');
  return res.status(401).send('Autenticação necessária.');
}

app.use('/inbox', inboxAuth);

function escapeHtml(str = '') {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:24px}
  a{color:#18C964;text-decoration:none}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-bottom:12px}
  .card:hover{border-color:#18C964}
  .badge{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:100px;background:#fee2e2;color:#b91c1c;margin-left:8px}
  .msg{padding:10px 14px;border-radius:10px;margin-bottom:8px;max-width:70%}
  .msg.user{background:#e2e8f0;margin-right:auto}
  .msg.bot{background:#d1fae5;margin-left:auto;text-align:right}
  .msg.human{background:#dbeafe;margin-left:auto;text-align:right}
  .meta{font-size:11px;color:#64748b;margin-top:2px}
  textarea{width:100%;padding:10px;border-radius:8px;border:1px solid #cbd5e1;font-family:inherit}
  button{background:#18C964;color:#fff;border:none;padding:10px 20px;border-radius:100px;font-weight:600;cursor:pointer;margin-top:8px}
  button.secondary{background:#64748b}
  h1{font-size:20px}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

// Lista de conversas
app.get('/inbox', (_req, res) => {
  const conversations = listConversations();
  const items = conversations
    .map((c) => {
      const date = c.lastTimestamp ? new Date(c.lastTimestamp).toLocaleString('pt-BR') : '';
      return `
      <a class="card" style="display:block" href="/inbox/${encodeURIComponent(c.phone)}">
        <strong>${escapeHtml(c.phone)}</strong>
        ${c.paused ? '<span class="badge">Pausado (humano)</span>' : ''}
        <div class="meta">${date} · ${c.totalMessages} mensagens</div>
        <div>${escapeHtml(c.lastText).slice(0, 120)}</div>
      </a>`;
    })
    .join('');

  res.send(
    layout(
      'Caixa de entrada — Método 6Tem',
      `<h1>Conversas</h1>${items || '<p>Nenhuma conversa ainda.</p>'}`
    )
  );
});

// Conversa individual + responder manualmente
app.get('/inbox/:phone', (req, res) => {
  const { phone } = req.params;
  const conv = getConversation(phone);

  const messages = conv.messages
    .map((m) => {
      const date = new Date(m.timestamp).toLocaleString('pt-BR');
      return `<div class="msg ${m.role}">${escapeHtml(m.text)}<div class="meta">${m.role} · ${date}</div></div>`;
    })
    .join('');

  res.send(
    layout(
      `Conversa com ${phone}`,
      `
      <p><a href="/inbox">← Voltar</a></p>
      <h1>${escapeHtml(phone)} ${conv.paused ? '<span class="badge">Pausado (humano)</span>' : ''}</h1>
      <div>${messages || '<p>Sem mensagens.</p>'}</div>

      <form method="POST" action="/inbox/${encodeURIComponent(phone)}/reply">
        <textarea name="text" rows="3" placeholder="Escreva sua resposta..." required></textarea>
        <button type="submit">Enviar como humano</button>
      </form>

      <form method="POST" action="/inbox/${encodeURIComponent(phone)}/toggle" style="display:inline">
        <button type="submit" class="secondary">${conv.paused ? 'Reativar o bot' : 'Pausar o bot (assumir a conversa)'}</button>
      </form>
      `
    )
  );
});

// Responder manualmente (pausa o bot automaticamente para essa conversa)
app.post('/inbox/:phone/reply', async (req, res) => {
  const { phone } = req.params;
  const { text } = req.body;

  if (text && text.trim()) {
    await sendWhatsAppMessage(phone, text.trim());
    addMessage(phone, 'human', text.trim());
    setPaused(phone, true);
  }

  res.redirect(`/inbox/${encodeURIComponent(phone)}`);
});

// Pausar/reativar o bot para uma conversa específica
app.post('/inbox/:phone/toggle', (req, res) => {
  const { phone } = req.params;
  setPaused(phone, !isPaused(phone));
  res.redirect(`/inbox/${encodeURIComponent(phone)}`);
});

app.get('/', (_req, res) => {
  res.send('Bot do Método 6Tem está no ar. Caixa de entrada em /inbox.');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
