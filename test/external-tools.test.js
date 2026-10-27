import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildTaskTestCommand,
  portableNodePath,
  readTaskFile,
  runTaskTest,
  writeTaskFile,
} from '../src/external-tools.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = () => mkdtempSync(path.join(tmpdir(), 'roundtable-external-tools-'));
const code = pattern => error => error?.code === pattern;

test('external tools: directory listing is shallow, bounded, and hides protected entries', async () => {
  const root = fixture();
  mkdirSync(path.join(root, '.git'));
  mkdirSync(path.join(root, 'nested'));
  writeFileSync(path.join(root, '.env'), 'secret');
  writeFileSync(path.join(root, 'visible.txt'), 'ok');
  const result = await readTaskFile(root, { path: '.' });
  assert.equal(result.type, 'directory');
  assert.ok(result.entries.some(entry => entry.name === 'visible.txt'));
  assert.ok(result.entries.every(entry => !['.git', '.env'].includes(entry.name)));
  assert.ok(result.entries.some(entry => entry.name === 'nested' && entry.type === 'directory'));
  assert.equal(result.truncated, false);
});

test('external tools: directory listing stops at 200 entries', async () => {
  const root = fixture();
  for (let i = 0; i < 201; i++) writeFileSync(path.join(root, `file-${String(i).padStart(3, '0')}.txt`), 'x');
  const result = await readTaskFile(root, { path: '.' });
  assert.equal(result.entries.length, 200);
  assert.equal(result.truncated, true);
});

test('external tools: file paging returns a raw-byte hash and at most 20k characters', async () => {
  const root = fixture();
  const content = '字'.repeat(25_000);
  const bytes = Buffer.from(content, 'utf8');
  writeFileSync(path.join(root, 'long.txt'), bytes);
  const first = await readTaskFile(root, { path: 'long.txt' });
  assert.equal(first.content.length, 20_000);
  assert.equal(first.offset, 0);
  assert.equal(first.nextOffset, 20_000);
  assert.equal(first.eof, false);
  assert.equal(first.hash, sha256(bytes));
  const second = await readTaskFile(root, { path: 'long.txt', offset: first.nextOffset });
  assert.equal(first.content + second.content, content);
  assert.equal(second.eof, true);
  assert.equal(second.bom, false);
  assert.equal(second.newline, 'none');
});

test('external tools: BOM and newline style are preserved on write, including nested parents and cmd files', async () => {
  const root = fixture();
  const initial = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('old\r\nvalue\r\n', 'utf8')]);
  writeFileSync(path.join(root, 'doc.txt'), initial);
  const before = await readTaskFile(root, { path: 'doc.txt' });
  assert.equal(before.bom, true);
  assert.equal(before.newline, 'crlf');
  const written = await writeTaskFile(root, {
    path: 'doc.txt',
    content: 'new\nvalue\n',
    expectedHash: before.hash,
  });
  const expected = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('new\r\nvalue\r\n', 'utf8')]);
  assert.deepEqual(readFileSync(path.join(root, 'doc.txt')), expected);
  assert.equal(written.hash, sha256(expected));

  const command = await writeTaskFile(root, { path: 'nested/script.cmd', content: 'echo ok\n', expectedHash: null });
  assert.equal(command.newline, 'crlf');
  assert.equal(readFileSync(path.join(root, 'nested', 'script.cmd'), 'utf8'), 'echo ok\r\n');
});

