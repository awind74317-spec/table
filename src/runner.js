import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { subscriptionStatus, subscriptionArgs } from './subscription.js';
import { isProfile, isolationFor, imageArgsFor, buildProfileEnv, buildManifest, cleanupProfile, discussionArgs } from './profile.js';

// 只把白名单内的变量传给子进程——API key 等敏感变量默认全部隔离。
// 注意：生产路径已改走 buildProfileEnv（profile.js），这里保留仅供测试断言旧行为。
export function buildEnv(whitelist, source = process.env) {
  const env = {};
  for (const k of whitelist) if (source[k] !== undefined) env[k] = source[k];
  return env;
}

// 从 stream-json 输出中提取最终文本：type=result 事件优先，无则回退原文
export function extractStreamText(raw) {
  let resultText = '';
  const agentParts = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const ev = JSON.parse(t);
      if (ev.type === 'result' && typeof ev.result === 'string') resultText = ev.result;
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') agentParts.push(ev.item.text);
    } catch { /* 单行坏 JSON 忽略 */ }
  }
  return resultText || agentParts.join('\n').trim() || raw.trim();
}

function parseOutput(mode, raw) {
  if (mode === 'json') {
    try {
      const j = JSON.parse(raw);
      // 依次尝试各家 CLI 的 JSON 答案位置：
      // 字符串 result/text（通用）→ payloads[].text（openclaw 嵌入路径）→ result.payloads[].text（openclaw gateway 路径）
      const fromPayloads = o => (o && Array.isArray(o.payloads)) ? o.payloads.map(p => p?.text).filter(Boolean).join('\n') : '';
      const text = (typeof j.result === 'string' && j.result)
        || (typeof j.text === 'string' && j.text)
        || fromPayloads(j)
        || fromPayloads(j.result);
      return String(text || raw).trim();
    } catch { return raw.trim(); }
  }
  if (mode === 'stream-json') return extractStreamText(raw);
  return raw.trim();
}

// 从 stream-json 单行事件中提取可展示的助手文本（claude 的 assistant 事件）。
// system/init/result 等内部事件返回空串——它们不该出现在用户眼前的发言栏里。
export function extractChunkText(line, { toolMarkers = false } = {}) {
  const t = line.trim();
  if (!t.startsWith('{')) return '';
  try {
    const ev = JSON.parse(t);
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      const parts = [];
      for (const c of ev.message.content) {
        if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
        // 动手实时可视：工具活动是"它正在干什么"的最强信号（正在改哪个文件）
        else if (toolMarkers && c.type === 'tool_use') {
          const target = c.input?.file_path ?? c.input?.pattern ?? c.input?.path ?? '';
          parts.push(`\n▸ ${c.name}${target ? ' ' + String(target).split(/[\\/]/).slice(-2).join('/') : ''}\n`);
        }
      }
      return parts.join('');
    }
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') return ev.item.text;
    if (toolMarkers && ev.type === 'item.started' && typeof ev.item?.type === 'string') {
      const target = ev.item.command ?? ev.item.path ?? '';
      return `\n▸ ${ev.item.type}${target ? ' ' + String(target).slice(0, 160) : ''}\n`;
    }
  } catch { /* 半行/坏行忽略，等缓冲齐 */ }
  return '';
}

// 从 JSONL 原始输出中提取会话 id：Claude=session_id；Codex thread.started=thread_id。
export function extractSessionId(raw) {
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t);
      if (j.session_id) return j.session_id;
      if (j.type === 'thread.started' && j.thread_id) return j.thread_id;
    } catch { /* 坏行忽略 */ }
  }
  return null;
}

// 按 adapter 配置的正则逐行过滤输出（如 hermes 的 "session_id: xxx" 前缀行）
function applyDropLines(text, dropLines) {
  if (!dropLines?.length) return text;
  const patterns = dropLines.map(p => new RegExp(p));
  return text.split('\n').filter(l => !patterns.some(re => re.test(l))).join('\n').trim();
}

const AUTH_RE = /log ?in|auth|401|unauthorized|credential|expired/i;

