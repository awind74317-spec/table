import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

export const API_BASE_URL = 'http://127.0.0.1:17880';
const DEFAULT_TIMEOUT_MS = 10_000;

const commonProperties = {
  connection: {
    type: 'string',
    minLength: 1,
    maxLength: 256,
    description: '同桌 session dirname；是持久識別，不是隨啟動變動的 benchId。'
  },
  taskId: {
    type: 'string',
    minLength: 1,
    maxLength: 256,
    description: '同桌已指派任務的識別。'
  },
  key: {
    type: 'string',
    minLength: 1,
    maxLength: 256,
    description: '本機單次任務的隨機配對碼；不得回傳或寫入其他內容。'
  }
};

const commonRequired = ['connection', 'taskId', 'key'];

function schema(properties, required = commonRequired) {
  return {
    type: 'object',
    properties: { ...commonProperties, ...properties },
    required,
    additionalProperties: false
  };
}

export const tools = [
  {
    name: 'claim',
    title: '領取同桌任務',
    description: '只能用這三個同桌工具進行唯讀討論。領取一個 task-scoped GPT 席位；不得使用 WebMCP raw process 越界。clientId 由 GPT 自行產生並在同一官方 Chat 續接時保持不變，不宣稱官方身份。',
    inputSchema: schema({
      clientId: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        description: 'GPT 自行產生的穩定續接代碼，不是官方身份。'
      }
    }, [...commonRequired, 'clientId'])
  },
  {
    name: 'read',
    title: '讀取同桌上下文',
    description: '只能用這三個同桌工具進行唯讀討論。讀取各席共用的增量討論內容；本地專案請由 Codex、Claude 閱讀後帶回同桌。不得使用 WebMCP raw process 越界。',
    inputSchema: schema({
      after: {
        type: 'integer',
        description: '增量游標；只能是非負整數。'
      },

    })
  },
  {
    name: 'deliver',
    title: '交付同桌成果',
    description: '只能用這三個同桌工具進行唯讀討論。回報 progress 或 final；ackSeq 必須是 read 回傳的 nextSeq。不得使用 WebMCP raw process 越界。',
    inputSchema: schema({
      text: {
        type: 'string',
        description: '要回報給同桌的進度或最終成果文字。'
      },
      ackSeq: {
        type: 'integer',
        description: 'read 回傳的 nextSeq；只能是非負整數。'
      },
      operationId: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        description: '本次交付的去重識別。'
      },
      final: {
        type: 'boolean',
        description: 'true 代表最終交付，省略時預設 true；false 代表 progress。'
      }
    }, [...commonRequired, 'text', 'ackSeq', 'operationId'])
  }
];

const toolNames = new Set(tools.map(tool => tool.name));

function rpc(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function contentText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    for (const key of ['message', 'text', 'status']) {
      if (typeof value[key] === 'string') return value[key];
    }
  }
  return value === undefined ? '' : JSON.stringify(value);
}

function redactString(value, secrets) {
  let output = String(value);
  for (const secret of secrets) {
    if (secret) output = output.split(String(secret)).join('<REDACTED>');
  }
  return output;
}

function sanitize(value, secrets = []) {
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map(item => sanitize(item, secrets));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/key|token|secret|password|authorization|pairing.?code/i.test(key)) {
      output[key] = '<REDACTED>';
    } else {
      output[key] = sanitize(item, secrets);
    }
  }
  return output;
}

function errorResult(code, message, secrets = []) {
  const safeMessage = redactString(message, secrets);
  return {
    content: [{ type: 'text', text: safeMessage }],
    structuredContent: { ok: false, code, message: safeMessage },
    isError: true
  };
}

