import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer, deriveWriteAgents } from '../src/server.js';
import { discussionArgs } from '../src/profile.js';

test('discussion CLI permissions override old writer and resume settings', () => {
  const profile = { cwdPolicy: 'readonly-materials' };
  const codex = discussionArgs({ family: 'codex' }, ['codex', 'exec', 'resume', 'old-session', '--full-auto', '--sandbox', 'workspace-write', '-c', 'sandbox_mode="danger-full-access"', '--dangerously-bypass-approvals-and-sandbox'], profile);
  assert.deepEqual(codex, ['codex', 'exec', 'resume', 'old-session', '-c', 'sandbox_mode="read-only"']);
  const claude = discussionArgs({ family: 'claude' }, ['claude', '-p', '--tools', 'Read,Write,Bash', '--allowedTools=Write', '--permission-mode', 'acceptEdits', '--dangerously-skip-permissions', '--resume', 'old-session'], profile);
  assert.deepEqual(claude, ['claude', '-p', '--resume', 'old-session', '--tools', 'Read,Glob,Grep', '--permission-mode', 'plan', '--strict-mcp-config']);
  assert.deepEqual(deriveWriteAgents({ codex: { writeArgs: ['exec'] }, gpt: { external: true } }, ['codex', 'gpt']), {});
});

test('local readers share project facts with GPT while all construction endpoints stay disabled', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rt-readonly-'));
  const fact = 'READ_ONLY_PROJECT_FACT_48';
  const material = path.join(root, 'project-fact.txt');
  await writeFile(material, fact);
  const fixture = path.join(root, 'reader.cjs');
  await writeFile(fixture, `const fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const text=process.env.READER_NAME+': '+fs.readFileSync('project-fact.txt','utf8');console.log(JSON.stringify({type:'system',subtype:'init',session_id:process.env.READER_NAME}));console.log(JSON.stringify({type:'result',result:text,session_id:process.env.READER_NAME}));});`);
  const agentsFile = path.join(root, 'agents.json');
  const reader = family => ({ name: family, family, command: [process.execPath, fixture], input: 'stdin', output: 'stream-json', timeoutMs: 5000, env: { READER_NAME: family } });
  await writeFile(agentsFile, JSON.stringify({ codex: reader('codex'), claude: reader('claude'), gpt: { name: 'GPT', external: true } }));
  let server, gptContext;
  const gptBrowser = {
    async status() { return { available: true, running: true, ready: true }; },
    async send(task) {
      const b = [...server.benches.values()].find(e => e.bench.externalTask?.taskId === task.taskId).bench;
      assert.match(b.externalSummary().launchText, /同桌只做唯讀討論/);
      assert.doesNotMatch(b.externalSummary().launchText, /選「GPT 執行」/);
      const auth = { taskId: task.taskId, key: b.externalTask.key, clientId: 'readonly-fixture' };
      const claim = await b.externalCall('claim', auth);
      gptContext = JSON.stringify(claim);
      await b.externalCall('deliver', { ...auth, ackSeq: claim.nextSeq, operationId: 'readonly-reply', text: 'GPT discussion based on ' + fact, final: true });
      return { ok: true, sent: true };
    },
  };
  try {
    server = await startServer({ port: 0, agentsFile, sessionsDir: path.join(root, 'sessions'), gptBrowser });
    const base = `http://127.0.0.1:${server.port}`;
    const post = async (route, body = {}, status = 200) => {
      const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
    };
    const { id } = await post('/api/workbenches', { name: 'read-only project', participants: ['codex', 'claude', 'gpt'], workspace: root });
    const route = '/api/workbenches/' + id;
    const done = async () => {
      for (let i = 0; i < 500; i++) { if (server.benches.get(id).bench.state === 'idle') return; await new Promise(r => setTimeout(r, 10)); }
      assert.fail('discussion did not finish');
    };
    await post(route + '/message', { text: 'Read project-fact.txt and report its contents for the other seats.', to: ['codex', 'claude'] });
    await done();
    const bench = server.benches.get(id).bench;
    for (const seat of ['codex', 'claude']) assert.match(bench.messages.find(m => m.from === seat).text, new RegExp(fact));
    await post(route + '/message', { text: 'Discuss the project facts supplied by Codex and Claude.', to: ['gpt'] });
    await done();
    assert.match(gptContext, /codex/); assert.match(gptContext, /claude/); assert.match(gptContext, new RegExp(fact));
    assert.match(bench.messages.at(-1).text, new RegExp(fact));
    for (const suffix of ['/build', '/builds/old/apply', '/builds/old/discard', '/builds/old/check', '/exec-package', '/exec-package/confirm', '/exec-package/summarize', '/handoff-launch', '/conflict-merge', '/capabilities', '/role']) {
      const result = await post(route + suffix, {}, 403); assert.equal(result.code, 'READ_ONLY_DISCUSSION');
    }
    for (const action of ['write', 'test']) { await post('/api/gpt/' + action, {}, 403); await assert.rejects(bench.externalCall(action, {}), /唯讀/); }
    await assert.rejects(bench.startExternal('edit the project', 'build', { agentId: 'gpt' }), /唯讀/);
    const config = await (await fetch(base + '/api/config')).json();
    assert.equal(config.discussionOnly, true);
    assert.ok(Object.values(config.agents).every(a => a.write === false && a.readOnly === true));
    const advanced = await fetch(base + '/advanced', { redirect: 'manual' }); assert.equal(advanced.status, 302); assert.equal(advanced.headers.get('location'), '/');
    const html = await (await fetch(base + '/')).text();
    assert.doesNotMatch(html, /id="(?:executeButton|buildTools|handoffButton|diffSection|gptTestPanel)"/);
    assert.match(html, /討論專案 · 唯讀/);
    assert.equal(await readFile(material, 'utf8'), fact);
  } finally { server?.close(); await rm(root, { recursive: true, force: true }); }
});