export async function runAgent(cfg, prompt, opts = {}) {
  const started = Date.now();
  // 架构不变量：所有模型调用必须携带显式 profile（profile.js 铸造），没有 ambient 回退。
  // 调用方也不能自带 env / cwd——环境与工作目录只能由 profile 层重新构造。
  if (!isProfile(opts.profile)) throw new Error('runAgent: 缺少显式 context profile（用 makeProfile 创建）——拒绝 ambient 环境回退');
  // 拒收非法调用时也要清理已铸 profile 的 scratch 目录，不留临时目录垃圾
  const rejectWith = msg => { cleanupProfile(opts.profile); throw new Error(msg); };
  if (cfg.external) rejectWith('GPT 網頁席位必須在官方 Chat 領取任務，不能以 CLI 自動啟動');
  if (opts.env !== undefined) rejectWith('runAgent: 不接受调用方传入 env——子进程环境由 profile 层构造');
  if (opts.cwd !== undefined) rejectWith('runAgent: 不接受调用方传入 cwd——工作目录由 profile 的 cwdPolicy 决定');
  const profile = opts.profile;
  if (opts.signal?.aborted) {
    cleanupProfile(profile);
    return { ok: false, error: 'aborted', text: '', raw: '', stderr: '', durationMs: 0 };
  }
  if (cfg.subscriptionOnly) {
    const status = await subscriptionStatus(cfg);
    if (!status.ok) {
      cleanupProfile(profile);
      return { ok: false, error: 'subscription-required: ' + status.detail, text: '', raw: '', stderr: '', durationMs: Date.now() - started };
    }
  }
  let argv = [...cfg.command];
  if (cfg.model) argv.push('--model', cfg.model);
  if (cfg.reasoningEffort) {
    if (cfg.family === 'codex') argv.push('-c', `model_reasoning_effort="${cfg.reasoningEffort}"`);
    if (cfg.family === 'claude') argv.push('--effort', cfg.reasoningEffort);
  }
  argv.push(...subscriptionArgs(cfg));
  // 追加该引擎实测验证过的隔离参数（claude: setting-sources/strict-mcp；codex: ignore-user-config）
  const iso = isolationFor(cfg, profile.cwdPolicy);
  if (iso) argv.push(...iso.args);
  argv = discussionArgs(cfg, argv, profile);
  // 图片附件：路径由调用层（服务端 uploads 目录）校验后传入，仅支持声明了 imageArgs 的引擎
  if (Array.isArray(opts.images) && opts.images.length) {
    const ia = imageArgsFor(cfg);
    if (ia) for (const img of opts.images) argv.push(...ia.map(a => (typeof a === 'string' ? a.replaceAll('{IMAGE}', img) : a)));
  }
  // argv 中 ~/ 前缀展开为用户主目录——让 agents.json 里的脚本路径跨机器可移植
  argv = argv.map(a => (typeof a === 'string' && /^~[/\\]/.test(a) ? path.join(homedir(), a.slice(1)) : a));
  let tmpDir = null;
  // {NONCE}：每次调用生成唯一串。用于要求"每次调用都是全新会话"的 CLI
  //（如 openclaw 的 --session-key roundtable-{NONCE}），保证 clean room 无记忆。
  const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  argv = argv.map(a => (typeof a === 'string' ? a.replaceAll('{NONCE}', nonce).replaceAll('{WORKSPACE}', profile.cwd) : a));
  // manifest 用的 argv 快照：在 prompt 注入 argv 之前截取——清单里不复制 prompt 正文
  const manifestArgv = [...argv];
  const childEnv = buildProfileEnv(cfg);
  if (cfg.input === 'file') {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'roundtable-'));
    const f = path.join(tmpDir, 'prompt.md');
    writeFileSync(f, prompt, 'utf8');
    if (argv.includes('{PROMPT_FILE}')) argv = argv.map(a => (a === '{PROMPT_FILE}' ? f : a));
    else argv.push(f);
  }
  if (cfg.input === 'arg') {
    // prompt 直接进 argv 的 CLI（openclaw -m / hermes -q）。Windows 命令行总长上限
    // 约 32767 字符，超限前显式报错，避免截断或诡异失败。
    if (process.platform === 'win32' && argv.join(' ').length + prompt.length > 30000) {
      cleanupProfile(profile); // 早退也要清理 scratch 目录
      return { ok: false, error: 'prompt-too-long', text: '', raw: '', stderr: '', exitCode: null, durationMs: Date.now() - started };
    }
    if (argv.includes('{PROMPT}')) argv = argv.map(a => (a === '{PROMPT}' ? prompt : a));
    else argv.push(prompt);
  }
  return await new Promise(resolve => {
    let out = '', err = '', settled = false;
    let timer;
    let onAbort;
    const cleanup = () => {
      if (tmpDir) try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      cleanupProfile(profile); // scratch 一次性目录用后即清；其余策略不清理
    };
    const finish = r => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
      const result = { raw: out, stderr: err, durationMs: Date.now() - started, ...r };
      // 每次调用落一份机器可读装配清单（context manifest）——只含变量名/哈希，无凭证值
      result.manifest = buildManifest({
        profile, cfg, argv: manifestArgv, envNames: Object.keys(childEnv).sort(),
        prompt, materials: opts.materials ?? null, capabilities: opts.capabilities ?? null, execThread: opts.execThread ?? null, result,
      });
      if (opts.manifestFile) {
        try {
          mkdirSync(path.dirname(opts.manifestFile), { recursive: true });
          writeFileSync(opts.manifestFile, JSON.stringify(result.manifest, null, 2), 'utf8');
        } catch { /* 清单落盘失败不影响调用结果（结果里仍带 manifest） */ }
      }
      cleanup();
      resolve(result);
    };
    let child;
    let stopped = null;
    const stopChild = reason => {
      if (stopped || settled) return;
      stopped = reason;
      if (process.platform === 'win32' && child?.pid) {
        // Only terminate the process tree spawned for this request.
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill('SIGKILL'));
        killer.on('close', code => { if (code !== 0) child.kill('SIGKILL'); });
      } else child.kill('SIGKILL');
    };
    try {
      // win32 下 .cmd/.bat 不能被 CreateProcess 直接执行（不是真正的 PE），
      // 需要在 spawn 时刻动态包一层 cmd /c；argv 仍是数组、shell 仍为 false，
      // prompt 仍走 stdin——不引入 shell 注入面。
      const isWinShimScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(argv[0] ?? '');
      // cmd.exe 会把参数里的换行当命令分隔符：arg 模式的 prompt（含上轮模型输出）经
      // cmd /c 传递既被截断又构成注入面——直接拒绝，提示改用真实可执行文件路径
      if (isWinShimScript && argv.some(a => typeof a === 'string' && /[\r\n]/.test(a))) {
        return finish({ ok: false, error: 'unsafe-cmd-args: .cmd/.bat 包装无法安全传递含换行的参数——请把该 CLI 的 command[0] 配为 .exe 或 node 脚本的真实路径', text: '', exitCode: null });
      }
      const [file, args] = isWinShimScript
        ? [process.env.COMSPEC ?? 'cmd.exe', ['/c', ...argv]]
        : [argv[0], argv.slice(1)];
      // env 与 cwd 均由 profile 层重新构造——cfg.cwd（旧配置遗留字段）在此被忽略
      child = spawn(file, args, {
        env: childEnv,
        cwd: profile.cwd,
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      return finish({ ok: false, error: 'spawn:' + (e.code ?? e.message), text: '', exitCode: null });
    }
    timer = setTimeout(() => {
      stopChild('timeout');
    }, cfg.timeoutMs);
    onAbort = () => {
      stopChild('aborted');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    // 按输出模式决定推给前端什么：text 原样流式；stream-json 逐行解析只推助手文本；
    // json 不推中间流（整体是一份 JSON，中间片段对人无意义，最终结果由 text 呈现）。
    let lineBuf = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => {
      const s = d.toString();
      out += s;
      if (!opts.onChunk) return;
      if (cfg.output === 'stream-json') {
        lineBuf += s;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop();
        for (const line of lines) {
          const text = extractChunkText(line, { toolMarkers: !!opts.toolMarkers });
          if (text) opts.onChunk(text);
        }
      } else if (cfg.output !== 'json') {
        opts.onChunk(s);
      }
    });
    child.stderr.on('data', d => (err += d.toString()));
    child.on('error', e => finish({ ok: false, error: 'spawn:' + (e.code ?? e.message), text: out, exitCode: null }));
    child.on('close', code => {
      if (stopped) return finish({ ok: false, error: stopped, text: '', exitCode: code });
      // Some CLIs report a failed model turn inside a successful process exit.
      const failed = out.split('\n').some(line => {
        try { const e = JSON.parse(line); return e.type === 'turn.failed' || (e.type === 'result' && e.is_error === true); }
        catch { return false; }
      });
      if (failed) {
        const detail = parseOutput(cfg.output, out);
        const error = /hit your.*limit|usage limit|rate.limit|quota/i.test(detail)
          ? '訂閱額度暫時用完：' + detail.slice(0, 240)
          : 'model-turn-failed';
        return finish({ ok: false, error, text: detail, exitCode: code });
      }
      if (code !== 0) {
        const auth = AUTH_RE.test(err + out);
        return finish({ ok: false, error: auth ? 'auth' : 'exit:' + code, text: out, exitCode: code });
      }
      const sessionId = extractSessionId(out);
      finish({
        ok: true, text: applyDropLines(parseOutput(cfg.output, out), cfg.dropLines), exitCode: 0,
        // Claude stream-json 与 Codex exec --json 都带原生线程 id，供受控续接复用。
        ...(sessionId ? { sessionId } : {}),
      });
    });
    // 子进程未读完 stdin 即退出时会在 stdin 侧 emit 'error'（EPIPE/EOF）；
    // 不监听会作为未捕获异常崩溃整个进程。这里吞掉——进程退出本身已由
    // 上面的 close 处理器归类为 exit/auth 错误，无需在这里重复处理。
    child.stdin.on('error', () => {});
    if (cfg.input === 'stdin') child.stdin.write(prompt);
    child.stdin.end();
  });
}
