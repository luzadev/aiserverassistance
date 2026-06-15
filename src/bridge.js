// Bridge HTTP locale (solo 127.0.0.1) tra il server MCP e il bot Telegram.
// Il server MCP chiede l'approvazione di un comando; il bridge inoltra la
// richiesta al bot (che la mostra su Telegram) e resta in attesa della tua
// risposta, poi la restituisce al server MCP.
import http from 'node:http';
import crypto from 'node:crypto';

export function createApprovalBridge({
  host,
  port,
  token,
  timeoutMs,
  sendApprovalMessage, // async ({chatId,id,server,host,command,reason}) -> messageId
  editApprovalMessage, // async ({chatId,messageId,text}) -> void
}) {
  const pending = new Map(); // id -> { resolve, timer, chatId, messageId }

  function finish(id, result, edited) {
    const entry = pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(id);
    if (!edited && result.uiText) {
      editApprovalMessage({ chatId: entry.chatId, messageId: entry.messageId, text: result.uiText })
        .catch(() => {});
    }
    entry.resolve({ decision: result.decision, reason: result.reason, command: result.command });
    return true;
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pending: pending.size }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/approval') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', async () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end('bad json');
        return;
      }
      if (data.token !== token) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      const id = crypto.randomUUID();
      let messageId;
      try {
        messageId = await sendApprovalMessage({
          chatId: data.chatId,
          id,
          server: data.server,
          host: data.host,
          command: data.command,
          reason: data.reason,
        });
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ decision: 'deny', reason: `invio Telegram fallito: ${e.message}` }));
        return;
      }

      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          finish(id, {
            decision: 'deny',
            reason: 'tempo scaduto',
            uiText: '⏱️ Richiesta scaduta — comando NON eseguito.',
          }, false);
        }, timeoutMs);
        pending.set(id, { resolve, timer, chatId: data.chatId, messageId });
      });

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });

  return {
    start() {
      return new Promise((resolve) => server.listen(port, host, resolve));
    },
    stop() {
      return new Promise((resolve) => server.close(resolve));
    },
    // Chiamato dal bot quando l'utente tocca un pulsante.
    resolve(id, decision, command) {
      return finish(id, { decision, command }, true);
    },
    isPending(id) {
      return pending.has(id);
    },
  };
}
