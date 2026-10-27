import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { Workbench, loadWorkbenchFromDisk } from '../src/workbench.js';
import { removeWorktree } from '../src/worktree.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();

function makeGitFixture() {
  const repo = mkdtempSync(path.join(tmpdir(), 'external-seat-repo-'));
  git(repo, 'init');
  git(repo, 'config', 'user.email', 'external-seat@test.local');
  git(repo, 'config', 'user.name', 'External Seat Test');
  writeFileSync(path.join(repo, 'readme.md'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'fixture');
  return repo;
}

async function makeWorkbench(kind = 'chat') {
  const workspace = makeGitFixture();
  const baseDir = mkdtempSync(path.join(tmpdir(), 'external-seat-session-'));
  const w = new Workbench({
    name: 'external-seat-test',
    agents: { gpt: { name: 'GPT' } },
    participants: ['gpt'],
    baseDir,
    emit: () => {},
    workspace,
  });
  await w.init();
  await w.startExternal('fixture task', kind);
  return { w, workspace, baseDir };
}

function args(w, extra = {}) {
  const task = w.externalTask;
  return {
    connection: path.basename(w.dir),
    taskId: task.taskId,
    key: task.key,
    ...extra,
  };
}

async function cleanup({ w, workspace, baseDir }) {
  const worktree = w?.externalTask?.worktree;
  if (worktree && existsSync(worktree)) await removeWorktree(workspace, worktree).catch(() => {});
  await rm(baseDir, { recursive: true, force: true }).catch(() => {});
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
}

const hash = value => createHash('sha256').update(value).digest('hex');

async function waitForEvent(events, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found) return found;
    await sleep(10);
  }
  throw new Error('timed out waiting for relay event');
}

async function makeRelayWorkbench({ captureFile = null, delayMs = 0 } = {}) {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'external-relay-session-'));
  const command = [process.execPath, path.resolve('test/mock-cli.cjs')];
  const common = { command, input: 'stdin', output: 'stream-json', timeoutMs: 5000 };
  const events = [];
  const env = (mode, text, extra = {}) => ({
    MOCK_SESSION_MODE: mode,
    MOCK_SESSION_ID: `${mode}-relay`,
    MOCK_AGENT_TEXT: text,
    ...(delayMs ? { MOCK_DELAY_MS: String(delayMs) } : {}),
    ...(extra.captureFile ? { MOCK_CAPTURE_FILE: extra.captureFile } : {}),
  });
  const agents = {
    claude: { ...common, name: 'Claude fixture', env: env('claude', 'Claude local reply') },
    codex: { ...common, name: 'Codex fixture', env: env('claude', 'Codex local reply', { captureFile }) },
    gpt: { name: 'GPT fixture', external: true },
  };
  const w = new Workbench({ name: 'relay-three-seat', agents, participants: ['claude', 'gpt', 'codex'], baseDir, emit: event => events.push(event) });
  await w.init();
  return { w, events, baseDir };
}

