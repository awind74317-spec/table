import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  mkdir,
  lstat,
  realpath,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_READ_CHARS = 20_000;
const MAX_OUTPUT_CHARS = 24_000;
const TASK_TEST_TIMEOUT_MS = 45_000;
const PORTABLE_NODE_PATH = fileURLToPath(new URL('../workdir/runtime/node-v26.12.1-win-x64/node.exe', import.meta.url));
const BUNDLED_CODEX_CLI = 'C:\\Users\\Username\\AppData\\Local\\OpenAI\\Codex\\bin\\6257d9e8f63c0f2b\\codex.exe';
const PROTECTED_NAMES = new Set(['.git', '.codex', '.agents', '.aws', '.env', '.ssh']);
const SECRET_FILE_NAMES = new Set(['.npmrc', '.pypirc', 'id_rsa', 'id_ed25519']);
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function hasUnpairedSurrogate(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateText(text, label = 'content') {
  if (typeof text !== 'string') throw fail('INVALID_TEXT', `${label} must be a string`);
  if (text.includes('\0') || hasUnpairedSurrogate(text)) {
    throw fail('INVALID_TEXT', `${label} must be UTF-8 text without NUL`);
  }
  return text;
}

function reservedName(name) {
  const trimmed = name.replace(/[ .]+$/g, '');
  if (!trimmed) return true;
  if (WINDOWS_RESERVED.test(trimmed)) return true;
  if (PROTECTED_NAMES.has(trimmed.toLowerCase())) return true;
  if (trimmed.toLowerCase().startsWith('.env.')) return true;
  if (SECRET_FILE_NAMES.has(trimmed.toLowerCase())) return true;
  return false;
}

function normalizeRelativePath(value, { allowRoot = false } = {}) {
  if (typeof value !== 'string') throw fail('INVALID_PATH', 'path must be a string');
  if (value.includes('\0')) throw fail('INVALID_PATH', 'path contains NUL');
  const raw = value.replaceAll('\\', '/');
  if (raw === '.' || raw === '') {
    if (allowRoot) return { fsPath: '.', displayPath: '.' };
    throw fail('INVALID_PATH', 'path must name a file');
  }
  if (raw.startsWith('/') || raw.startsWith('//') || /^[A-Za-z]:/.test(raw)) {
    throw fail('PATH_ESCAPE', 'path must be relative to root');
  }
  const parts = raw.split('/');
  const clean = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') throw fail('PATH_ESCAPE', 'path traversal is not allowed');
    if (part.includes(':')) throw fail('PATH_ESCAPE', 'Windows alternate data streams are not allowed');
    if (reservedName(part)) throw fail('PATH_BLOCKED', `protected path segment: ${part}`);
    clean.push(part);
  }
  if (!clean.length) {
    if (allowRoot) return { fsPath: '.', displayPath: '.' };
    throw fail('INVALID_PATH', 'path must name a file');
  }
  return { fsPath: clean.join(path.sep), displayPath: clean.join('/') };
}

function isContained(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === ''
    || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function pathSegments(fullPath) {
  const parsed = path.parse(fullPath);
  return {
    root: parsed.root,
    segments: fullPath.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean),
  };
}

async function checkExistingSegments(fullPath, { allowMissing = false } = {}) {
  const { root, segments } = pathSegments(fullPath);
  let current = root;
  let missing = false;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') {
        missing = true;
        break;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) throw fail('SYMLINK_REJECTED', `symbolic link or junction is not allowed: ${current}`);
    if (i < segments.length - 1 && !stats.isDirectory()) {
      throw fail('INVALID_PATH', `path segment is not a directory: ${current}`);
    }
  }
  return { missing, existingPath: missing ? current.slice(0, current.lastIndexOf(path.sep)) || root : fullPath };
}

