import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';

test('three GPT chats keep independent cursors across restart; discussion history survives while construction stays disabled', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rt-multiseat-'));
  const repo = path.join(root, 'repo');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' });
  git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(repo, 'result.txt'), 'before'); git('add', 'result.txt'); git('commit', '-m', 'fixture');
  const capture = path.join(root, 'received.jsonl');
  const agentsFile = path.join(root, 'agents.json');
  await writeFile(agentsFile, JSON.stringify({ codex: {
    name: 'Codex fixture', command: [process.execPath, path.resolve('test/mock-cli.cjs')],
    writeArgs: [path.resolve('test/mock-cli.cjs')], input: 'stdin', output: 'stream-json', timeoutMs: 5000,
    resumeArgs: ['--resume', '{SESSION_ID}'],
    env: { MOCK_SESSION_MODE: 'codex', MOCK_CAPTURE_FILE: capture, MOCK_WRITE_FILE: 'result.txt', MOCK_WRITE_CONTENT: 'after', MOCK_AGENT_TEXT: 'fixture build complete' },
  } }));
  let server;
  const calls = [];
  const errors = [];
  const browser = { async send(task) {
    try {
      const w = [...server.benches.values()].find(e => e.bench.externalTask?.taskId === task.taskId).bench;
      const t = w.externalTask;
      const auth = { taskId: t.taskId, key: t.key, clientId: 'chat-' + t.agentId };
      const ctx = await w.externalCall('claim', auth);
      calls.push({ seat: t.agentId, url: task.chatUrl, ctx });
      await w.externalCall('deliver', { ...auth, operationId: 'deliver-' + t.taskId, ackSeq: ctx.nextSeq,
        text: t.agentId === 'gpt3' ? 'DECISION: change result.txt to after; preserve files; validate result. OPEN: none.' : 'INTERMEDIATE-' + t.agentId,
        final: true });
      return { ok: true };
    } catch (error) { errors.push(error); throw error; }
  } };
  const opts = { port: 0, sessionsDir: path.join(root, 'sessions'), agentsFile, gptBrowser: browser };
  const post = async (route, body = {}, status = 200) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
  };
  const done = async (id, complete = () => true) => {
    for (let n = 0; n < 300; n++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      const entry = server.benches.get(id);
      const failure = entry.events.find(e => e.type === 'error');
      assert.equal(failure, undefined, JSON.stringify(failure));
      if (entry.bench.state === 'idle' && complete()) { assert.deepEqual(errors, []); return; }
    }
    assert.fail('task did not finish');
  };
  try {
    server = await startServer(opts);
    let { id } = await post('/api/workbenches', { name: 'three GPT fixture', participants: ['gpt', 'codex'], workspace: repo });
    let route = `/api/workbenches/${id}`;
    await post(route + '/seats', { op: 'add', provider: 'gpt' });
    await post(route + '/seats', { op: 'add', provider: 'gpt' });
    const urls = {};
    for (const [i, agentId] of ['gpt', 'gpt2', 'gpt3'].entries()) {
      urls[agentId] = `https://chatgpt.com/c/00000000-0000-0000-0000-00000000000${i}`;
      await post(route + '/gpt-connection', { agentId, chatUrl: urls[agentId] });
    }
    await post(route + '/gpt-connection', { agentId: 'gpt2', chatUrl: urls.gpt }, 409);
    await post(route + '/seats', { op: 'order', order: ['gpt', 'gpt2', 'gpt3'] });
    await post(route + '/relay', { rounds: 2, order: ['gpt', 'gpt2', 'gpt3'], seed: 'USER_REQUIREMENT preserve files and change result.txt' });
    await done(id);
    assert.deepEqual(calls.map(c => c.seat), ['gpt', 'gpt2', 'gpt3', 'gpt', 'gpt2', 'gpt3']);
    for (let i = 0; i < calls.length; i++) {
      assert.equal(calls[i].url, urls[calls[i].seat]);
      assert.equal(calls[i].ctx.sync, i < 3 ? 'initial' : 'resume');
      if (i >= 3) assert.equal(calls[i].ctx.messages.length, 2);
    }
    let w = server.benches.get(id).bench;
    assert.equal(w.messages.some(m => m.from === 'codex'), false);
    await post(route + '/seats', { op: 'update', agentId: 'gpt2', enabled: false });
    await post(route + '/message', { to: ['gpt2'], text: 'must not run' }, 400);
    await post(route + '/relay', { order: ['gpt', 'gpt2'], seed: 'must not run' }, 400);
    const dirname = path.basename(w.dir);
    const cursor = { ...w.cursorFor('gpt2') };
    server.close(); server = await startServer(opts);
    ({ id } = await post('/api/workbenches/resume', { dirname })); route = `/api/workbenches/${id}`;
    w = server.benches.get(id).bench;
    assert.equal(w.seatEnabled('gpt2'), false);
    assert.deepEqual(w.cursorFor('gpt2'), cursor);
    assert.equal(w.chatUrlFor('gpt3'), urls.gpt3);
    await post(route + '/seats', { op: 'update', agentId: 'gpt2', enabled: true });
    await post(route + '/message', { to: ['gpt2'], text: 'FOLLOWUP' }); await done(id);
    assert.equal(calls.at(-1).ctx.sync, 'resume');
    await post(route + '/build', { agentId: 'codex', handoff: true }, 403);
    assert.equal(w.builds.length, 0);
    assert.equal(await readFile(path.join(repo, 'result.txt'), 'utf8'), 'before');
    await assert.rejects(readFile(capture, 'utf8'), { code: 'ENOENT' });
  } finally { server?.close(); await rm(root, { recursive: true, force: true }); }
});