test('chat seat: duplicate claim, cursor ack, same-client increment, new-client full context', { concurrency: false }, async () => {
  const fixture = await makeWorkbench('chat');
  const { w } = fixture;
  try {
    const firstTaskId = w.externalTask.taskId;
    const first = await w.externalCall('claim', args(w, { clientId: 'chat-a' }));
    assert.equal(first.sync, 'initial');
    assert.equal(first.messages.length, 1);
    assert.equal(w.externalTask.taskId, firstTaskId);
    const worktreeBefore = w.externalTask.worktree;

    const duplicate = await w.externalCall('claim', args(w, { clientId: 'chat-a' }));
    assert.equal(duplicate.taskId, first.taskId);
    assert.equal(w.externalTask.taskId, firstTaskId);
    assert.equal(w.externalTask.worktree, worktreeBefore);
    await assert.rejects(() => w.externalCall('claim', args(w, { clientId: 'chat-b' })), /另一個對話/);

    const beforeAck = await w.externalCall('read', args(w));
    const beforeAckAgain = await w.externalCall('read', args(w));
    assert.deepEqual(beforeAck, beforeAckAgain);
    const firstDeliverArgs = args(w, {
      text: 'first final', ackSeq: beforeAck.nextSeq, operationId: 'deliver-first', final: true,
    });
    const delivered = await w.externalCall('deliver', firstDeliverArgs);
    assert.equal(delivered.final, true);
    assert.deepEqual(await w.externalCall('deliver', firstDeliverArgs), delivered);
    await assert.rejects(() => w.externalCall('deliver', { ...firstDeliverArgs, text: 'different final' }), /operationId 已被不同內容使用/);

    await w.startExternal('second task', 'chat');
    const second = await w.externalCall('claim', args(w, { clientId: 'chat-a' }));
    assert.equal(second.sync, 'resume');
    assert.deepEqual(second.messages.map(message => message.text), ['second task']);
    const secondAck = await w.externalCall('read', args(w));
    await w.externalCall('deliver', args(w, {
      text: 'second final', ackSeq: secondAck.nextSeq, operationId: 'deliver-second', final: true,
    }));

    await w.startExternal('third task', 'chat');
    const third = await w.externalCall('claim', args(w, { clientId: 'chat-b' }));
    assert.equal(third.sync, 'initial');
    assert.equal(third.messages.length, w.messages.length);
    assert.equal(third.messages[0].text, 'fixture task');
  } finally {
    await cleanup(fixture);
  }
});

test('wrong key and discussion task cannot write; cancelled task rejects writes', { concurrency: false }, async () => {
  const chat = await makeWorkbench('chat');
  try {
    await chat.w.externalCall('claim', args(chat.w, { clientId: 'chat-a' }));
    await assert.rejects(() => chat.w.externalCall('read', { ...args(chat.w), key: 'wrong' }), /配對無效/);
    await assert.rejects(() => chat.w.externalCall('write', args(chat.w, {
      path: 'blocked.txt', content: 'x', expectedHash: null, operationId: 'write-chat',
    })), /唯讀/);
  } finally {
    await cleanup(chat);
  }


});



test('restart preserves external task and acknowledged read progress', { concurrency: false }, async () => {
  const fixture = await makeWorkbench('chat');
  const { w, baseDir } = fixture;
  try {
    await w.externalCall('claim', args(w, { clientId: 'chat-a' }));
    const initial = await w.externalCall('read', args(w));
    await w.externalCall('deliver', args(w, {
      text: 'progress', ackSeq: initial.nextSeq, operationId: 'deliver-progress', final: false,
    }));
    const before = { taskId: w.externalTask.taskId, cursor: w.externalCursor.lastSeq, key: w.externalTask.key };
    const loaded = await loadWorkbenchFromDisk(w.dir);
    const resumed = await Workbench.resume({
      ...loaded.meta,
      name: w.name,
      agents: w.agents,
      participants: w.participants,
      dir: w.dir,
      baseDir,
      emit: () => {},
      messages: loaded.messages,
      builds: loaded.builds,
      workspace: w.workspace,
      writeAgents: w.writeAgents,
      externalTask: loaded.meta.externalTask,
      externalCursor: loaded.meta.externalCursor,
    });
    assert.equal(resumed.externalTask.taskId, before.taskId);
    assert.equal(resumed.externalTask.key, before.key);
    assert.equal(resumed.externalCursor.lastSeq, before.cursor);
    const after = await resumed.externalCall('read', {
      connection: path.basename(resumed.dir), taskId: before.taskId, key: before.key, after: before.cursor,
    });
    assert.equal(after.messages.length, 0);
    assert.equal(after.nextSeq, before.cursor);
  } finally {
    await cleanup(fixture);
  }
});





