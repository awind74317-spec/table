import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';

test('native browser API only sends the current server-owned task and rejects cross-origin triggers', async () => {
  const sessionsDir = await mkdtemp(path.join(tmpdir(), 'rt-native-api-'));
  const calls = [];
  let firstSend = true;
  const gptBrowser = {
    async status(chatUrl) { return { available: true, running: true, ready: !!chatUrl, transport: 'native-browser', extensions: false }; },
    async open(chatUrl) { calls.push({ action: 'open', chatUrl }); return { ok: true, opened: true }; },
    async send(body) {
      calls.push({ action: 'send', ...body });
      if (firstSend) { firstSend = false; throw new Error('DRAFT_PRESENT'); }
      return { ok: true, sent: true, alreadySent: false };
    },
  };
  const server = await startServer({ port: 0, sessionsDir, agentsFile: 'test/agents.fixture.json', gptBrowser });
  const base = `http://127.0.0.1:${server.port}`;
  const chatUrl = 'https://chatgpt.com/c/6adaa9c0-0f94-83ec-8c50-59110cf9495d';
  const post = (route, body = {}, origin) => fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await (await fetch(base + '/api/gpt-browser/status?chatUrl=' + encodeURIComponent(chatUrl))).json()).ready, true);
    for (const origin of ['https://evil.test', 'null', 'http://127.0.0.1:9999']) {
      assert.equal((await post('/api/gpt-browser/open', { chatUrl }, origin)).status, 403);
    }
    assert.equal(calls.length, 0);
    assert.equal((await post('/api/gpt-browser/open', { chatUrl }, base)).status, 200);
    const bench = await (await post('/api/workbenches', { name: 'native test', participants: ['gpt'] })).json();
    const route = '/api/workbenches/' + bench.id;
    assert.equal((await post(route + '/gpt-send', { chatUrl, taskId: 'none' })).status, 409);
    await post(route + '/gpt-connection', { chatUrl });
    await post(route + '/message', { text: 'ACTUAL USER TASK', to: ['gpt'] });
    const detail = await (await fetch(base + route)).json();
    assert.equal((await post(route + '/gpt-send', { chatUrl, taskId: 'old' })).status, 409);
    assert.equal((await post(route + '/gpt-send', { chatUrl: 'https://evil.test', taskId: detail.external.taskId })).status, 400);
    const sent = await post(route + '/gpt-send', { chatUrl, taskId: detail.external.taskId, text: 'UNTRUSTED_TEXT' });
    assert.equal(sent.status, 200);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].taskId, detail.external.taskId);
    assert.match(calls[2].text, /ACTUAL USER TASK/);
    assert.doesNotMatch(calls[2].text, /UNTRUSTED_TEXT/);
    await post(route + '/stop');
  } finally { server.close(); await rm(sessionsDir, { recursive: true, force: true }); }
});

test('unbound panelists and chair auto-bind different Chats; acknowledged cursors and bindings survive restart', async () => {
  const sessionsDir = await mkdtemp(path.join(tmpdir(), 'rt-auto-binding-'));
  let server;
  const calls = [], errors = [];
  const urls = Object.fromEntries(['gpt', 'gpt2', 'gpt3'].map((id, i) => [id, `https://chatgpt.com/c/20000000-0000-0000-0000-00000000000${i}`]));
  const gptBrowser = { async send(task) {
    try {
      const w = [...server.benches.values()].find(e => e.bench.externalTask?.taskId === task.taskId).bench;
      const t = w.externalTask;
      calls.push({ id: t.agentId, chatUrl: task.chatUrl });
      const auth = { taskId: t.taskId, key: t.key, clientId: 'auto-' + t.agentId };
      const ctx = await w.externalCall('claim', auth);
      // A browser can discover the URL after MCP has already acknowledged the first task.
      await task.onChatUrl(urls[t.agentId]);
      assert.equal(w.cursorFor(t.agentId).clientId, auth.clientId);
      await w.externalCall('deliver', { ...auth, ackSeq: ctx.nextSeq, operationId: 'reply-' + t.taskId,
        text: t.agentId === 'gpt3' ? 'AUTO_CHAIR_SUMMARY' : 'AUTO_PANEL', final: true });
      return { ok: true, sent: true, chatUrl: urls[t.agentId] };
    } catch (error) { errors.push(error); throw error; }
  } };
  const options = { port: 0, sessionsDir, agentsFile: 'test/agents.fixture.json', gptBrowser };
  const post = async (route, body, status = 200, origin) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
    const data = await res.json(); assert.equal(res.status, status, JSON.stringify(data)); return data;
  };
  const done = async id => {
    for (let n = 0; n < 250; n++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      if (server.benches.get(id).bench.state === 'idle') { assert.deepEqual(errors, []); return; }
    }
    assert.fail('auto-bound relay did not finish');
  };
  try {
    server = await startServer(options);
    let { id } = await post('/api/workbenches', { participants: ['gpt'] });
    let route = `/api/workbenches/${id}`;
    await post(route + '/seats', { op: 'add', provider: 'gpt' });
    await post(route + '/seats', { op: 'add', provider: 'gpt' });
    await post(route + '/seats', { op: 'chair', agentId: 'gpt3' });
    await post(route + '/relay', { order: ['gpt', 'gpt2'], seed: 'AUTO_USER_GOAL' }, 403, 'null');
    await post(route + '/message', { to: ['gpt'], text: 'must not send' }, 403, 'http://127.0.0.1:9999');
    assert.equal(calls.length, 0);
    await post(route + '/relay', { rounds: 1, order: ['gpt', 'gpt2'], seed: 'AUTO_USER_GOAL' }); await done(id);
    const w = server.benches.get(id).bench;
    assert.deepEqual(calls.map(c => c.chatUrl), ['', '', '']);
    assert.deepEqual(calls.map(c => c.id), ['gpt', 'gpt2', 'gpt3']);
    for (const [seatId, url] of Object.entries(urls)) {
      assert.equal(w.chatUrlFor(seatId), url);
      assert.ok(w.cursorFor(seatId).lastSeq > 0);
    }
    assert.equal(w.messages.at(-1).text, 'AUTO_CHAIR_SUMMARY');
    const dirname = path.basename(w.dir);
    server.close(); server = await startServer(options);
    ({ id } = await post('/api/workbenches/resume', { dirname })); route = `/api/workbenches/${id}`;
    for (const [seatId, url] of Object.entries(urls)) assert.equal(server.benches.get(id).bench.chatUrlFor(seatId), url);
    await post(route + '/message', { to: ['gpt2'], text: 'FOLLOWUP' }); await done(id);
    assert.equal(calls.at(-1).chatUrl, urls.gpt2);
    assert.equal(server.benches.get(id).bench.messages.at(-1).sync.mode, 'resume');
  } finally { server?.close(); await rm(sessionsDir, { recursive: true, force: true }); }
});