test('external tools: stale versions and missing hashes are rejected', async () => {
  const root = fixture();
  writeFileSync(path.join(root, 'version.txt'), 'one\n');
  const before = await readTaskFile(root, { path: 'version.txt' });
  await assert.rejects(
    () => writeTaskFile(root, { path: 'version.txt', content: 'two\n', expectedHash: '0'.repeat(64) }),
    code('VERSION_CONFLICT'),
  );
  await assert.rejects(
    () => writeTaskFile(root, { path: 'new.txt', content: 'new\n' }),
    code('EXPECTED_HASH_REQUIRED'),
  );
  const created = await writeTaskFile(root, { path: 'new.txt', content: 'new\n', expectedHash: null });
  assert.equal(created.hash, sha256(Buffer.from('new\n')));
  await assert.rejects(
    () => writeTaskFile(root, { path: 'new.txt', content: 'overwrite\n', expectedHash: null }),
    code('VERSION_CONFLICT'),
  );
  assert.equal((await readTaskFile(root, { path: 'version.txt' })).hash, before.hash);
});

test('external tools: traversal, absolute paths, protected names, and invalid text are rejected', async () => {
  const root = fixture();
  writeFileSync(path.join(root, 'ok.txt'), 'ok');
  for (const badPath of ['../outside.txt', path.join(root, 'outside.txt'), 'nested/../../outside.txt', 'file.txt:secret', '.env.local']) {
    await assert.rejects(() => readTaskFile(root, { path: badPath }));
  }
  await assert.rejects(() => writeTaskFile(root, { path: '.codex/state.json', content: '{}', expectedHash: null }));
  await assert.rejects(() => writeTaskFile(root, { path: 'bad.txt', content: 'nul\0x', expectedHash: null }), code('INVALID_TEXT'));
});

test('external tools: symlinks cannot be read', async t => {
  const root = fixture();
  writeFileSync(path.join(root, 'real.txt'), 'real');
  try {
    symlinkSync(path.join(root, 'real.txt'), path.join(root, 'link.txt'));
  } catch (error) {
    t.skip(`symlink unavailable: ${error.code ?? error.message}`);
    return;
  }
  await assert.rejects(() => readTaskFile(root, { path: 'link.txt' }), code('SYMLINK_REJECTED'));
});

test('external tools: hardlinks cannot be read', async t => {
  const root = fixture();
  writeFileSync(path.join(root, 'real.txt'), 'real');
  try {
    linkSync(path.join(root, 'real.txt'), path.join(root, 'hard.txt'));
  } catch (error) {
    t.skip(`hardlink unavailable: ${error.code ?? error.message}`);
    return;
  }
  await assert.rejects(() => readTaskFile(root, { path: 'hard.txt' }), code('HARDLINK_REJECTED'));
});

test('external tools: task command is a sandboxed Node script, never a model exec', () => {
  const root = fixture();
  const previous = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = 'C:\\test\\codex.exe';
  try {
    const built = buildTaskTestCommand(root, 'scripts/check.mjs');
    assert.equal(built.command, 'C:\\test\\codex.exe');
    assert.equal(built.cwd, root);
    assert.ok(built.args.includes('sandbox'));
    assert.ok(built.args.includes('--permission'));
    assert.ok(built.args.includes(portableNodePath()));
    assert.ok(!built.args.includes(process.execPath));
    assert.ok(built.args.includes('--no-experimental-sqlite'));
    assert.ok(built.args.some(arg => arg === `--allow-fs-read=${root}`));
    assert.ok(built.args.some(arg => arg === `--allow-fs-write=${root}`));
    assert.ok(!built.args.some(arg => arg === '--allow-net' || arg.startsWith('--allow-net=')));
    assert.ok(!built.args.includes('exec'));
    assert.ok(!Object.keys(built.env).some(name => /NODE_OPTIONS|OPENAI|ANTHROPIC|HTTP_PROXY|HTTPS_PROXY/i.test(name)));
    assert.throws(() => buildTaskTestCommand(root, 'run.ps1'), code('INVALID_SCRIPT'));
  } finally {
    if (previous === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = previous;
  }
});

test('external tools: non-Windows task execution fails closed without an unsandboxed fallback', async () => {
  if (process.platform === 'win32') return;
  const result = await runTaskTest(fixture(), 'check.mjs');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'UNSUPPORTED_PLATFORM');
  assert.equal(result.code, null);
});