test('three-seat relay waits for GPT delivery before Codex and keeps busy until the round ends', { concurrency: false }, async () => {
  const captureFile = path.join(mkdtempSync(path.join(tmpdir(), 'external-relay-capture-')), 'codex.jsonl');
  const fixture = await makeRelayWorkbench({ captureFile, delayMs: 30 });
  const { w, events, baseDir } = fixture;
  try {
    await w.startExternal('an old unrelated task', 'chat');
    await w.stop();
    events.length = 0;
    const relay = w.relay(1, ['claude', 'gpt', 'codex'], 'three-seat topic');
    const waiting = await waitForEvent(events, event => event.type === 'external-task' && event.data?.relay === true && event.data.status === 'waiting');
    assert.equal(w.state, 'busy');
    assert.match(waiting.data.launchText, /three-seat topic/);
    assert.doesNotMatch(waiting.data.launchText, /an old unrelated task/);
    assert.match(waiting.data.launchText, /討論/);
    const context = await w.externalCall('claim', {
      connection: path.basename(w.dir), taskId: waiting.data.taskId, key: w.externalTask.key, clientId: 'relay-chat',
    });
    assert.match(context.messages.map(message => message.text).join('\n'), /Claude local reply/);
    await w.externalCall('deliver', {
      connection: path.basename(w.dir), taskId: w.externalTask.taskId, key: w.externalTask.key,
      text: 'GPT external reply', ackSeq: context.nextSeq, operationId: 'relay-deliver-1', final: true,
    });
    assert.equal(w.state, 'busy');
    assert.equal(events.some(event => event.type === 'state' && event.data === 'idle'), false);
    await relay;
    assert.equal(w.state, 'idle');
    assert.deepEqual(w.messages.filter(message => message.from !== 'user').map(message => message.from), ['claude', 'gpt', 'codex']);
    assert.match(readFileSync(captureFile, 'utf8'), /GPT external reply/);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('stopping a GPT relay cancels the pending task and skips later seats', { concurrency: false }, async () => {
  const fixture = await makeRelayWorkbench();
  const { w, events, baseDir } = fixture;
  try {
    const relay = w.relay(1, ['claude', 'gpt', 'codex'], 'stop topic');
    relay.catch(() => {}); // Observe early cancellation before awaiting stop's persistence.
    await waitForEvent(events, event => event.type === 'external-task' && event.data?.relay === true && event.data.status === 'waiting');
    await w.stop();
    await assert.rejects(relay, /GPT 圓桌回合已停止|已停止後續席位/);
    assert.equal(w.state, 'idle');
    assert.equal(w.externalTask.status, 'cancelled');
    assert.equal(w.messages.some(message => message.from === 'codex'), false);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test('restarting a pending GPT relay marks it interrupted without auto-resuming', { concurrency: false }, async () => {
  const fixture = await makeRelayWorkbench();
  const { w, events, baseDir } = fixture;
  let relay;
  try {
    relay = w.relay(1, ['claude', 'gpt', 'codex'], 'restart topic');
    relay.catch(() => {}); // Cancellation may settle while stop is persisting metadata.
    await waitForEvent(events, event => event.type === 'external-task' && event.data?.relay === true && event.data.status === 'waiting');
    const loaded = await loadWorkbenchFromDisk(w.dir);
    const resumed = await Workbench.resume({
      ...loaded.meta, name: w.name, agents: w.agents, participants: w.participants, dir: w.dir, baseDir,
      emit: () => {}, messages: loaded.messages, builds: loaded.builds, workspace: w.workspace,
      writeAgents: w.writeAgents, externalTask: loaded.meta.externalTask, externalCursor: loaded.meta.externalCursor,
    });
    assert.equal(resumed.externalTask.status, 'interrupted');
    await assert.rejects(() => resumed.externalCall('claim', {
      connection: path.basename(resumed.dir), taskId: resumed.externalTask.taskId, key: resumed.externalTask.key, clientId: 'relay-restart',
    }), /已結束、取消或中斷/);
  } finally {
    await w.stop();
    if (relay) await assert.rejects(relay, /GPT 圓桌回合已停止|已停止後續席位/);
    await rm(baseDir, { recursive: true, force: true });
  }
});
test('former external build requests are rejected without changing the project or current discussion', async () => {
  const fixture = await makeWorkbench('chat');
  try {
    const taskId = fixture.w.externalTask.taskId;
    await assert.rejects(fixture.w.startExternal('edit readme.md', 'build'), /唯讀/);
    assert.equal(fixture.w.externalTask.taskId, taskId);
    assert.equal(fixture.w.externalTask.kind, 'chat');
    assert.equal(fixture.w.builds.length, 0);
    assert.equal(readFileSync(path.join(fixture.workspace, 'readme.md'), 'utf8'), 'base\n');
  } finally { await cleanup(fixture); }
});
