import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
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
  KIWIFY_WEBHOOK_TOKEN,
  PORT = 3000,
} = process.env;

if (!KIWIFY_WEBHOOK_TOKEN) {
  console.warn('Aviso: KIWIFY_WEBHOOK_TOKEN não configurado — o webhook da Kiwify vai aceitar chamadas sem checar token (defina essa variável assim que criar o webhook na Kiwify).');
}

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

// ───────────────────────── WEBHOOK (Kiwify — pós-venda / carrinho abandonado) ─────────────────────────
//
// Configure em: Kiwify → Apps → Webhooks → Criar Webhook
//   URL: https://SEU-APP.onrender.com/webhook/kiwify?token=SEU_KIWIFY_WEBHOOK_TOKEN
//   Eventos: "Compra aprovada" e "Carrinho abandonado"
//   (defina KIWIFY_WEBHOOK_TOKEN no Render com um valor secreto de sua escolha,
//    e use o MESMO valor na URL do webhook lá na Kiwify — isso evita que qualquer
//    pessoa na internet chame essa rota e mande mensagem em nome do seu número)
//
// IMPORTANTE — janela de 24h do WhatsApp: essas mensagens são iniciadas pela empresa
// (a pessoa não mandou "oi" primeiro). O envio abaixo usa texto livre, que só é
// entregue de forma garantida se esse número já tiver uma conversa aberta com o bot
// nas últimas 24h (ex.: veio de um anúncio de Clique-para-WhatsApp e já mandou msg).
// Para clientes que compraram direto pela página de vendas (sem nunca ter mandado
// msg pro bot), a Meta pode bloquear o envio — nesse caso a solução é criar um
// modelo (template) categoria "Utilidade" aprovado pela Meta. Posso te ajudar a
// criar esse template depois; por enquanto o texto livre já cobre quem veio do
// WhatsApp (anúncios, ou quem já conversou antes de comprar).
//
// A Kiwify pode mudar levemente os nomes dos campos do payload. Por segurança,
// o código abaixo tenta vários caminhos possíveis E sempre loga o payload cru,
// pra gente conferir nos logs do Render depois de um "Testar Webhook" real.

function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  digits = digits.replace(/^0+/, '');
  // já tem código do país (55) + DDD + número (12 ou 13 dígitos)
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return digits;
  }
  // só DDD + número (10 ou 11 dígitos) — adiciona o 55
  if (digits.length === 10 || digits.length === 11) {
    return `55${digits}`;
  }
  return digits;
}

function extractKiwifyEvent(body = {}) {
  const eventType =
    body.webhook_event_type ||
    body.order_status ||
    body.event ||
    body.status ||
    '';

  const customer = body.Customer || body.customer || {};
  const name =
    customer.full_name ||
    customer.first_name ||
    customer.name ||
    body.customer_name ||
    body.name ||
    '';

  const phone =
    customer.mobile ||
    customer.phone_number ||
    customer.phone ||
    customer.CustomerPhoneNumber ||
    body.customer_phone ||
    body.phone ||
    '';

  return { eventType: String(eventType).toLowerCase(), name, phone };
}

function isApprovedPurchase(eventType) {
  return ['compra_aprovada', 'order_approved', 'paid', 'approved'].some((k) => eventType.includes(k));
}

function isAbandonedCart(eventType) {
  return ['carrinho_abandonado', 'abandoned_cart', 'abandoned'].some((k) => eventType.includes(k));
}

function buildPurchaseMessage(firstName) {
  const hello = firstName ? `Oi, ${firstName}! ` : 'Oi! ';
  return (
    `${hello}Sua compra do Método 6Tem foi aprovada 🎉\n\n` +
    `O acesso chega no seu e-mail (confira também a caixa de spam). Qualquer dúvida pra acessar o conteúdo ou sobre os módulos, pode falar comigo aqui mesmo que eu te ajudo.`
  );
}

function buildAbandonedCartMessage(firstName) {
  const hello = firstName ? `Oi, ${firstName}! ` : 'Oi! ';
  return (
    `${hello}vi que você chegou a iniciar a compra do Método 6Tem e não finalizou.\n\n` +
    `Ficou alguma dúvida? É pagamento único de R$97, acesso vitalício, e garantia de 7 dias — se não for pra você, devolvemos o valor. Se quiser, me conta o que travou que eu te ajudo a decidir.`
  );
}

