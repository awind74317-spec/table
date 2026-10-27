import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir, rm, rename, mkdir, stat, copyFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { Committee } from './orchestrator.js';
import { makeProfile } from './profile.js';
import { normalizeTemplateId, writebackTemplate, MEETING_TEMPLATE_IDS } from './capabilities.js';
import { Workbench, loadWorkbenchFromDisk, withSeatAgents, reasoningEfforts } from './workbench.js';
import { loadTemplates } from './templates.js';
import { resolveCliPath } from './resolve.js';
import { redact } from './redactor.js';
import { runAgent } from './runner.js';
import { subscriptionStatus } from './subscription.js';
import { GptBrowser, validChatUrl } from './gpt-browser.js';
import { normalizeRemoteAccess, requestAccess } from './remote-access.js';

// 上传文件名清洗（跨平台）：path.basename 依赖运行平台——在 Linux(posix) 上 `\` 不是分隔符，
// 会放过 Windows 风格穿越名（..\..\x 整段留下）。这里平台无关地同时按 / 和 \ 切分取最后一段，
// 去危险字符、把连续点收敛为一个、剥掉前导点，确保结果永远是纯基名、绝不残留 `..`。
export function safeUploadBasename(rawName) {
  return String(rawName ?? '')
    .split(/[\\/]/).pop()               // 同时认 / 和 \，取最后一段（= 平台无关的 basename）
    .replace(/[<>:"/\\|?* -]/g, '_')    // 文件系统不安全字符 → _
    .replace(/\.{2,}/g, '.')            // 连续点收敛为单个点，消灭 .. 残留
    .replace(/^\.+/, '')                // 去前导点，杜绝 . / .. / 隐藏文件名
    .slice(-120);
}

// 静态文件白名单（无通用静态服务，杜绝路径穿越）
const STATIC = {
  '/': ['public/desk.html', 'text/html'],
  '/advanced': ['public/index.html', 'text/html'],
  '/desk.css': ['public/desk.css', 'text/css'],
  '/desk.js': ['public/desk.js', 'text/javascript'],
  '/style.css': ['public/style.css', 'text/css'],
  '/i18n.js': ['public/i18n.js', 'text/javascript'],
  '/app-core.js': ['public/app-core.js', 'text/javascript'],
  '/app-committee.js': ['public/app-committee.js', 'text/javascript'],
  '/handoff-clipboard.js': ['public/handoff-clipboard.js', 'text/javascript'],
  '/app-workbench.js': ['public/app-workbench.js', 'text/javascript'],
  '/app-sidebar.js': ['public/app-sidebar.js', 'text/javascript'],
  '/app-boot.js': ['public/app-boot.js', 'text/javascript'],
};

let pickInFlight = false;
let pickChild = null; // 当前原生对话框子进程；取消端点据此终结它并放开 pickInFlight

const HANDOFF_SHORTCUT_NAMES = Object.freeze({
  claude: new Set(['claude.lnk', 'claude desktop.lnk']),
  codex: new Set(['codex.lnk', 'openai codex.lnk']),
});

async function findHandoffShortcut(provider) {
  if (process.platform !== 'win32' || !HANDOFF_SHORTCUT_NAMES[provider]) return null;
  const roots = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
    process.env.PROGRAMDATA ? path.join(process.env.PROGRAMDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : null,
  ].filter(Boolean);
  const queue = roots.map(dir => ({ dir, depth: 0 }));
  let inspected = 0;
  while (queue.length && inspected < 5000) {
    const current = queue.shift();
    let entries = [];
    try { entries = await readdir(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      inspected++;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < 5) queue.push({ dir: full, depth: current.depth + 1 });
      else if (entry.isFile() && HANDOFF_SHORTCUT_NAMES[provider].has(entry.name.toLowerCase())) return full;
    }
  }
  return null;
}

const WINDOWS_FOLDER_PICKER_SCRIPT = `$ErrorActionPreference = 'Stop'
$shown = $false
try {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  Add-Type -Namespace RTWin -Name Api -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
'
  $dlg = New-Object System.Windows.Forms.OpenFileDialog
  $dlg.Title = $env:RT_PICK_TITLE
  $dlg.ValidateNames = $false
  $dlg.CheckFileExists = $false
  $dlg.CheckPathExists = $true
  $dlg.FileName = $env:RT_PICK_PLACEHOLDER
  if ($env:RT_PICK_START -and (Test-Path -LiteralPath $env:RT_PICK_START)) { $dlg.InitialDirectory = $env:RT_PICK_START }
  $script:fgDone = $false
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 250
  $timer.Add_Tick({
    if ($script:fgDone) { return }
    $h = [RTWin.Api]::FindWindowW('#32770', $env:RT_PICK_TITLE)
    if ($h -ne [IntPtr]::Zero) {
      $script:fgDone = $true
      [RTWin.Api]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003) | Out-Null
      [RTWin.Api]::SetForegroundWindow($h) | Out-Null
    }
  })
  $timer.Start()
  $result = $dlg.ShowDialog()
  $timer.Stop()
  $shown = $true
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    $picked = [System.IO.Path]::GetDirectoryName($dlg.FileName)
    if ($picked -and (Test-Path -LiteralPath $picked -PathType Container)) { Write-Output $picked; exit 0 }
  }
  exit 2
} catch {
  if ($shown) { exit 3 }
  try {
    $fb = New-Object System.Windows.Forms.FolderBrowserDialog
    if ($env:RT_PICK_START) { $fb.SelectedPath = $env:RT_PICK_START }
    if ($fb.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $fb.SelectedPath; exit 0 }
    exit 2
  } catch { exit 3 }
}
`;

const runFolderDialogProcess = (command, args, options = {}) => new Promise(resolve => {
  let child;
  let stdout = '';
  let settled = false;
  let timedOut = false;
  let timer;
  const finish = result => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (pickChild === child) pickChild = null;
    resolve({ stdout, timedOut, ...result });
  };
  try {
    child = spawn(command, args, options);
    pickChild = child; // 供 /api/pick-folder/cancel 终结：对话框万一没能到前台，用户可自救
  } catch (error) {
    resolve({ stdout, timedOut, spawnError: error });
    return;
  }
  timer = setTimeout(() => {
    timedOut = true;
    try { child.kill(); } catch { finish({ code: null }); }
  }, 5 * 60 * 1000);
  timer.unref?.();
  child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr?.resume();
  child.once('error', error => finish({ spawnError: error }));
  child.once('close', code => finish({ code }));
});

// 用户常直接粘贴 Windows「复制文件地址」的结果(首尾带引号),或带首尾空白。
// 统一在入口处剥掉,避免出现「路径不存在」这种误导性报错。
export function normalizeFsPath(raw) {
  let s = String(raw ?? '').trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) s = s.slice(1, -1).trim();
  return s;
}

const isDir = p => {
  try { return existsSync(p) && statSync(p).isDirectory(); }
  catch { return false; }
};

const workspacePathError = (workspace, lang = 'zh') => {
  if (!workspace || isDir(workspace)) return null;
  if (!existsSync(workspace)) return {
    error: lang === 'en'
      ? 'Path not found: ' + workspace + '. Check the spelling, or click "Browse…" to pick a folder.'
      : '找不到这个路径：' + workspace + '。请检查是否输入正确，或点「浏览…」直接选择文件夹',
  };
  const parent = path.dirname(workspace);
  return {
    error: lang === 'en'
      ? 'This is a file, not a folder: ' + workspace + '. Use the folder that contains it instead.'
      : '这是一个文件，不是文件夹：' + workspace + '。请改用它所在的文件夹',
    ...(isDir(parent) ? { suggest: parent } : {}),
  };
};

// 按会话派生 agent 配置：挂载工作区（项目目录只读访问）时，cwd 指向项目根，
// 且配置了 workspaceArgs 的 adapter 换用只读工具集参数（如 claude 放开 Read/Grep/Glob）。
// 深拷贝，绝不污染全局 adapter 配置。
export function deriveSessionAgents(agents, ids, workspace) {
  const out = {};
  for (const id of new Set(ids)) {
    const a = structuredClone(agents[id]);
    if (workspace) {
      // contextRoot 不是 cwd 直传：调用层据此选 readonly-materials 策略并经 makeProfile
      // 校验后才成为子进程工作目录（runner 忽略旧配置里的 cfg.cwd 字段）
      a.contextRoot = workspace;
      if (a.workspaceArgs) a.command = [a.command[0], ...a.workspaceArgs];
    }
    out[id] = a;
  }
  return out;
}

// 同桌只派發討論席位；歷史施工設定不再授予寫入能力。
export function deriveWriteAgents(agents, ids) {
  return {};
}

