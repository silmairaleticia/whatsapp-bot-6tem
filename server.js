import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './knowledgeBase.js';
import {
    addMessage,
    getHistoryForClaude,
    isPaused,
    setPaused,
    setReferral,
    listConversations,
    getConversation,
    addQuizLead,
    listQuizLeads,
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

// ───────────────────────── Limite de mensagens (anti-abuso/custo) ─────────────────────────
// Guarda em memória (reseta a cada deploy/reinício — o que é aceitável, já que é só
// uma proteção contra alguém mandar centenas de mensagens seguidas e estourar o
// custo da API da Anthropic, não um controle que precise sobreviver a reinícios).
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutos
const RATE_LIMIT_MAX_MESSAGES = 20; // por número, dentro da janela acima
const recentMessageTimestamps = new Map();

function isRateLimited(phone) {
    const now = Date.now();
    const timestamps = (recentMessageTimestamps.get(phone) || []).filter(
          (t) => now - t < RATE_LIMIT_WINDOW_MS
        );
    timestamps.push(now);
    recentMessageTimestamps.set(phone, timestamps);
    return timestamps.length > RATE_LIMIT_MAX_MESSAGES;
}

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

      // Quando a conversa começa por um anúncio de Clique-para-WhatsApp, a Meta manda
      // esse campo "referral" só na primeira mensagem — guardamos pra saber depois
      // qual anúncio/criativo trouxe esse lead (aparece na caixa de entrada).
      if (message.referral) {
              setReferral(from, message.referral);
              console.log(`Lead via anúncio (${from}):`, JSON.stringify(message.referral));
      }

      addMessage(from, 'user', text);

      // Se a conversa estiver pausada (alguém da equipe assumiu manualmente),
      // o bot só guarda a mensagem e não responde sozinho.
      if (isPaused(from)) {
              console.log(`Conversa com ${from} está pausada — aguardando resposta humana.`);
              return;
      }

      if (isRateLimited(from)) {
              console.warn(`Limite de mensagens atingido para ${from} — ignorando até a janela liberar.`);
              return;
      }

      const reply = await askClaude(from);
                 addMessage(from, 'bot', reply);
                 await sendReplyInChunks(from, reply);
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

// Quebra a resposta em várias mensagens curtas (separadas por linha em branco).
// O system prompt já pede respostas curtas divididas em várias mensagens — antes
// o código mandava tudo num único bloco de texto, o que fica menos natural no
// WhatsApp e mais parecido com um "textão" de robô.
async function sendReplyInChunks(to, fullText) {
    const chunks = fullText
      .split(/\n\s*\n/)
      .map((c) => c.trim())
      .filter(Boolean);

  if (chunks.length === 0) return;

  for (let i = 0; i < chunks.length; i++) {
        await sendWhatsAppMessage(to, chunks[i]);
        if (i < chunks.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, 800));
        }
  }
}

// ───────────────────────── WEBHOOK (Kiwify — pós-venda / carrinho abandonado) ─────────────────────────
//
// Configure em: Kiwify → Apps → Webhooks → Criar Webhook
// URL: https://SEU-APP.onrender.com/webhook/kiwify?token=SEU_KIWIFY_WEBHOOK_TOKEN
// Eventos: "Compra aprovada" e "Carrinho abandonado"
// (defina KIWIFY_WEBHOOK_TOKEN no Render com um valor secreto de sua escolha,
// e use o MESMO valor na URL do webhook lá na Kiwify — isso evita que qualquer
// pessoa na internet chame essa rota e mande mensagem em nome do seu número)
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

      addMessage(to, 'bot', message);
                 await sendReplyInChunks(to, message);
           } catch (err) {
                 console.error('Erro ao processar webhook da Kiwify:', err);
           }
});

// ───────────────────────── QUIZ DE QUALIFICAÇÃO (landing page pro anúncio) ─────────────────────────
// Página pública em /quiz — usada como destino de anúncios de link comum (não
// depende do número do WhatsApp estar aprovado). Qualifica a pessoa com algumas
// perguntas e no final manda pra página de oferta. As respostas + contato são
// salvos como lead em /inbox/leads mesmo se a pessoa não finalizar a compra.

