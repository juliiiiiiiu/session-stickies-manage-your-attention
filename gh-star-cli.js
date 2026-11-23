import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { homedir } from 'node:os';

const args = [
  'api', '--hostname', 'github.com', '--include', '--method', 'PUT',
  '-H', 'Accept: application/vnd.github+json',
  '-H', 'X-GitHub-Api-Version: 2022-11-28',
  'user/starred/juliiiiiiiu/session-stickies-manage-your-attention',
];
const excludedEnv = /KEY|PASSWORD|SECRET|TOKEN|^DSH_|^GH_(?:HOST|REPO|DEBUG|API_URL|CONFIG_DIR|FORCE_TTY)$/i;
const loginRequired = /gh auth login|bad credentials|requires authentication|not logged (?:in|into)/i;
const permissionDenied = /this api operation needs the .+ scope|resource not accessible|insufficient (?:permission|scope)|requires .*scope|permission denied/i;
const hostLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function runCommand(run, command, args, options) {
  return new Promise(resolve => {
    const child = run(command, args, options, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    child?.stdin?.on('error', () => {});
    child?.stdin?.end();
  });
}

function parseSystemHttpsProxy(stdout) {
  const proxy = Object.fromEntries(stdout.split(/\r?\n/).flatMap(line => {
    const field = /^  (HTTPSEnable|HTTPSProxy|HTTPSPort) : (\S+)\s*$/.exec(line);
    return field ? [[field[1], field[2]]] : [];
  }));
  if (proxy.HTTPSEnable !== '1' || !/^\d{1,5}$/.test(proxy.HTTPSPort ?? '')) return;
  const port = Number(proxy.HTTPSPort);
  const host = proxy.HTTPSProxy?.replace(/^\[([^\]]+)\]$/, '$1');
  if (!host || port < 1 || port > 65535) return;
  if (isIP(host) === 6) return `http://[${host}]:${port}`;
  if (host.length <= 253 && host.replace(/\.$/, '').split('.').every(label => hostLabel.test(label))) {
    return `http://${host}:${port}`;
  }
}

function starStatus({ error, stdout = '', stderr = '' }) {
  const [headers, ...body] = stdout.split(/\r?\n\r?\n/);
  const status = Number(/^HTTP\/(?:\d+\.)?\d+[ \t]+(\d{3})(?=[ \t\r\n]|$)/.exec(headers)?.[1]);
  if (error?.code === 'ENOENT') return 'noAuthorization';
  if (error?.killed || error?.signal || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error?.code === 'ABORT_ERR') return 'retry';
  if (!error && status === 204) return 'starred';
  if (status === 401) return 'noAuthorization';
  if (status === 429 || status >= 500) return 'retry';
  const diagnostic = `${stderr}\n${body.join('\n')}`;
  if (/^(?:retry-after\s*:|x-ratelimit-remaining\s*:\s*0\s*$)/im.test(headers) || /rate limit|abuse detection/i.test(diagnostic)) return 'retry';
  if (loginRequired.test(diagnostic)) return 'noAuthorization';
  if ((status === 403 || status === 404) && permissionDenied.test(diagnostic)) return 'noAuthorization';
  return 'retry';
}

export async function starRepositoryWithGh(signal, { run = execFile, env = process.env, platform = process.platform } = {}) {
  const reply = status => ({ ok: true, status });
  try {
    signal?.throwIfAborted();
    const safeEnv = Object.fromEntries(Object.keys(env).filter(key => !excludedEnv.test(key)).map(key => [key, env[key]]));
    Object.assign(safeEnv, { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_TELEMETRY: 'false', GH_PAGER: '', NO_COLOR: '1', CLICOLOR: '0', CLICOLOR_FORCE: '0' });
    const options = { env: safeEnv, cwd: homedir(), timeout: 12000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024, windowsHide: true, signal };
    if (platform === 'darwin') {
      safeEnv.PATH = [safeEnv.PATH || '/usr/bin:/bin', '/opt/homebrew/bin', '/usr/local/bin'].join(':');
      if (!safeEnv.HTTPS_PROXY && !safeEnv.https_proxy) {
        const { error, stdout } = await runCommand(run, '/usr/sbin/scutil', ['--proxy'], { ...options, timeout: 1000 });
        const proxy = !error && parseSystemHttpsProxy(stdout);
        if (proxy) safeEnv.HTTPS_PROXY = proxy;
      }
    }
    signal?.throwIfAborted();
    const result = await runCommand(run, 'gh', [...args], options);
    signal?.throwIfAborted();
    return reply(starStatus(result));
  } catch {
    return reply('retry');
  }
}
