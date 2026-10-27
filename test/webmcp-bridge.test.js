import test from 'node:test';
import assert from 'node:assert/strict';
import { API_BASE_URL, handleRequest, tools } from '../scripts/webmcp-bridge.mjs';

const base = { connection: 'session-dir', taskId: 'task-1', key: 'PAIR-SECRET-123' };

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('initialize 使用 webcodex-plugin-v1', async () => {
  const result = await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.deepEqual(result, { jsonrpc: '2.0', id: 1, result: { protocolVersion: 'webcodex-plugin-v1' } });
});

test('tools/list 只暴露三個繁中工具與 schema', async () => {
  const result = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(result.result.tools.map(tool => tool.name), ['claim', 'read', 'deliver']);
  for (const tool of result.result.tools) {
    assert.match(tool.description, /只能用這三個同桌工具/);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const field of ['connection', 'taskId', 'key']) assert.ok(tool.inputSchema.properties[field]);
  }
  const readSchema = result.result.tools.find(tool => tool.name === 'read').inputSchema.properties;
  assert.equal(readSchema.path, undefined);
  assert.equal(readSchema.offset, undefined);
  assert.equal(readSchema.size, undefined);
  assert.equal(result.result.tools.find(tool => tool.name === 'deliver').inputSchema.properties.final.default, undefined);
  for (const tool of result.result.tools) {
    for (const property of Object.values(tool.inputSchema.properties)) {
      assert.equal(property.pattern, undefined);
      assert.equal(property.enum, undefined);
    }
  }
});

test('三個 action 都固定 POST 到 loopback action URL', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response({ ok: true, action: url.split('/').at(-1), nextSeq: 4, status: 'running' });
  };
  const requests = [
    ['claim', { ...base, clientId: 'chat-client' }],
    ['read', { ...base, after: 0 }],
    ['deliver', { ...base, text: 'progress', ackSeq: 4, operationId: 'op-deliver', final: false }]
  ];
  for (let i = 0; i < requests.length; i += 1) {
    const [name, args] = requests[i];
    const result = await handleRequest({ jsonrpc: '2.0', id: i + 10, method: 'tools/call', params: { name, arguments: args } }, { fetchImpl });
    assert.equal(result.result.isError, false);
    assert.equal(calls[i].url, `${API_BASE_URL}/api/gpt/${name}`);
    const body = JSON.parse(calls[i].options.body);
    assert.deepEqual(body, args);
    assert.equal(calls[i].options.method, 'POST');
  }
});

test('unknown tool and invalid arguments are MCP error results', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return response({ ok: true }); };
  const unknown = await handleRequest({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'raw_process', arguments: base } }, { fetchImpl });
  assert.equal(unknown.result.isError, true);
  assert.equal(unknown.result.structuredContent.code, 'unknown_tool');
  const invalid = await handleRequest({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'read', arguments: { ...base, size: 20_001 } } }, { fetchImpl });
  assert.equal(invalid.result.isError, true);
  assert.equal(invalid.result.structuredContent.code, 'invalid_arguments');
  for (const name of ['write', 'test']) {
    const removed = await handleRequest({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name, arguments: base } }, { fetchImpl });
    assert.equal(removed.result.structuredContent.code, 'unknown_tool');
  }
  assert.equal(called, false);
});

test('API errors do not echo the pairing code', async () => {
  const result = await handleRequest({
    jsonrpc: '2.0',
    id: 30,
    method: 'tools/call',
    params: { name: 'claim', arguments: { ...base, clientId: 'chat-client' } }
  }, { fetchImpl: async () => response({ error: `bad key ${base.key}` }, 401) });
  assert.equal(result.result.isError, true);
  assert.equal(JSON.stringify(result), JSON.stringify(result).replaceAll(base.key, '<REDACTED>'));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(base.key));
});

test('unknown JSON-RPC method returns protocol error', async () => {
  const result = await handleRequest({ jsonrpc: '2.0', id: 40, method: 'tools/unknown' });
  assert.deepEqual(result.error, { code: -32601, message: 'Method not found' });
});
