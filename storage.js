import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Guarda tudo em um arquivo JSON simples ao lado do server.js.
// Suficiente para um volume pequeno/médio de conversas. Se o volume crescer muito,
// troque por um banco de dados de verdade (Postgres, SQLite, etc).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'conversations.json');

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

// role: 'user' (cliente) | 'bot' (IA) | 'human' (você respondendo manualmente)
export function addMessage(phone, role, text) {
  const data = loadData();
  if (!data[phone]) {
    data[phone] = { paused: false, messages: [] };
  }
  data[phone].messages.push({ role, text, timestamp: Date.now() });
  saveData(data);
}

export function getConversation(phone) {
  const data = loadData();
  return data[phone] || { paused: false, messages: [] };
}

export function isPaused(phone) {
  const data = loadData();
  return Boolean(data[phone]?.paused);
}

export function setPaused(phone, paused) {
  const data = loadData();
  if (!data[phone]) {
    data[phone] = { paused: false, messages: [] };
  }
  data[phone].paused = paused;
  saveData(data);
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
