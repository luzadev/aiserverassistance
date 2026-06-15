#!/usr/bin/env node
// Server MCP "serverops" — viene lanciato da `claude` come sottoprocesso (stdio).
// Espone a Claude tre strumenti per operare sui server, SENZA dargli una shell locale:
//   - list_servers      : elenca i server configurati
//   - run_readonly      : esegue un comando di sola lettura (validato, niente conferma)
//   - run_privileged    : chiede la TUA conferma su Telegram, poi esegue se approvi
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadServers, findServer } from './config.js';
import { isReadOnly, sshExec, clip } from './ssh.js';

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:8765';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || '';
const SERVERS_FILE = process.env.SERVERS_FILE || './servers.json';

let servers = [];
try {
  servers = loadServers(SERVERS_FILE);
} catch (e) {
  // Verrà segnalato alla prima chiamata di tool.
  servers = [];
  process.stderr.write(`[serverops] errore caricamento server: ${e.message}\n`);
}

function resolveServer(name) {
  const s = findServer(servers, name);
  if (!s) {
    const known = servers.map((x) => x.name).join(', ') || '(nessuno configurato)';
    throw new Error(`Server "${name}" sconosciuto. Server disponibili: ${known}`);
  }
  return s;
}

function fmtResult(server, command, res) {
  const head = `$ ${command}\n[${server.name} • exit ${res.code}]`;
  const out = clip(res.stdout).trim();
  const err = clip(res.stderr).trim();
  let body = head;
  if (out) body += `\n--- stdout ---\n${out}`;
  if (err) body += `\n--- stderr ---\n${err}`;
  if (!out && !err) body += '\n(nessun output)';
  return body;
}

// Richiede approvazione umana al bot via bridge HTTP locale. Blocca finché
// l'utente non risponde su Telegram (o scade il timeout → negato).
async function requestApproval({ server, command, reason }) {
  if (!CHAT_ID) {
    return { decision: 'deny', reason: 'CHAT_ID non impostato per questa sessione' };
  }
  try {
    const resp = await fetch(`${BRIDGE_URL}/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: BRIDGE_TOKEN,
        chatId: CHAT_ID,
        server: server.name,
        host: server.host,
        command,
        reason: reason || '',
      }),
    });
    if (!resp.ok) {
      return { decision: 'deny', reason: `bridge HTTP ${resp.status}` };
    }
    return await resp.json();
  } catch (e) {
    return { decision: 'deny', reason: `bridge non raggiungibile: ${e.message}` };
  }
}

const server = new McpServer({ name: 'serverops', version: '1.0.0' });

server.tool(
  'list_servers',
  'Elenca i server che puoi gestire (nome, host, utente e descrizione). Usalo per capire quale server corrisponde alla richiesta dell\'utente.',
  {},
  async () => {
    if (servers.length === 0) {
      return { content: [{ type: 'text', text: 'Nessun server configurato (servers.json mancante o vuoto).' }] };
    }
    const lines = servers.map(
      (s) => `• ${s.name} → ${s.user}@${s.host}${s.description ? ` — ${s.description}` : ''}`,
    );
    return { content: [{ type: 'text', text: `Server disponibili:\n${lines.join('\n')}` }] };
  },
);

server.tool(
  'run_readonly',
  'Esegue un comando di SOLA LETTURA su un server via SSH (diagnostica: stato servizi, log, uso disco/memoria, processi, configurazioni…). Viene eseguito subito, senza conferma. Se il comando modifica qualcosa verrà rifiutato: usa run_privileged.',
  {
    server: z.string().describe('Nome del server (come da list_servers)'),
    command: z.string().describe('Comando shell di sola lettura, es: "systemctl status nginx" o "df -h"'),
  },
  async ({ server: name, command }) => {
    let srv;
    try {
      srv = resolveServer(name);
    } catch (e) {
      return { content: [{ type: 'text', text: e.message }], isError: true };
    }
    const verdict = isReadOnly(command);
    if (!verdict.ok) {
      return {
        content: [{
          type: 'text',
          text: `RIFIUTATO (non di sola lettura): ${verdict.reason}.\nSe è una modifica intenzionale, usa run_privileged.`,
        }],
        isError: true,
      };
    }
    const res = await sshExec(srv, command, { timeoutMs: 120000 });
    return { content: [{ type: 'text', text: fmtResult(srv, command, res) }] };
  },
);

server.tool(
  'run_privileged',
  'Esegue un comando che MODIFICA lo stato del server (riavvio servizi, modifica file/config, installazioni, query di scrittura…). Mostra il comando all\'utente su Telegram e attende la sua approvazione esplicita. Viene eseguito SOLO se l\'utente approva. Fornisci sempre un "reason" chiaro che spieghi perché serve.',
  {
    server: z.string().describe('Nome del server (come da list_servers)'),
    command: z.string().describe('Comando shell completo da eseguire'),
    reason: z.string().describe('Spiegazione breve e chiara del perché questo comando è necessario (verrà mostrata all\'utente)'),
  },
  async ({ server: name, command, reason }) => {
    let srv;
    try {
      srv = resolveServer(name);
    } catch (e) {
      return { content: [{ type: 'text', text: e.message }], isError: true };
    }
    const decision = await requestApproval({ server: srv, command, reason });
    if (decision.decision !== 'allow') {
      return {
        content: [{
          type: 'text',
          text: `NEGATO dall'utente${decision.reason ? ` (${decision.reason})` : ''}. Non procedere con questo comando; proponi un'alternativa o chiedi chiarimenti.`,
        }],
      };
    }
    const cmd = decision.command || command; // l'utente potrebbe aver modificato il comando
    const res = await sshExec(srv, cmd, { timeoutMs: 300000 });
    return { content: [{ type: 'text', text: `[APPROVATO ed eseguito]\n${fmtResult(srv, cmd, res)}` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[serverops] MCP server avviato\n');
