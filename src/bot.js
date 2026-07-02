// Bot Telegram: punto di ingresso del programma.
// - riceve i messaggi dell'utente autorizzato
// - per ogni richiesta lancia Claude Code in headless (con memoria di sessione)
// - ospita il bridge HTTP locale che gestisce le approvazioni dei comandi
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Bot, InlineKeyboard, GrammyError } from 'grammy';
import { run } from '@grammyjs/runner';
import { config, loadServers, loadProjects, findProject } from './config.js';
import { createApprovalBridge } from './bridge.js';
import { runClaude } from './claude.js';

// ─── Verifiche iniziali ──────────────────────────────────────────────────────
if (!config.telegramToken) {
  console.error('TELEGRAM_BOT_TOKEN mancante. Copia .env.example in .env e compilalo.');
  process.exit(1);
}
try {
  const servers = loadServers();
  console.log(`Server configurati: ${servers.map((s) => s.name).join(', ') || '(nessuno)'}`);
} catch (e) {
  console.error(`Attenzione: ${e.message}`);
  console.error('Il bot parte comunque, ma /servers e i comandi falliranno finché non crei servers.json.');
}

const BRIDGE_TOKEN = crypto.randomUUID();
const BRIDGE_URL = `http://${config.bridgeHost}:${config.bridgePort}`;
const SESSION_STORE = path.join(config.root, '.session-store.json');

// ─── Stato ───────────────────────────────────────────────────────────────────
const sessions = loadSessions(); // chiave contesto -> sessionId
const busy = new Set(); // chatId attualmente in elaborazione
const approvalByMsg = new Map(); // messageId -> { htmlText }
const modes = new Map(); // chatId -> { mode:'sysadmin'|'project', project?:{name,path} }

function getMode(chatId) {
  return modes.get(String(chatId)) || { mode: 'sysadmin' };
}
function sessionKey(chatId, m) {
  return m.mode === 'project' ? `${chatId}:proj:${m.project.name}` : `${chatId}:sys`;
}

// Marker per "riparti da zero" dopo /reset in modalità progetto (evita che
// venga riagganciata la cronologia importata).
const FRESH = '__fresh__';

// Trova l'ID dell'ultima sessione Claude Code registrata per la cartella di un
// progetto (incluse le cronologie importate). Claude Code indicizza le sessioni
// in ~/.claude/projects/<percorso-con-slash-sostituiti-da-trattini>/<id>.jsonl
function latestProjectSessionId(projectPath) {
  try {
    const encoded = projectPath.replace(/\//g, '-');
    const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    let best;
    let bestM = -1;
    for (const f of files) {
      const m = fs.statSync(path.join(dir, f)).mtimeMs;
      if (m > bestM) {
        bestM = m;
        best = f;
      }
    }
    return best ? best.replace(/\.jsonl$/, '') : undefined;
  } catch {
    return undefined;
  }
}

function loadSessions() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(SESSION_STORE, 'utf8'))));
  } catch {
    return new Map();
  }
}
function saveSessions() {
  try {
    fs.writeFileSync(SESSION_STORE, JSON.stringify(Object.fromEntries(sessions)));
  } catch (e) {
    console.error('Salvataggio sessioni fallito:', e.message);
  }
}

