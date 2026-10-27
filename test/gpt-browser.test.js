import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { GptBrowser, CdpConnection, validChatUrl, stagePrompt, submitPrompt, chatPageState } from '../src/gpt-browser.js';

const chatUrl = 'https://chatgpt.com/c/6adaa9c0-0f94-83ec-8c50-59110cf9495d';

test('chat binding rejects Work, credentials, queries and unrelated hosts', () => {
  assert.equal(validChatUrl(chatUrl), true);
  for (const value of ['https://chatgpt.com/', chatUrl + '?workspace=x', chatUrl + '#x', chatUrl.replace('https://', 'https://user:pass@'),
    chatUrl.replace('chatgpt.com', 'chatgpt.com.evil.test'), 'https://chatgpt.com/work/123']) {
    assert.equal(validChatUrl(value), false, value);
  }
});

function pageFixture({ draft = '', busy = false, model = true, changed = false } = {}) {
  let clicks = 0;
  const composer = { innerText: draft, getClientRects: () => [1], focus() {}, dispatchEvent() {} };
  const button = { disabled: false, getClientRects: () => [1], getAttribute: () => null, click: () => clicks++ };
  const document = {
    title: 'fixture',
    querySelectorAll(selector) {
      const found = this.querySelector(selector);
      return [{ getClientRects: () => [], innerText: 'hidden stale draft' }, ...(found ? [found] : [])];
    },
    querySelector(selector) {
      if (selector.includes('選取 ChatGPT')) return model ? { getClientRects: () => [1] } : null;
      if (selector.includes('停止')) return busy ? { getClientRects: () => [1] } : null;
      if (selector.includes('data-composer-markdown')) return composer;
      if (selector.includes('submit')) return button;
      return null;
    },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    createRange: () => ({ selectNodeContents() {} }),
    execCommand(command, _show, text) { assert.equal(command, 'insertText'); composer.innerText = text; return true; },
  };
  const context = vm.createContext({ document, location: new URL(changed ? chatUrl.replace('6adaa9c0', '7adaa9c0') : chatUrl), InputEvent: class {} });
  const run = (fn, arg) => JSON.parse(JSON.stringify(vm.runInContext(`(${fn.toString()})(${JSON.stringify(arg)})`, context)));
  return { run, composer, clicks: () => clicks, button };
}

test('native sender preserves drafts and refuses busy, changed or non-Chat pages', () => {
  for (const [options, error] of [[{ draft: 'MY DRAFT' }, 'DRAFT_PRESENT'], [{ busy: true }, 'CHAT_IS_RUNNING'],
    [{ model: false }, 'CHAT_MODE_NOT_CONFIRMED'], [{ changed: true }, 'CHAT_CHANGED']]) {
    const page = pageFixture(options);
    assert.equal(page.run(stagePrompt, { chatUrl, text: 'task' }).error, error);
    assert.equal(page.clicks(), 0);
    if (options.draft) assert.equal(page.composer.innerText, options.draft);
  }
});

test('submit uses exact staged text and rechecks the page before clicking once', () => {
  const page = pageFixture();
  const arg = { chatUrl, text: 'first line\nsecond line' };
  assert.deepEqual(page.run(stagePrompt, arg), { ok: true });
  page.composer.innerText = 'a human edited this';
  assert.equal(page.run(submitPrompt, arg).error, 'COMPOSER_CHANGED');
  assert.equal(page.clicks(), 0);
  page.composer.innerText = arg.text;
  assert.deepEqual(page.run(submitPrompt, arg), { ok: true, clicked: true });
  assert.equal(page.clicks(), 1);
});

test('hidden duplicate ChatGPT controls cannot mask the active composer', () => {
  const page = pageFixture();
  const state = page.run(chatPageState, { chatUrl });
  assert.equal(state.ready, true);
  assert.equal(state.draft, false);
  assert.equal(state.busy, false);
});

test('CDP correlates replies and rejects pending calls on disconnect', async () => {
  class Socket extends EventTarget {
    sent = [];
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const socket = new Socket();
  const connection = new CdpConnection(socket);
  const first = connection.call('Example.one');
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 1, result: { value: 42 } }) }));
  assert.deepEqual(await first, { value: 42 });
  const second = connection.call('Example.two');
  connection.close();
  await assert.rejects(second, /BROWSER_DISCONNECTED/);
  assert.equal(connection.pending.size, 0);
});

