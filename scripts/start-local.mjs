import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
await import('./configure-local.mjs');
const { startServer } = await import('../src/server.js');
const port = Number(process.env.PORT) || 17880;
try {
  let remoteAccess = null;
  try { remoteAccess = JSON.parse(await readFile('workdir/mobile-access.json', 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await startServer({port, remoteAccess});
  console.log(`同桌已啟動：http://127.0.0.1:${port}`);
} catch (error) {
  console.error(error.message);
  process.exitCode=1;
}
