import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Guarda tudo em um arquivo JSON simples. Por padrão fica ao lado do server.js,
// mas se a variável de ambiente DATA_DIR for definida (ex: um Persistent Disk
// montado no Render), os dados são gravados lá — assim sobrevivem a deploys.
// Sem isso, todo novo deploy apaga o histórico de conversas e o estado de "pausado".
// Se o volume de conversas crescer muito, troque por um banco de dados de verdade
// (Postgres, SQLite, etc).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'conversations.json');

function loadData() {
    try {
          const raw = fs.readFileSync(DATA_FILE, 'utf-8');
          return JSON.parse(raw);
    } catch {
          return {};
    }
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function ensureConversation(data, phone) {
    if (!data[phone]) {
          data[phone] = { paused: false, messages: [], referral: null };
    }
    return data[phone];
}

// role: 'user' (cliente) | 'bot' (IA) | 'human' (você respondendo manualmente)
export function addMessage(phone, role, text) {
    const data = loadData();
    const conv = ensureConversation(data, phone);
    conv.messages.push({ role, text, timestamp: Date.now() });
    saveData(data);
}

export function getConversation(phone) {
    const data = loadData();
    return data[phone] || { paused: false, messages: [], referral: null };
}

export function isPaused(phone) {
    const data = loadData();
    return Boolean(data[phone]?.paused);
}

export function setPaused(phone, paused) {
    const data = loadData();
    const conv = ensureConversation(data, phone);
    conv.paused = paused;
    saveData(data);
}

// Guarda de onde a conversa veio (anúncio do Meta) assim que a primeira mensagem
// chega. Só grava uma vez por número, pra não perder a origem original conforme
// a conversa avança.
export function setReferral(phone, referral) {
    if (!referral) return;
    const data = loadData();
    const conv = ensureConversation(data, phone);
    if (!conv.referral) {
          conv.referral = referral;
          saveData(data);
    }
}

// Retorna as conversas ordenadas da mais recente para a mais antiga,
// cada uma com um preview da última mensagem.
export function listConversations() {
    const data = loadData();
    return Object.entries(data)
      .map(([phone, conv]) => {
              const last = conv.messages[conv.messages.length - 1];
              return {
                        phone,
                        paused: Boolean(conv.paused),
                        lastText: last?.text || '',
                        lastRole: last?.role || '',
                        lastTimestamp: last?.timestamp || 0,
                        totalMessages: conv.messages.length,
                        referral: conv.referral || null,
              };
      })
      .sort((a, b) => b.lastTimestamp - a.lastTimestamp);
}

// Converte o histórico salvo para o formato que a API da Anthropic espera,
// pegando só as últimas N mensagens para não estourar o contexto.
export function getHistoryForClaude(phone, maxMessages = 12) {
    const conv = getConversation(phone);
    const recent = conv.messages.slice(-maxMessages);
    return recent.map((m) => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.text,
    }));
}
