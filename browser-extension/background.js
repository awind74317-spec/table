const LOCAL_ORIGIN = 'http://127.0.0.1:17880';
const CHAT_ORIGIN = 'https://chatgpt.com';
const CHAT_PATH = /^\/c\/[0-9a-f-]{36,64}$/i;
const TASK_ID = /^[A-Za-z0-9]{1,128}$/;
const STORAGE_KEY = 'roundtableLastTaskIds';
const TAB_WAIT_MS = 15_000;

function error(message) {
  return { ok: false, error: message };
}

export function validChatUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === CHAT_ORIGIN && CHAT_PATH.test(url.pathname) && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function validLocalSender(sender) {
  try {
    return new URL(sender?.tab?.url ?? '').origin === LOCAL_ORIGIN;
  } catch {
    return false;
  }
}

export function validateSend(message) {
  if (!validChatUrl(message?.chatUrl)) return 'CHAT_URL_INVALID';
  if (typeof message?.taskId !== 'string' || !TASK_ID.test(message.taskId)) return 'TASK_ID_INVALID';
  if (typeof message?.text !== 'string' || !message.text || message.text.length > 30_000) return 'TEXT_INVALID';
  return null;
}

function waitForTabComplete(api, tabId) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (fn, value) => {
      clearTimeout(timer);
      api.tabs.onUpdated.removeListener(onUpdated);
      fn(value);
    };
    const onUpdated = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === 'complete') finish(resolve);
    };
    api.tabs.onUpdated.addListener(onUpdated);
    timer = setTimeout(() => finish(() => reject(new Error('CHAT_TAB_LOAD_TIMEOUT'))), TAB_WAIT_MS);
  });
}

async function findChatTab(api, chatUrl) {
  const target = new URL(chatUrl);
  const tabs = await api.tabs.query({ url: `${CHAT_ORIGIN}/c/*` });
  return tabs.find(tab => {
    try {
      const url = new URL(tab.url ?? '');
      return url.origin === CHAT_ORIGIN && url.pathname === target.pathname;
    } catch {
      return false;
    }
  }) ?? null;
}

async function getLastTask(api, chatUrl) {
  const stored = await api.storage.local.get(STORAGE_KEY);
  return stored?.[STORAGE_KEY]?.[chatUrl] ?? null;
}

async function rememberTask(api, chatUrl, taskId) {
  const stored = await api.storage.local.get(STORAGE_KEY);
  const lastTaskIds = { ...(stored?.[STORAGE_KEY] ?? {}), [chatUrl]: taskId };
  await api.storage.local.set({ [STORAGE_KEY]: lastTaskIds });
}

export async function handleMessage(message, sender, api = globalThis.chrome) {
  if (!validLocalSender(sender)) return error('LOCAL_SENDER_INVALID');
  if (!message || message.source !== 'roundtable-app') return error('MESSAGE_SOURCE_INVALID');
  if (message.action === 'ping') return { ok: true };
  if (message.action !== 'send') return error('ACTION_INVALID');
  const invalid = validateSend(message);
  if (invalid) return error(invalid);
  if (!api?.tabs || !api?.storage?.local) return error('EXTENSION_API_UNAVAILABLE');
  if (await getLastTask(api, message.chatUrl) === message.taskId) {
    return { ok: true, sent: false, alreadySent: true };
  }

  let tab;
  let created = false;
  try {
    tab = await findChatTab(api, message.chatUrl);
    if (!tab) {
      tab = await api.tabs.create({ url: message.chatUrl, active: false });
      created = true;
    }
    if (!tab?.id) return error('CHAT_TAB_UNAVAILABLE');
    if (created && tab.status !== 'complete') await waitForTabComplete(api, tab.id);
  } catch (caught) {
    return error(caught instanceof Error ? caught.message : 'CHAT_TAB_UNAVAILABLE');
  }

  let response;
  try {
    response = await api.tabs.sendMessage(tab.id, {
      source: 'roundtable-extension',
      action: 'send',
      chatUrl: message.chatUrl,
      taskId: message.taskId,
      text: message.text,
    });
  } catch {
    return error('CHAT_CONTENT_SCRIPT_UNAVAILABLE');
  }
  if (!response?.ok || response.sent !== true) return response?.error ? response : error('CHAT_SEND_UNKNOWN');
  await rememberTask(api, message.chatUrl, message.taskId);
  return { ok: true, sent: true, alreadySent: false };
}

if (globalThis.chrome?.runtime?.onMessage) {
  globalThis.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse).catch(() => sendResponse(error('BRIDGE_FAILED')));
    return true;
  });
}
