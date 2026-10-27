import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { Workbench, loadWorkbenchFromDisk, RELAY_CONVERGED } from '../src/workbench.js';

test('new table preserves dynamic seats without copying old GPT links; chair closes once and survives restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rt-seat-controls-'));
  let server;
  let converge = false;
  const calls = [];
  const errors = [];
  const browser = { async send(task) {
    try {
      const w = [...server.benches.values()].find(e => e.bench.externalTask?.taskId === task.taskId).bench;
      const t = w.externalTask;
      const auth = { taskId: t.taskId, key: t.key, clientId: 'seat-' + t.agentId };
      const ctx = await w.externalCall('claim', auth);
      calls.push({ id: t.agentId, instruction: t.instruction, ctx });
      let answer;
      if (t.instruction.includes('[圓桌階段:proposals]')) answer = JSON.stringify({ proposals: [{ text: 'agreed change' }] });
      else if (t.instruction.includes('[圓桌階段:vote]')) answer = JSON.stringify({ votes: [{ proposalId: 'P1', choice: 'agree', reason: 'supported' }] });
      else answer = t.agentId === 'gpt3' ? 'CHAIR_DECISION: agreed change, unresolved: none.' : converge ? RELAY_CONVERGED.zh : 'PANEL_OPINION';
      await w.externalCall('deliver', { ...auth, operationId: 'reply-' + t.taskId, ackSeq: ctx.nextSeq,
        text: answer, final: true });
      return { ok: true, sent: true };
    } catch (error) { errors.push(error); throw error; }
  } };
  const options = { port: 0, sessionsDir: root, agentsFile: 'test/agents.fixture.json', gptBrowser: browser };
  const post = async (route, body, status = 200) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    assert.equal(res.status, status, JSON.stringify(data));
    return data;
  };
  const done = async id => {
    for (let i = 0; i < 250; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      if (server.benches.get(id).bench.state === 'idle') { assert.deepEqual(errors, []); return; }
    }
    assert.fail('relay did not finish');
  };
  try {
    server = await startServer(options);
    const source = await post('/api/workbenches', { participants: ['gpt', 'mockA'] });
    const sourceRoute = `/api/workbenches/${source.id}`;
    await post(sourceRoute + '/seats', { op: 'add', provider: 'gpt' });
    await post(sourceRoute + '/seats', { op: 'add', provider: 'gpt' });
    await post(sourceRoute + '/seats', { op: 'update', agentId: 'mockA', enabled: false });
    await post(sourceRoute + '/gpt-connection', { chatUrl: 'https://chatgpt.com/c/00000000-0000-0000-0000-000000000001' });
    const original = server.benches.get(source.id).bench;
    const body = { name: 'new multi-seat table', participants: original.participants, seats: original.seatsSummary(), relayOrder: ['gpt', 'gpt2'], chairId: 'gpt3' };
    let { id } = await post('/api/workbenches', body);
    let route = `/api/workbenches/${id}`;
    let w = server.benches.get(id).bench;
    assert.equal(w.participants.length, 4);
    assert.equal(w.seatEnabled('mockA'), false);
    assert.equal(w.chatUrlFor('gpt'), '');
    assert.equal(original.chatUrlFor('gpt').endsWith('0001'), true);
    for (const [i, agentId] of ['gpt', 'gpt2', 'gpt3'].entries()) {
      await post(route + '/gpt-connection', { agentId, chatUrl: `https://chatgpt.com/c/10000000-0000-0000-0000-00000000000${i}` });
    }
    await post(route + '/relay', { rounds: 2, seed: 'USER_GOAL', order: ['gpt', 'gpt2', 'gpt3'] });
    await done(id);
    assert.deepEqual(calls.map(c => c.id), ['gpt', 'gpt2', 'gpt', 'gpt2', 'gpt3', 'gpt', 'gpt2', 'gpt3']);
    assert.match(calls.at(-1).instruction, /主席.*不發表個人方案/);
    assert.equal(calls.find(c => c.instruction.includes('[圓桌階段:proposals]')).ctx.messages.filter(m => m.from !== 'user').length, 4);
    assert.equal(w.lastDiscussion.status, 'finished');
    assert.deepEqual(w.lastDiscussion.order, ['gpt', 'gpt2']);
    assert.match(w.discussionHandoff('', 'mockA'), /CHAIR_DECISION/);
    assert.doesNotMatch(w.discussionHandoff('', 'mockA'), /PANEL_OPINION/);
    const dirname = path.basename(w.dir);
    server.close(); server = await startServer(options);
    ({ id } = await post('/api/workbenches/resume', { dirname }));
    route = `/api/workbenches/${id}`; w = server.benches.get(id).bench;
    assert.equal(w.chairId, 'gpt3');
    assert.deepEqual(w.relayOrder, ['gpt', 'gpt2']);
    calls.length = 0; converge = true;
    await post(route + '/relay', { rounds: 3, seed: 'SECOND_GOAL' }); await done(id);
    assert.deepEqual(calls.map(c => c.id), ['gpt', 'gpt3', 'gpt', 'gpt2', 'gpt3']);
    assert.equal(w.lastDiscussion.status, 'finished');
    await post(route + '/seats', { op: 'chair', agentId: 'mockA' }, 400);
    await post(route + '/seats', { op: 'update', agentId: 'gpt3', enabled: false });
    assert.equal(w.chairId, null);
    await post('/api/workbenches', { ...body, seats: body.seats.map(s => ({ ...s, enabled: false })) }, 400);
  } finally { server?.close(); await rm(root, { recursive: true, force: true }); }
});