const CHECKOUT_URL = 'https://pay.kiwify.com.br/Zp5yD8m?utm_source=quiz&utm_medium=ad&utm_campaign=6tem_quiz';

function quizPage() {
    return `<!DOCTYPE html>
    <html lang="pt-BR">
    <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Descubra se o Método 6Tem é pra você</title>
    <script>
    !function(f,b,e,v,n,t,s)
    {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};
    if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
    n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s)}(window, document,'script',
    'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', '1745121656368578');
    fbq('init', '1273822687548335');
    fbq('track', 'PageView');
    </script>
    <noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=1745121656368578&ev=PageView&noscript=1" /></noscript>
    <noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=1273822687548335&ev=PageView&noscript=1" /></noscript>
    <style>
      :root{--green:#18C964;--bg:#f8fafc;--text:#0f172a;--muted:#64748b;--border:#e2e8f0;}
        *{box-sizing:border-box}
          body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:24px;min-height:100vh;display:flex;align-items:center;justify-content:center}
            .wrap{max-width:480px;width:100%;margin:0 auto}
              .eyebrow{text-align:center;margin-bottom:16px;font-weight:700;color:var(--green);font-size:14px;letter-spacing:.05em}
                .bar{height:6px;background:var(--border);border-radius:100px;overflow:hidden;margin-bottom:24px}
                  .bar-fill{height:100%;background:var(--green);width:0%;transition:width .3s}
                    .card{background:#fff;border:1px solid var(--border);border-radius:20px;padding:28px;box-shadow:0 10px 30px -14px rgba(15,23,42,.15)}
                      .anim{animation:fadeSlide .35s ease}
                        @keyframes fadeSlide{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
                          h1{font-size:22px;margin:0 0 8px}
                            h2{font-size:20px;margin:0 0 8px}
                              p.sub{color:var(--muted);font-size:14px;margin:0 0 20px}
                                .opt{display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:16px 18px;margin-bottom:10px;border:1.5px solid var(--border);border-radius:14px;background:#fff;font-size:15px;cursor:pointer;transition:.15s}
                                  .opt:hover{border-color:var(--green);background:#f0fdf4;transform:translateY(-1px);box-shadow:0 6px 16px -8px rgba(24,201,100,.35)}
                                    .opt .dot{width:18px;height:18px;border-radius:50%;border:2px solid var(--border);flex-shrink:0;transition:.15s}
                                      .opt:hover .dot{border-color:var(--green);background:var(--green)}
                                        input[type=text],input[type=tel]{width:100%;padding:14px;border-radius:12px;border:1.5px solid var(--border);font-size:15px;margin-bottom:12px}
                                          .btn{display:block;width:100%;padding:16px;background:var(--green);color:#fff;border:none;border-radius:100px;font-size:16px;font-weight:700;cursor:pointer;text-align:center;text-decoration:none}
                                            .trust{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:14px;padding:16px 18px;margin:16px 0;font-size:14px;line-height:2}
                                              .price{font-size:28px;font-weight:800;color:var(--green);margin:12px 0 4px}
                                                .muted{color:var(--muted);font-size:13px}
                                                </style>
                                                </head>
                                                <body>
                                                <div class="wrap">
                                                  <div class="eyebrow">MÉTODO 6TEM</div>
                                                    <div class="bar"><div class="bar-fill" id="barFill"></div></div>
                                                      <div class="card" id="card"></div>
                                                      </div>
                                                      <script>
                                                      var QUESTIONS = [
                                                        {
                                                            key: 'clt',
                                                                text: 'Você trabalha registrado (CLT) hoje?',
                                                                    options: ['Sim, trabalho CLT', 'Não, sou autônomo(a)', 'Não estou trabalhando no momento']
                                                                      },
                                                                        {
                                                                            key: 'tempo',
                                                                                text: 'Quantas horas livres você tem por semana pra cuidar de um projeto extra?',
                                                                                    options: ['Pouquíssimas, minha rotina é corrida', 'Algumas horas nos fins de semana', 'Tenho uma boa margem de tempo livre']
                                                                                      },
                                                                                        {
                                                                                            key: 'receio',
                                                                                                text: 'O que mais pesa na hora de pensar em ter um negócio próprio?',
                                                                                                    options: ['Não ter dinheiro pra investir muito', 'Não saber por onde começar', 'Medo de dar errado e perder tempo ou dinheiro', 'Não ter tempo pra tocar o negócio']
                                                                                                      },
                                                                                                        {
                                                                                                            key: 'investimento',
                                                                                                                text: 'Quanto você teria disponível pra aprender e estruturar esse projeto?',
                                                                                                                    options: ['Já tenho esse valor guardado', 'Consigo juntar em pouco tempo', 'Ainda não tenho, mas quero entender antes de decidir']
                                                                                                                      },
                                                                                                                        {
                                                                                                                            key: 'atrativo',
                                                                                                                                text: 'O que mais te chamou atenção na ideia de minimercado autônomo?',
                                                                                                                                    options: ['Não precisar ficar o dia todo tomando conta', 'Investimento menor que outros negócios físicos', 'Ter uma segunda fonte de renda sem largar o emprego', 'Aprender um método antes de arriscar meu dinheiro']
                                                                                                                                      }
                                                                                                                                      ];
                                                                                                                                      
                                                                                                                                      var answers = {};
                                                                                                                                      var current = 0;
                                                                                                                                      var totalSteps = QUESTIONS.length + 2;
                                                                                                                                      
                                                                                                                                      function getQueryParam(name) {
                                                                                                                                        var params = new URLSearchParams(window.location.search);
                                                                                                                                          return params.get(name) || '';
                                                                                                                                          }
                                                                                                                                          
                                                                                                                                          function renderProgress() {
                                                                                                                                            var pct = Math.min(100, Math.round((current / totalSteps) * 100));
                                                                                                                                              document.getElementById('barFill').style.width = pct + '%';
                                                                                                                                              }
                                                                                                                                              
                                                                                                                                              function renderQuestion() {
                                                                                                                                                var q = QUESTIONS[current];
                                                                                                                                                  var html = '<div class="anim"><h1>' + q.text + '</h1><p class="sub">Pergunta ' + (current + 1) + ' de ' + QUESTIONS.length + '</p>';
                                                                                                                                                    q.options.forEach(function (opt, i) {
                                                                                                                                                        html += '<button class="opt" onclick="answerQuestion(' + i + ')"><span class="dot"></span>' + opt + '</button>';
                                                                                                                                                          });
                                                                                                                                                            html += '</div>';
                                                                                                                                                              document.getElementById('card').innerHTML = html;
                                                                                                                                                                renderProgress();
                                                                                                                                                                }
                                                                                                                                                                
                                                                                                                                                                function answerQuestion(index) {
                                                                                                                                                                  var q = QUESTIONS[current];
                                                                                                                                                                    answers[q.key] = q.options[index];
                                                                                                                                                                      current++;
                                                                                                                                                                        if (current < QUESTIONS.length) {
                                                                                                                                                                            renderQuestion();
                                                                                                                                                                              } else {
                                                                                                                                                                                  renderCapture();
                                                                                                                                                                                    }
                                                                                                                                                                                    }
                                                                                                                                                                                    
                                                                                                                                                                                    function renderCapture() {
                                                                                                                                                                                      document.getElementById('card').innerHTML =
                                                                                                                                                                                          '<div class="anim">' +
                                                                                                                                                                                              '<h1>Quase lá!</h1>' +
                                                                                                                                                                                                  '<p class="sub">Pra onde a gente manda seu resultado?</p>' +
                                                                                                                                                                                                      '<input type="text" id="inpNome" placeholder="Seu nome" />' +
                                                                                                                                                                                                          '<input type="tel" id="inpWhats" placeholder="Seu WhatsApp com DDD" />' +
                                                                                                                                                                                                              '<button class="btn" onclick="submitCapture()">Ver meu resultado</button>' +
                                                                                                                                                                                                                  '</div>';
                                                                                                                                                                                                                    renderProgress();
                                                                                                                                                                                                                    }
                                                                                                                                                                                                                    
                                                                                                                                                                                                                    function submitCapture() {
                                                                                                                                                                                                                      var nome = document.getElementById('inpNome').value.trim();
                                                                                                                                                                                                                        var whats = document.getElementById('inpWhats').value.trim();
                                                                                                                                                                                                                          if (!nome || !whats) {
                                                                                                                                                                                                                              alert('Preenche seu nome e WhatsApp pra continuar.');
                                                                                                                                                                                                                                  return;
                                                                                                                                                                                                                                    }
                                                                                                                                                                                                                                      answers.nome = nome;
                                                                                                                                                                                                                                        answers.whatsapp = whats;
                                                                                                                                                                                                                                          answers.fbclid = getQueryParam('fbclid');
                                                                                                                                                                                                                                            current++;
                                                                                                                                                                                                                                              if (typeof fbq === 'function') { fbq('track', 'Lead'); }
                                                                                                                                                                                                                                                fetch('/quiz/lead', {
                                                                                                                                                                                                                                                    method: 'POST',
                                                                                                                                                                                                                                                        headers: { 'Content-Type': 'application/json' },
                                                                                                                                                                                                                                                            body: JSON.stringify(answers)
                                                                                                                                                                                                                                                              }).catch(function () {});
                                                                                                                                                                                                                                                                renderResult();
                                                                                                                                                                                                                                                                }
                                                                                                                                                                                                                                                                
                                                                                                                                                                                                                                                                var CONCERN_COPY = {
                                                                                                                                                                                                                                                                  'Não ter dinheiro pra investir muito': 'Por isso o Método 6Tem custa R$97 (pagamento único) — a ideia é você aprender o passo a passo ANTES de precisar investir alto num ponto físico.',
                                                                                                                                                                                                                                                                    'Não saber por onde começar': 'É exatamente pra isso que o método existe: um passo a passo, do planejamento até a operação, pra você não ficar perdido tentando descobrir tudo sozinho.',
                                                                                                                                                                                                                                                                      'Medo de dar errado e perder tempo ou dinheiro': 'Por isso tem garantia de 7 dias — se você entrar e achar que não é pra você, devolvemos o valor, sem burocracia.',
                                                                                                                                                                                                                                                                        'Não ter tempo pra tocar o negócio': 'O método foi pensado pra quem trabalha CLT: dá pra estudar e planejar no seu ritmo, sem precisar largar o emprego atual.'
                                                                                                                                                                                                                                                                        };
                                                                                                                                                                                                                                                                        
                                                                                                                                                                                                                                                                        function renderResult() {
                                                                                                                                                                                                                                                                          var nome = answers.nome ? answers.nome.split(' ')[0] : '';
                                                                                                                                                                                                                                                                            var concernText = CONCERN_COPY[answers.receio] || 'O método te dá o passo a passo completo, do planejamento até a operação.';
                                                                                                                                                                                                                                                                              var offerUrl = '/oferta?receio=' + encodeURIComponent(answers.receio || '') + '&nome=' + encodeURIComponent(answers.nome || '');
                                                                                                                                                                                                                                                                                document.getElementById('card').innerHTML =
                                                                                                                                                                                                                                                                                    '<div class="anim">' +
                                                                                                                                                                                                                                                                                        '<h2>' + (nome ? nome + ', seu perfil combina com o Método 6Tem' : 'Seu perfil combina com o Método 6Tem') + '</h2>' +
                                                                                                                                                                                                                                                                                            '<p>' + concernText + '</p>' +
                                                                                                                                                                                                                                                                                                '<div class="trust">' +
                                                                                                                                                                                                                                                                                                    '&#10003; Acesso vitalício, no seu ritmo<br>' +
                                                                                                                                                                                                                                                                                                        '&#10003; Garantia de 7 dias<br>' +
                                                                                                                                                                                                                                                                                                            '&#10003; Não precisa largar o emprego atual' +
                                                                                                                                                                                                                                                                                                                '</div>' +
                                                                                                                                                                                                                                                                                                                    '<a class="btn" href="' + offerUrl + '">Ver como funciona</a>' +
                                                                                                                                                                                                                                                                                                                        '</div>';
                                                                                                                                                                                                                                                                                                                          renderProgress();
                                                                                                                                                                                                                                                                                                                          }
                                                                                                                                                                                                                                                                                                                          
                                                                                                                                                                                                                                                                                                                          function renderIntro() {
                                                                                                                                                                                                                                                                                                                            document.getElementById('card').innerHTML =
                                                                                                                                                                                                                                                                                                                                '<div class="anim">' +
                                                                                                                                                                                                                                                                                                                                    '<video id="introVideo" src="/quiz-intro.mp4" autoplay muted playsinline controls style="width:100%;border-radius:14px;margin-bottom:4px;background:#000" onclick="this.muted = !this.muted"></video>' +
                                                                                                                                                                                                                                                                                                                                        '<p class="sub" style="text-align:center;margin:0 0 16px">🔊 Toque no vídeo pra ativar o som</p>' +
                                                                                                                                                                                                                                                                                                                                            '<button class="btn" onclick="renderQuestion()">Começar o quiz</button>' +
                                                                                                                                                                                                                                                                                                                                                '</div>';
                                                                                                                                                                                                                                                                                                                                                  var v = document.getElementById('introVideo');
                                                                                                                                                                                                                                                                                                                                                    if (v) { v.play().catch(function () {}); }
                                                                                                                                                                                                                                                                                                                                                    }
                                                                                                                                                                                                                                                                                                                                                    
                                                                                                                                                                                                                                                                                                                                                    renderIntro();
                                                                                                                                                                                                                                                                                                                                                    </script>
                                                                                                                                                                                                                                                                                                                                                    </body>
                                                                                                                                                                                                                                                                                                                                                    </html>`;
}

