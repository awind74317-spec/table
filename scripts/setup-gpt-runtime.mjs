import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_VERSION = 'v26.12.1';
export const RUNTIME_PLATFORM = 'win-x64';
export const runtimePaths = Object.freeze({
  root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  directory: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'workdir', 'runtime', `node-${RUNTIME_VERSION}-${RUNTIME_PLATFORM}`),
});
export const portableNodePath = path.join(runtimePaths.directory, 'node.exe');
export const checksumUrl = `https://nodejs.org/dist/${RUNTIME_VERSION}/SHASUMS256.txt`;
export const nodeUrl = `https://nodejs.org/dist/${RUNTIME_VERSION}/${RUNTIME_PLATFORM}/node.exe`;

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function expectedNodeHash(checksums) {
  const line = checksums.split(/\r?\n/).find(value => /^([a-f0-9]{64})\s+\*?win-x64\/node\.exe\s*$/i.test(value));
  const match = line?.match(/^([a-f0-9]{64})\s+\*?win-x64\/node\.exe\s*$/i);
  if (!match) throw new Error(`SHA256 entry missing for ${RUNTIME_PLATFORM}/node.exe`);
  return match[1].toLowerCase();
}

async function expectedHash() {
  const response = await fetch(checksumUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`SHA256 manifest HTTP ${response.status}`);
  return expectedNodeHash(await response.text());
}

async function existingNodeHash() {
  try {
    const stats = await lstat(portableNodePath);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`portable Node path is not a regular file: ${portableNodePath}`);
    return await sha256File(portableNodePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function downloadNode(tempPath) {
  const response = await fetch(nodeUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Node runtime HTTP ${response.status}`);
  if (!response.body) throw new Error('Node runtime response has no body');
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(tempPath, { flags: 'wx' }),
  );
}

export async function installRuntime() {
  if (process.platform !== 'win32') throw new Error('GPT runtime setup supports Windows only');
  const hash = await expectedHash();
  const current = await existingNodeHash();
  if (current === hash) {
    console.log(`Reused verified portable Node: ${portableNodePath}`);
    return portableNodePath;
  }
  if (current) throw new Error(`portable Node exists with unexpected SHA256; refusing to overwrite: ${portableNodePath}`);

  await mkdir(runtimePaths.directory, { recursive: true });
  const tempPath = `${portableNodePath}.download-${process.pid}-${randomUUID()}`;
  try {
    await downloadNode(tempPath);
    const downloaded = await sha256File(tempPath);
    if (downloaded !== hash) throw new Error('downloaded Node runtime SHA256 mismatch');
    try {
      const raced = await existingNodeHash();
      if (raced === hash) {
        console.log(`Reused verified portable Node: ${portableNodePath}`);
        return portableNodePath;
      }
      if (raced) throw new Error(`portable Node appeared with unexpected SHA256; refusing to overwrite: ${portableNodePath}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(tempPath, portableNodePath);
    console.log(`Installed verified portable Node: ${portableNodePath}`);
    return portableNodePath;
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  installRuntime().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
