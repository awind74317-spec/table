import { execFile } from 'node:child_process';
import { buildProfileEnv } from './profile.js';

const cache = new Map();

// Inspect only the official CLI's public status. Never open or copy token files.
export async function subscriptionStatus(cfg, { fresh = false } = {}) {
  const family = cfg.family;
  if (!cfg.subscriptionOnly) return { ok: true, method: 'fixture', detail: 'Test adapter' };
  if (!['claude', 'codex'].includes(family)) return { ok: false, detail: '未支援的訂閱 CLI' };
  if (cfg.unavailable) return { ok: false, detail: '找不到可用的 CLI，請檢查安裝路徑。' };
  const key = `${family}:${cfg.command[0]}`;
  const previous = cache.get(key);
  if (!fresh && previous && Date.now() - previous.ts < 60000) return previous.value;
  const args = family === 'claude' ? ['auth', 'status'] : ['login', 'status'];
  const value = await new Promise(resolve => {
    execFile(cfg.command[0], args, { env: buildProfileEnv(cfg), timeout: 12000, windowsHide: true, maxBuffer: 65536 }, (error, stdout, stderr) => {
      if (family === 'claude') {
        try {
          const status = JSON.parse(stdout);
          const ok = !error && status.loggedIn === true && status.authMethod === 'claude.ai' && !!status.subscriptionType;
          resolve({ ok, method: ok ? 'Claude 訂閱' : '未確認訂閱', detail: ok ? `已登入 · ${status.subscriptionType}` : '請在終端執行 claude auth login，選擇 Claude 訂閱帳號。' });
        } catch { resolve({ ok: false, detail: 'Claude 登入狀態讀取失敗；尚未呼叫模型。' }); }
      } else {
        const ok = !error && /Logged in using ChatGPT/i.test(stdout + stderr);
        resolve({ ok, method: ok ? 'ChatGPT 訂閱' : '未確認訂閱', detail: ok ? '已登入 · ChatGPT' : '請使用目前設定的 Codex CLI 執行 login；不接受 API key 登入。' });
      }
    });
  });
  cache.set(key, { ts: Date.now(), value });
  return value;
}

export function subscriptionArgs(cfg) {
  if (!cfg.subscriptionOnly) return [];
  if (cfg.family === 'codex') return ['-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"'];
  if (cfg.family === 'claude') return ['--settings', '{"forceLoginMethod":"claudeai","disableAllHooks":true}'];
  throw new Error('Unknown subscription CLI');
}
