// Avvio di Claude Code in modalità headless (`claude -p ... --output-format json`).
// Claude riceve SOLO gli strumenti del server MCP "serverops": niente shell locale.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.join(__dirname, 'mcp-server.js');

export const SYSTEM_PROMPT = [
  "Sei un assistente sysadmin che l'utente contatta via Telegram per gestire i suoi server Linux.",
  "NON hai una shell locale né accesso al filesystem: l'unico modo per agire sui server è tramite gli strumenti MCP \"serverops\": list_servers, run_readonly, run_privileged.",
  '',
  'Regole operative:',
  "- Se non sai a quale server si riferisce la richiesta, chiama list_servers e deducilo dal nome/contesto. Se resta ambiguo, chiedi all'utente.",
  '- Indaga SEMPRE prima in sola lettura con run_readonly (stato servizi, log, uso disco/memoria, processi, configurazioni) per capire il problema reale prima di proporre modifiche.',
  "- Per QUALSIASI azione che modifica lo stato del server (riavvio/stop servizi, modifica di file o configurazioni, installazioni, query di scrittura) usa run_privileged con un campo \"reason\" chiaro: l'utente la approverà o negherà su Telegram. Non tentare di aggirare questo flusso.",
  '- Se run_readonly rifiuta un comando perché "non di sola lettura", quel comando modifica qualcosa: usa run_privileged.',
  '- Procedi un passo alla volta: interpreta l\'output di ogni comando prima del successivo. Evita comandi distruttivi se non strettamente necessari e motivati.',
  "- Se l'utente nega un comando, non insistere: proponi un'alternativa o chiedi chiarimenti.",
  '',
  "Stile della risposta finale (è una chat Telegram, in italiano): concisa e leggibile. Riassumi cosa hai trovato e cosa hai fatto, evidenzia la causa e l'eventuale fix in poche righe. Non incollare output lunghissimi: cita solo le parti rilevanti.",
].join('\n');

// Scrive il file di configurazione MCP che `claude` userà per lanciare il server
// serverops. I valori (compreso il CHAT_ID per-richiesta) vengono inseriti come
// LETTERALI nel blocco env: così arrivano al server MCP a prescindere dal supporto
// all'espansione `${...}` nella versione di Claude Code installata.
// Un file per chat (le richieste di una stessa chat sono serializzate).
export function writeMcpConfig({ chatId, bridgeUrl, bridgeToken, serversFile }) {
  const cfg = {
    mcpServers: {
      serverops: {
        command: process.execPath, // stesso node
        args: [MCP_SERVER_PATH],
        env: {
          BRIDGE_URL: bridgeUrl,
          BRIDGE_TOKEN: bridgeToken,
          CHAT_ID: String(chatId),
          SERVERS_FILE: serversFile,
        },
      },
    },
  };
  fs.mkdirSync(config.workdir, { recursive: true });
  const outPath = path.join(config.workdir, `mcp-${String(chatId).replace(/[^\w-]/g, '_')}.json`);
  fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2));
  return outPath;
}

/**
 * Lancia una richiesta a Claude in headless.
 * @param {{prompt:string, sessionId?:string, chatId:string|number, bridgeUrl:string, bridgeToken:string}} p
 * @returns {Promise<{result:string, sessionId?:string, cost?:number, isError:boolean, stderr:string}>}
 */
export function runClaude({ prompt, sessionId, chatId, bridgeUrl, bridgeToken }) {
  const mcpConfigPath = writeMcpConfig({
    chatId,
    bridgeUrl,
    bridgeToken,
    serversFile: config.serversFile,
  });
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--model', config.claudeModel,
    '--allowedTools', 'mcp__serverops__list_servers,mcp__serverops__run_readonly,mcp__serverops__run_privileged',
    '--disallowedTools', 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit',
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--append-system-prompt', SYSTEM_PROMPT,
  ];
  if (sessionId) args.push('--resume', sessionId);

  // I valori sono già letterali nel file MCP; li passiamo anche via env per
  // ridondanza (alcune versioni li ereditano dal processo claude).
  const env = {
    ...process.env,
    BRIDGE_URL: bridgeUrl,
    BRIDGE_TOKEN: bridgeToken,
    CHAT_ID: String(chatId),
    SERVERS_FILE: config.serversFile,
  };

  return new Promise((resolve) => {
    // stdin ignorato: il prompt è passato via -p, così claude non attende stdin.
    const child = spawn(config.claudeBin, args, { cwd: config.workdir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, config.claudeTimeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ result: `Impossibile avviare "${config.claudeBin}": ${e.message}`, isError: true, stderr });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      // Prova a interpretare l'output JSON di Claude.
      try {
        const json = JSON.parse(stdout);
        resolve({
          result: json.result ?? '(nessuna risposta)',
          sessionId: json.session_id,
          cost: json.total_cost_usd,
          isError: Boolean(json.is_error) || code !== 0,
          stderr,
        });
        return;
      } catch {
        // Output non-JSON (es. errore precoce della CLI).
      }
      resolve({
        result: stdout.trim() || `Claude è terminato con codice ${code}.`,
        isError: code !== 0,
        stderr,
      });
    });
  });
}