export async function startServer({ port = 7777, agentsFile = 'adapters/agents.json', templatesDir = 'templates', sessionsDir = 'sessions', capTemplatesFile = 'adapters/meeting-templates.json', gptBrowser = new GptBrowser(), remoteAccess = null } = {}) {
  const mobileAccess = normalizeRemoteAccess(remoteAccess);
  // 「前端新后端旧」错配检测：前端文件按请求现读、后端代码进程启动时定格。
  // src/*.js 磁盘 mtime 晚于进程启动 → 下发 stale 标记，前端亮「重启生效」横幅。
  const serverStartedMs = Date.now();
  const backendStale = async () => {
    try {
      for (const f of await readdir('src')) {
        if (!f.endsWith('.js')) continue;
        const { mtimeMs } = await stat(path.join('src', f));
        if (mtimeMs > serverStartedMs) return true;
      }
    } catch { /* 探测失败按不陈旧处理 */ }
    return false;
  };
  if (!existsSync(agentsFile)) {
    const exampleFile = path.join(path.dirname(agentsFile), 'agents.example.json');
    if (existsSync(exampleFile)) {
      await copyFile(exampleFile, agentsFile);
      console.log(`[config] 已从 agents.example.json 生成 ${agentsFile}`);
    }
  }
  const agents = JSON.parse(await readFile(agentsFile, 'utf8'));
  // 启动与热重载共用同一加载路径：解析失败不阻塞服务，只标记该 agent 不可用。
  const loadAgents = configuredAgents => {
    configuredAgents.gpt = { name: 'GPT · 網頁', family: 'gpt-web', external: true, models: [] };
    for (const [id, a] of Object.entries(configuredAgents)) {
      delete a.unavailable;
      if (a.external) continue;
      try {
        if (a.disabled) throw new Error(a.disabled); // 手工禁用（已知运行时必失败的 agent，修好后删 disabled 字段即恢复）
        a.command[0] = resolveCliPath(a);
        // 配置里的相对脚本路径在装载时冻结为绝对路径：子进程 cwd 由 profile 策略决定
        //（scratch＝临时目录），不能再指望相对路径恰好从服务目录解析得到
        a.command = a.command.map(arg =>
          (typeof arg === 'string' && !arg.startsWith('-') && !path.isAbsolute(arg) && /[\\/]/.test(arg) && existsSync(arg))
            ? path.resolve(arg) : arg);
        console.log(`[adapter] ${id} -> ${a.command[0]}`);
      } catch (e) {
        a.unavailable = String(e.message);
        console.warn(`[adapter] ${id} 不可用: ${e.message}`);
      }
    }
  };
  loadAgents(agents);
  const templates = await loadTemplates(templatesDir);
  // 就绪检查（状态灯）：启动时的路径解析只能发现「找不到 CLI」，auth 过期等运行时故障
  // 要真调用一次才暴露。结果存内存（重启清零），随 /api/config 下发供前端亮灯。
  const smokeStatus = {}; // agentId -> { ok, error?, durationMs, ts }
  const smokeInflight = new Set();
  const publicAgents = () => Object.fromEntries(Object.entries(agents).map(([id, a]) => [id, {
    name: a.name,
    family: a.family,
    model: a.model ?? '',
    models: a.models ?? [],
    reasoningEfforts: reasoningEfforts(a),
    roles: Array.isArray(a.roles) ? a.roles : [],
    write: false,
    readOnly: true,
    external: !!a.external,
    bin: a.command?.[0] ?? '',
    ...(a.unavailable ? { unavailable: a.unavailable } : {}),
    ...(smokeStatus[id] ? { smoke: smokeStatus[id] } : {}),
  }]));
  const sessions = new Map();
  const benches = new Map(); // 工作台会话（与委员会平行的顶层类型）：{ bench, events, clients, updatedAt }
  const externalResumes = new Map();
  const drafts = new Map(); // 外部 AI（项目对话侧）预填的议题+简报草稿，浏览器 #draft=<id> 打开即填入表单

  // 统一的事件发射器（委员会与工作台共用一套语义，杜绝两套回放代码漂移）：
  // - 纯瞬态流（build-progress）只发给在线客户端，绝不进回放缓冲——否则长命工作台
  //   积累几十次动手的流式碎片会无界增长、重连越来越慢
  // - 其余事件进缓冲供重连回放；缓冲总量硬上限，超限丢最旧（骨架事件由磁盘状态兜底重建）
  const TRANSIENT = new Set(['build-progress', 'chat-chunk']);
  const EVENT_BUFFER_CAP = 4000;
  const attachEmit = entry => {
    entry.emit = rawEv => {
      entry.updatedAt = new Date().toISOString();
      // 展示层统一脱敏：落盘各处已过 redact，但 SSE 直达前端（进而进录屏/截图）这条路此前是裸的。
      // 模型转述的 worktree/临时目录绝对路径（含用户名）、凭据样式字符串都在这里擦掉；
      // redact 对 JSON 串安全（messages.jsonl 同样 redact 后回读解析，已有先例）。
      const ev = JSON.parse(redact(JSON.stringify(rawEv)));
      if (!TRANSIENT.has(ev.type)) {
        entry.events.push(ev);
        if (entry.events.length > EVENT_BUFFER_CAP) entry.events.splice(0, entry.events.length - EVENT_BUFFER_CAP);
      }
      const line = `data: ${JSON.stringify(ev)}\n\n`;
      for (const c of entry.clients) { try { c.write(line); } catch { entry.clients.delete(c); } }
    };
    return entry;
  };
  const sendPendingGpt = async entry => {
    if (entry.bench.externalTask?.kind === 'build') throw new Error('同桌僅提供唯讀討論；舊施工任務不會送出。');
    const b = entry.bench;
    const task = b?.externalSummary();
    if (!task || task.status !== 'waiting') throw new Error('NO_WAITING_GPT_TASK');
    const isCurrent = () => b.externalTask?.taskId === task.taskId && b.externalTask.status === 'waiting' && !b.stopped;
    entry.emit({ type: 'external-send', taskId: task.taskId, status: 'sending' });
    try {
      const result = await gptBrowser.send({ chatUrl: b.chatUrlFor(task.agentId), taskId: task.taskId, text: task.launchText, isCurrent,
        onChatUrl: async chatUrl => {
          if (!validChatUrl(chatUrl)) throw new Error('CHAT_URL_INVALID');
          if (b.externalTask?.taskId !== task.taskId) throw new Error('GPT_TASK_CHANGED');
          const current = b.chatUrlFor(task.agentId);
          if (current && current !== chatUrl) throw new Error('GPT_CONNECTION_CHANGED');
          if (b.participants.some(id => id !== task.agentId && b.chatUrlFor(id) === chatUrl)) throw new Error('GPT_CONNECTION_CHANGED');
          // This is the first task in this Chat; preserve any claim/delivery cursor already acknowledged.
          if (task.agentId === 'gpt') b.gptChatUrl = chatUrl;
          else b.seatSettings[task.agentId] = { ...b.seatSettings[task.agentId], chatUrl };
          await b.saveMeta();
          entry.emit({ type: 'gpt-connection', agentId: task.agentId, chatUrl });
        } });
      entry.emit({ type: 'external-send', taskId: task.taskId, status: 'sent' });
      return result;
    } catch (error) {
      entry.emit({ type: 'external-send', taskId: task.taskId, status: 'error', error: error.message });
      throw error;
    }
  };
  const newBenchEntry = () => {
    const entry = attachEmit({ events: [], clients: new Set(), updatedAt: new Date().toISOString() });
    const emit = entry.emit;
    entry.emit = event => {
      emit(event);
      if (event.type === 'external-task' && event.data?.status === 'waiting'
          && entry.gptDispatchTaskId !== event.data.taskId) {
        entry.gptDispatchTaskId = event.data.taskId;
        void sendPendingGpt(entry).catch(() => {}); // Error is visible; never retry an unknown send automatically.
      }
    };
    return entry;
  };

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  const MAX_BODY_BYTES = 1024 * 1024; // 1MB 上限，防止无界内存增长
  const readBody = req => new Promise(r => {
    let b = ''; let bytes = 0; let done = false;
    req.on('data', d => {
      if (done) return;
      bytes += d.length;
      if (bytes > MAX_BODY_BYTES) { done = true; req.destroy(); r({}); return; }
      b += d;
    });
    req.on('end', () => { if (done) return; done = true; try { r(JSON.parse(b || '{}')); } catch { r({}); } });
  });

  // 软删除：移入 sessions/.trash/（可手工找回），绝不物理抹除会议记录
  const moveToTrash = async dir => {
    const trashDir = path.join(sessionsDir, '.trash');
    await mkdir(trashDir, { recursive: true });
    await rename(dir, path.join(trashDir, path.basename(dir) + '-' + Date.now().toString(36)));
  };

  // 活动工作台查找 + 从磁盘装配（resume 路由 / 裁决投放 / 自动落卡共用）
  const findActiveBenchId = dirname => {
    for (const [bid, e] of benches.entries()) if (e.bench.dir && path.basename(e.bench.dir) === dirname) return bid;
    return null;
  };
  const resumeBenchFromDisk = async dirname => {
    let entries = [];
    try { entries = (await readdir(sessionsDir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); } catch { /* 无目录 */ }
    if (!entries.includes(dirname)) throw new Error('归档不存在'); // 白名单精确匹配，杜绝路径穿越
    const dir = path.join(sessionsDir, dirname);
    const { meta, messages, builds } = await loadWorkbenchFromDisk(dir);
    const seatAgents = withSeatAgents(agents, meta.seatSettings);
    const participants = (meta.participants ?? []).filter(x => seatAgents[x]);
    if (!participants.length) throw new Error('该工作台的参与模型已全部从配置中移除');
    const wbWorkspace = String(meta.workspace ?? '');
    const entry = newBenchEntry();
    const bench = await Workbench.resume({
      name: String(meta.topic ?? '').replace(/^\[工作台\] /, ''), agents: deriveSessionAgents(seatAgents, participants, wbWorkspace),
      participants, baseDir: sessionsDir, emit: ev => entry.emit(ev), dir, messages,
      workspace: wbWorkspace, writeAgents: deriveWriteAgents(seatAgents, participants), builds,
      buildSessions: meta.buildSessions ?? {}, chatSessions: meta.chatSessions ?? {}, models: meta.models ?? {}, execPackages: meta.execPackages ?? {},
      externalTask: meta.externalTask ?? null, externalCursor: meta.externalCursor ?? null,
      gptChatUrl: validChatUrl(meta.gptChatUrl) ? meta.gptChatUrl : '',
      seatSettings: meta.seatSettings ?? {}, externalCursors: meta.externalCursors ?? {},
      chairId: meta.chairId ?? null,
      relayOrder: meta.relayOrder ?? participants, lastDiscussion: meta.lastDiscussion ?? null,
      currentExecutionPackageId: meta.currentExecutionPackageId ?? null,
      copyLog: meta.copyLog ?? [], handoffInvalidations: meta.handoffInvalidations ?? [],
      lang: meta.lang === 'en' ? 'en' : 'zh', perms: meta.perms ?? {},
      caps: meta.caps ?? null, // 老会话无 caps → 默认 basic_strategy（兼容）
      capFiles: { templatesFile: capTemplatesFile },
    });
    entry.bench = bench;
    await bench.saveMeta();
    // 合成事件回放：重建聊天记录（含动手 diff 卡片——patch 从会话目录读回）
    for (const msg of messages) {
      let build;
      if (msg.build) {
        const rec = builds.find(x => x.buildId === msg.build);
        if (rec) {
          let patch = '';
          try { patch = (await readFile(bench.patchPathOf(msg.build), 'utf8')).slice(0, 200000); } catch { /* patch 文件缺失则只展示统计 */ }
          build = { buildId: rec.buildId, stat: rec.stat, status: rec.status, ...(rec.files ? { files: rec.files } : {}), patch };
        }
      }
      entry.events.push({ type: 'chat-message', seq: msg.seq, from: msg.from, name: msg.name, ts: msg.ts, sync: msg.sync, ...(msg.from === 'user' && msg.toNames ? { to: msg.toNames } : {}), data: msg.text, ...(msg.ctx ? { ctx: msg.ctx } : {}), ...(msg.meeting ? { meeting: msg.meeting } : {}), ...(msg.attachments ? { attachments: msg.attachments } : {}), ...(build ? { build } : {}) });
    }
    entry.events.push({ type: 'state', data: bench.state });
    if (bench.externalTask) entry.events.push({ type: 'external-task', data: bench.externalSummary() });
    const id = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    benches.set(id, entry);
    return id;
  };

  // 把裁决卡作为消息贴进目标工作台（活动的直接用，归档的从磁盘恢复）
  const postVerdictToBench = async (c, targetDirname, card) => {
    const benchId = findActiveBenchId(targetDirname) ?? await resumeBenchFromDisk(targetDirname);
    const b = benches.get(benchId).bench;
    await b.note(
      b.lang === 'en'
        ? '[Verdict] From meeting "' + c.topic + '"\n\n' + card.trim()
        : '【会议裁决】来自会议「' + c.topic + '」\n\n' + card.trim(),
      { meeting: { dir: path.basename(c.dir), topic: c.topic, kind: 'verdict', role: 'judge', outputType: 'verdict', verdictVersion: c.verdictVersions.at(-1)?.version ?? 1, verdictState: c.verdictStatus ?? 'current' } },
    );
    return benchId;
  };

  // 辩手发言落回来源工作台：kind='statement'，收起态卡片（时间线保持紧凑，正文进对话上下文）
  const postStatementToBench = async (c, targetDirname, ev) => {
    const benchId = findActiveBenchId(targetDirname) ?? await resumeBenchFromDisk(targetDirname);
    const b = benches.get(benchId).bench;
    await b.note(
      b.lang === 'en'
        ? `[Meeting statement] Round ${ev.round} · ${ev.name} in "${c.topic}"\n\n` + String(ev.data ?? '').trim()
        : `【会议发言】「${c.topic}」第 ${ev.round} 轮 · ${ev.name}\n\n` + String(ev.data ?? '').trim(),
      { meeting: { dir: path.basename(c.dir), topic: c.topic, kind: 'statement', round: ev.round, speaker: ev.name, role: 'debater', outputType: 'statement' } },
    );
    return benchId;
  };

  // 轮次小结落回来源工作台：与裁决卡同一管道，kind='round'（前端渲染为可展开的进展卡）
  const postRoundSummaryToBench = async (c, targetDirname, round, summaryText) => {
    const benchId = findActiveBenchId(targetDirname) ?? await resumeBenchFromDisk(targetDirname);
    const b = benches.get(benchId).bench;
    await b.note(
      b.lang === 'en'
        ? `[Meeting update] Round ${round} summary from "${c.topic}"\n\n` + String(summaryText ?? '').trim()
        : `【会议进展】「${c.topic}」第 ${round} 轮小结\n\n` + String(summaryText ?? '').trim(),
      { meeting: { dir: path.basename(c.dir), topic: c.topic, kind: 'round', round, role: 'scribe', outputType: 'summary' } },
    );
    return benchId;
  };

  // 统一容器（方案 A 第一期）：会议是工作台时间线里的事件——裁决卡产出即自动落回来源工作台，
  // 不再需要手动「回流」。重跑裁决会再次落卡（以最新为准）。恢复回放走 events.push 不经 emit，不会误触。
  const attachAutoVerdictFlow = entry => {
    const orig = entry.emit;
    entry.emit = ev => {
      orig(ev);
      if (ev.type === 'judge-card' && entry.committee?.origin) {
        postVerdictToBench(entry.committee, entry.committee.origin, ev.data)
          .catch(e => orig({ type: 'sys', data: (entry.committee.lang === 'en' ? 'Auto-post of the verdict to the source workbench failed: ' : '裁决卡自动落回来源工作台失败：') + String(e.message ?? e) }));
      }
      // 每轮书记小结同样落回：没走到裁决就回到对话时，会议内容也已在时间线里
      //（既给用户看，也进对话上下文——此后在对话里让模型总结/引用会议内容才有据可依）
      if (ev.type === 'summary' && entry.committee?.origin) {
        postRoundSummaryToBench(entry.committee, entry.committee.origin, ev.round, ev.data)
          .catch(e => orig({ type: 'sys', data: (entry.committee.lang === 'en' ? 'Auto-post of the round summary to the source workbench failed: ' : '轮次小结自动落回来源工作台失败：') + String(e.message ?? e) }));
      }
      // 辩手发言逐段落回：不等整轮完成——半轮弃会也不丢内容
      if (ev.type === 'statement' && entry.committee?.origin) {
        postStatementToBench(entry.committee, entry.committee.origin, ev)
          .catch(e => orig({ type: 'sys', data: (entry.committee.lang === 'en' ? 'Auto-post of the statement to the source workbench failed: ' : '会议发言自动落回来源工作台失败：') + String(e.message ?? e) }));
      }
    };
    return entry;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const access = requestAccess(req, mobileAccess);
      if (access.error) return json(res, 403, { error: access.error });
      const origin = req.headers.origin;
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/advanced' && req.method === 'GET') {
        res.writeHead(302, { location: '/' }); res.end(); return;
      }
      const constructionRoute = /^\/api\/workbenches\/[^/]+\/(?:build(?:\/|$)|builds(?:\/|$)|exec-package(?:\/|$)|handoff-(?:copy-log|launch)(?:\/|$)|conflict-merge(?:\/|$)|capabilities(?:\/|$)|role(?:\/|$))/.test(url.pathname)
        || /^\/api\/gpt\/(?:write|test)$/.test(url.pathname)
        || (url.pathname === '/api/agents/raw' && req.method === 'POST');
      if (constructionRoute) return json(res, 403, { code: 'READ_ONLY_DISCUSSION', error: '同桌僅提供唯讀討論。需要施工時，請把討論結論帶回 Codex／Claude 桌面版。' });
      const browserAction = url.pathname.startsWith('/api/gpt-browser/') || url.pathname.endsWith('/gpt-send')
        || /^\/api\/workbenches\/[a-z0-9]+\/(message|relay|build)$/.test(url.pathname);
      if (browserAction && origin && origin !== access.origin) return json(res, 403, { error: 'forbidden origin' });
      if (url.pathname === '/api/gpt-browser/status' && req.method === 'GET') {
        return json(res, 200, await gptBrowser.status(url.searchParams.get('chatUrl') || ''));
      }
      if (url.pathname === '/api/gpt-browser/open' && req.method === 'POST') {
        const body = await readBody(req);
        try { return json(res, 200, await gptBrowser.open(body.chatUrl || 'https://chatgpt.com/')); }
        catch (error) { return json(res, 409, { error: error.message }); }
      }
      // 静态文件（白名单，无路径穿越面）
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        try {
          const data = await readFile(file);
          // no-cache：本地应用不需要浏览器缓存。否则 HTML/JS 可能一新一旧（浏览器启发式缓存），
          // 曾致按钮文案空白等「幽灵 UI」——同一页面上跑着两个版本的前端
          res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-cache' });
          return res.end(data);
        } catch { return json(res, 404, { error: 'not found' }); }
      }
      // 自救通道：对话框若没能到前台（后台进程的 GUI 可能被前台锁挡住），
      // 用户可从界面取消，终结子进程并放开 pickInFlight，无需重启服务。
      if (url.pathname === '/api/pick-folder/cancel' && req.method === 'POST') {
        const had = !!pickChild;
        try { pickChild?.kill(); } catch { /* 已退出 */ }
        pickChild = null;
        pickInFlight = false; // 兜底：即便子进程已消失也放开锁
        return json(res, 200, { ok: true, killed: had });
      }
      if (url.pathname === '/api/pick-folder' && req.method === 'POST') {
        const body = await readBody(req);
        const pickLang = body.lang === 'en' ? 'en' : 'zh';
        if (pickInFlight) {
          return json(res, 409, { error: pickLang === 'en' ? 'A folder dialog is already open' : '已有一个选择窗口打开' });
        }
        pickInFlight = true;
        let pickScriptPath = '';
        try {
          const requestedStart = normalizeFsPath(body.start);
          const start = requestedStart && path.isAbsolute(requestedStart) ? requestedStart : '';
          let result;
          try {
            if (process.platform === 'win32') {
              pickScriptPath = path.join(tmpdir(), `roundtable-folder-picker-${randomUUID()}.ps1`);
              await writeFile(pickScriptPath, WINDOWS_FOLDER_PICKER_SCRIPT, 'utf8');
              result = await runFolderDialogProcess(
                'powershell.exe',
                ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', pickScriptPath],
                {
                  env: {
                    ...process.env,
                    RT_PICK_START: start ?? '',
                    RT_PICK_TITLE: pickLang === 'en'
                      ? 'Choose project folder — open the folder you want'
                      : '选择项目文件夹——进入目标文件夹后点『打开』',
                    RT_PICK_PLACEHOLDER: pickLang === 'en' ? 'Use this folder' : '选择此文件夹',
                  },
                  windowsHide: false,
                },
              );
            } else if (process.platform === 'darwin') {
              result = await runFolderDialogProcess('osascript', ['-e', 'POSIX path of (choose folder)']);
            } else {
              result = await runFolderDialogProcess('zenity', ['--file-selection', '--directory']);
            }
          } catch (error) {
            result = { spawnError: error, stdout: '', timedOut: false };
          }

          if (result.timedOut) return json(res, 200, { canceled: true });
          if (result.spawnError) {
            return json(res, 200, {
              unsupported: true,
              error: pickLang === 'en'
                ? 'Native dialog unavailable; falling back to the built-in picker'
                : '系统对话框不可用，已切换到内置选择器',
            });
          }
          const selectedPath = String(result.stdout ?? '').replace(/^\uFEFF/, '').trim();
          if (result.code === 0 && selectedPath) {
            if (isDir(selectedPath)) return json(res, 200, { ok: true, path: selectedPath });
            return json(res, 200, { error: pickLang === 'en' ? 'Not a valid folder' : '不是有效的文件夹' });
          }
          if (result.code === 0) {
            return json(res, 200, { error: pickLang === 'en' ? 'Not a valid folder' : '不是有效的文件夹' });
          }
          if (result.code === 2 || process.platform !== 'win32') return json(res, 200, { canceled: true });
          return json(res, 200, {
            unsupported: true,
            error: pickLang === 'en'
              ? 'Native dialog unavailable; falling back to the built-in picker'
              : '系统对话框不可用，已切换到内置选择器',
          });
        } finally {
          if (pickScriptPath) {
            try { await rm(pickScriptPath, { force: true }); } catch { /* 临时脚本清理失败不覆盖选择结果 */ }
          }
          pickInFlight = false;
        }
      }
      if (url.pathname === '/api/browse' && req.method === 'GET') {
        const requestedPath = normalizeFsPath(url.searchParams.get('path'));
        if (process.platform === 'win32' && requestedPath === ':drives:') {
          const dirs = [];
          for (let code = 65; code <= 90; code++) {
            const drive = String.fromCharCode(code) + ':\\';
            if (existsSync(drive)) dirs.push(drive);
          }
          return json(res, 200, { ok: true, path: '', parent: '', dirs });
        }
        const browsePath = path.resolve(requestedPath || homedir());
        const browseLang = url.searchParams.get('lang') === 'en' ? 'en' : 'zh';
        const browsePathError = workspacePathError(browsePath, browseLang);
        if (browsePathError) return json(res, 200, browsePathError);
        let names;
        try { names = await readdir(browsePath); }
        catch { return json(res, 200, { error: browseLang === 'en' ? 'Not a valid folder' : '不是有效的文件夹' }); }
        const dirs = [];
        for (const name of names) {
          try {
            if (statSync(path.join(browsePath, name)).isDirectory()) dirs.push(name);
          } catch { /* 无权限或条目已消失：跳过 */ }
        }
        dirs.sort((a, b) => a.localeCompare(b));
        return json(res, 200, {
          ok: true,
          path: browsePath,
          parent: path.dirname(browsePath),
          dirs: dirs.slice(0, 500),
        });
      }
      if (url.pathname === '/api/agents/raw' && req.method === 'GET') {
        try { return json(res, 200, { ok: true, content: await readFile(agentsFile, 'utf8') }); }
        catch (e) { return json(res, 200, { error: String(e.message ?? e) }); }
      }
      if (url.pathname === '/api/agents/raw' && req.method === 'POST') {
        const body = await readBody(req);
        const content = typeof body.content === 'string' ? body.content : '';
        let nextAgents;
        try { nextAgents = JSON.parse(content); }
        catch (e) { return json(res, 400, { error: 'JSON 解析失败: ' + String(e.message ?? e) }); }
        if (!nextAgents || typeof nextAgents !== 'object' || Array.isArray(nextAgents)) {
          return json(res, 400, { error: '配置无效：顶层必须是对象' });
        }
        for (const [key, a] of Object.entries(nextAgents)) {
          const valid = a && typeof a === 'object' && !Array.isArray(a)
            && typeof a.name === 'string' && !!a.name.trim()
            && Array.isArray(a.command) && a.command.length > 0
            && a.command.every(part => typeof part === 'string') && !!a.command[0].trim();
          if (!valid) return json(res, 400, { error: `agent「${key}」配置无效：需要 name 与非空 command 数组` });
        }
        await writeFile(agentsFile, content, 'utf8');
        const reloadedAgents = JSON.parse(content);
        for (const key of Object.keys(agents)) delete agents[key];
        Object.assign(agents, reloadedAgents);
        loadAgents(agents);
        for (const key of Object.keys(smokeStatus)) if (!agents[key]) delete smokeStatus[key];
        return json(res, 200, { ok: true, agents: publicAgents() });
      }
      if (url.pathname === '/api/subscriptions' && req.method === 'GET') {
        const result = await Promise.all(Object.entries(agents).filter(([, cfg]) => !cfg.external).map(async ([id, cfg]) => [id, await subscriptionStatus(cfg, { fresh: true })]));
        return json(res, 200, Object.fromEntries(result));
      }
      if (url.pathname === '/api/config') {
        // 只额外暴露诊断所需的可执行路径，不泄漏 command 参数、envWhitelist 等 adapter 细节
        const tpl = Object.fromEntries(Object.entries(templates).map(([n, t]) => [n, {
          title: t.title,
          debaterFormat: t.debaterFormat,
          judgeFormat: t.judgeFormat,
          roleBriefs: t.roleBriefs,
        }]));
        // 会议模板（能力授权装配）：只下发安全元数据供选择器渲染
        let capTemplates = {};
        try {
          const { loadCapabilityConfig } = await import('./capabilities.js');
          const capCfg = loadCapabilityConfig({ templatesFile: capTemplatesFile });
          capTemplates = Object.fromEntries(Object.entries(capCfg.templates).map(([tid, t]) => [tid, {
            title: t.title, version: t.version,
            enabled: (t.enabled ?? []).map(cid => ({ id: cid, name: capCfg.catalog[cid]?.name, summary: capCfg.catalog[cid]?.summary, risk: capCfg.catalog[cid]?.risk })),
            recommendable: (t.recommendable ?? []).map(cid => ({ id: cid, name: capCfg.catalog[cid]?.name, summary: capCfg.catalog[cid]?.summary, risk: capCfg.catalog[cid]?.risk })),
            permissions: t.permissions ?? {},
          }]));
        } catch { /* 模板文件损坏不阻塞 config——前端选择器降级隐藏 */ }
        return json(res, 200, { product: 'aos-same-table', discussionOnly: true, agents: publicAgents(), templates: tpl, capTemplates, stale: await backendStale(), mobileUrl: mobileAccess?.origin || '', remote: access.remote });
      }
      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        const activeDirs = new Set([
          ...[...sessions.values()].map(e => e.committee.dir && path.basename(e.committee.dir)),
          ...[...benches.values()].map(e => e.bench.dir && path.basename(e.bench.dir)),
        ].filter(Boolean));
        const active = [...sessions.entries()].map(([id, entry]) => ({
          id, topic: entry.committee.topic, state: entry.committee.state, round: entry.committee.round,
          archived: false, updatedAt: entry.updatedAt, origin: entry.committee.origin || '', // 母子分组：会议挂在来源工作台下
          dirname: entry.committee.dir ? path.basename(entry.committee.dir) : '',
        }));
        const activeBenches = [...benches.entries()].map(([id, entry]) => ({
          id, topic: '[工作台] ' + (entry.bench.name || (entry.bench.lang === 'en' ? 'unnamed' : '未命名')), state: entry.bench.state,
          round: entry.bench.messages.length, archived: false, updatedAt: entry.updatedAt, type: 'workbench',
          dirname: entry.bench.dir ? path.basename(entry.bench.dir) : '', // 裁决卡投放等按目录名寻址的操作用
          pending: entry.bench.builds.filter(b => b.status === 'pending').length, // 待批 diff 数
        }));
        let archived = [];
        try {
          const dirents = await readdir(sessionsDir, { withFileTypes: true });
          for (const d of dirents) {
            if (!d.isDirectory() || activeDirs.has(d.name)) continue;
            let meta;
            try { meta = JSON.parse(await readFile(path.join(sessionsDir, d.name, 'metadata.json'), 'utf8')); }
            catch { continue; } // 无 metadata.json（非会话目录）跳过
            archived.push({ id: d.name, topic: meta.topic, state: meta.status, round: meta.rounds, archived: true, explicitlyArchived: meta.archived === true, updatedAt: meta.updatedAt, origin: String(meta.origin ?? ''), ...(meta.type ? { type: meta.type } : {}) });
          }
        } catch { /* sessionsDir 尚不存在 */ }
        archived.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))); // 归档按最近更新在前
        return json(res, 200, [...active, ...activeBenches, ...archived]);
      }
      // 就绪检查：对单个 agent 做一次真实最小调用（验证 CLI 可启动 + 登录态有效）。
      // 由用户在界面上显式触发——每次消耗一次真实额度，绝不自动轮询。
      if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/smoke') && req.method === 'POST') {
        const id = url.pathname.slice('/api/agents/'.length, -'/smoke'.length);
        const a = agents[id];
        if (!a) return json(res, 404, { error: '未知 agent: ' + id });
        if (a.external) return json(res, 400, { error: 'GPT 網頁席位請從官方 Chat 領取任務驗證' });
        if (a.unavailable) {
          smokeStatus[id] = { ok: false, error: a.unavailable, ts: new Date().toISOString() };
          return json(res, 200, smokeStatus[id]);
        }
        if (smokeInflight.has(id)) return json(res, 409, { error: 'smoke already running' });
        smokeInflight.add(id);
        try {
          // 超时沿用该 adapter 自己声明的 timeoutMs：慢引擎（如 OpenClaw 正常要 ~3 分钟）
          // 用统一的短上限会被误判 timeout——健康检查不能比引擎的已知特性更急躁
          const r = await runAgent(structuredClone(a), 'Health check. Reply with the single word: ok', {
            profile: makeProfile({ id: `health:${id}`, role: 'health-check', cwdPolicy: 'scratch' }),
            manifestFile: path.join(sessionsDir, '_health', `${id}.context_manifest.json`),
          });
          smokeStatus[id] = { ok: r.ok, ...(r.ok ? {} : { error: r.error }), durationMs: r.durationMs, ts: new Date().toISOString() };
          return json(res, 200, smokeStatus[id]);
        } finally { smokeInflight.delete(id); }
      }
      if (url.pathname === '/api/draft' && req.method === 'POST') {
        const body = await readBody(req);
        const id = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
        drafts.set(id, { topic: String(body.topic ?? ''), materials: String(body.materials ?? ''), template: String(body.template ?? ''), workspace: String(body.workspace ?? ''), lang: body.lang === 'en' ? 'en' : (body.lang === 'zh' ? 'zh' : '') });
        while (drafts.size > 20) drafts.delete(drafts.keys().next().value); // 只保留最近 20 份
        return json(res, 200, { id });
      }
      if (url.pathname.startsWith('/api/draft/') && req.method === 'GET') {
        const d = drafts.get(url.pathname.slice('/api/draft/'.length));
        return d ? json(res, 200, d) : json(res, 404, { error: '草稿不存在' });
      }
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const body = await readBody(req);
        const template = templates[body.template];
        if (!template) return json(res, 400, { error: '未知模板: ' + body.template });
        for (const id of [...(body.roles?.debaters ?? []), body.roles?.judge, body.roles?.summarizer])
          if (!agents[id] || agents[id].external) return json(res, 400, { error: '自動會議只支援 CLI agent: ' + id });
        // 工作区挂载：参会 AI 以该目录为只读工作目录，可自行查阅项目文件
        const lang = body.lang === 'en' ? 'en' : 'zh'; // 会话语言：建会时定死，存 metadata，提示词链路按此选中英文
        const workspace = normalizeFsPath(body.workspace);
        const workspaceError = workspacePathError(workspace, lang);
        if (workspaceError) return json(res, 400, workspaceError);
        let materials = body.materials ?? '';
        if (workspace) materials += lang === 'en'
          ? "\n\n---\nParticipant note: your working directory is the project root (read-only). Before speaking, check the key files yourself to verify the brief's claims; cite facts as plain-text \"relative/path:line\" (e.g. src/server.js:123) — no absolute paths, no markdown link syntax (your statements render as plain text, links just become screen-filling noise)."
          : '\n\n---\n参会说明：你的工作目录就是该项目的根目录（只读）。发言前请先自行查阅关键文件核实简报中的说法；引用事实时用「相对路径:行号」纯文本格式（如 src/server.js:123），不要写绝对路径，不要用 markdown 链接语法——你的发言按纯文本展示，链接语法只会变成刷屏的长串。';
        const id = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
        const now = new Date().toISOString();
        const entry = attachEmit({ events: [], clients: new Set(), createdAt: now, updatedAt: now });
        const roleIds = [...body.roles.debaters, body.roles.judge, body.roles.summarizer];
        let sessionOrigin = String(body.origin ?? '');
        if (!body.origin) {
          sessionOrigin = ''; // 包台被跳过或失败时，保持无 origin 的旧行为
          const participantsIds = [...new Set(roleIds)].filter(agentId => agents[agentId] && !agents[agentId].unavailable);
          if (participantsIds.length) {
            try {
              const wrapEntry = newBenchEntry();
              const wrapBench = new Workbench({
                name: String(body.topic ?? '').slice(0, 40),
                agents: deriveSessionAgents(agents, participantsIds, workspace),
                participants: participantsIds,
                baseDir: sessionsDir,
                emit: ev => wrapEntry.emit(ev),
                workspace,
                writeAgents: deriveWriteAgents(agents, participantsIds),
                lang,
              });
              await wrapBench.init();
              wrapEntry.bench = wrapBench;
              const wrapId = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
              benches.set(wrapId, wrapEntry);
              sessionOrigin = path.basename(wrapBench.dir);
            } catch { /* 包台失败不阻塞建会，回退为无 origin 的旧行为 */ }
          }
        }
        const committee = new Committee({
          topic: body.topic, materials,
          agents: deriveSessionAgents(agents, roleIds, workspace),
          roles: body.roles, template, mode: body.mode ?? 'manual', workspace, origin: sessionOrigin,
          maxRounds: Math.min(Math.max(Number(body.maxRounds) || 4, 1), 10),
          baseDir: sessionsDir, lang,
          // 会议模板显式选择；capGrants 只用于升格继承来源工作台的本场授权（compileCaps 会按模板过滤）
          caps: { templateId: normalizeTemplateId(String(body.capTemplate ?? '')), grants: Array.isArray(body.capGrants) ? body.capGrants.map(String) : [] },
          capFiles: { templatesFile: capTemplatesFile },
          emit: ev => entry.emit(ev),
        });
        committee.workspace = workspace;
        entry.committee = committee;
        attachAutoVerdictFlow(entry); // 裁决卡产出即自动落回来源工作台（统一容器第一期）
        await committee.init();
        sessions.set(id, entry);
        // 时间线事件通知：来源工作台里留一条「会议已开始」记录（仅活动台，便宜路径）
        const srcBenchId = committee.origin ? findActiveBenchId(committee.origin) : null;
        if (srcBenchId) {
          const b = benches.get(srcBenchId).bench;
          b.note(
            b.lang === 'en' ? `[Meeting started] "${committee.topic}" — see the sidebar to watch or join` : `【会议已开始】「${committee.topic}」——侧栏可进入旁听或主持`,
            { meeting: { dir: path.basename(committee.dir), topic: committee.topic, kind: 'started' } },
          ).catch(() => {});
        }
        return json(res, 200, { id });
      }
      if (url.pathname.startsWith('/api/archive/')) {
        const rest = url.pathname.slice('/api/archive/'.length);
        const slashIdx = rest.indexOf('/');
        const rawDirname = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
        const sub = slashIdx === -1 ? '' : rest.slice(slashIdx + 1);
        let dirname;
        try { dirname = decodeURIComponent(rawDirname); } catch { return json(res, 404, { error: 'not found' }); }
        let entries;
        try { entries = await readdir(sessionsDir); } catch { entries = []; }
        const activeDirs = () => new Set([
          ...[...sessions.values()].map(e => e.committee.dir && path.basename(e.committee.dir)),
          ...[...benches.values()].map(e => e.bench.dir && path.basename(e.bench.dir)),
        ].filter(Boolean));

        if (sub === 'rename' && req.method === 'POST') {
          if (!entries.includes(dirname)) return json(res, 404, { error: '归档不存在' }); // 白名单精确匹配，杜绝路径穿越
          const body = await readBody(req);
          const title = String(body.title ?? '').trim();
          if (!title) return json(res, 400, { error: '名字不能为空' });
          const metaPath = path.join(sessionsDir, dirname, 'metadata.json');
          let meta;
          try { meta = JSON.parse(await readFile(metaPath, 'utf8')); } catch { return json(res, 404, { error: '归档不存在' }); }
          meta.topic = meta.type === 'workbench' ? '[工作台] ' + title : title;
          await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
          return json(res, 200, { ok: true });
        }

        if (sub === 'resume' && req.method === 'POST') {
          if (!entries.includes(dirname)) return json(res, 404, { error: '归档不存在' }); // 白名单精确匹配，杜绝路径穿越
          if (activeDirs().has(dirname)) return json(res, 409, { error: '该会话已在进行中' });
          const dir = path.join(sessionsDir, dirname);
          let meta;
          try { meta = JSON.parse(await readFile(path.join(dir, 'metadata.json'), 'utf8')); }
          catch { return json(res, 404, { error: '归档不存在' }); }
          const template = templates[meta.template];
          if (!template) return json(res, 400, { error: '未知模板: ' + meta.template });
          const materials = await readFile(path.join(dir, 'problem.md'), 'utf8').catch(() => '');
          const rounds = meta.rounds || 0;
          const history = [];
          for (let n = 1; n <= rounds; n++) {
            const briefs = {}, outputs = {};
            for (const d of meta.roles.debaters) {
              briefs[d] = await readFile(path.join(dir, 'prompts', `r${n}-${d}.md`), 'utf8').catch(() => '');
              const raw = await readFile(path.join(dir, 'raw', `r${n}-${d}.md`), 'utf8').catch(() => null);
              outputs[d] = raw === null ? { ok: false, error: 'missing', text: '' } : { ok: true, text: raw };
            }
            const summary = await readFile(path.join(dir, 'summaries', `r${n}.md`), 'utf8').catch(() => '');
            history.push({ briefs, outputs, summary });
          }
          const id = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
          const now = new Date().toISOString();
          const entry = attachEmit({ events: [], clients: new Set(), createdAt: now, updatedAt: now });
          // agent 配置优先用当前全局配置重新派生（让 adapter 修复/升级惠及恢复的会话），
          // 仅当某 agent 已从全局配置中移除时才回退到存档快照
          const roleIds = [...meta.roles.debaters, meta.roles.judge, meta.roles.summarizer];
          const currentIds = roleIds.filter(x => agents[x]);
          const resumedAgents = {
        ...Object.fromEntries(roleIds.filter(x => !agents[x]).map(x => [x, meta.agents[x]])),
        ...deriveSessionAgents(agents, currentIds, String(meta.workspace ?? '')),
          };
          const committee = Committee.resume({
            topic: meta.topic, materials, agents: resumedAgents, roles: meta.roles, template,
            mode: meta.mode, maxRounds: meta.maxRounds, baseDir: sessionsDir,
            dir, round: rounds, history, origin: String(meta.origin ?? ''),
            lang: meta.lang === 'en' ? 'en' : 'zh',
            workspace: String(meta.workspace ?? ''), // 挂载信息随恢复带回，防 saveMeta 抹掉
            caps: meta.caps ?? null,
            capFiles: { templatesFile: capTemplatesFile },
            emit: ev => entry.emit(ev),
          });
          committee.restoreCrossoverState(meta); // 跨界事件/裁决版本/过期标记随恢复带回
          entry.committee = committee;
          attachAutoVerdictFlow(entry); // 恢复后再出的新裁决同样自动落回（回放走 events.push 不经 emit，不误触）
          await committee.saveMeta('paused');
          // 合成事件缓冲：供新连上的前端 SSE 回放重建界面（辩手栏、摘要、裁决卡）
          entry.events.push({ type: 'state', data: 'paused' });
          for (let n = 1; n <= rounds; n++) {
            const h = history[n - 1];
            for (const d of meta.roles.debaters) {
              const o = h.outputs[d];
              entry.events.push({ type: 'chunk', agentId: d, label: `r${n}`, data: o.ok ? o.text : '' });
              entry.events.push({ type: 'agent-status', agentId: d, label: `r${n}`, data: o.ok ? 'done' : 'failed:' + o.error });
            }
            entry.events.push({ type: 'summary', round: n, data: h.summary });
          }
          const judgeCard = await readFile(path.join(dir, 'judge-card.md'), 'utf8').catch(() => null);
          if (judgeCard !== null) entry.events.push({ type: 'judge-card', data: judgeCard });
          // 群聊记录（若存在）：重建 chatLog 并合成事件回放
          const chatRaw = await readFile(path.join(dir, 'chat.jsonl'), 'utf8').catch(() => null);
          if (chatRaw !== null) {
            const chatLog = chatRaw.split('\n').filter(Boolean).map(l => JSON.parse(l));
            committee.chatLog = chatLog;
            committee.chatSeq = chatLog.length;
            for (const m of chatLog) entry.events.push({ type: 'chat-message', from: m.from, name: m.name, data: m.text });
          }
          sessions.set(id, entry);
          return json(res, 200, { id });
        }

        if (sub === '' && (req.method === 'GET' || req.method === 'DELETE')) {
          if (!entries.includes(dirname)) return json(res, 404, { error: '归档不存在' }); // 白名单精确匹配，杜绝路径穿越
          const dir = path.join(sessionsDir, dirname);
          if (req.method === 'DELETE') {
            // 不允许删除仍挂在活动会话名下的目录（先删活动会话）
            if (activeDirs().has(dirname)) return json(res, 409, { error: '该会话仍在进行中，请先删除活动会话' });
            await moveToTrash(dir);
            return json(res, 200, { ok: true });
          }
          let sessionMd;
          try { sessionMd = await readFile(path.join(dir, 'session.md'), 'utf8'); }
          catch {
            try { sessionMd = await readFile(path.join(dir, 'problem.md'), 'utf8'); }
            catch { return json(res, 404, { error: '归档不存在' }); }
          }
          let topic = dirname;
          try { topic = JSON.parse(await readFile(path.join(dir, 'metadata.json'), 'utf8')).topic ?? topic; } catch { /* 无 metadata 时退化用目录名 */ }
          return json(res, 200, { topic, sessionMd });
        }
      }
      // ---- 工作台：多模型群聊会话 ----
      const gptTool = url.pathname.match(/^\/api\/gpt\/(claim|read|write|test|deliver)$/);
      if (gptTool && req.method === 'POST') {
        const body = await readBody(req);
        if (typeof body.connection !== 'string' || /[\\/]/.test(body.connection)) return json(res, 400, { error: '桌的配對識別無效' });
        try {
          let id = findActiveBenchId(body.connection);
          if (!id) {
            if (!externalResumes.has(body.connection)) externalResumes.set(body.connection,
              resumeBenchFromDisk(body.connection).finally(() => externalResumes.delete(body.connection)));
            id = await externalResumes.get(body.connection);
          }
          const result = await benches.get(id).bench.externalCall(gptTool[1], body);
          return json(res, 200, result);
        } catch (e) { return json(res, 409, { error: String(e.message ?? e) }); }
      }
      if (url.pathname === '/api/workbenches' && req.method === 'POST') {
        const body = await readBody(req);
        const participants = [...new Set(Array.isArray(body.participants) ? body.participants : [])];
        if (!participants.length) return json(res, 400, { error: '请至少选择一个参与模型' });
        const seatSettings = {};
        for (const seat of Array.isArray(body.seats) ? body.seats : []) {
          if (!seat || !participants.includes(seat.id)) return json(res, 400, { error: '席位不存在' });
          const provider = /^gpt(?:[2-9]|[1-9]\d+)$/.test(seat.id) ? 'gpt' : seat.id;
          if (seat.provider !== provider || !agents[provider]) return json(res, 400, { error: '席位來源無效' });
          if (typeof seat.name !== 'string' || !seat.name.trim() || seat.name.trim().length > 50 || typeof seat.enabled !== 'boolean') return json(res, 400, { error: '席位設定無效' });
          const effort = seat.effort ?? '';
          if (effort !== '' && !reasoningEfforts(agents[provider]).includes(effort)) return json(res, 400, { error: '推理程度無效' });
          // New tables keep seat preferences, but each GPT must bind a fresh Chat.
          seatSettings[seat.id] = { provider, name: seat.name.trim(), enabled: seat.enabled, effort, chatUrl: '' };
        }
        const seatAgents = withSeatAgents(agents, seatSettings);
        for (const id of participants) {
          if (!seatAgents[id]) return json(res, 400, { error: '未知 agent: ' + id });
          if (seatAgents[id].unavailable) return json(res, 400, { error: `${seatAgents[id].name} 当前不可用: ${seatAgents[id].unavailable}` });
        }
        const enabled = participants.filter(id => seatSettings[id]?.enabled !== false);
        if (!enabled.length) return json(res, 400, { error: '至少保留一個啟用席位' });
        const chairId = body.chairId || null;
        if (chairId && !enabled.includes(chairId)) return json(res, 400, { error: '主席須為已啟用席位' });
        if (body.relayOrder !== undefined && (!Array.isArray(body.relayOrder) || body.relayOrder.some(id => !enabled.includes(id)))) return json(res, 400, { error: '圓桌只能勾選已啟用席位' });
        const wbLang = body.lang === 'en' ? 'en' : 'zh';
        const wbWorkspace = normalizeFsPath(body.workspace);
        const workspaceError = workspacePathError(wbWorkspace, wbLang);
        if (workspaceError) return json(res, 400, workspaceError);
        const entry = newBenchEntry();
        const bench = new Workbench({
          name: String(body.name ?? '').trim(),
          agents: deriveSessionAgents(seatAgents, participants, wbWorkspace), // 挂了目录则聊天也可只读查阅
          participants, baseDir: sessionsDir, emit: ev => entry.emit(ev),
          workspace: wbWorkspace, writeAgents: deriveWriteAgents(seatAgents, participants),
          lang: wbLang,
          // 会议模板只认用户显式选择；未选＝通用入口默认 basic_strategy（normalizeTemplateId 兜底）
          caps: { templateId: normalizeTemplateId(String(body.capTemplate ?? '')) },
          capFiles: { templatesFile: capTemplatesFile },
        });
        bench.seatSettings = seatSettings;
        bench.chairId = chairId;
        bench.relayOrder = [...new Set(body.relayOrder ?? enabled)].filter(id => id !== chairId);
        for (const id of participants) {
          bench.agents[id].reasoningEffort = seatSettings[id]?.effort || '';
          if (bench.writeAgents[id]) bench.writeAgents[id].reasoningEffort = seatSettings[id]?.effort || '';
        }
        await bench.init();
        // 建台时的角色分配（能力+仲裁叠加）：逐个校验，无效项按默认角色处理不阻塞建台
        for (const [aid, r] of Object.entries(body.roles ?? {})) {
          if (!participants.includes(aid) || typeof r !== 'object') continue;
          try { await bench.setRole(aid, String(r.role ?? ''), !!r.arbiter, !!r.decide); } catch { /* 能力不符→保持默认 */ }
        }
        entry.bench = bench;
        const id = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
        benches.set(id, entry);
        return json(res, 200, { id });
      }
      if (url.pathname === '/api/workbenches/resume' && req.method === 'POST') {
        const body = await readBody(req);
        const dirname = String(body.dirname ?? '');
        if (findActiveBenchId(dirname)) return json(res, 409, { error: '该工作台已在进行中' });
        try { return json(res, 200, { id: await resumeBenchFromDisk(dirname) }); }
        catch (e) { return json(res, 404, { error: String(e.message ?? e) }); }
      }
      const wb = url.pathname.match(/^\/api\/workbenches\/([a-z0-9]+)(\/([a-z-]+))?$/);
      if (wb) {
        const entry = benches.get(wb[1]);
        if (!entry) return json(res, 404, { error: '工作台不存在' });
        const b = entry.bench, action = wb[3];
        if (action === 'gpt-connection' && req.method === 'POST') {
          const body = await readBody(req);
          if (b.state === 'busy') return json(res, 409, { error: '請等目前任務結束後再變更 GPT 對話' });
          if (body.chatUrl !== '' && !validChatUrl(body.chatUrl)) return json(res, 400, { error: 'CHAT_URL_INVALID' });
          const agentId = body.agentId || 'gpt';
          if (!b.isExternal(agentId) || !b.participants.includes(agentId)) return json(res, 400, { error: 'GPT 席位不存在' });
          if (body.chatUrl && b.participants.some(id => id !== agentId && b.chatUrlFor(id) === body.chatUrl)) return json(res, 409, { error: '每個 GPT 席位必須綁定不同對話；不能共用同一個 Chat 網址' });
          if (b.chatUrlFor(agentId) !== body.chatUrl) Object.assign(b.cursorFor(agentId), { clientId: null, lastSeq: 0 });
          if (agentId === 'gpt') b.gptChatUrl = body.chatUrl;
          else b.seatSettings[agentId] = { ...b.seatSettings[agentId], chatUrl: body.chatUrl };
          await b.saveMeta();
          return json(res, 200, { agentId, chatUrl: b.chatUrlFor(agentId) });
        }
        if (action === 'gpt-send' && req.method === 'POST') {
          const body = await readBody(req);
          const task = b.externalSummary();
          if (!task || task.status !== 'waiting') return json(res, 409, { error: 'NO_WAITING_GPT_TASK' });
          if (body.taskId !== task.taskId) return json(res, 409, { error: 'GPT_TASK_CHANGED' });
          if (body.chatUrl && !validChatUrl(body.chatUrl)) return json(res, 400, { error: 'CHAT_URL_INVALID' });
          if ((body.chatUrl || '') !== b.chatUrlFor(task.agentId)) return json(res, 409, { error: 'GPT_CONNECTION_CHANGED' });
          try {
            return json(res, 200, await sendPendingGpt(entry));
          } catch (error) { return json(res, 409, { error: error.message }); }
        }
        if (!action && req.method === 'GET') {
          return json(res, 200, {
            name: b.name, state: b.state, participants: b.participants,
            connection: path.basename(b.dir),
            gptChatUrl: b.gptChatUrl,
            seats: b.seatsSummary(), relayOrder: b.relayOrder, chairId: b.chairId, lastDiscussion: b.lastDiscussion,
            models: b.models,
            external: b.externalSummary(),
            agentNames: Object.fromEntries(b.participants.map(id => [id, b.nameOf(id)])),
            workspace: b.workspace, writeCapable: Object.keys(b.writeAgents),
            roles: Object.fromEntries(b.participants.map(id => [id, b.roleOf(id)])),
            caps: b.capsSummary(), // 当前模板与能力（安全元数据）
          });
        }
        if (!action && req.method === 'DELETE') {
          if (b.state === 'busy') return json(res, 409, { error: '請先停止進行中的任務' });
          if (b.dir) await moveToTrash(b.dir);
          for (const client of entry.clients) { try { client.end(); } catch { /* 已断开 */ } }
          benches.delete(wb[1]);
          return json(res, 200, { ok: true });
        }
        if (action === 'events' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          res.flushHeaders();
          res.on('error', () => entry.clients.delete(res));
          try {
            for (const ev of entry.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
          } catch { entry.clients.delete(res); return; }
          entry.clients.add(res);
          req.on('close', () => entry.clients.delete(res));
          return;
        }
        if (action === 'conflicts' && req.method === 'GET')
          return json(res, 200, b.conflictSheet());
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        if (action === 'archive') {
          if (b.state === 'busy') return json(res, 409, { error: '請先停止進行中的任務，再封存對話' });
          await b.saveMeta({ archived: true });
          for (const client of entry.clients) { try { client.end(); } catch { /* 已断开 */ } }
          benches.delete(wb[1]);
          return json(res, 200, { ok: true, dirname: path.basename(b.dir) });
        }
        // 上传附件：原始字节流（不能走 readBody 的 JSON 解析）。文件名经 x-rt-filename 头传入，
        // 只取基名并过扩展名白名单；落到会话目录 uploads/ 下，返回描述符供 message 引用。
        if (action === 'upload') {
          const rawName = (() => { try { return decodeURIComponent(String(req.headers['x-rt-filename'] ?? '')); } catch { return ''; } })();
          const base = safeUploadBasename(rawName);
          const ext = path.extname(base).toLowerCase().slice(1);
          const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
          const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'sh', 'ps1', 'bat', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'sql', 'diff', 'patch', 'ini', 'cfg', 'conf', 'env', 'tex']);
          if (!base || !ext) return json(res, 400, { error: b.lang === 'en' ? 'Missing or invalid file name' : '文件名缺失或无效' });
          const kind = IMAGE_EXT.has(ext) ? 'image' : (TEXT_EXT.has(ext) ? 'text' : null);
          if (!kind) return json(res, 400, { error: b.lang === 'en' ? `Unsupported file type: .${ext} (images and text files only for now)` : `暂不支持的文件类型：.${ext}（目前支持图片与文本类文件）` });
          const MAX_UPLOAD = 20 * 1024 * 1024;
          const chunks = [];
          let size = 0, overflow = false;
          await new Promise(resolve => {
            req.on('data', d => {
              size += d.length;
              if (size > MAX_UPLOAD) { overflow = true; req.destroy(); resolve(); return; }
              chunks.push(d);
            });
            req.on('end', resolve);
            req.on('error', resolve);
          });
          if (overflow) return json(res, 400, { error: b.lang === 'en' ? 'File too large (max 20MB)' : '文件太大（上限 20MB）' });
          if (!size) return json(res, 400, { error: b.lang === 'en' ? 'Empty file' : '空文件' });
          const uploadsDir = path.join(b.dir, 'uploads');
          await mkdir(uploadsDir, { recursive: true });
          const stored = `${Date.now().toString(36)}-${base}`;
          await writeFile(path.join(uploadsDir, stored), Buffer.concat(chunks));
          return json(res, 200, { file: stored, name: base, kind, size });
        }
        const body = await readBody(req);
        if (action === 'seats') {
          if (b.state === 'busy') return json(res, 409, { error: '請等目前任務結束後再調整席位' });
          try {
            if (body.op === 'add') {
              if (body.provider !== 'gpt' || !agents.gpt) throw new Error('目前可新增 GPT 網頁席位');
              let n = 2;
              while (b.participants.includes(`gpt${n}`)) n++;
              const id = `gpt${n}`;
              const name = body.name == null ? `GPT ${n}` : String(body.name).trim();
              if (!name || name.length > 50) throw new Error('席位名稱須為 1–50 字元');
              b.seatSettings[id] = { provider: 'gpt', name, enabled: true, chatUrl: '' };
              const available = withSeatAgents(agents, b.seatSettings);
              await b.addParticipant(id, deriveSessionAgents(available, [id], b.workspace)[id], deriveWriteAgents(available, [id])[id]);
            } else if (body.op === 'update') {
              await b.configureSeat(String(body.agentId ?? ''), body);
            } else if (body.op === 'order') {
              if (!Array.isArray(body.order) || body.order.some(id => !b.seatEnabled(id))) throw new Error('圓桌只能勾選已啟用席位');
              b.relayOrder = [...new Set(body.order)].filter(id => id !== b.chairId);
              await b.saveMeta();
            } else if (body.op === 'chair') {
              await b.setChair(String(body.agentId || ''));
            } else throw new Error('不支援的席位操作');
            return json(res, 200, { seats: b.seatsSummary(), relayOrder: b.relayOrder, chairId: b.chairId });
          } catch (error) { return json(res, 400, { error: error.message }); }
        }
        if (action === 'message') {
          const text = String(body.text ?? '').trim();
          // 附件校验：只认 upload 返回的存储名（纯基名，杜绝路径穿越），且文件必须真实存在
          const atts = [];
          for (const a of (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 8)) {
            const stored = String(a?.file ?? '');
            // 平台无关地拒绝任何带路径分隔符（/ 或 \）或 `..` 的存储名——path.basename 在
            // Linux 不认 `\`，单靠它挡不住 Windows 风格穿越名。再加一道解析后的目录归属校验。
            if (!stored || /[\\/]/.test(stored) || stored.includes('..')) continue;
            const uploadsRoot = path.resolve(b.dir, 'uploads');
            const abs = path.resolve(uploadsRoot, stored);
            const rel = path.relative(uploadsRoot, abs);
            if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue; // 解析后必须仍在 uploads/ 内
            if (!existsSync(abs)) continue;
            const ext = path.extname(stored).toLowerCase().slice(1);
            atts.push({ name: String(a.name ?? stored), kind: ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext) ? 'image' : 'text', size: Number(a.size ?? 0), file: abs });
          }
          if (!text && !atts.length) return json(res, 400, { error: '内容不能为空' });
          if (b.state === 'busy') return json(res, 409, { error: '上一条消息还在处理中' });
          const requested = Array.isArray(body.to) ? body.to : [];
          if (requested.some(x => !b.seatEnabled(x))) return json(res, 400, { error: '指定席位尚未加入這張桌' });
          const to = requested.length ? requested : [b.seatEnabled(b.lastSpeaker) ? b.lastSpeaker : b.participants.find(id => b.seatEnabled(id))];
          if (to.some(id => b.isExternal(id))) {
            if (to.length !== 1 || atts.length) return json(res, 400, { error: 'GPT 網頁任務請單獨指派，並將需求填在文字中' });
            try { await b.startExternal(text, 'chat', { agentId: to[0] }); }
            catch (e) { return json(res, 400, { error: String(e.message ?? e) }); }
          } else b.message(text, to, atts).catch(e => entry.emit({ type: 'error', data: String(e.message ?? e) }));
          return json(res, 200, { ok: true });
        }
        if (action === 'relay') {
          if (b.state === 'busy') return json(res, 409, { error: '上一条消息还在处理中' });
          const requestedOrder = Array.isArray(body.order) ? body.order : [];
          const order = [...new Set(Array.isArray(body.order) ? requestedOrder : b.relayOrder)].filter(id => id !== b.chairId);
          if (order.length < 2 || order.some(id => !b.seatEnabled(id))) return json(res, 400, { error: '請勾選至少兩個已啟用的席位' });
          b.relay(body.rounds, order, String(body.seed ?? '')).catch(e => entry.emit({ type: 'error', data: String(e.message ?? e) }));
          return json(res, 200, { ok: true });
        }
        if (action === 'conflict-discuss') {
          const conflictPath = String(body.path ?? '');
          if (!conflictPath.trim()) return json(res, 400, { error: '文件路径不能为空' });
          if (b.state === 'busy') return json(res, 409, { error: '上一条消息还在处理中' });
          b.discussConflict(conflictPath).catch(e => entry.emit({ type: 'error', data: String(e.message ?? e) }));
          return json(res, 200, { ok: true });
        }
        if (action === 'stop') { await b.stop(); return json(res, 200, { ok: true }); }
        if (action === 'crossover') {
          // 聊天→会议显式交接：只认结构化字段（seq+枚举类型），host 绝不从文本推断相关性。
          // 目标会议＝以本台为 origin 的进行中会议；没有就明确报错，不做任何静默同步。
          const seq = Number(body.seq);
          const msg = b.messages.find(x => x.seq === seq);
          if (!msg) return json(res, 400, { error: b.lang === 'en' ? 'No such message' : '消息不存在' });
          const benchDirname = path.basename(b.dir);
          const target = [...sessions.values()].find(e => e.committee?.origin === benchDirname);
          if (!target) return json(res, 400, { error: b.lang === 'en' ? 'No meeting originated from this workbench is open' : '没有从本工作台发起且仍开着的会议' });
          try {
            const ev = await target.committee.addCrossover({ type: String(body.type ?? ''), text: msg.text, sourceSeq: seq, sourceBench: benchDirname });
            b.emit({ type: 'sys', data: b.lang === 'en' ? `Sent to meeting "${target.committee.topic}" as ${ev.type} — pending your approval at the round boundary` : `已发送到会议「${target.committee.topic}」（${ev.type}）——待你在轮末批准后进入下一阶段` });
            return json(res, 200, { ok: true, eventId: ev.id, meetingTopic: target.committee.topic });
          } catch (e) { return json(res, 400, { error: String(e.message ?? e) }); }
        }
        if (action === 'model') {
          try { await b.setModel(String(body.agentId ?? ''), String(body.model ?? '')); }
          catch (e) { return json(res, 400, { error: String(e.message ?? e) }); }
          return json(res, 200, { models: b.models });
        }
        if (action === 'workspace') {
          const workspacePath = normalizeFsPath(body.path);
          const workspaceError = workspacePathError(workspacePath, b.lang === 'en' ? 'en' : 'zh');
          if (workspaceError) return json(res, 400, workspaceError);
          if (b.state === 'busy') return json(res, 409, { error: '上一条消息还在处理中' });
          await b.setWorkspace(
            workspacePath,
            deriveSessionAgents(withSeatAgents(agents, b.seatSettings), b.participants, workspacePath),
            workspacePath ? deriveWriteAgents(withSeatAgents(agents, b.seatSettings), b.participants) : {},
          );
          return json(res, 200, {
            workspace: b.workspace,
            writeCapable: Object.keys(b.writeAgents),
            roles: Object.fromEntries(b.participants.map(id => [id, b.roleOf(id)])),
          });
        }
        if (action === 'participants') {
          // 中途增删参与者：add 按当前全局配置派生会话/写配置（含工作区只读挂载）
          const agentId = String(body.agentId ?? '');
          try {
            if (body.op === 'add') {
              if (!agents[agentId]) return json(res, 400, { error: '未知 agent: ' + agentId });
              if (agents[agentId].unavailable) return json(res, 400, { error: `${agents[agentId].name} 当前不可用: ${agents[agentId].unavailable}` });
              await b.addParticipant(agentId,
                deriveSessionAgents(agents, [agentId], b.workspace)[agentId],
                deriveWriteAgents(agents, [agentId])[agentId]);
            } else if (body.op === 'remove') {
              await b.removeParticipant(agentId);
            } else return json(res, 400, { error: '未知操作: ' + String(body.op) });
          } catch (e) { return json(res, 400, { error: String(e.message ?? e) }); }
          return json(res, 200, {
            participants: b.participants,
            agentNames: Object.fromEntries(b.participants.map(id => [id, b.nameOf(id)])),
            writeCapable: Object.keys(b.writeAgents),
            roles: Object.fromEntries(b.participants.map(id => [id, b.roleOf(id)])),
          });
        }
        if (action === 'rename') {
          const name = String(body.name ?? '').trim();
          if (!name) return json(res, 400, { error: '名字不能为空' });
          b.name = name;
          await b.saveMeta();
          return json(res, 200, { ok: true });
        }
        if (action === 'promote') {
          // 升格：对话史打包成会议草稿，走既有 #draft 预填链路；携带来源目录名供裁决卡回流
          const id = Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
          // 升格继承工作台的能力授权：会议与工作台共用同一份授权清单（模板+本场授权）
          drafts.set(id, { topic: String(body.topic ?? '') || (b.lang === 'en' ? 'Workbench topic: ' + (b.name || 'unnamed') : '工作台议题：' + (b.name || '未命名')), materials: b.promoteMaterials(), template: 'general', workspace: '', originBench: path.basename(b.dir), lang: b.lang, capTemplate: b.capState.templateId, capGrants: b.capState.grants });
          while (drafts.size > 20) drafts.delete(drafts.keys().next().value);
          return json(res, 200, { id });
        }
        return json(res, 404, { error: '未知操作: ' + action });
      }
      const m = url.pathname.match(/^\/api\/sessions\/([a-z0-9]+)(\/([a-z-]+))?$/);
      if (m) {
        const entry = sessions.get(m[1]);
        if (!entry) return json(res, 404, { error: '会话不存在' });
        const c = entry.committee, action = m[3];
        if (!action && req.method === 'DELETE') {
          // 删除活动会话：中止子进程、断开 SSE、移出内存，并连同磁盘目录一起删除
          try { c.stopRound(); } catch { /* 未在运行中也无妨 */ }
          for (const client of entry.clients) { try { client.end(); } catch { /* 已断开 */ } }
          sessions.delete(m[1]);
          if (c.dir) await moveToTrash(c.dir);
          return json(res, 200, { ok: true });
        }
        if (!action && req.method === 'GET')
          return json(res, 200, {
            state: c.state, round: c.round, topic: c.topic, dir: c.dir, materials: c.materials, origin: c.origin,
            roles: c.roles, agentNames: Object.fromEntries(Object.entries(c.agents).map(([id, a]) => [id, a.name])),
            crossover: c.crossoverSummary(), verdictVersions: c.verdictVersions, // 跨界队列+裁决版本表
          });
        // events 是 GET 语义（SSE），必须先放行，再统一做 POST 检查
        if (action === 'events' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
          res.flushHeaders(); // 无缓冲事件回放时也要立即放行响应头，否则客户端会一直等待
          res.on('error', () => entry.clients.delete(res)); // 双保险：写入触发的 error 事件也要清理
          try {
            for (const ev of entry.events) res.write(`data: ${JSON.stringify(ev)}\n\n`); // 回放缓冲
          } catch { entry.clients.delete(res); return; }
          entry.clients.add(res);
          req.on('close', () => entry.clients.delete(res));
          return;
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
        const body = await readBody(req);
        const fire = fn => { fn().catch(e => c.emit({ type: 'error', data: String(e.message ?? e) })); return json(res, 200, { ok: true }); };
        switch (action) {
          case 'round': return fire(() => c.runNextRound());
          case 'auto': {
            // 最大轮数只对自动模式有意义：点「自动跑完」时随请求携带、此处生效
            const n = Number(body.maxRounds);
            if (n) c.maxRounds = Math.min(Math.max(n, 1), 10);
            return fire(() => c.runAuto());
          }
          case 'judge': return fire(() => c.runJudge());
          case 'rejudge': return fire(() => c.rejudge()); // 全体重审：新裁决版本，历史归档
          case 'crossover-resolve': {
            // 待纳入事件的批准/拒绝——只认结构化字段，且只在轮末（非 running）可操作
            try { return json(res, 200, { ok: true, event: await c.resolveCrossover(String(body.id ?? ''), body.approve !== false), crossover: c.crossoverSummary() }); }
            catch (e) { return json(res, 400, { error: String(e.message ?? e) }); }
          }
          case 'retry': return fire(() => c.retrySide(body.agentId));
          case 'skip': return fire(() => c.skipSide(body.agentId));
          case 'interject': c.interject(String(body.text ?? '')); return json(res, 200, { ok: true });
          case 'stop': c.stopRound(); return json(res, 200, { ok: true });
          case 'save-partial': return fire(() => c.savePartial());
          case 'resummarize': return fire(() => c.resummarize());
          case 'flowback': {
            // 裁决卡投放工作台：默认回升格来源；无来源（草稿直建/手建）可用 body.target 指定任意工作台目录名。
            // target 在 resumeBenchFromDisk 内走白名单精确匹配，无路径穿越面。
            const target = String(body.target ?? '') || c.origin;
            if (!target) return json(res, 400, { error: '该会议无来源工作台——请指定投放目标（target）' });
            let card;
            try { card = await readFile(path.join(c.dir, 'judge-card.md'), 'utf8'); }
            catch { return json(res, 400, { error: '尚无裁决卡——先「进入裁决」' }); }
            try {
              return json(res, 200, { benchId: await postVerdictToBench(c, target, card) });
            } catch (e) { return json(res, 404, { error: '目标工作台不存在或无法恢复: ' + String(e.message ?? e) }); }
          }
          case 'rename': {
            // 只改展示标题（同步进 metadata）；后续轮次 prompt 中的议题随之更新——改名以澄清议题为目的，属预期行为
            const title = String(body.title ?? '').trim();
            if (!title) return json(res, 400, { error: '名字不能为空' });
            c.topic = title;
            await c.saveMeta(c.state);
            return json(res, 200, { ok: true });
          }
          case 'chat': {
            const text = String(body.text ?? '').trim();
            const to = Array.isArray(body.to) ? body.to : [];
            if (!text) return json(res, 400, { error: '内容不能为空' });
            if (!to.length) return json(res, 400, { error: '请至少选择一位收件人' });
            for (const agentId of to) if (!c.agents[agentId]) return json(res, 400, { error: '未知 agent: ' + agentId });
            return fire(() => c.chat(text, to));
          }
          default: return json(res, 404, { error: '未知操作: ' + action });
        }
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: String(e.message ?? e) });
    }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  // closeAllConnections：连已建立的 SSE/keep-alive socket 一并断开，close 才能真正结束、端口立即释放
  return { port: server.address().port, close: () => { server.closeAllConnections?.(); server.close(); }, sessions, benches };
}

// 直接运行时启动
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('src/server.js')) {
  const { port } = await startServer({ port: Number(process.env.PORT) || 7777 });
  console.log(`Roundtable 已启动: http://127.0.0.1:${port}`);
}