async function safeRoot(root) {
  if (typeof root !== 'string' || !root.trim()) throw fail('INVALID_ROOT', 'root must be a directory path');
  const rootPath = path.resolve(root);
  let stats;
  try {
    await checkExistingSegments(rootPath);
    stats = await lstat(rootPath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw fail('INVALID_ROOT', `root does not exist: ${root}`);
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw fail('INVALID_ROOT', 'root must be a real directory');
  const realRoot = await realpath(rootPath);
  if (!isContained(realRoot, realRoot)) throw fail('PATH_ESCAPE', 'root containment check failed');
  return { rootPath, realRoot };
}

async function safeTarget(rootInfo, normalized, { allowMissing = false } = {}) {
  const targetPath = path.resolve(rootInfo.rootPath, normalized.fsPath);
  if (!isContained(rootInfo.rootPath, targetPath)) throw fail('PATH_ESCAPE', 'path escapes root');
  const segments = await checkExistingSegments(targetPath, { allowMissing });
  if (segments.missing) {
    const requestedParent = path.dirname(targetPath);
    let parentPath = requestedParent;
    let parentReal;
    while (!parentReal) {
      try {
        parentReal = await realpath(parentPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        const next = path.dirname(parentPath);
        if (next === parentPath) throw fail('INVALID_ROOT', 'unable to resolve parent directory');
        parentPath = next;
      }
    }
    if (!isContained(rootInfo.realRoot, parentReal)) throw fail('PATH_ESCAPE', 'parent escapes root');
    return { targetPath, parentPath: requestedParent, exists: false };
  }
  const targetStats = await lstat(targetPath);
  if (targetStats.isSymbolicLink()) throw fail('SYMLINK_REJECTED', 'symbolic link or junction is not allowed');
  const targetReal = await realpath(targetPath);
  if (!isContained(rootInfo.realRoot, targetReal)) throw fail('PATH_ESCAPE', 'path realpath escapes root');
  return { targetPath, parentPath: path.dirname(targetPath), exists: true, stats: targetStats, realPath: targetReal };
}

async function ensureParentDirs(rootInfo, parentPath) {
  if (!isContained(rootInfo.rootPath, path.resolve(parentPath))) throw fail('PATH_ESCAPE', 'parent escapes root');
  const { root, segments } = pathSegments(path.resolve(parentPath));
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(current);
      stats = await lstat(current);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw fail(stats.isSymbolicLink() ? 'SYMLINK_REJECTED' : 'INVALID_PATH', `unsafe parent directory: ${current}`);
    }
    if (isContained(rootInfo.rootPath, current)) {
      const resolved = await realpath(current);
      if (!isContained(rootInfo.realRoot, resolved)) throw fail('PATH_ESCAPE', 'parent realpath escapes root');
    }
  }
}

function decodeText(buffer) {
  if (buffer.length > MAX_FILE_BYTES) throw fail('FILE_TOO_LARGE', `file exceeds ${MAX_FILE_BYTES} bytes`);
  let bom = false;
  let bytes = buffer;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bom = true;
    bytes = bytes.subarray(3);
  }
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw fail('INVALID_TEXT', 'file is not valid UTF-8 text');
  }
  validateText(content, 'file');
  return { content, bom };
}

function newlineInfo(content) {
  const matches = content.match(/\r\n|\r|\n/g) ?? [];
  const styles = [...new Set(matches)];
  if (!styles.length) return { newline: 'none', sequence: '' };
  if (styles.length > 1) return { newline: 'mixed', sequence: styles[0] };
  const sequence = styles[0];
  return { newline: sequence === '\r\n' ? 'crlf' : sequence === '\r' ? 'cr' : 'lf', sequence };
}

function normalizeNewlines(content, sequence) {
  if (!sequence) return content;
  const lf = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return sequence === '\n' ? lf : lf.replace(/\n/g, sequence);
}

function extensionNeedsCrlf(displayPath) {
  return /\.(?:cmd|bat)$/i.test(displayPath);
}

async function readRegularFile(target) {
  if (!target.stats.isFile()) throw fail('INVALID_TARGET', 'path is not a regular file');
  if (target.stats.nlink > 1) throw fail('HARDLINK_REJECTED', 'hard-linked files are not allowed');
  if (target.stats.size > MAX_FILE_BYTES) throw fail('FILE_TOO_LARGE', `file exceeds ${MAX_FILE_BYTES} bytes`);
  const buffer = await readFile(target.targetPath);
  const decoded = decodeText(buffer);
  return { buffer, ...decoded, hash: sha256(buffer), ...newlineInfo(decoded.content) };
}

async function directoryResult(rootInfo, normalized) {
  const target = await safeTarget(rootInfo, normalized);
  if (!target.stats.isDirectory()) throw fail('INVALID_TARGET', 'path is not a directory');
  const entries = await readdir(target.targetPath, { withFileTypes: true });
  const visible = entries
    .filter(entry => entry.name !== '.git' && !reservedName(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const truncated = visible.length > 200;
  return {
    path: normalized.displayPath,
    type: 'directory',
    entries: visible.slice(0, 200).map(entry => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
    })),
    truncated,
  };
}

export async function readTaskFile(root, { path: filePath, offset = 0, size = MAX_READ_CHARS } = {}) {
  const rootInfo = await safeRoot(root);
  const normalized = normalizeRelativePath(filePath, { allowRoot: true });
  if (!Number.isSafeInteger(offset) || offset < 0) throw fail('INVALID_OFFSET', 'offset must be a non-negative integer');
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_READ_CHARS) throw fail('INVALID_SIZE', `size must be between 0 and ${MAX_READ_CHARS}`);
  const target = await safeTarget(rootInfo, normalized);
  if (target.stats.isDirectory()) return directoryResult(rootInfo, normalized);
  const file = await readRegularFile(target);
  const characters = Array.from(file.content);
  const start = Math.min(offset, characters.length);
  const content = characters.slice(start, start + size).join('');
  const nextOffset = start + Array.from(content).length;
  return {
    path: normalized.displayPath,
    content,
    hash: file.hash,
    offset: start,
    nextOffset,
    eof: nextOffset >= file.content.length,
    bom: file.bom,
    newline: file.newline,
  };
}