test('reasoning settings reach CLI chat and write configs, persist, and remain after workspace reassignment', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rt-effort-'));
  const capture = path.join(root, 'capture.jsonl');
  const cfg = family => ({ name: family, family, command: [process.execPath, path.resolve('test/mock-cli.cjs')],
    input: 'stdin', output: 'stream-json', timeoutMs: 5000, env: { MOCK_SESSION_MODE: family, MOCK_CAPTURE_FILE: capture, MOCK_AGENT_TEXT: 'done' } });
  const agents = { claude: cfg('claude'), codex: cfg('codex') };
  const w = new Workbench({ agents: structuredClone(agents), participants: Object.keys(agents), baseDir: root, writeAgents: structuredClone(agents) });
  try {
    await w.init();
    await w.configureSeat('claude', { effort: 'high' });
    await w.configureSeat('codex', { effort: 'xhigh' });
    await assert.rejects(w.configureSeat('codex', { effort: 'injected' }));
    assert.equal(w.writeAgents.codex.reasoningEffort, 'xhigh');
    await w.message('fixture only', ['claude', 'codex']);
    const calls = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls[0].argv[calls[0].argv.indexOf('--effort') + 1], 'high');
    assert.ok(calls[1].argv.includes('model_reasoning_effort="xhigh"'));
    const { meta, messages } = await loadWorkbenchFromDisk(w.dir);
    const resumed = await Workbench.resume({ agents: structuredClone(agents), participants: w.participants, baseDir: root, dir: w.dir, messages,
      seatSettings: meta.seatSettings, writeAgents: structuredClone(agents) });
    assert.equal(resumed.agents.claude.reasoningEffort, 'high');
    await resumed.setWorkspace('', structuredClone(agents), structuredClone(agents));
    assert.equal(resumed.agents.codex.reasoningEffort, 'xhigh');
    assert.equal(resumed.writeAgents.codex.reasoningEffort, 'xhigh');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI chair speaks only after panelists; a failed chair cannot supply an implementation handoff', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rt-cli-chair-'));
  const capture = path.join(root, 'capture.jsonl');
  const cfg = { command: [process.execPath, path.resolve('test/mock-cli.cjs')], input: 'stdin', output: 'stream-json', timeoutMs: 5000 };
  const agents = Object.fromEntries(['a', 'b', 'chair'].map(id => [id, { ...cfg, name: id, env: { MOCK_SESSION_MODE: 'claude', MOCK_AGENT_TEXT: id, MOCK_CAPTURE_FILE: capture, MOCK_ROUNDTABLE: '1' } }]));
  const w = new Workbench({ agents, participants: Object.keys(agents), baseDir: root });
  try {
    await w.init(); await w.setChair('chair');
    await w.relay(2, ['chair', 'a', 'b'], 'GOAL');
    assert.deepEqual(w.messages.filter(m => m.from !== 'user').map(m => m.from), ['a', 'b', 'a', 'b', 'chair', 'a', 'b', 'system', 'chair']);
    const calls = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.match(calls.at(-1).input, /主席.*不發表個人方案/);
    w.agents.chair.command = [path.join(root, 'missing-cli.exe')];
    await assert.rejects(w.relay(1, ['a', 'b'], 'NEXT'), /主席提案格式無效/);
    assert.equal(w.lastDiscussion.status, 'interrupted');
    assert.throws(() => w.discussionHandoff('', 'a'), /尚未完整結束/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
