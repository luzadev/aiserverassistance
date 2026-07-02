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

export function projectPrompt(name) {
  return [
    `Stai assistendo l'utente via Telegram sul progetto "${name}", che si trova nella cartella di lavoro corrente sul server.`,
    'Hai i tuoi strumenti nativi per leggere ed esplorare il codice (Read, Grep, Glob): usali liberamente per capire il contesto. Leggi il CLAUDE.md del progetto se presente.',
    'Le operazioni che MODIFICANO qualcosa (Write, Edit, MultiEdit, Bash, ecc.) richiedono l\'approvazione dell\'utente: gli verranno mostrate su Telegram con dei pulsanti. Non c\'è modo di aggirarle. Se una modifica viene negata, proponi un\'alternativa o chiedi chiarimenti.',
    'Procedi con metodo: prima esplora e capisci, poi proponi/applichi le modifiche una alla volta con messaggi chiari.',
    'Rispondi in italiano, in modo conciso (è una chat Telegram): spiega cosa hai trovato e cosa hai fatto senza incollare interi file.',
  ].join('\n');
}

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
 * @param {{prompt:string, sessionId?:string, chatId:string|number, bridgeUrl:string, bridgeToken:string, mode?:'sysadmin'|'project', projectPath?:string, projectName?:string}} p
 * @returns {Promise<{result:string, sessionId?:string, cost?:number, isError:boolean, stderr:string}>}
 */
export function runClaude({ prompt, sessionId, chatId, bridgeUrl, bridgeToken, mode = 'sysadmin', projectPath, projectName }) {
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
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    // SICUREZZA: carica solo i settings a livello utente (root), NON quelli di
    // progetto/locali (.claude/settings*.json). Un repo può contenere regole
    // permissions.allow che altrimenti auto-approverebbero comandi bypassando
    // la conferma su Telegram. Il CLAUDE.md del progetto resta comunque caricato.
    '--setting-sources', 'user',
  ];

  let cwd;
  if (mode === 'project') {
    // Modalità progetto: strumenti nativi di lettura auto-consentiti; le modifiche
    // (Write/Edit/Bash/…) non sono in allowedTools quindi passano dal
    // permission-prompt-tool → conferma su Telegram. Il CLAUDE.md del progetto
    // viene caricato automaticamente (cwd = cartella del progetto).
    cwd = projectPath;
    args.push('--allowedTools', 'Read,Glob,Grep,LS,TodoWrite');
    args.push('--permission-prompt-tool', 'mcp__serverops__approve');
    args.push('--append-system-prompt', projectPrompt(projectName || 'progetto'));
  } else {
    // Modalità sysadmin: solo strumenti serverops, nessuna shell/FS locale.
    cwd = config.workdir;
    args.push('--allowedTools', 'mcp__serverops__list_servers,mcp__serverops__run_readonly,mcp__serverops__run_privileged');
    args.push('--disallowedTools', 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit');
    args.push('--append-system-prompt', SYSTEM_PROMPT);
  }
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
    const child = spawn(config.claudeBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
