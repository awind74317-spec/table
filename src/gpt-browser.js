import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../workdir/gpt-browser/', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function validChatUrl(value) {
  try {
    const u = new URL(value);
    return u.origin === 'https://chatgpt.com' && !u.username && !u.password
      && /^\/c\/[a-f0-9-]{36,64}$/i.test(u.pathname) && !u.search && !u.hash;
  } catch { return false; }
}

export function browserExecutable() {
  return [
    process.env.ROUNDTABLE_BROWSER_PATH,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].find(file => file && existsSync(file)) || null;
}

// Native browser control, inspired by CCCC's dedicated-profile transport.
// No cookies/tokens are extracted; the official page owns authentication and model requests.
export class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      let data;
      try { data = JSON.parse(String(event.data)); } catch { return; }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      clearTimeout(pending.timer);
      data.error ? pending.reject(new Error('BROWSER_COMMAND_FAILED')) : pending.resolve(data.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('BROWSER_DISCONNECTED'));
      }
      this.pending.clear();
    });
    socket.addEventListener('error', () => {});
  }
  static async connect(url) {
    const u = new URL(url);
    if (u.protocol !== 'ws:' || u.hostname !== '127.0.0.1') throw new Error('BROWSER_ADDRESS_INVALID');
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('BROWSER_CONNECT_TIMEOUT')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('BROWSER_UNAVAILABLE')); }, { once: true });
    });
    return new CdpConnection(socket);
  }
  call(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('BROWSER_COMMAND_TIMEOUT')); }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('BROWSER_DISCONNECTED')); }
    });
  }
  async evaluate(fn, arg) {
    const result = await this.call('Runtime.evaluate', {
      expression: `(${fn.toString()})(${JSON.stringify(arg ?? null)})`, returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error('BROWSER_PAGE_ERROR');
    return result.result?.value;
  }
  close() { this.socket.close(); }
}

// Only observes the selected chat's controls and our own delivery marker, never credentials.
export function chatPageState({ chatUrl, marker = '' } = {}) {
  const selectVisible = selector => [...document.querySelectorAll(selector)].find(el => el.getClientRects().length > 0);
  const visible = el => !!el && el.getClientRects().length > 0;
  const composer = selectVisible('[data-composer-markdown][contenteditable="true"][role="textbox"], #prompt-textarea');
  const model = selectVisible('button[aria-label="選取 ChatGPT 模型"],button[aria-label="Select ChatGPT model"]');
  const busy = [...document.querySelectorAll('button[aria-label="停止"],button[aria-label="Stop"],button[data-testid="stop-button"]')].some(visible);
  const receipt = marker && [...document.querySelectorAll('[data-chatgpt-search-unit-key$=":user"]')].some(el => (el.innerText || '').includes(marker));
  return {
    chatUrl: location.origin + location.pathname,
    sameChat: !chatUrl || location.origin + location.pathname === chatUrl,
    ready: visible(composer) && visible(model), busy,
    draft: !!(composer?.innerText || composer?.value || '').trim(),
    model: model?.innerText || '', receipt: !!receipt,
    title: document.title,
  };
}

export function stagePrompt({ chatUrl, text }) {
  const selectVisible = selector => [...document.querySelectorAll(selector)].find(el => el.getClientRects().length > 0);
  if (location.origin + location.pathname !== chatUrl) return { ok: false, error: 'CHAT_CHANGED' };
  if (!selectVisible('button[aria-label="選取 ChatGPT 模型"],button[aria-label="Select ChatGPT model"]')) return { ok: false, error: 'CHAT_MODE_NOT_CONFIRMED' };
  if (selectVisible('button[aria-label="停止"],button[aria-label="Stop"],button[data-testid="stop-button"]')) return { ok: false, error: 'CHAT_IS_RUNNING' };
  const el = selectVisible('[data-composer-markdown][contenteditable="true"][role="textbox"], #prompt-textarea');
  if (!el) return { ok: false, error: 'COMPOSER_NOT_FOUND' };
  const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  if (norm(el.innerText || el.value)) return { ok: false, error: 'DRAFT_PRESENT' };
  el.focus();
  const selection = document.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el); selection.removeAllRanges(); selection.addRange(range);
  if (!document.execCommand('insertText', false, text)) return { ok: false, error: 'COMPOSER_INSERT_FAILED' };
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  return norm(el.innerText || el.value) === norm(text)
    ? { ok: true } : { ok: false, error: 'COMPOSER_INSERT_FAILED' };
}

