import assert from 'node:assert/strict';
import test from 'node:test';
import { starRepositoryWithGh } from './gh-star-cli.js';

const http = (status, headers = '', body = '') => `HTTP/2.0 ${status}\r\n${headers}${headers ? '\r\n' : ''}\r\n${body}`;
const failed = { code: 1 };
const repo = 'user/starred/juliiiiiiiu/session-stickies-manage-your-attention';

function fixture({ gh = [null, http(204), ''], proxy = [], env = {}, platform = 'linux', signal } = {}) {
  const calls = [];
  const result = starRepositoryWithGh(signal, {
    env, platform,
    run(command, args, options, callback) {
      calls.push({ command, args, options: { ...options, env: { ...options.env } } });
      const [error, stdout = '', stderr = ''] = command === 'gh' ? gh : proxy;
      callback(error, stdout, stderr);
    },
  });
  return { calls, result };
}

test('the signed-in CLI receives one fixed noninteractive PUT, without token overrides', async () => {
  const env = { PATH: '/bin', HOME: '/home/signed-in', GH_HOST: 'other.example', GH_REPO: 'other/repo', GH_DEBUG: 'api', GH_CONFIG_DIR: '/other-config' };
  for (const token of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'github_token', 'DSH_SESSION_SECRET']) {
    Object.defineProperty(env, token, { enumerable: true, get() { assert.fail(`${token} was read`); } });
  }
  const { calls, result } = fixture({ env });
  assert.deepEqual(await result, { ok: true, status: 'starred' });
  assert.equal(calls.length, 1);
  const [{ command, args, options }] = calls;
  assert.equal(command, 'gh');
  assert.deepEqual(args, [
    'api', '--hostname', 'github.com', '--include', '--method', 'PUT',
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28', repo,
  ]);
  assert.equal(options.env.HOME, '/home/signed-in');
  assert.equal(options.env.GH_PROMPT_DISABLED, '1');
  assert.equal(options.env.GH_PAGER, '');
  assert.equal(options.shell, undefined);
  assert.ok(options.timeout > 0 && options.timeout <= 12000);
  assert.ok(options.maxBuffer > 0 && options.maxBuffer <= 128 * 1024);
  for (const key of Object.keys(env).filter(key => key !== 'PATH' && key !== 'HOME')) {
    assert.equal(Object.hasOwn(options.env, key), false, key);
  }
});

for (const [name, gh, status] of [
  ['response without 204', [null, http(200)], 'retry'],
  ['success-looking response body', [null, http(200, '', 'HTTP/2.0 204\n')], 'retry'],
  ['204 with a CLI failure', [failed, http(204)], 'retry'],
  ['missing executable', [{ code: 'ENOENT' }], 'noAuthorization'],
  ['CLI is not logged in', [failed, '', 'To get started with GitHub CLI, please run: gh auth login'], 'noAuthorization'],
  ['expired login', [failed, http(401)], 'noAuthorization'],
  ['token lacks permission', [failed, http(403, '', '{"message":"Resource not accessible by integration"}')], 'noAuthorization'],
  ['scope restriction masked as a 404', [failed, http(404), 'This API operation needs the "public_repo" scope'], 'noAuthorization'],
  ['unexplained permission response', [failed, http(403)], 'retry'],
  ['primary rate limit with permission-looking body', [failed, http(403, 'X-RateLimit-Remaining: 0', '{"message":"Permission denied"}')], 'retry'],
  ['secondary rate limit', [failed, http(403), 'You have exceeded a secondary rate limit'], 'retry'],
  ['retry-after takes precedence over permissions', [failed, http(403, 'Retry-After: 60'), 'Resource not accessible'], 'retry'],
  ['429', [failed, http(429)], 'retry'],
  ['503', [failed, http(503)], 'retry'],
  ['network failure', [failed, '', 'Post "https://api.github.com/user/starred/…": EOF'], 'retry'],
  ['deadline', [{ killed: true, signal: 'SIGKILL' }, http(401)], 'retry'],
  ['response exceeded maxBuffer', [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, http(204)], 'retry'],
]) {
  test(name, async () => {
    const { calls, result } = fixture({ gh });
    assert.deepEqual(await result, { ok: true, status });
    assert.equal(calls.length, 1);
  });
}

const proxyConfig = (host = 'proxy.lan', port = 8443, enabled = 1) => [
  '<dictionary> {', '  HTTPEnable : 1', '  HTTPProxy : unused.lan', '  HTTPPort : 8080',
  `  HTTPSEnable : ${enabled}`, `  HTTPSProxy : ${host}`, `  HTTPSPort : ${port}`, '}', '',
].join('\n');

test('macOS uses its enabled HTTPS proxy and bounds proxy discovery', async () => {
  const { calls, result } = fixture({ platform: 'darwin', proxy: [null, proxyConfig()] });
  assert.deepEqual(await result, { ok: true, status: 'starred' });
  assert.deepEqual(calls.map(call => call.command), ['/usr/sbin/scutil', 'gh']);
  assert.deepEqual(calls[0].args, ['--proxy']);
  assert.ok(calls[0].options.timeout > 0 && calls[0].options.timeout <= 1000);
  assert.equal(calls[1].options.env.HTTPS_PROXY, 'http://proxy.lan:8443');
});

for (const key of ['HTTPS_PROXY', 'https_proxy']) {
  test(`macOS preserves explicit ${key} and NO_PROXY without discovery`, async () => {
    const env = { [key]: 'http://explicit.lan:4321', NO_PROXY: 'localhost' };
    const { calls, result } = fixture({ platform: 'darwin', env });
    assert.deepEqual(await result, { ok: true, status: 'starred' });
    assert.deepEqual(calls.map(call => call.command), ['gh']);
    assert.equal(calls[0].options.env[key], env[key]);
    assert.equal(calls[0].options.env.NO_PROXY, 'localhost');
  });
}

for (const [name, proxy] of [
  ['disabled', [null, proxyConfig('proxy.lan', 8443, 0)]],
  ['invalid URL-like host', [null, proxyConfig('user@proxy.lan')]],
  ['invalid port', [null, proxyConfig('proxy.lan', 65536)]],
  ['unavailable', [{ code: 'ENOENT' }]],
]) {
  test(`a ${name} system proxy does not replace the environment or cause fallback`, async () => {
    const { calls, result } = fixture({ platform: 'darwin', proxy, gh: [failed, '', 'EOF'] });
    assert.deepEqual(await result, { ok: true, status: 'retry' });
    assert.deepEqual(calls.map(call => call.command), ['/usr/sbin/scutil', 'gh']);
    assert.equal(calls[1].options.env.HTTPS_PROXY, undefined);
  });
}

test('a canceled click does not start any child command', async () => {
  const { calls, result } = fixture({ platform: 'darwin', signal: AbortSignal.abort() });
  assert.deepEqual(await result, { ok: true, status: 'retry' });
  assert.deepEqual(calls, []);
});
