import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';

test('archive survives restart, resume preserves content, and delete only moves the selected conversation to trash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rt-conversation-'));
  const options = { port: 0, sessionsDir: root, agentsFile: 'test/agents.fixture.json' };
  let server = await startServer(options);
  const request = async (route, method = 'GET', body, status = 200) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${route}`, {
      method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  };
  const create = name => request('/api/workbenches', 'POST', { name, participants: ['mockA'] });
  try {
    const { id: keeper } = await create('keep this conversation');
    const keeperBench = server.benches.get(keeper).bench;
    await keeperBench.note('PRESERVE_EXISTING_CONTENT');
    const keeperDir = keeperBench.dir;
    const keeperMessages = await readFile(path.join(keeperDir, 'messages.jsonl'), 'utf8');
    const { id } = await create('archive lifecycle');
    const bench = server.benches.get(id).bench;
    await bench.note('ARCHIVE_AND_RESTORE_CONTENT');
    const dirname = path.basename(bench.dir);
    const messages = await readFile(path.join(bench.dir, 'messages.jsonl'), 'utf8');
    bench.state = 'busy';
    await request(`/api/workbenches/${id}/archive`, 'POST', {}, 409);
    await request(`/api/workbenches/${id}`, 'DELETE', undefined, 409);
    bench.state = 'idle';
    await request(`/api/archive/${encodeURIComponent(dirname)}`, 'DELETE', undefined, 409);
    await request(`/api/workbenches/${id}/archive`, 'POST', {});
    assert.equal(server.benches.has(id), false);
    assert.equal(await readFile(path.join(bench.dir, 'messages.jsonl'), 'utf8'), messages);
    assert.equal(JSON.parse(await readFile(path.join(bench.dir, 'metadata.json'), 'utf8')).archived, true);
    let listing = await request('/api/sessions');
    assert.equal(listing.find(s => s.id === dirname).explicitlyArchived, true);
    server.close();
    server = await startServer(options);
    listing = await request('/api/sessions');
    assert.equal(listing.find(s => s.id === dirname).explicitlyArchived, true);
    const { id: resumed } = await request('/api/workbenches/resume', 'POST', { dirname });
    assert.equal(server.benches.get(resumed).bench.messages[0].text, 'ARCHIVE_AND_RESTORE_CONTENT');
    assert.equal(JSON.parse(await readFile(path.join(bench.dir, 'metadata.json'), 'utf8')).archived, false);
    await request(`/api/workbenches/${resumed}/archive`, 'POST', {});
    await request(`/api/archive/${encodeURIComponent(dirname)}`, 'DELETE');
    listing = await request('/api/sessions');
    assert.equal(listing.some(s => s.id === dirname), false);
    const trashed = (await readdir(path.join(root, '.trash'))).filter(name => name.startsWith(dirname + '-'));
    assert.equal(trashed.length, 1);
    assert.equal(await readFile(path.join(root, '.trash', trashed[0], 'messages.jsonl'), 'utf8'), messages);
    const { id: disposable } = await create('delete active conversation');
    const activeDir = server.benches.get(disposable).bench.dir;
    await request(`/api/workbenches/${disposable}`, 'DELETE');
    assert.equal(server.benches.has(disposable), false);
    assert.equal((await readdir(path.join(root, '.trash'))).some(name => name.startsWith(path.basename(activeDir) + '-')), true);
    assert.equal(await readFile(path.join(keeperDir, 'messages.jsonl'), 'utf8'), keeperMessages);
    assert.equal((await request('/api/sessions')).some(s => s.id === path.basename(keeperDir)), true);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});