export function submitPrompt({ chatUrl, text }) {
  const selectVisible = selector => [...document.querySelectorAll(selector)].find(el => el.getClientRects().length > 0);
  if (location.origin + location.pathname !== chatUrl) return { ok: false, error: 'CHAT_CHANGED' };
  if (!selectVisible('button[aria-label="選取 ChatGPT 模型"],button[aria-label="Select ChatGPT model"]')) return { ok: false, error: 'CHAT_MODE_NOT_CONFIRMED' };
  if (selectVisible('button[aria-label="停止"],button[aria-label="Stop"],button[data-testid="stop-button"]')) return { ok: false, error: 'CHAT_IS_RUNNING' };
  const el = selectVisible('[data-composer-markdown][contenteditable="true"][role="textbox"], #prompt-textarea');
  const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!el || norm(el.innerText || el.value) !== norm(text)) return { ok: false, error: 'COMPOSER_CHANGED' };
  const button = selectVisible('button[type="submit"][aria-label="傳送"],button[type="submit"][aria-label="Send"],button[data-testid="send-button"]');
  if (!button || !button.getClientRects().length || button.disabled || button.getAttribute('aria-disabled') === 'true') return { ok: false, error: 'SEND_BUTTON_NOT_FOUND_OR_DISABLED' };
  button.click();
  return { ok: true, clicked: true };
}

export function clearStagedPrompt({ chatUrl, text }) {
  const selectVisible = selector => [...document.querySelectorAll(selector)].find(el => el.getClientRects().length > 0);
  if (location.origin + location.pathname !== chatUrl) return;
  const el = selectVisible('[data-composer-markdown][contenteditable="true"][role="textbox"], #prompt-textarea');
  const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!el || norm(el.innerText || el.value) !== norm(text)) return;
  el.focus();
  const selection = document.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el); selection.removeAllRanges(); selection.addRange(range);
  document.execCommand('delete', false);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
}

