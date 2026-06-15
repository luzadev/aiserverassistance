# AI Server Assistance

Assistente **sysadmin via Telegram** alimentato da **Claude Code**.

Scrivi al bot in linguaggio naturale ("perché nginx su web1 dà 502?", "quanto spazio
è rimasto su db1?", "riavvia php-fpm su web1") e Claude:

1. **indaga in sola lettura** sui tuoi server via SSH (stato servizi, log, risorse, configurazioni);
2. quando serve un comando che **modifica** qualcosa (riavvii, edit di file, installazioni, query di scrittura) **te lo mostra su Telegram e attende la tua conferma** (pulsanti ✅/❌);
3. esegue solo ciò che approvi e ti riassume cosa ha trovato e fatto.

Gira sul tuo server "ponte" (quello che ha già accesso SSH agli altri) e usa la CLI di
Claude Code già installata e loggata lì — niente API key separata.

```
Telegram ─► bot.js (grammy + bridge HTTP 127.0.0.1)
               │  spawn per ogni richiesta
               ▼
          claude -p   (headless, --resume per la memoria della conversazione)
               │  unici strumenti: il server MCP "serverops" (nessuna shell locale)
               ▼
          mcp-server.js ──► ssh ──► i tuoi server
               │
               └─ run_privileged ─► bridge ─► Telegram (Approva/Nega) ─► esegue se approvi
```

## Sicurezza

- **Niente shell locale per Claude**: può usare solo i 3 strumenti `serverops`. La shell
  e la classificazione "sola lettura vs modifica" stanno nel codice di questo progetto.
- `run_readonly` accetta **solo** comandi di sola lettura (lista in `src/ssh.js`). Nel
  dubbio rifiuta e obbliga il passaggio da `run_privileged`.
- `run_privileged` **non esegue nulla** senza la tua approvazione esplicita su Telegram
  (con timeout → negato).
- Solo gli utenti in `ALLOWED_USER_IDS` possono parlare col bot. Tutti gli altri vengono ignorati.
- Il bridge di approvazione ascolta solo su `127.0.0.1` ed è protetto da un token casuale generato a ogni avvio.

## Prerequisiti (sul server ponte)

- **Node.js ≥ 20** (`node --version`)
- **Claude Code** installato e **loggato** (`claude` raggiungibile; prova `claude -p "ok" --output-format json`)
- **Accesso SSH senza password** (chiave) verso i server da gestire — verificalo con
  `ssh root@HOST 'echo ok'`. Il bot usa la config SSH e le chiavi dell'utente con cui gira.

## Installazione

```bash
git clone https://github.com/luzadev/aiserverassistance.git
cd aiserverassistance
npm install

# Configurazione
cp .env.example .env            # inserisci token bot e il/i tuoi ID Telegram
cp servers.example.json servers.json   # elenca i tuoi server (nome, host, user, descrizione)

# Avvio
npm start
```

Poi su Telegram apri una chat col tuo bot e scrivi `/start`.
Se non conosci il tuo ID Telegram, scrivi `/whoami` al bot e mettilo in `ALLOWED_USER_IDS`.

### `servers.json`

Dai un **nome parlante** a ogni server e una **descrizione**: Claude la usa per capire a
quale server ti riferisci.

```json
{
  "servers": [
    { "name": "web1", "host": "192.168.14.38", "user": "root", "description": "Server web nginx + php-fpm" },
    { "name": "db1",  "host": "192.168.30.95", "user": "root", "description": "Database MySQL di produzione" }
  ]
}
```

## Comandi del bot

| Comando | Azione |
|---|---|
| `/start` | Messaggio di benvenuto |
| `/servers` | Elenca i server configurati |
| `/reset` | Azzera la conversazione (nuova sessione Claude) |
| `/whoami` | Mostra il tuo ID Telegram |

Per il resto: **scrivi in italiano** cosa ti serve.

## Avvio come servizio (systemd)

```bash
sudo cp deploy/aiserverassistance.service /etc/systemd/system/
# modifica WorkingDirectory / User / HOME nel file secondo il tuo setup
sudo systemctl daemon-reload
sudo systemctl enable --now aiserverassistance
sudo journalctl -u aiserverassistance -f
```

## Configurazione (`.env`)

| Variabile | Default | Descrizione |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Token del bot da @BotFather |
| `ALLOWED_USER_IDS` | — | ID Telegram autorizzati (separati da virgola) |
| `CLAUDE_BIN` | `claude` | Eseguibile Claude Code |
| `CLAUDE_MODEL` | `opus` | Modello (`opus`/`sonnet`/`haiku`) |
| `CLAUDE_TIMEOUT_MS` | `900000` | Timeout di una richiesta a Claude |
| `BRIDGE_HOST` / `BRIDGE_PORT` | `127.0.0.1` / `8765` | Bridge approvazioni (solo locale) |
| `APPROVAL_TIMEOUT_MS` | `240000` | Attesa massima della tua approvazione |
| `SERVERS_FILE` | `./servers.json` | Elenco server |
| `WORKDIR` | `./workdir` | Directory di lavoro di Claude |

## Come estendere la "sola lettura"

Se Claude ti chiede conferma per comandi che consideri sicuri (es. un tool specifico),
aggiungi il binario a `READ_ONLY_BINS` (o le sue regole in `SUBCOMMAND_RULES`) in
`src/ssh.js`. Al contrario, restringere quella lista rende il bot più prudente.