app.get('/quiz', (_req, res) => {
    res.send(quizPage());
});

// Vídeo de introdução exibido antes da primeira pergunta do quiz.
app.get('/quiz-intro.mp4', (_req, res) => {
    res.sendFile(path.join(process.cwd(), 'vd quiz 02.mp4'));
});

app.post('/quiz/lead', (req, res) => {
    const { nome, whatsapp, ...rest } = req.body || {};
    const phone = normalizePhone(whatsapp) || whatsapp || '';
    addQuizLead({ nome: nome || '', whatsapp: phone, ...rest });
    res.json({ ok: true });
});

// ───────────────────────── OFERTA (página completa antes do checkout) ─────────────────────────
// Destino do botão final do quiz. Reforça a proposta de valor tratando a
// principal objeção que a pessoa indicou nas perguntas, antes de mandar pro
// checkout de verdade.

const CONCERN_COPY_LANDING = {
    'Não ter dinheiro pra investir muito': {
          headline: 'Você não precisa ter muito dinheiro pra começar a aprender',
          text: 'O Método 6Tem custa R$97, pagamento único. A ideia não é você já sair investindo alto num ponto físico — é aprender o passo a passo primeiro, entender o modelo de negócio, e só depois decidir se e quando vai investir na estrutura.',
    },
    'Não saber por onde começar': {
          headline: 'Você não precisa descobrir tudo sozinho',
          text: 'O método é um passo a passo estruturado: mentalidade e planejamento, escolha do local, negociação, estrutura e equipamentos, tecnologia e pagamentos, abertura e gestão. Você segue a ordem, sem ficar perdido tentando juntar informação solta na internet.',
    },
    'Medo de dar errado e perder tempo ou dinheiro': {
          headline: 'Você tem 7 dias pra decidir com calma',
          text: 'Se depois de começar você achar que não é pra você, é só pedir o reembolso dentro de 7 dias — devolvemos o valor, sem burocracia. O risco de testar é baixo.',
    },
    'Não ter tempo pra tocar o negócio': {
          headline: 'Dá pra estudar no seu ritmo, sem largar o emprego',
          text: 'O método foi pensado pra quem trabalha CLT de segunda a sábado. O conteúdo é 100% online e fica disponível pra sempre — você estuda quando tiver tempo, no celular ou computador.',
    },
};