export class GptBrowser {
  constructor({ root = DEFAULT_ROOT } = {}) { this.root = root; this.sending = new Set(); }
  async json(port, endpoint) {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error('BROWSER_UNAVAILABLE');
    return response.json();
  }
  async running() {
    try {
      const saved = JSON.parse(await readFile(path.join(this.root, 'browser.json'), 'utf8'));
      if (!Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535) return null;
      const live = await this.json(saved.port, '/json/version');
      return live.webSocketDebuggerUrl === saved.webSocketDebuggerUrl ? saved : null;
    } catch { return null; }
  }
  async launch() {
    const current = await this.running();
    if (current) return current;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const executable = browserExecutable();
      if (!executable) throw new Error('BROWSER_NOT_INSTALLED');
      if (typeof WebSocket !== 'function') throw new Error('NODE_WEBSOCKET_UNAVAILABLE');
      await mkdir(this.root, { recursive: true });
      const listener = net.createServer();
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
      const port = listener.address().port;
      await new Promise(resolve => listener.close(resolve));
      const child = spawn(executable, [
        `--user-data-dir=${path.join(this.root, 'profile')}`, `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1', '--disable-extensions', '--no-first-run',
        '--no-default-browser-check', '--new-window', 'https://chatgpt.com/',
      ], { detached: true, stdio: 'ignore', windowsHide: false });
      let failed = false;
      child.once('error', () => { failed = true; }); child.unref();
      for (let attempt = 0; attempt < 40 && !failed; attempt++) {
        try {
          const live = await this.json(port, '/json/version');
          const state = { port, pid: child.pid, webSocketDebuggerUrl: live.webSocketDebuggerUrl };
          await writeFile(path.join(this.root, 'browser.json'), JSON.stringify(state));
          return state;
        } catch { await pause(250); }
      }
      throw new Error('BROWSER_START_FAILED');
    })();
    try { return await this.launching; } finally { this.launching = null; }
  }
  async pages() {
    const state = await this.running();
    return state ? (await this.json(state.port, '/json/list')).filter(tab => tab.type === 'page') : [];
  }
  async open(chatUrl = 'https://chatgpt.com/', { activate = true } = {}) {
    if (chatUrl !== 'https://chatgpt.com/' && !validChatUrl(chatUrl)) throw new Error('CHAT_URL_INVALID');
    const state = await this.launch();
    let page = (await this.pages()).find(tab => tab.url.replace(/\/$/, '') === chatUrl.replace(/\/$/, ''));
    const browser = await CdpConnection.connect(state.webSocketDebuggerUrl);
    try {
      if (!page) {
        const created = await browser.call('Target.createTarget', { url: chatUrl, background: !activate });
        page = { id: created.targetId };
      }
      if (activate) await browser.call('Target.activateTarget', { targetId: page.id });
    } finally { browser.close(); }
    return { ok: true, opened: true };
  }
  async page(chatUrl) {
    const page = (await this.pages()).find(tab => tab.url.replace(/\/$/, '') === chatUrl);
    if (!page) throw new Error('CHAT_NOT_OPEN');
    return CdpConnection.connect(page.webSocketDebuggerUrl);
  }
  async newChatTarget() {
    const state = await this.launch();
    const browser = await CdpConnection.connect(state.webSocketDebuggerUrl);
    try { return (await browser.call('Target.createTarget', { url: 'https://chatgpt.com/', background: true })).targetId; }
    finally { browser.close(); }
  }
  async pageById(targetId) {
    const page = (await this.pages()).find(tab => tab.id === targetId);
    if (!page) throw new Error('CHAT_NOT_OPEN');
    return CdpConnection.connect(page.webSocketDebuggerUrl);
  }
  async status(chatUrl) {
    const running = !!await this.running();
    const state = { available: !!browserExecutable(), running, ready: false, transport: 'native-browser', extensions: false };
    if (!running || !validChatUrl(chatUrl)) return state;
    let page;
    try { page = await this.page(chatUrl); return { ...state, ...await page.evaluate(chatPageState, { chatUrl }) }; }
    catch { return state; }
    finally { page?.close(); }
  }
  async send({ chatUrl = '', taskId, text, isCurrent = () => true, onChatUrl = async () => {} }) {
    if (chatUrl && !validChatUrl(chatUrl)) throw new Error('CHAT_URL_INVALID');
    if (typeof taskId !== 'string' || !/^[a-z0-9]{1,128}$/i.test(taskId)) throw new Error('TASK_ID_INVALID');
    if (typeof text !== 'string' || !text.trim() || text.length > 30000) throw new Error('TEXT_INVALID');
    const creating = !chatUrl;
    const receiptKey = chatUrl || `new:${taskId}`;
    if (this.sending.has(receiptKey)) throw new Error('SEND_IN_PROGRESS');
    if (!isCurrent()) throw new Error('GPT_TASK_CHANGED');
    this.sending.add(receiptKey);
    let page;
    const receiptFile = path.join(this.root, 'receipts.json');
    let receipts = {};
    try {
      try { receipts = JSON.parse(await readFile(receiptFile, 'utf8')); } catch {}
      let targetId;
      if (creating) {
        targetId = receipts[receiptKey]?.targetId;
        if (!targetId) {
          targetId = await this.newChatTarget();
          receipts[receiptKey] = { taskId, targetId, status: 'created' };
          await writeFile(receiptFile, JSON.stringify(receipts));
        }
        chatUrl = receipts[receiptKey]?.chatUrl || 'https://chatgpt.com/';
      } else await this.open(chatUrl, { activate: false });
      for (let n = 0; n < 40; n++) {
        try { page = creating ? await this.pageById(targetId) : await this.page(chatUrl); break; } catch { await pause(250); }
      }
      if (!page) throw new Error('CHAT_NOT_OPEN');
      const marker = `[同桌任務:${taskId}]`;
      const prompt = `${marker}\n${text}`;
      const confirmReceipt = async state => {
        if (!state.receipt || (creating && !validChatUrl(state.chatUrl))) return false;
        if (creating) {
          chatUrl = state.chatUrl;
          receipts[receiptKey].chatUrl = chatUrl;
          receipts[chatUrl] = { taskId, status: 'sent' };
          await writeFile(receiptFile, JSON.stringify(receipts));
          await onChatUrl(chatUrl);
        }
        return true;
      };
      let state;
      // MCP deliver can finish before ChatGPT closes its reply. Wait before staging, never retry a click.
      for (let n = 0; n < 120; n++) {
        if (!isCurrent()) throw new Error('GPT_TASK_CHANGED');
        state = await page.evaluate(chatPageState, { chatUrl, marker });
        if (state.receipt || (state.ready && !state.busy) || (!state.sameChat && state.chatUrl !== 'nullblank')) break;
        await pause(250);
      }
      if (await confirmReceipt(state)) return { ok: true, chatUrl, sent: false, alreadySent: true };
      if (receipts[receiptKey]?.taskId === taskId && receipts[receiptKey].status !== 'created') throw new Error('CHAT_SEND_UNKNOWN');
      if (!state.sameChat) throw new Error('CHAT_CHANGED');
      if (!state.ready) throw new Error('CHAT_MODE_NOT_CONFIRMED');
      if (!isCurrent()) throw new Error('GPT_TASK_CHANGED');
      const staged = await page.evaluate(stagePrompt, { chatUrl, text: prompt });
      if (!staged.ok) throw new Error(staged.error);
      await pause(200);
      if (!isCurrent()) {
        await page.evaluate(clearStagedPrompt, { chatUrl, text: prompt });
        throw new Error('GPT_TASK_CHANGED');
      }
      receipts[receiptKey] = { ...receipts[receiptKey], taskId, status: 'sending' };
      await writeFile(receiptFile, JSON.stringify(receipts));
      const submitted = await page.evaluate(submitPrompt, { chatUrl, text: prompt });
      if (!submitted.ok) {
        if (creating) receipts[receiptKey].status = 'created';
        else delete receipts[receiptKey];
        await writeFile(receiptFile, JSON.stringify(receipts));
        throw new Error(submitted.error);
      }
      for (let n = 0; n < 24; n++) {
        if (await confirmReceipt(await page.evaluate(chatPageState, { chatUrl, marker }))) {
          receipts[receiptKey].status = 'sent'; await writeFile(receiptFile, JSON.stringify(receipts));
          return { ok: true, chatUrl, sent: true, alreadySent: false };
        }
        await pause(250);
      }
      throw new Error('CHAT_SEND_UNKNOWN');
    } finally { page?.close(); this.sending.delete(receiptKey); }
  }
}