test('unknown post-click delivery survives restart and is never silently sent again', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'roundtable-browser-'));
  let clicks = 0;
  let visibleReceipt = false;
  const fakePage = {
    async evaluate(fn) {
      if (fn.name === 'chatPageState') return { sameChat: true, ready: true, receipt: visibleReceipt };
      if (fn.name === 'stagePrompt') return { ok: true };
      if (fn.name === 'submitPrompt') { clicks++; throw new Error('BROWSER_DISCONNECTED'); }
    }, close() {},
  };
  const browser = () => {
    const instance = new GptBrowser({ root });
    instance.open = async () => ({ ok: true });
    instance.page = async () => fakePage;
    return instance;
  };
  const task = { chatUrl, taskId: 'oneTask', text: 'fixed synthetic test' };
  try {
    await assert.rejects(browser().send(task), /BROWSER_DISCONNECTED/);
    assert.equal(JSON.parse(await readFile(path.join(root, 'receipts.json'), 'utf8'))[chatUrl].taskId, task.taskId);
    await assert.rejects(browser().send(task), /CHAT_SEND_UNKNOWN/);
    assert.equal(clicks, 1);
    visibleReceipt = true;
    assert.equal((await browser().send(task)).alreadySent, true);
    assert.equal(clicks, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('chair followup waits for the previous ChatGPT reply to finish, then sends exactly once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rt-chair-followup-'));
  let observations = 0, staged = 0, clicks = 0;
  const browser = new GptBrowser({ root });
  browser.open = async () => {};
  browser.page = async () => ({ async evaluate(fn) {
    if (fn === chatPageState) return { sameChat: true, ready: true, busy: ++observations <= 2, receipt: clicks > 0 };
    if (fn === stagePrompt) { assert.ok(observations >= 3); staged++; return { ok: true }; }
    if (fn === submitPrompt) { clicks++; return { ok: true }; }
  }, close() {} });
  try {
    const sent = await browser.send({ chatUrl, taskId: 'chairFollowup', text: 'Chair handoff after tie ruling' });
    assert.equal(sent.sent, true); assert.equal(staged, 1); assert.equal(clicks, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancelling while the previous reply is busy never stages or submits the next task', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rt-chair-cancel-'));
  let current = true, stages = 0;
  const browser = new GptBrowser({ root });
  browser.open = async () => {};
  browser.page = async () => ({ async evaluate(fn) {
    if (fn === chatPageState) { current = false; return { sameChat: true, ready: true, busy: true }; }
    stages++; return { ok: true };
  }, close() {} });
  try {
    await assert.rejects(browser.send({ chatUrl, taskId: 'cancelChairWait', text: 'Must not send', isCurrent: () => current }), /GPT_TASK_CHANGED/);
    assert.equal(stages, 0);
    await assert.rejects(access(path.join(root, 'receipts.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancelled mobile task clears only its staged prompt and never submits a model request', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rt-mobile-cancel-'));
  let current = true;
  const seen = [];
  const browser = new GptBrowser({ root });
  browser.open = async () => {};
  browser.page = async () => ({
    async evaluate(fn) {
      seen.push(fn.name);
      if (fn.name === 'chatPageState') return { sameChat: true, ready: true, receipt: false };
      if (fn.name === 'stagePrompt') { current = false; return { ok: true }; }
    }, close() {},
  });
  try {
    await assert.rejects(browser.send({ chatUrl, taskId: 'cancelTask', text: 'synthetic', isCurrent: () => current }), /GPT_TASK_CHANGED/);
    assert.ok(seen.includes('clearStagedPrompt'));
    assert.ok(!seen.includes('submitPrompt'));
    await assert.rejects(access(path.join(root, 'receipts.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('first real task creates one independent Chat, binds its URL, and retries reuse its receipt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rt-auto-chat-'));
  let created = 0, clicks = 0;
  const bound = [];
  const staged = [];
  const browser = new GptBrowser({ root });
  browser.newChatTarget = async () => { created++; return 'fresh-target'; };
  browser.pageById = async id => {
    assert.equal(id, 'fresh-target');
    return { async evaluate(fn, arg) {
      if (fn === chatPageState) return { sameChat: true, ready: true, receipt: clicks > 0, chatUrl: clicks ? chatUrl : 'https://chatgpt.com/' };
      if (fn === stagePrompt) { staged.push(arg.text); return { ok: true }; }
      if (fn === submitPrompt) { clicks++; return { ok: true }; }
    }, close() {} };
  };
  const task = { taskId: 'autoFirst', text: 'ONLY REAL USER TASK', onChatUrl: async url => bound.push(url) };
  try {
    const sent = await browser.send(task);
    assert.equal(sent.chatUrl, chatUrl);
    assert.equal(sent.sent, true);
    assert.match(staged[0], /ONLY REAL USER TASK/);
    assert.equal(staged.length, 1);
    const repeated = await browser.send(task);
    assert.equal(repeated.alreadySent, true);
    assert.equal(created, 1); assert.equal(clicks, 1);
    assert.deepEqual(bound, [chatUrl, chatUrl]);
    const receipts = JSON.parse(await readFile(path.join(root, 'receipts.json'), 'utf8'));
    assert.equal(receipts[chatUrl].taskId, task.taskId);
    assert.equal(receipts['new:' + task.taskId].chatUrl, chatUrl);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unknown new-Chat submission reuses its tab after restart without duplicating the request', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rt-auto-unknown-'));
  let clicks = 0, created = 0, receipt = false;
  const browser = () => {
    const instance = new GptBrowser({ root });
    instance.newChatTarget = async () => { created++; return 'pending-target'; };
    instance.pageById = async () => ({ async evaluate(fn) {
      if (fn === chatPageState) return { sameChat: true, ready: true, receipt, chatUrl };
      if (fn === stagePrompt) return { ok: true };
      if (fn === submitPrompt) { clicks++; throw new Error('BROWSER_DISCONNECTED'); }
    }, close() {} });
    return instance;
  };
  try {
    const task = { taskId: 'uncertainNew', text: 'synthetic' };
    await assert.rejects(browser().send(task), /BROWSER_DISCONNECTED/);
    await assert.rejects(browser().send(task), /CHAT_SEND_UNKNOWN/);
    assert.equal(clicks, 1); assert.equal(created, 1);
    receipt = true;
    assert.equal((await browser().send(task)).alreadySent, true);
    assert.equal(clicks, 1); assert.equal(created, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