const DEFAULT_CONCERN = {
    headline: 'Veja como funciona o Método 6Tem',
    text: 'Um passo a passo estruturado pra planejar, montar e operar um minimercado autônomo, sem precisar largar o emprego atual.',
};

function ofertaPage(query = {}) {
    const nome = (query.nome || '').toString().trim();
    const firstName = nome ? nome.split(' ')[0] : '';
    const concern = CONCERN_COPY_LANDING[query.receio] || DEFAULT_CONCERN;
    const greeting = firstName ? `${escapeHtml(firstName)}, ` : '';

  return `<!DOCTYPE html>
  <html lang="pt-BR">
  <head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Método 6Tem — Como funciona</title>
  <script>
  !function(f,b,e,v,n,t,s)
  {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};
  if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
  n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t,s)}(window, document,'script',
  'https://connect.facebook.net/en_US/fbevents.js');
  fbq('init', '1745121656368578');
  fbq('init', '1273822687548335');
  fbq('track', 'PageView');
  </script>
  <noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=1745121656368578&ev=PageView&noscript=1" /></noscript>
  <noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=1273822687548335&ev=PageView&noscript=1" /></noscript>
  <style>
    :root{--green:#18C964;--bg:#f8fafc;--text:#0f172a;--muted:#64748b;--border:#e2e8f0;}
      *{box-sizing:border-box}
        body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);margin:0}
          .wrap{max-width:600px;margin:0 auto;padding:32px 24px}
            .eyebrow{text-align:center;font-weight:700;color:var(--green);font-size:14px;letter-spacing:.05em;margin-bottom:8px}
              h1{font-size:26px;text-align:center;margin:0 0 24px;line-height:1.3}
                .card{background:#fff;border:1px solid var(--border);border-radius:20px;padding:24px;margin-bottom:20px;box-shadow:0 10px 30px -16px rgba(15,23,42,.15)}
                  h2{font-size:18px;margin:0 0 12px}
                    p{line-height:1.6;color:var(--text);margin:0}
                      ul{padding-left:20px;line-height:1.9;margin:0}
                        .trust{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px;font-size:14px;line-height:1.9}
                          .price-card{text-align:center}
                            .price{font-size:36px;font-weight:800;color:var(--green);margin:8px 0}
                              .btn{display:block;width:100%;padding:16px;background:var(--green);color:#fff;border:none;border-radius:100px;font-size:17px;font-weight:700;cursor:pointer;text-align:center;text-decoration:none;margin-top:12px}
                                .muted{color:var(--muted);font-size:13px;text-align:center;margin:0}
                                </style>
                                </head>
                                <body>
                                <div class="wrap">
                                  <div class="eyebrow">MÉTODO 6TEM</div>
                                    <h1>${greeting}${escapeHtml(concern.headline)}</h1>

                                      <div class="card">
                                          <p>${escapeHtml(concern.text)}</p>
                                            </div>

                                              <div class="card">
                                                  <h2>O que você vai aprender</h2>
                                                      <ul>
                                                            <li>Mentalidade e planejamento, sem sair do emprego</li>
                                                                  <li>Como escolher o local ideal (condomínios, empresas e outros pontos)</li>
                                                                        <li>Negociação e parcerias pra viabilizar o ponto</li>
                                                                              <li>Estrutura, equipamentos e fornecedores</li>
                                                                                    <li>Tecnologia: Pix, cartão, aproximação, câmeras e estoque</li>
                                                                                          <li>Abertura e gestão do dia a dia, mesmo à distância</li>
                                                                                              </ul>
                                                                                                </div>

                                                                                                  <div class="card trust">
                                                                                                      &#10003; Acesso vitalício, no seu ritmo<br>
                                                                                                          &#10003; Suporte pra tirar dúvidas ao longo da jornada<br>
                                                                                                              &#10003; Aplicável desde a primeira aula<br>
                                                                                                                  &#10003; Garantia de 7 dias
                                                                                                                    </div>
                                                                                                                    
                                                                                                                      <div class="card price-card">
                                                                                                                          <p class="muted">Investimento único, sem mensalidade</p>
                                                                                                                              <div class="price">R$97</div>
                                                                                                                                  <a class="btn" href="${CHECKOUT_URL}" onclick="if(typeof fbq==='function'){fbq('track','InitiateCheckout');}">Quero começar agora</a>
                                                                                                                                      <p class="muted" style="margin-top:12px">Pagamento único · Acesso vitalício · Garantia de 7 dias</p>
                                                                                                                                        </div>
                                                                                                                                        </div>
                                                                                                                                        </body>
                                                                                                                                        </html>`;
}

