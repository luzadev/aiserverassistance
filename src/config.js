// Caricamento configurazione da .env (parser minimale, nessuna dipendenza esterna)
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

function loadDotenv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotenv();

function resolveMaybeRelative(p, fallback) {
  const v = p || fallback;
  return path.isAbsolute(v) ? v : path.join(ROOT, v);
}

export const config = {
  root: ROOT,
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  allowedUserIds: (process.env.ALLOWED_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  claudeModel: process.env.CLAUDE_MODEL || 'opus',
  claudeTimeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS || 900000),
  bridgeHost: process.env.BRIDGE_HOST || '127.0.0.1',
  bridgePort: Number(process.env.BRIDGE_PORT || 8765),
  approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS || 240000),
  serversFile: resolveMaybeRelative(process.env.SERVERS_FILE, './servers.json'),
  workdir: resolveMaybeRelative(process.env.WORKDIR, './workdir'),
};

export function loadServers(serversFile = config.serversFile) {
  if (!fs.existsSync(serversFile)) {
    throw new Error(`File server non trovato: ${serversFile} (copia servers.example.json in servers.json)`);
  }
  const data = JSON.parse(fs.readFileSync(serversFile, 'utf8'));
  const servers = Array.isArray(data) ? data : data.servers;
  if (!Array.isArray(servers)) {
    throw new Error('servers.json deve contenere un array "servers"');
  }
  for (const s of servers) {
    if (!s.name || !s.host) {
      throw new Error('Ogni server deve avere almeno "name" e "host"');
    }
    if (!s.user) s.user = 'root';
  }
  return servers;
}

export function findServer(servers, name) {
  if (!name) return undefined;
  const target = String(name).trim().toLowerCase();
  return servers.find(
    (s) => s.name.toLowerCase() === target || s.host.toLowerCase() === target,
  );
}
