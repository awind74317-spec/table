import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { handleMessage } from '../browser-extension/background.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = name => readFileSync(path.join(root, 'browser-extension', name), 'utf8');

test('browser extension manifest keeps the bridge permissions and routes bounded', () => {
  const manifest = JSON.parse(load('manifest.json'));
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
  assert.ok(manifest.content_scripts.some(item => item.matches.includes('http://127.0.0.1/*') && item.js.includes('local.js')));
  assert.ok(manifest.content_scripts.some(item => item.matches.includes('https://chatgpt.com/c/*') && item.js.includes('chat.js')));
});

test('background rejects a non-17880 sender before routing', async () => {
  const result = await handleMessage(
    { source: 'roundtable-app', action: 'ping' },
    { tab: { url: 'http://localhost:17880/' } },
  );
  assert.deepEqual(result, { ok: false, error: 'LOCAL_SENDER_INVALID' });
});

test('local bridge ignores a wrong-origin page', () => {
  let registered = false;
  const context = {
    location: { origin: 'http://127.0.0.1:17881' },
    window: { addEventListener: () => { registered = true; } },
    chrome: { runtime: { sendMessage: () => Promise.resolve() } },
  };
  vm.runInNewContext(load('local.js'), context);
  assert.equal(registered, false);
});

test('chat bridge refuses an existing draft', async () => {
  let listener;
  const composer = {
    textContent: 'keep this draft',
    focus() {},
    dispatchEvent() {},
  };
  class FakeTextArea {}
  const context = {
    location: { origin: 'https://chatgpt.com', pathname: '/c/01234567-89ab-cdef-0123-456789abcdef', search: '' },
    HTMLTextAreaElement: FakeTextArea,
    InputEvent: class {},
    URL,
    document: {
      querySelector(selector) {
        if (selector.includes('[data-composer-markdown]')) return composer;
        if (selector.includes('選取 ChatGPT 模型')) return {};
        return null;
      },
      getSelection() { return null; },
      createRange() { return { selectNodeContents() {} }; },
      execCommand() { return true; },
    },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    setTimeout,
  };
  vm.runInNewContext(load('chat.js'), context);
  const result = await new Promise(resolve => listener({ source: 'roundtable-extension', action: 'send', chatUrl: 'https://chatgpt.com' + context.location.pathname, text: 'new text' }, {}, resolve));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'DRAFT_PRESENT');
  const changed = await new Promise(resolve => listener({ source: 'roundtable-extension', action: 'send', chatUrl: 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555', text: 'new text' }, {}, resolve));
  assert.equal(changed.error, 'CHAT_CHANGED');
});

test('background records one task per Chat URL and does not resend the same taskId', async () => {
  const chatUrl = 'https://chatgpt.com/c/01234567-89ab-cdef-0123-456789abcdef';
  const store = {};
  let sends = 0;
  const api = {
    storage: {
      local: {
        async get() { return { roundtableLastTaskIds: store.last ?? {} }; },
        async set(value) { store.last = value.roundtableLastTaskIds; },
      },
    },
    tabs: {
      onUpdated: { addListener() {}, removeListener() {} },
      async query() { return [{ id: 7, url: chatUrl, status: 'complete' }]; },
      async sendMessage() { sends++; return { ok: true, sent: true }; },
    },
  };
  const request = { source: 'roundtable-app', action: 'send', chatUrl, taskId: 'task1', text: 'hello' };
  const sender = { tab: { url: 'http://127.0.0.1:17880/' } };
  assert.deepEqual(await handleMessage(request, sender, api), { ok: true, sent: true, alreadySent: false });
  assert.deepEqual(await handleMessage(request, sender, api), { ok: true, sent: false, alreadySent: true });
  assert.equal(sends, 1);
});
