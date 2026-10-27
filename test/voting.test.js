import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { parseProposals, parseBallot, tallyVotes, resolveTies, votingReport } from '../src/voting.js';

test('strict ballots, absolute majority and evidence-based ties cannot turn missing votes into consent', () => {
  const proposals = parseProposals('```json\n{"proposals":[{"text":"One"},{"text":"Two"}]}\n```');
  assert.deepEqual(proposals.map(p => p.id), ['P1', 'P2']);
  assert.throws(() => parseProposals('I agree'), /格式無效/);
  const ballot = entries => parseBallot(JSON.stringify({ votes: entries.map(([proposalId, choice]) => ({ proposalId, choice, reason: 'evidence' })) }), proposals);
  const v = { voters: ['a', 'b', 'c'], proposals, ballots: {
    a: ballot([['P1', 'agree'], ['P2', 'agree']]), b: ballot([['P1', 'agree'], ['P2', 'oppose']]),
    c: ballot([['P1', 'abstain'], ['P2', 'abstain']]),
  } };
  const results = tallyVotes(v);
  assert.deepEqual(results.map(p => p.status), ['passed', 'tied']);
  assert.equal(results[0].threshold, 2);
  const resolved = resolveTies(results, JSON.stringify({ decisions: [
    { proposalId: 'P1', choice: 'oppose', reason: 'chair disagrees', evidence: 'claim' },
    { proposalId: 'P2', choice: 'agree', reason: 'no evidence field' },
  ] }));
  assert.deepEqual(resolved.map(p => p.status), ['passed', 'unresolved']);
  const ruled = resolveTies(results, JSON.stringify({ decisions: [{ proposalId: 'P2', choice: 'oppose', reason: 'cost', evidence: 'a cited cost' }] }));
  assert.equal(ruled[1].status, 'rejected');
  delete v.ballots.b; delete v.ballots.c;
  assert.equal(tallyVotes(v)[0].status, 'unresolved');
  assert.equal(tallyVotes(v)[0].missing, 2);
  assert.equal(parseBallot('agree', proposals)[0].choice, 'missing');
  assert.equal(ballot([['P1', 'agree'], ['P1', 'agree']])[0].choice, 'missing');
  assert.equal(ballot([['P1', 'yes']])[0].choice, 'missing');
  assert.equal(parseBallot('{"votes":[{"proposalId":"P1","choice":"agree"}]}', proposals)[0].choice, 'missing');
  assert.match(votingReport(v), /未回覆／無效 2/);
  v.ballots = { a: ballot([['P1', 'oppose']]), b: ballot([['P1', 'oppose']]) };
  assert.equal(tallyVotes(v)[0].status, 'rejected');
});

