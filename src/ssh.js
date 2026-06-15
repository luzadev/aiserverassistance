// Esecuzione SSH + classificazione comandi di sola lettura.
// La sicurezza vive QUI: run_readonly accetta solo comandi che superano isReadOnly().
import { execFile } from 'node:child_process';

// Binari considerati di sola lettura (non modificano stato di sistema/file).
const READ_ONLY_BINS = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'nl', 'tac',
  'grep', 'egrep', 'fgrep', 'zgrep', 'zcat',
  'find', 'locate', 'stat', 'file', 'readlink', 'realpath', 'basename', 'dirname',
  'wc', 'sort', 'uniq', 'cut', 'awk', 'sed', 'tr', 'column', 'xargs',
  'df', 'du', 'free', 'uptime', 'uname', 'hostname', 'hostnamectl', 'arch',
  'whoami', 'id', 'who', 'w', 'last', 'lastlog', 'groups', 'getent',
  'ps', 'pgrep', 'top', 'htop', 'vmstat', 'iostat', 'mpstat', 'sar', 'pidstat',
  'dmesg', 'lsof', 'ss', 'netstat', 'ip', 'ifconfig', 'route', 'arp',
  'ping', 'ping6', 'traceroute', 'tracepath', 'mtr', 'dig', 'nslookup', 'host', 'getent',
  'date', 'cal', 'uptime', 'env', 'printenv', 'locale',
  'lscpu', 'lsblk', 'lsmod', 'lspci', 'lsusb', 'blkid', 'fdisk', 'lsof',
  'mount', 'findmnt', 'swapon',
  'echo', 'pwd', 'which', 'type', 'whereis', 'command', 'true', 'false', 'test',
  'sha256sum', 'md5sum', 'sha1sum', 'cksum',
  'tree', 'ncdu', 'watch',
  'systemctl', 'journalctl', 'service', 'systemd-analyze', 'loginctl', 'timedatectl',
  'docker', 'podman', 'kubectl', 'crictl', 'nginx', 'apachectl', 'httpd', 'php', 'php-fpm',
  'git', 'composer', 'npm', 'node', 'python', 'python3', 'pip', 'pip3',
  'sysctl', 'ulimit', 'crontab', 'ufw', 'iptables', 'firewall-cmd',
  'mysql', 'mysqladmin', 'psql', 'redis-cli',
  'sleep',
]);