app.post('/webhook/kiwify', async (req, res) => {
  // Responde rápido pra Kiwify não reenviar o mesmo evento
  res.sendStatus(200);

  try {
    if (KIWIFY_WEBHOOK_TOKEN && req.query.token !== KIWIFY_WEBHOOK_TOKEN) {
      console.warn('Webhook Kiwify: token ausente ou inválido, ignorando chamada.');
      return;
    }

    console.log('Webhook Kiwify recebido:', JSON.stringify(req.body));

    const { eventType, name, phone } = extractKiwifyEvent(req.body);
    const to = normalizePhone(phone);

    if (!to) {
      console.warn('Webhook Kiwify: não encontrei telefone no payload, nada foi enviado.');
      return;
    }

    const firstName = (name || '').trim().split(' ')[0] || '';
    let message = null;

    if (isApprovedPurchase(eventType)) {
      message = buildPurchaseMessage(firstName);
    } else if (isAbandonedCart(eventType)) {
      message = buildAbandonedCartMessage(firstName);
    } else {
      console.log(`Webhook Kiwify: evento "${eventType}" recebido, nenhuma ação configurada pra ele.`);
      return;
    }

    await sendWhatsAppMessage(to, message);
    addMessage(to, 'bot', message);
  } catch (err) {
    console.error('Erro ao processar webhook da Kiwify:', err);
  }
});

// ───────────────────────── CAIXA DE ENTRADA (painel manual) ─────────────────────────
// Protegida por usuário/senha (defina INBOX_USER e INBOX_PASSWORD no .env).
// Observação: usamos login via formulário + cookie em vez de HTTP Basic Auth
// porque o header "WWW-Authenticate" (usado no desafio do Basic Auth) fazia o
// proxy do Render responder 503 nesta rota especificamente.

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

// ── Login por formulário + cookie (sem WWW-Authenticate) ──

const COOKIE_NAME = 'inbox_session';
const INBOX_TOKEN = crypto.createHash('sha256').update(`${INBOX_USER}:${INBOX_PASSWORD}`).digest('hex');

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

app.get('/inbox/login', (_req, res) => {
  res.send(
    layout(
      'Entrar — Caixa de entrada 6Tem',
      `<h1>Entrar</h1>
      <form method="POST" action="/inbox/login">
        <input type="text" name="user" placeholder="Usuário" required style="display:block;width:100%;padding:10px;margin-bottom:8px;border-radius:8px;border:1px solid #cbd5e1;box-sizing:border-box" />
        <input type="password" name="pass" placeholder="Senha" required style="display:block;width:100%;padding:10px;margin-bottom:8px;border-radius:8px;border:1px solid #cbd5e1;box-sizing:border-box" />
        <button type="submit">Entrar</button>
      </form>`
    )
  );
});

app.post('/inbox/login', (req, res) => {
  const { user, pass } = req.body || {};
  const userOk = (user || '').trim() === (INBOX_USER || '').trim();
  const passOk = (pass || '').trim() === (INBOX_PASSWORD || '').trim();
  if (userOk && passOk) {
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${INBOX_TOKEN}; HttpOnly; Path=/inbox; Max-Age=${60 * 60 * 24 * 7}`
    );
    return res.redirect('/inbox');
  }
  res.status(401).send(
    layout(
      'Entrar — Caixa de entrada 6Tem',
      `<h1>Entrar</h1><p>Usuário ou senha incorretos.</p><p><a href="/inbox/login">Tentar novamente</a></p>`
    )
  );
});

app.post('/inbox/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/inbox; Max-Age=0`);
  res.redirect('/inbox/login');
});

function inboxAuth(req, res, next) {
  if (getCookie(req, COOKIE_NAME) === INBOX_TOKEN) {
    return next();
  }
  return res.redirect('/inbox/login');
}

app.use('/inbox', inboxAuth);

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
      `<h1>Conversas</h1>${items || '<p>Nenhuma conversa ainda.</p>'}
      <form method="POST" action="/inbox/logout" style="margin-top:24px">
        <button type="submit" class="secondary">Sair</button>
      </form>`
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