test('real HTTP relay runs debate, proposals, ballots, tie ruling and chair handoff; persists and blocks incomplete handoffs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rt-voting-'));
  let server;
  let mode = 'normal';
  const calls = [], errors = [];
  const browser = { async send(task) {
    try {
      const w = [...server.benches.values()].find(e => e.bench.externalTask?.taskId === task.taskId).bench;
      const t = w.externalTask;
      const auth = { taskId: t.taskId, key: t.key, clientId: 'voting-' + t.agentId };
      const ctx = await w.externalCall('claim', auth);
      const phase = /\[圓桌階段:([^\]]+)\]/.exec(t.instruction)?.[1];
      calls.push({ phase, id: t.agentId, instruction: t.instruction, ctx });
      let text = 'DEBATE evidence: preserve user files, use local components.';
      if (mode === 'converged' && phase === 'discussion') text = '【无新增】';
      if (phase === 'proposals') text = mode === 'bad' ? 'not json' : JSON.stringify({ proposals: mode === 'empty' ? [] : [
        { text: 'Preserve user files' }, { text: 'Reuse existing components' }, { text: 'Uncertain addition' },
      ] });
      if (phase === 'vote') text = JSON.stringify({ votes: [
        { proposalId: 'P1', choice: 'agree', reason: 'Both explicitly supported preserving files' },
        { proposalId: 'P2', choice: t.agentId === 'gpt' ? 'agree' : 'oppose', reason: 'Local reuse versus cost' },
        { proposalId: 'P3', choice: 'abstain', reason: 'Insufficient evidence' },
      ] });
      if (mode === 'missing' && phase === 'vote') text = 'No ballot provided';
      if (phase === 'tie-break') text = JSON.stringify({ decisions: [
        { proposalId: 'P1', choice: 'oppose', reason: 'Cannot override majority', evidence: 'ignored' },
        { proposalId: 'P2', choice: 'agree', reason: 'Avoid new dependencies', evidence: 'DEBATE local components' },
      ] });
      if (phase === 'handoff') text = 'CHAIR_HANDOFF: P1 and P2 passed. Preserve files, reuse components, verify. P3 unresolved, user decides.';
      await w.externalCall('deliver', { ...auth, operationId: 'reply-' + t.taskId, ackSeq: ctx.nextSeq, text, final: true });
      return { ok: true, sent: true };
    } catch (error) { errors.push(error); throw error; }
  } };
  const options = { port: 0, sessionsDir: root, agentsFile: 'test/agents.fixture.json', gptBrowser: browser };
  const post = async (route, body = {}, status = 200) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json(); assert.equal(res.status, status, JSON.stringify(data)); return data;
  };
  const done = async id => {
    for (let n = 0; n < 300; n++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      if (server.benches.get(id).bench.state === 'idle') { assert.deepEqual(errors, []); return; }
    }
    assert.fail('relay did not finish');
  };
  try {
    server = await startServer(options);
    let { id } = await post('/api/workbenches', { name: 'vote fixture', participants: ['gpt', 'mockA'] });
    let route = `/api/workbenches/${id}`;
    await post(route + '/seats', { op: 'add', provider: 'gpt' });
    await post(route + '/seats', { op: 'add', provider: 'gpt' });
    await post(route + '/seats', { op: 'chair', agentId: 'gpt3' });
    for (const [i, agentId] of ['gpt', 'gpt2', 'gpt3'].entries()) {
      await post(route + '/gpt-connection', { agentId, chatUrl: `https://chatgpt.com/c/20000000-0000-0000-0000-00000000000${i}` });
    }
    await post(route + '/relay', { rounds: 1, order: ['gpt', 'gpt2', 'gpt3'], seed: 'Preserve files, evaluate reuse, leave unknowns for user.' });
    await done(id);
    let w = server.benches.get(id).bench;
    assert.deepEqual(calls.map(c => `${c.phase}:${c.id}`), ['discussion:gpt', 'discussion:gpt2', 'proposals:gpt3', 'vote:gpt', 'vote:gpt2', 'tie-break:gpt3', 'handoff:gpt3']);
    assert.deepEqual(w.lastDiscussion.voting.voters, ['gpt', 'gpt2']);
    assert.deepEqual(w.lastDiscussion.voting.results.map(p => p.status), ['passed', 'passed', 'unresolved']);
    assert.equal(w.lastDiscussion.status, 'finished');
    assert.match(calls.at(-1).instruction, /P1｜Preserve user files/);
    assert.match(calls.at(-1).instruction, /同意 2、反對 0/);
    assert.match(calls.at(-1).instruction, /未決/);
    const handoff = w.discussionHandoff('', 'mockA');
    assert.match(handoff, /CHAIR_HANDOFF/); assert.match(handoff, /【系統投票結果】/);
    assert.match(handoff, /投票不擴大使用者授權/); assert.doesNotMatch(handoff, /DEBATE evidence:/);
    assert.throws(() => w.discussionHandoff('', 'gpt'), /未參與/);
    assert.throws(() => w.discussionHandoff('', 'gpt3'), /未參與/);
    const meta = JSON.parse(await readFile(path.join(w.dir, 'metadata.json'), 'utf8'));
    assert.deepEqual(meta.lastDiscussion.voting, w.lastDiscussion.voting);
    const dirname = path.basename(w.dir);
    server.close(); server = await startServer(options);
    ({ id } = await post('/api/workbenches/resume', { dirname })); route = `/api/workbenches/${id}`; w = server.benches.get(id).bench;
    assert.match(w.discussionHandoff('', 'mockA'), /同意 2、反對 0/);
    for (const testMode of ['converged', 'missing', 'empty', 'bad']) {
      mode = testMode; calls.length = 0;
      await post(route + '/relay', { rounds: 3, order: ['gpt', 'gpt2'], seed: 'NEXT ' + mode }); await done(id);
      if (mode === 'converged') {
        assert.equal(calls.filter(c => c.phase === 'discussion').length, 1);
        assert.equal(calls.filter(c => c.phase === 'vote').length, 2);
        assert.equal(w.lastDiscussion.status, 'finished');
      } else if (mode === 'bad') {
        assert.equal(w.lastDiscussion.status, 'interrupted');
        assert.throws(() => w.discussionHandoff('', 'mockA'), /尚未完整結束/);
      } else {
        assert.equal(w.lastDiscussion.status, 'finished');
        assert.throws(() => w.discussionHandoff('', 'mockA'), /沒有通過/);
      }
    }
  } finally { server?.close(); await rm(root, { recursive: true, force: true }); }
});