function isAllowed(userId) {
  if (config.allowedUserIds.length === 0) return false;
  return config.allowedUserIds.includes(String(userId));
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function chunk(text, size = 3800) {
  const out = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

// ─── Bot ───────────────────────────────────────────────────────────────────
const bot = new Bot(config.telegramToken);

// ─── Bridge di approvazione ───────────────────────────────────────────────────
const bridge = createApprovalBridge({
  host: config.bridgeHost,
  port: config.bridgePort,
  token: BRIDGE_TOKEN,
  timeoutMs: config.approvalTimeoutMs,
  async sendApprovalMessage({ chatId, id, title, body, code }) {
    const html =
      `⚠️ <b>${escapeHtml(title || 'Richiesta di conferma')}</b>\n` +
      (body ? `${escapeHtml(body)}\n` : '') +
      (code ? `\n<pre>${escapeHtml(code)}</pre>\n` : '') +
      'Approvi?';
    const kb = new InlineKeyboard().text('✅ Approva', `ok:${id}`).text('❌ Nega', `no:${id}`);
    const msg = await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', reply_markup: kb });
    approvalByMsg.set(msg.message_id, { htmlText: html });
    return msg.message_id;
  },
  async editApprovalMessage({ chatId, messageId, text }) {
    await applyApprovalStatus(chatId, messageId, text);
  },
});

async function applyApprovalStatus(chatId, messageId, statusText) {
  const entry = approvalByMsg.get(messageId);
  const base = entry ? entry.htmlText : '';
  approvalByMsg.delete(messageId);
  try {
    await bot.api.editMessageText(chatId, messageId, `${base}\n\n${escapeHtml(statusText)}`, {
      parse_mode: 'HTML',
    });
  } catch {
    // messaggio già modificato o non editabile: ignora
  }
}

// ─── Comandi ────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  if (!isAllowed(ctx.from?.id)) {
    await ctx.reply(
      'Ciao! Questo bot è privato. Il tuo ID Telegram è: ' +
        `${ctx.from?.id}\n\nChiedi all'amministratore di aggiungerlo a ALLOWED_USER_IDS nel file .env.`,
    );
    return;
  }
  await ctx.reply(
    'Ciao! Sono il tuo assistente sysadmin. 🛠️\n\n' +
      'Scrivimi cosa ti serve su uno dei tuoi server, in linguaggio naturale. Esempi:\n' +
      '• "Controlla perché nginx su web1 dà 502"\n' +
      '• "Quanto spazio disco è rimasto su db1?"\n' +
      '• "Riavvia il servizio php-fpm su web1"\n\n' +
      'Indagherò in sola lettura e, per ogni comando che modifica qualcosa, ti chiederò conferma con dei pulsanti.\n\n' +
      '🗂️ Modalità progetto: con /progetto <nome> posso anche leggere e modificare il codice di un progetto presente sul server (le modifiche restano soggette a conferma). /sys per tornare al sysadmin.\n\n' +
      'Comandi: /servers · /progetti · /progetto <nome> · /sys · /reset · /whoami',
  );
});

bot.command('help', (ctx) => ctx.reply('Scrivimi un problema o una richiesta sui tuoi server. /servers per l\'elenco, /reset per ripartire da capo.'));

bot.command('whoami', (ctx) => ctx.reply(`Il tuo ID Telegram è: ${ctx.from?.id}`));