function okResult(payload, secrets = []) {
  const safePayload = sanitize(payload, secrets);
  return {
    content: [{ type: 'text', text: JSON.stringify(safePayload) }],
    structuredContent: safePayload,
    isError: false
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return false;
  return !value.split(/[\\/]+/).includes('..');
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validateCommon(args) {
  for (const key of commonRequired) {
    if (typeof args[key] !== 'string' || !args[key]) return `缺少或無效欄位：${key}`;
  }
  return null;
}

function validateToolArguments(name, rawArgs) {
  if (!isPlainObject(rawArgs)) return { error: 'arguments 必須是 JSON object' };
  const args = { ...rawArgs };
  const commonError = validateCommon(args);
  if (commonError) return { error: commonError };

  if (name === 'claim') {
    if (typeof args.clientId !== 'string' || !args.clientId) return { error: '缺少或無效欄位：clientId' };
  } else if (name === 'read') {
    if (args.path !== undefined && !isSafeRelativePath(args.path)) return { error: 'path 必須是唯讀專案內相對路徑' };
    if (args.after !== undefined && !isNonNegativeInteger(args.after)) return { error: 'after 必須是非負整數' };
    if (args.offset !== undefined && !isNonNegativeInteger(args.offset)) return { error: 'offset 必須是非負整數' };
    if (args.size !== undefined && (!isNonNegativeInteger(args.size) || args.size > 20_000)) return { error: 'size 必須是 0 到 20000 的整數' };
  } else if (name === 'deliver') {
    if (typeof args.text !== 'string') return { error: 'text 必須是 string' };
    if (!isNonNegativeInteger(args.ackSeq)) return { error: 'ackSeq 必須是非負整數' };
    if (typeof args.operationId !== 'string' || !args.operationId) return { error: '缺少或無效欄位：operationId' };
    if (args.final === undefined) args.final = true;
    if (typeof args.final !== 'boolean') return { error: 'final 必須是 boolean' };
  }
  return { args };
}

async function callApi(action, args, fetchImpl = globalThis.fetch) {
  const secrets = [args.key];
  const timeoutMs = DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${API_BASE_URL}/api/gpt/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
      signal: controller.signal
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = { ok: false, code: 'invalid_json', message: '同桌 API 回傳不是有效 JSON' };
    }
    if (!response.ok) {
      const message = contentText(sanitize(payload, secrets)) || `同桌 API HTTP ${response.status}`;
      return errorResult(`api_http_${response.status}`, message, secrets);
    }
    return okResult(payload, secrets);
  } catch (error) {
    if (error?.name === 'AbortError') return errorResult('timeout', `同桌 ${action} API 超過 ${timeoutMs}ms`, secrets);
    return errorResult('api_request_failed', '同桌 API 請求失敗', secrets);
  } finally {
    clearTimeout(timer);
  }
}

export async function handleRequest(request, { fetchImpl = globalThis.fetch } = {}) {
  if (!request || request.jsonrpc !== '2.0' || request.id === undefined) return null;
  if (request.method === 'initialize') return rpc(request.id, { protocolVersion: 'webcodex-plugin-v1' });
  if (request.method === 'tools/list') return rpc(request.id, { tools });
  if (request.method === 'tools/call') {
    const name = request.params?.name;
    if (!toolNames.has(name)) return rpc(request.id, errorResult('unknown_tool', '未知工具', []));
    const validation = validateToolArguments(name, request.params?.arguments);
    if (validation.error) return rpc(request.id, errorResult('invalid_arguments', validation.error, [request.params?.arguments?.key]));
    const apiArgs = validation.args;
    return rpc(request.id, await callApi(name, apiArgs, fetchImpl));
  }
  return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } };
}

export function startStdio({ input = process.stdin, output = process.stdout, fetchImpl = globalThis.fetch } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const run = (async () => {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const response = await handleRequest(JSON.parse(line), { fetchImpl });
        if (response) output.write(`${JSON.stringify(response)}\n`);
      } catch {
        // Keep the provider alive; malformed input does not produce a secret-bearing error.
      }
    }
  })();
  return { rl, done: run };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) startStdio();