function checkExpectedHash(expectedHash) {
  if (expectedHash === null) return;
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
    throw fail('EXPECTED_HASH_REQUIRED', 'expectedHash must be a SHA-256 hex string or null for a new file');
  }
}

export async function writeTaskFile(root, { path: filePath, content, expectedHash } = {}) {
  if (expectedHash === undefined) throw fail('EXPECTED_HASH_REQUIRED', 'expectedHash is required');
  checkExpectedHash(expectedHash);
  validateText(content);
  const rootInfo = await safeRoot(root);
  const normalized = normalizeRelativePath(filePath);
  const target = await safeTarget(rootInfo, normalized, { allowMissing: true });
  let existing = null;
  if (target.exists) {
    existing = await readRegularFile(target);
    if (expectedHash === null || existing.hash.toLowerCase() !== expectedHash.toLowerCase()) {
      throw fail('VERSION_CONFLICT', 'file changed since it was read');
    }
  } else if (expectedHash !== null) {
    throw fail('VERSION_CONFLICT', 'expectedHash does not match a new file');
  }
  await ensureParentDirs(rootInfo, target.parentPath);

  let text = content;
  let requestedBom = false;
  if (text.startsWith('\ufeff')) {
    requestedBom = true;
    text = text.slice(1);
  }
  const keepBom = existing ? existing.bom : requestedBom;
  const existingSequence = existing?.sequence ?? '';
  const sequence = extensionNeedsCrlf(normalized.displayPath)
    ? '\r\n'
    : existingSequence || '';
  text = normalizeNewlines(text, sequence);
  validateText(text);
  const body = Buffer.from(text, 'utf8');
  const buffer = keepBom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  if (buffer.length > MAX_FILE_BYTES) throw fail('FILE_TOO_LARGE', `file exceeds ${MAX_FILE_BYTES} bytes`);

  let latest;
  try {
    latest = await lstat(target.targetPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (latest) {
    if (latest.isSymbolicLink()) throw fail('SYMLINK_REJECTED', 'symbolic link or junction is not allowed');
    if (!latest.isFile()) throw fail('INVALID_TARGET', 'path is not a regular file');
    if (expectedHash === null) throw fail('VERSION_CONFLICT', 'file appeared while creating it');
  }
  await writeFile(target.targetPath, buffer, { flag: latest ? 'w' : 'wx' });
  const written = await readFile(target.targetPath);
  const readback = decodeText(written);
  const hash = sha256(written);
  return { path: normalized.displayPath, hash, bom: readback.bom, newline: newlineInfo(readback.content).newline };
}

function envLookup(name) {
  const key = Object.keys(process.env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
  return key ? process.env[key] : undefined;
}

function cleanTaskEnv() {
  const env = {};
  const names = ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'CODEX_HOME'];
  for (const name of names) {
    const value = envLookup(name);
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function codexCliPath() {
  const override = envLookup('CODEX_CLI_PATH');
  return override?.trim() || BUNDLED_CODEX_CLI;
}

function makeTaskTestCommand(rootPath, scriptPath) {
  const command = codexCliPath();
  const args = [
    '-c', 'windows.sandbox="elevated"',
    'sandbox', '--include-managed-config', '--permission-profile', ':workspace',
    '-C', rootPath,
    '--', PORTABLE_NODE_PATH, '--permission', '--no-experimental-sqlite',
    `--allow-fs-read=${rootPath}`,
    `--allow-fs-write=${rootPath}`,
    scriptPath,
  ];
  return { command, args, cwd: rootPath, env: cleanTaskEnv() };
}

export const portableNodePath = () => PORTABLE_NODE_PATH;

// Exported for a deterministic unit check. It only builds argv; it never starts a CLI or model.
export function buildTaskTestCommand(root, script) {
  const rootPath = path.resolve(root);
  const normalized = normalizeRelativePath(script);
  if (!/\.(?:js|mjs|cjs)$/i.test(normalized.displayPath)) {
    throw fail('INVALID_SCRIPT', 'only relative .js, .mjs, or .cjs scripts are allowed');
  }
  const scriptPath = path.resolve(rootPath, normalized.fsPath);
  if (!isContained(rootPath, scriptPath)) throw fail('PATH_ESCAPE', 'script escapes root');
  return makeTaskTestCommand(rootPath, scriptPath);
}

async function terminateChildTree(child) {
  if (!child?.pid) return;
  if (process.platform !== 'win32') {
    try { child.kill('SIGKILL'); } catch { /* close will report the result */ }
    return;
  }
  await new Promise(resolve => {
    let settled = false;
    let killer;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => {
        try { child.kill('SIGKILL'); } catch { /* child close is authoritative */ }
        finish();
      });
      killer.once('close', () => {
        try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* child close is authoritative */ }
        finish();
      });
    } catch {
      try { child.kill('SIGKILL'); } catch { /* child close is authoritative */ }
      finish();
    }
    setTimeout(finish, 3000).unref?.();
  });
}

function appendOutput(state, stream, text) {
  if (!text) return;
  const remaining = MAX_OUTPUT_CHARS - Array.from(state.output).length;
  const piece = Array.from(text).slice(0, Math.max(0, remaining)).join('');
  if (piece) {
    state.output += piece;
    state[stream] += piece;
    try { state.onChunk?.(piece); } catch { /* output callbacks cannot change process control */ }
  }
}

async function validateTaskScript(rootInfo, script) {
  const normalized = normalizeRelativePath(script);
  if (!/\.(?:js|mjs|cjs)$/i.test(normalized.displayPath)) {
    throw fail('INVALID_SCRIPT', 'only relative .js, .mjs, or .cjs scripts are allowed');
  }
  const target = await safeTarget(rootInfo, normalized);
  const file = await readRegularFile(target);
  if (file.buffer.length > MAX_FILE_BYTES) throw fail('FILE_TOO_LARGE', 'script exceeds 1 MiB');
  return { normalized, target };
}

async function portableNodeError() {
  try {
    const stats = await lstat(PORTABLE_NODE_PATH);
    if (stats.isSymbolicLink() || !stats.isFile()) return `PORTABLE_NODE_INVALID: ${PORTABLE_NODE_PATH}`;
    return null;
  } catch (error) {
    if (error?.code === 'ENOENT') return `PORTABLE_NODE_MISSING: ${PORTABLE_NODE_PATH}`;
    return `PORTABLE_NODE_UNREADABLE: ${PORTABLE_NODE_PATH}`;
  }
}

export async function runTaskTest(root, script, { signal, onChunk } = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'UNSUPPORTED_PLATFORM', output: '', stdout: '', stderr: '', code: null, exitCode: null };
  }
  const runtimeError = await portableNodeError();
  if (runtimeError) {
    return { ok: false, error: runtimeError, output: '', stdout: '', stderr: '', code: null, exitCode: null };
  }
  const rootInfo = await safeRoot(root);
  const { target } = await validateTaskScript(rootInfo, script);
  if (signal?.aborted) return { ok: false, error: 'aborted', aborted: true, output: '', stdout: '', stderr: '', code: null, exitCode: null };
  const command = makeTaskTestCommand(rootInfo.rootPath, target.targetPath);
  const started = Date.now();
  return await new Promise(resolve => {
    const state = { output: '', stdout: '', stderr: '', onChunk };
    let child;
    let settled = false;
    let stopped = null;
    let spawnError = null;
    let timer;
    let abortHandler;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const finish = ({ code = null, signal: childSignal = null } = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      appendOutput(state, 'stdout', stdoutDecoder.end());
      appendOutput(state, 'stderr', stderrDecoder.end());
      const error = stopped || (spawnError ? `spawn:${spawnError.code ?? spawnError.message}` : (code === 0 ? null : 'exit'));
      resolve({
        ok: !error && code === 0,
        error,
        output: state.output,
        stdout: state.stdout,
        stderr: state.stderr,
        code,
        exitCode: code,
        signal: childSignal,
        timedOut: stopped === 'timeout',
        aborted: stopped === 'aborted',
        durationMs: Date.now() - started,
      });
    };
    try {
      child = spawn(command.command, command.args, {
        cwd: command.cwd,
        env: command.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      spawnError = error;
      finish();
      return;
    }
    child.stdout?.on('data', chunk => appendOutput(state, 'stdout', stdoutDecoder.write(chunk)));
    child.stderr?.on('data', chunk => appendOutput(state, 'stderr', stderrDecoder.write(chunk)));
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, childSignal) => finish({ code, signal: childSignal }));
    const stop = reason => {
      if (stopped || settled) return;
      stopped = reason;
      void terminateChildTree(child);
    };
    timer = setTimeout(() => stop('timeout'), TASK_TEST_TIMEOUT_MS);
    timer.unref?.();
    abortHandler = () => stop('aborted');
    signal?.addEventListener('abort', abortHandler, { once: true });
    if (signal?.aborted) abortHandler();
  });
}