app.get('/oferta', (req, res) => {
    res.send(ofertaPage(req.query));
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
    .badge.ad{background:#dbeafe;color:#1e40af}
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
                                            ${c.referral ? '<span class="badge ad">Veio de anúncio</span>' : ''}
                                                    <div class="meta">${date} · ${c.totalMessages} mensagens</div>
                                                            <div>${escapeHtml(c.lastText).slice(0, 120)}</div>
                                                                  </a>`;
      })
      .join('');

          res.send(
                layout(
                        'Caixa de entrada — Método 6Tem',
                        `<h1>Conversas</h1>
                              <p><a href="/inbox/leads">Ver leads do quiz →</a></p>
                                    ${items || '<p>Nenhuma conversa ainda.</p>'}
                                          <form method="POST" action="/inbox/logout" style="margin-top:24px">
                                                  <button type="submit" class="secondary">Sair</button>
                                                        </form>`
                      )
              );
});

// Lista de leads capturados no quiz de qualificação
app.get('/inbox/leads', (_req, res) => {
    const leads = listQuizLeads();
    const rows = leads
      .map((l) => {
              const date = new Date(l.timestamp).toLocaleString('pt-BR');
              return `<div class="card">
                      <strong>${escapeHtml(l.nome || 'Sem nome')}</strong> · ${escapeHtml(l.whatsapp || '')}
                              <div class="meta">${date}</div>
                                      <div class="meta">CLT: ${escapeHtml(l.clt || '-')} · Tempo: ${escapeHtml(l.tempo || '-')} · Receio: ${escapeHtml(l.receio || '-')} · Investimento: ${escapeHtml(l.investimento || '-')} · Atrativo: ${escapeHtml(l.atrativo || '-')}</div>
                                            </div>`;
      })
      .join('');

          res.send(
                layout(
                        'Leads do quiz — Método 6Tem',
                        `<p><a href="/inbox">← Conversas</a></p>
                              <h1>Leads do quiz (${leads.length})</h1>
                                    ${rows || '<p>Nenhum lead ainda.</p>'}`
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

          const referralHtml = conv.referral
      ? `<div class="card" style="background:#eff6ff;border-color:#bfdbfe">
              <strong>Veio de um anúncio</strong>
                      <div class="meta">${escapeHtml(conv.referral.headline || conv.referral.source_type || 'Origem: anúncio Meta')}</div>
                              ${conv.referral.source_url ? `<div class="meta"><a href="${escapeHtml(conv.referral.source_url)}" target="_blank" rel="noopener">${escapeHtml(conv.referral.source_url)}</a></div>` : ''}
                                    </div>`
                : '';

          res.send(
                layout(
                        `Conversa com ${phone}`,
                        `
                              <p><a href="/inbox">← Voltar</a></p>
                                    <h1>${escapeHtml(phone)} ${conv.paused ? '<span class="badge">Pausado (humano)</span>' : ''}</h1>
                                          ${referralHtml}
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
