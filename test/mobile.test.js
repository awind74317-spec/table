import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { normalizeRemoteAccess, requestAccess } from '../src/remote-access.js';
import { startServer } from '../src/server.js';

const origin = 'https://home.example.ts.net:8447';
const config = { origin, userLogin: 'owner@example.test' };
const forwarded = { host: 'home.example.ts.net:8447', 'x-forwarded-host': 'home.example.ts.net:8447',
  'x-forwarded-proto': 'https', 'tailscale-user-login': config.userLogin };
const req = headers => ({ headers, socket: { remoteAddress: '127.0.0.1' } });

test('private mobile access requires the exact Serve host, HTTPS and owner identity; Funnel is rejected', () => {
  const allowed = normalizeRemoteAccess(config);
  assert.deepEqual(requestAccess(req(forwarded), allowed), { remote: true, origin });
  for (const patch of [
    { 'tailscale-user-login': '' }, { 'tailscale-user-login': 'other@example.test' },
    { 'tailscale-funnel-request': '1' }, { origin: 'null' }, { origin: 'https://evil.test' },
    { host: '127.0.0.1:17880' }, { 'x-forwarded-host': 'wrong.example.ts.net:8447' },
    { 'x-forwarded-proto': 'http' },
  ]) assert.ok(requestAccess(req({ ...forwarded, ...patch }), allowed).error);
  assert.ok(requestAccess(req(forwarded), null).error);
  assert.ok(requestAccess({ ...req(forwarded), socket: { remoteAddress: '192.168.1.2' } }, allowed).error);
  assert.equal(requestAccess(req({ host: '127.0.0.1:17880' }), null).remote, false);
  assert.throws(() => normalizeRemoteAccess({ ...config, origin: 'https://public.example.com' }));
});

test('phone binding survives restart and GPT/relay sends continue with zero browser clients', async () => {
  const sessionsDir = await mkdtemp(path.join(tmpdir(), 'rt-mobile-'));
  const calls = [];
  let server;
  const gptBrowser = {
    async status() { return { available: true, running: true, ready: true }; },
    async send(task) {
      calls.push(task.taskId);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(task.isCurrent(), true);
      const entry = [...server.benches.values()].find(e => e.bench.externalTask?.taskId === task.taskId);
      assert.equal(entry.clients.size, 0);
      const auth = { taskId: task.taskId, key: entry.bench.externalTask.key, clientId: 'mobile-test-client' };
      const claimed = await entry.bench.externalCall('claim', auth);
      await entry.bench.externalCall('deliver', { ...auth, operationId: 'reply-' + task.taskId,
        ackSeq: claimed.nextSeq, text: 'PHONE TEST REPLY', final: true });
      return { ok: true, sent: true };
    },
  };
  const options = { port: 0, sessionsDir, agentsFile: 'test/agents.fixture.json', remoteAccess: config, gptBrowser };
  const request = (route, method, body, headers) => new Promise((resolve, reject) => {
    const outgoing = http.request(`http://127.0.0.1:${server.port}${route}`, { method, headers }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const post = async (route, body, remote = false) => {
    const response = await request(route, 'POST', body, { 'content-type': 'application/json', ...(remote ? { ...forwarded, origin } : {}) });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  async function finished(id) {
    for (let n = 0; n < 150; n++) {
      if (server.benches.get(id).bench.state === 'idle') return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('background task did not finish');
  }
  try {
    server = await startServer(options);
    const { id } = await post('/api/workbenches', { name: 'mobile', participants: ['gpt', 'mockA'] }, true);
    const chatUrl = 'https://chatgpt.com/c/6adaa9c0-0f94-83ec-8c50-59110cf9495d';
    await post(`/api/workbenches/${id}/gpt-connection`, { chatUrl }, true);
    const freshClient = (await request(`/api/workbenches/${id}`, 'GET', undefined, forwarded)).body;
    assert.equal(freshClient.gptChatUrl, chatUrl);
    await post(`/api/workbenches/${id}/message`, { text: 'PHONE TASK', to: ['gpt'] }, true);
    await finished(id);
    const dirname = path.basename(server.benches.get(id).bench.dir);
    server.close();
    server = await startServer(options);
    const resumed = await post('/api/workbenches/resume', { dirname }, true);
    assert.equal(server.benches.get(resumed.id).bench.gptChatUrl, chatUrl);
    await post(`/api/workbenches/${resumed.id}/relay`, { rounds: 1, order: ['gpt', 'mockA'], seed: 'PHONE RELAY' }, true);
    await finished(resumed.id);
    assert.equal(calls.length, 2);
    assert.equal(server.benches.get(resumed.id).bench.messages.at(-1).from, 'mockA');
  } finally { server?.close(); await rm(sessionsDir, { recursive: true, force: true }); }
});