bot.command('servers', async (ctx) => {
  if (!isAllowed(ctx.from?.id)) return;
  try {
    const servers = loadServers();
    const lines = servers.map(
      (s) => `• <b>${escapeHtml(s.name)}</b> → <code>${escapeHtml(s.user + '@' + s.host)}</code>${s.description ? '\n  ' + escapeHtml(s.description) : ''}`,
    );
    await ctx.reply(`Server configurati:\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  } catch (e) {
    await ctx.reply(`Errore: ${e.message}`);
  }
});

bot.command('reset', async (ctx) => {
  if (!isAllowed(ctx.from?.id)) return;
  const m = getMode(ctx.chat.id);
  const key = sessionKey(ctx.chat.id, m);
  if (m.mode === 'project') {
    // Fresh esplicito: NON riagganciare la cronologia importata.
    sessions.set(key, FRESH);
  } else {
    sessions.delete(key);
  }
  saveSessions();
  await ctx.reply('🔄 Conversazione azzerata. Ripartiamo da capo (senza riprendere la cronologia).');
});

bot.command('progetti', async (ctx) => {
  if (!isAllowed(ctx.from?.id)) return;
  let projects = [];
  try {
    projects = loadProjects();
  } catch (e) {
    await ctx.reply(`Errore lettura progetti: ${e.message}`);
    return;
  }
  if (projects.length === 0) {
    await ctx.reply('Nessun progetto configurato. Aggiungili in projects.json sul server.');
    return;
  }
  const lines = projects.map(
    (p) => `• <b>${escapeHtml(p.name)}</b>${p.description ? ' — ' + escapeHtml(p.description) : ''}\n  <code>${escapeHtml(p.path)}</code>`,
  );
  await ctx.reply(
    `Progetti disponibili:\n${lines.join('\n')}\n\nEntra con <code>/progetto &lt;nome&gt;</code>.`,
    { parse_mode: 'HTML' },
  );
});

bot.command('progetto', async (ctx) => {
  if (!isAllowed(ctx.from?.id)) return;
  const name = (ctx.match || '').trim();
  if (!name) {
    await ctx.reply('Uso: /progetto <nome>. Vedi /progetti per l\'elenco.');
    return;
  }
  let projects = [];
  try {
    projects = loadProjects();
  } catch (e) {
    await ctx.reply(`Errore lettura progetti: ${e.message}`);
    return;
  }
  const p = findProject(projects, name);
  if (!p) {
    await ctx.reply(`Progetto "${name}" non trovato. Vedi /progetti.`);
    return;
  }
  if (!fs.existsSync(p.path)) {
    await ctx.reply(`La cartella del progetto non esiste sul server: ${p.path}`);
    return;
  }
  modes.set(String(ctx.chat.id), { mode: 'project', project: { name: p.name, path: p.path } });
  const key = sessionKey(ctx.chat.id, { mode: 'project', project: p });
  const stored = sessions.get(key);
  const willResume = stored && stored !== FRESH ? true : !!latestProjectSessionId(p.path);
  await ctx.reply(
    `🗂️ Modalità progetto: <b>${escapeHtml(p.name)}</b>\n<code>${escapeHtml(p.path)}</code>\n\n` +
      (willResume
        ? '🧠 Riprenderò la conversazione precedente su questo progetto (cronologia trovata).\n'
        : '') +
      'Ora chiedimi pure di leggere/analizzare/modificare il codice. Le modifiche richiederanno la tua conferma.\n' +
      'Con /reset riparti da zero (senza cronologia). Torna al sysadmin con /sys.',
    { parse_mode: 'HTML' },
  );
});

bot.command(['sys', 'esci'], async (ctx) => {
  if (!isAllowed(ctx.from?.id)) return;
  modes.set(String(ctx.chat.id), { mode: 'sysadmin' });
  await ctx.reply('🛠️ Modalità sysadmin (server). Scrivimi cosa ti serve.');
});

// ─── Pulsanti di approvazione ──────────────────────────────────────────────────
bot.callbackQuery(/^(ok|no):(.+)$/, async (ctx) => {
  if (!isAllowed(ctx.from?.id)) {
    await ctx.answerCallbackQuery({ text: 'Non autorizzato', show_alert: true });
    return;
  }
  const action = ctx.match[1];
  const id = ctx.match[2];
  const decision = action === 'ok' ? 'allow' : 'deny';
  const handled = bridge.resolve(id, decision);
  const status = !handled
    ? '⏱️ Richiesta non più valida (scaduta o già gestita).'
    : decision === 'allow'
      ? '✅ Approvato — eseguo il comando…'
      : '❌ Negato — comando non eseguito.';
  await applyApprovalStatus(ctx.chat.id, ctx.callbackQuery.message.message_id, status);
  await ctx.answerCallbackQuery();
});

// ─── Messaggi di testo: una richiesta per Claude ───────────────────────────────
bot.on('message:text', async (ctx) => {
  const userId = ctx.from?.id;
  if (!isAllowed(userId)) {
    await ctx.reply(`Non sei autorizzato. Il tuo ID è ${userId}: chiedi all'amministratore di aggiungerlo.`);
    return;
  }
  const chatId = String(ctx.chat.id);
  if (busy.has(chatId)) {
    await ctx.reply('⏳ Sto ancora lavorando alla richiesta precedente. Aspetta che finisca o usa /reset.');
    return;
  }
  busy.add(chatId);

  // Indicatore "sta scrivendo" finché Claude lavora.
  const typing = setInterval(() => ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {}), 6000);
  ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {});

  try {
    const m = getMode(chatId);
    const key = sessionKey(chatId, m);
    let sessionId = sessions.get(key);
    if (sessionId === FRESH) {
      sessionId = undefined; // /reset richiesto: parti pulito
    } else if (!sessionId && m.mode === 'project') {
      // Prima volta su questo progetto: riprendi l'ultima sessione registrata
      // (incluse le cronologie importate), se esiste.
      sessionId = latestProjectSessionId(m.project.path);
    }
    const res = await runClaude({
      prompt: ctx.message.text,
      sessionId,
      chatId,
      bridgeUrl: BRIDGE_URL,
      bridgeToken: BRIDGE_TOKEN,
      mode: m.mode,
      projectPath: m.project?.path,
      projectName: m.project?.name,
    });

    if (res.sessionId) {
      sessions.set(key, res.sessionId);
      saveSessions();
    }

    const text = res.result || '(nessuna risposta)';
    for (const part of chunk(text)) {
      await ctx.reply(part);
    }
    if (res.isError && res.stderr) {
      console.error('[claude stderr]', res.stderr.slice(-2000));
    }
  } catch (e) {
    console.error('Errore elaborazione:', e);
    await ctx.reply(`❌ Errore: ${e.message}`);
  } finally {
    clearInterval(typing);
    busy.delete(chatId);
  }
});

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) console.error('Errore Telegram:', e.description);
  else console.error('Errore bot:', e);
});

// ─── Avvio ─────────────────────────────────────────────────────────────────
await bridge.start();
console.log(`Bridge approvazioni in ascolto su ${BRIDGE_URL}`);

await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
await bot.init();
// Runner: elabora gli update in CONCORRENZA. Indispensabile perché il click su
// "Approva/Nega" (callback_query) venga gestito mentre il gestore del messaggio
// è ancora in attesa che Claude completi la richiesta (altrimenti deadlock).
const runner = run(bot);
console.log(`Bot @${bot.botInfo.username} avviato (elaborazione concorrente). In ascolto…`);

const stop = () => { if (runner.isRunning()) runner.stop(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