// Sottocomandi consentiti per binari che hanno sia lettura che scrittura.
const SUBCOMMAND_RULES = {
  systemctl: { allow: ['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files', 'list-timers', 'list-sockets', 'list-dependencies', 'show', 'show-environment', 'cat', 'get-default', '--version', '--help'] },
  service: { allow: ['status'] },
  docker: { allow: ['ps', 'logs', 'inspect', 'images', 'stats', 'version', 'info', 'top', 'port', 'df', 'history', 'events', 'diff', 'volume', 'network', 'system', 'image', 'container', 'compose'] },
  podman: { allow: ['ps', 'logs', 'inspect', 'images', 'stats', 'version', 'info', 'top', 'port', 'df', 'history', 'events', 'diff'] },
  kubectl: { allow: ['get', 'describe', 'logs', 'top', 'version', 'explain', 'api-resources', 'config', 'cluster-info', 'events'] },
  crictl: { allow: ['ps', 'pods', 'images', 'inspect', 'logs', 'stats', 'info', 'version'] },
  git: { allow: ['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'describe', 'blame', 'ls-files', 'config', 'tag', 'shortlog', 'reflog', 'whatchanged', 'cat-file', 'fetch'] },
  nginx: { allow: ['-t', '-T', '-v', '-V'] },
  apachectl: { allow: ['configtest', '-t', '-S', '-v', '-V', 'status'] },
  httpd: { allow: ['-t', '-S', '-v', '-V'] },
  composer: { allow: ['show', 'status', 'diagnose', 'about', 'config', 'licenses', 'validate', 'outdated'] },
  npm: { allow: ['ls', 'list', 'outdated', 'view', 'config', 'doctor', 'why', 'audit'] },
  pip: { allow: ['list', 'show', 'freeze', 'check'] },
  pip3: { allow: ['list', 'show', 'freeze', 'check'] },
  ufw: { allow: ['status'] },
  iptables: { allow: ['-L', '-S', '-n', '-t', '-v'] },
  'firewall-cmd': { allow: ['--list-all', '--list-all-zones', '--state', '--get-active-zones', '--get-zones', '--get-services'] },
  crontab: { allow: ['-l'] },
  mysqladmin: { allow: ['status', 'extended-status', 'processlist', 'variables', 'version', 'ping'] },
};

// Flag che consumano il token successivo come valore (vanno saltati quando si
// cerca il sottocomando).
const VALUE_FLAGS = {
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']),
  docker: new Set(['-H', '--host', '--context', '--config', '-c']),
  kubectl: new Set(['-n', '--namespace', '--context', '--cluster', '--kubeconfig']),
};

// Token che indicano scrittura/distruzione anche dentro binari "read-only".
const DANGER_TOKENS = [
  '--vacuum', '--rotate', '-w', '--delete', '-delete', '-exec', '-execdir',
  '--force', '--prune', '--write', 'flush', 'restart', 'reload', 'start', 'stop',
];

function stripRedirections(segment) {
  // Consenti solo redirezioni innocue verso /dev/null e fusione stderr.
  return segment
    .replace(/2>&1/g, ' ')
    .replace(/&>\s*\/dev\/null/g, ' ')
    .replace(/2>\s*\/dev\/null/g, ' ')
    .replace(/1?>\s*\/dev\/null/g, ' ');
}

/**
 * Decide se un comando è di sola lettura (può girare senza approvazione umana).
 * Conservativo: nel dubbio ritorna false → Claude dovrà usare run_privileged.
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function isReadOnly(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, reason: 'comando vuoto' };

  // Blocca sostituzioni di comando e redirezioni verso file reali.
  if (/\$\(|`/.test(cmd)) {
    return { ok: false, reason: 'sostituzione di comando ($(...) o backtick) non ammessa in sola lettura' };
  }
  const noNull = stripRedirections(cmd);
  if (/(^|\s)\d?>>?\s*[^&\s]/.test(noNull) || /(^|\s)>\s*[^&\s]/.test(noNull)) {
    return { ok: false, reason: 'redirezione su file non ammessa in sola lettura' };
  }

  // Spezza su separatori di pipeline/sequenza e valida ogni segmento.
  const segments = cmd.split(/\|\||&&|\||;/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const r = checkSegment(seg);
    if (!r.ok) return r;
  }
  return { ok: true };
}

function checkSegment(segment) {
  let tokens = segment.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { ok: false, reason: 'segmento vuoto' };

  // Salta eventuali assegnazioni VAR=val iniziali e "sudo".
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
  if (tokens[0] === 'sudo') tokens = tokens.slice(1);
  if (tokens.length === 0) return { ok: false, reason: 'nessun binario' };

  let bin = tokens[0];
  // Gestisci percorsi tipo /usr/bin/systemctl
  if (bin.includes('/')) bin = bin.split('/').pop();

  if (!READ_ONLY_BINS.has(bin)) {
    return { ok: false, reason: `comando "${bin}" non è nella lista di sola lettura` };
  }

  const rest = tokens.slice(1);
  // Token pericolosi (esclusi i casi gestiti dalle regole specifiche più sotto).
  for (const t of rest) {
    if (DANGER_TOKENS.includes(t) && !(SUBCOMMAND_RULES[bin]?.allow.includes(t))) {
      return { ok: false, reason: `opzione "${t}" implica una modifica` };
    }
  }

  // Regole per sottocomandi (primo argomento non-opzione, saltando i flag che
  // consumano un valore, es. `git -C <dir>`).
  const rule = SUBCOMMAND_RULES[bin];
  if (rule) {
    const valueFlags = VALUE_FLAGS[bin] || new Set();
    let sub = '';
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t.startsWith('-')) {
        if (valueFlags.has(t)) i++; // salta il valore del flag
        continue;
      }
      sub = t;
      break;
    }
    const candidate = sub || rest[0] || '';
    if (!rule.allow.includes(candidate)) {
      return {
        ok: false,
        reason: `"${bin} ${candidate}" non è un'operazione di sola lettura (ammessi: ${rule.allow.slice(0, 6).join(', ')}…)`,
      };
    }
  }

  // ip: blocca operazioni di modifica.
  if (bin === 'ip' && /\b(add|del|set|change|replace|flush|append)\b/.test(rest.join(' '))) {
    return { ok: false, reason: 'ip con operazione di modifica' };
  }
  // sysctl: solo lettura (niente -w o chiave=valore).
  if (bin === 'sysctl' && (rest.includes('-w') || rest.some((t) => t.includes('=')))) {
    return { ok: false, reason: 'sysctl in scrittura' };
  }
  // mysql/psql/redis: blocca query di modifica evidenti.
  if (['mysql', 'psql', 'redis-cli'].includes(bin)) {
    if (/\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|flushall|flushdb|set\s)\b/i.test(segment)) {
      return { ok: false, reason: 'query SQL/Redis di modifica' };
    }
  }

  return { ok: true };
}

/**
 * Esegue un comando su un server via SSH.
 * @param {{host:string,user:string}} server
 * @param {string} command
 * @param {{timeoutMs?:number}} opts
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function sshExec(server, command, opts = {}) {
  const timeout = opts.timeoutMs ?? 120000;
  const target = `${server.user}@${server.host}`;
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'LogLevel=ERROR',
    target,
    command,
  ];
  return new Promise((resolve) => {
    execFile('ssh', args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && error.killed) {
        resolve({ code: 124, stdout: stdout || '', stderr: `Timeout dopo ${timeout}ms` });
        return;
      }
      const code = error && typeof error.code === 'number' ? error.code : 0;
      resolve({ code, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

export function clip(text, max = 6000) {
  if (text == null) return '';
  const s = String(text);
  return s.length > max ? s.slice(0, max) + `\n…[troncato, ${s.length} caratteri]` : s;
}
