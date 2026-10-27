// 上下文装配层：Roundtable 是子进程上下文的唯一装配者。
// 每次模型调用必须先经 makeProfile 造出显式 profile——声明 cwd 策略、环境变量、
// 各引擎经过实测验证的隔离参数——runner 只认这里造出的 profile，没有 ambient 回退。
//
// 三档 cwd 策略（受控枚举，调用方不能传任意路径）：
// - scratch            一次性临时目录（会后清理）。干净房：无项目规则、无项目记忆。
// - readonly-materials 用户显式挂载的工作区根（只读评审）。挂载即授权该项目自身的规则。
// - trusted-project    用户明确进入执行模式后的隔离副本（worktree）。仅动手流程可用。
//
// 引擎隔离参数（2026-07-22 本机实测，见 dev-log fix9 探针记录）：
// - claude: --setting-sources project --strict-mcp-config
//     实测 init 事件 plugins:[] mcp_servers:[]，用户级 skills/hooks/全局插件全部消失；
//     认证不属于 setting source，OAuth 登录不受影响。CLAUDE_CONFIG_DIR 全新目录
//     虽也隔离但实测认证直接 403——被否决（不复制凭证是红线）。
// - codex: --ignore-user-config（官方语义：不加载 config.toml，auth 仍走 CODEX_HOME）
//     实测最小环境下认证可用、用户 hooks 不再触发、cwd AGENTS.md canary 消失。
// - 其他引擎（hermes/openclaw 等）：无已验证的隔离参数——只能靠最小环境 + scratch cwd
//     尽力隔离，manifest 中如实标注 best-effort。
import { mkdtempSync, existsSync, statSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

export const CWD_POLICIES = ['scratch', 'readonly-materials', 'trusted-project'];
export const PROFILE_VERSION = 1;

// Discussion profiles keep project access read-only even if an old adapter
// configuration or resumed CLI session contains execution permissions.
export function discussionArgs(cfg, argv, profile) {
  if (profile.cwdPolicy === 'trusted-project') return argv;
  const base = path.basename(String(argv[0] || '')).toLowerCase();
  const family = cfg.family || (base.startsWith('codex') ? 'codex' : base.startsWith('claude') ? 'claude' : '');
  if (!['codex', 'claude'].includes(family)) return argv;
  const result = [argv[0]];
  const valueFlags = family === 'codex'
    ? ['--sandbox', '-s', '--permission-profile', '--add-dir']
    : ['--tools', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--permission-mode', '--mcp-config'];
  const switchFlags = ['--full-auto', '--yolo', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'];
  for (let i = 1; i < argv.length; i++) {
    const arg = String(argv[i]);
    if (valueFlags.includes(arg)) { i++; continue; }
    if (switchFlags.includes(arg) || valueFlags.some(flag => arg.startsWith(flag + '='))) continue;
    if (family === 'codex' && ['-c', '--config'].includes(arg) && /^(?:sandbox_mode|sandbox_workspace_write\.|permissions\.)/.test(String(argv[i + 1]))) { i++; continue; }
    if (family === 'codex' && /^--config=(?:sandbox_mode|sandbox_workspace_write\.|permissions\.)/.test(arg)) continue;
    result.push(argv[i]);
  }
  if (family === 'codex') result.push('-c', 'sandbox_mode="read-only"');
  else {
    result.push('--tools', profile.cwdPolicy === 'readonly-materials' ? 'Read,Glob,Grep' : '', '--permission-mode', 'plan');
    if (!result.includes('--strict-mcp-config')) result.push('--strict-mcp-config');
  }
  return result;
}

// 允许进入子进程的环境变量全集——envWhitelist 只能从这里挑，配置里写别的名字一律不生效。
// USERPROFILE 是 claude（OAuth 凭证在 ~/.claude）与 codex（CODEX_HOME 默认 ~/.codex/auth.json）
// 的认证必需项，实测缺它认证即断；这是「明确需要且经过验证」的保留，不是疏漏。
export const ALLOWED_ENV = [
  'PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP', 'PATHEXT',
  'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
];
// 引擎没写 envWhitelist 时的最小集合（实测 claude/codex 认证与运行均够用）
export const MIN_ENV = ['PATH', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE'];

// 被禁止自动继承的 ambient 来源——manifest 逐项标注每个引擎的真实执行力度
const AMBIENT_SOURCES = ['user-global-config', 'hooks', 'skills', 'plugins', 'mcp', 'memories', 'other-project-rules'];

// 按 command[0] 识别引擎家族，返回实测验证过的隔离参数与逐项执行力度。
// enforcement 取值：verified（探针证实关闭）/ partial（部分关闭，注明残余）/
// best-effort（无 CLI 开关，只有最小环境 + cwd 策略）。识别不了的引擎整体 best-effort。
export function isolationFor(cfg, policy) {
  if (Array.isArray(cfg.isolationArgs)) return { args: [...cfg.isolationArgs], enforcement: { '*': 'user-supplied isolationArgs (unverified)' } }; // 用户显式覆盖，自担验证
  const base = path.basename(String(cfg.command?.[0] ?? '')).toLowerCase();
  if (base.startsWith('claude')) {
    const args = ['--setting-sources', 'project', '--strict-mcp-config'];
    // scratch 调用永不续接会话（续接只发生在 trusted-project 的动手路径）——
    // 不留会话文件，也避免 ~/.claude/projects 里堆一次性目录的会话垃圾
    if (policy === 'scratch') args.push('--no-session-persistence');
    return {
      args,
      enforcement: {
        'user-global-config': 'verified', hooks: 'verified', plugins: 'verified', mcp: 'verified',
        memories: 'verified', 'other-project-rules': policy === 'scratch' ? 'verified' : 'n/a (mounted project rules are authorized materials)',
        skills: 'partial (user-level skills removed; CLI built-in skills remain — runtime-trusted)',
      },
    };
  }
  if (base.startsWith('codex')) {
    // --skip-git-repo-check 三档策略都要：scratch 是临时目录、readonly-materials 挂载的
    // 材料目录常常不是 git 仓库（实测故障：codex "Not inside a trusted directory" 拒启动）；
    // trusted-project 的 worktree 本身是仓库，此参数无副作用。
    const args = ['--ignore-user-config', '--skip-git-repo-check'];
    return {
      args,
      enforcement: {
        hooks: 'verified', mcp: 'verified (config.toml-defined servers not loaded)',
        'other-project-rules': policy === 'scratch' ? 'verified (cwd AGENTS.md canary gone)' : 'n/a (mounted project rules are authorized materials)',
        'user-global-config': 'partial (config.toml ignored; CODEX_HOME/AGENTS.md still loads — no CLI off-switch found, probes 2026-07-22)',
        skills: 'not-enforced (CODEX_HOME/skills still loads — no CLI off-switch found)',
        memories: 'best-effort (not directly observable)',
      },
    };
  }
  return null;
}

// 图片附件参数：引擎显式声明 imageArgs（含 {IMAGE} 占位）优先；codex 家族有官方 -i 参数，
// 按 command[0] 基名自动启用（老 agents.json 不用改就能用）。返回 null＝该引擎不支持图片，
// 调用层改为在 prompt 里如实标注「图片附件本引擎无法查看」，绝不假装看过。
export function imageArgsFor(cfg) {
  if (Array.isArray(cfg.imageArgs)) return cfg.imageArgs;
  const base = path.basename(String(cfg.command?.[0] ?? '')).toLowerCase();
  if (base.startsWith('codex')) return ['-i', '{IMAGE}'];
  return null;
}

// 防伪造：runner 只接受本模块造出的 profile 对象
const minted = new WeakSet();
export const isProfile = p => typeof p === 'object' && p !== null && minted.has(p);

const sha256 = s => createHash('sha256').update(s).digest('hex');

// 造 profile。id 必填（无默认 ambient profile）；root 仅 readonly-materials / trusted-project
// 需要且必须是已存在目录——scratch 由本层自建临时目录，调用方无权指定。
export function makeProfile({ id, cwdPolicy, root = null, role = 'unspecified' } = {}) {
  if (!id || typeof id !== 'string') throw new Error('profile: id 必填（拒绝无名 ambient profile）');
  if (!CWD_POLICIES.includes(cwdPolicy)) throw new Error(`profile: cwdPolicy 必须是 ${CWD_POLICIES.join('/')}，收到: ${cwdPolicy}`);
  let cwd, cleanup = false;
  if (cwdPolicy === 'scratch') {
    if (root) throw new Error('profile: scratch 策略不接受调用方指定目录');
    cwd = mkdtempSync(path.join(tmpdir(), 'rt-scratch-'));
    cleanup = true;
  } else {
    if (!root || !existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`profile: ${cwdPolicy} 需要一个已存在的目录，收到: ${root}`);
    }
    cwd = root;
  }
  const p = {
    id, version: PROFILE_VERSION, cwdPolicy, cwd, cleanup, role,
    hash: sha256(JSON.stringify({ id, v: PROFILE_VERSION, cwdPolicy, role })).slice(0, 16),
  };
  minted.add(p);
  return p;
}

// 由 profile + 引擎配置重新构造子进程环境：最小集起步，envWhitelist 只能在 ALLOWED_ENV
// 内加项。绝不整包继承 process.env，绝不接受调用方传入的 env。
// cfg.env 是「明确覆盖项」：按名逐个声明的键值（值为 null＝按名继承当前进程该变量）。
// 它是引擎配置里的显式声明（进 manifest 可审计），不是 ambient 继承通道。
export function buildProfileEnv(cfg, source = process.env) {
  const wanted = Array.isArray(cfg.envWhitelist) && cfg.envWhitelist.length ? cfg.envWhitelist : MIN_ENV;
  const env = {};
  for (const k of wanted) {
    if (!ALLOWED_ENV.includes(k)) continue; // 白名单外的名字静默拒绝（manifest 可见实际结果）
    if (source[k] !== undefined) env[k] = source[k];
  }
  for (const [k, v] of Object.entries(cfg.env ?? {})) {
    if (v === null) { if (source[k] !== undefined) env[k] = source[k]; }
    else env[k] = String(v);
  }
  if (cfg.subscriptionOnly) {
    for (const key of Object.keys(env)) {
      if (/^(OPENAI|ANTHROPIC|AZURE|AWS|GOOGLE|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH|CODEX_API|CODEX_ACCESS)/i.test(key)) delete env[key];
    }
  }
  return env;
}

// 一次性 scratch 目录清理（只清本层自建目录；绝不动用户真实配置）
export function cleanupProfile(profile) {
  if (profile?.cleanup && profile.cwd && path.basename(profile.cwd).startsWith('rt-scratch-')) {
    try { rmSync(profile.cwd, { recursive: true, force: true }); } catch { /* 句柄残留下次系统清理 */ }
  }
}

const redactHome = s => String(s).replaceAll(homedir(), '~');
const safeSessionId = value => {
  const sessionId = String(value ?? '');
  return sessionId ? `${sessionId.slice(0, 8)}…` : null;
};
const safeEngineArg = (value, execThread) => {
  const text = redactHome(value);
  const sessionId = String(execThread?.sessionId ?? '');
  return sessionId ? text.replaceAll(sessionId, safeSessionId(sessionId)) : text;
};

function executionThreadSection(execThread, profile) {
  if (!execThread) return null;
  const section = {
    type: execThread.type,
    provider: execThread.provider,
    safeSessionId: safeSessionId(execThread.sessionId),
    cwd: redactHome(execThread.cwd ?? profile.cwd),
    profileId: profile.id,
    profileVersion: profile.version,
    profileHash: profile.hash,
    cwdPolicy: profile.cwdPolicy,
    permSnapshot: structuredClone(execThread.permSnapshot ?? null),
    executionPackageId: execThread.executionPackageId ?? null,
    taskId: execThread.taskId ?? null,
    taskVersion: execThread.taskVersion ?? null,
    decisionVersion: execThread.decisionVersion ?? null,
    fullTextHash: execThread.fullTextHash ?? null,
    userConfirmedAt: execThread.userConfirmedAt ?? null,
    sentAt: execThread.sentAt ?? null,
    userTriggered: execThread.userTriggered === true,
    authorizationEventIds: [...(execThread.authorizationEventIds ?? [])],
    status: execThread.status ?? null,
    diffRef: execThread.diffRef ?? null,
    testRefs: [...(execThread.testRefs ?? [])],
    blockers: [...(execThread.blockers ?? [])],
    reflowSourceType: execThread.reflowSourceType ?? null,
    unobservable: execThread.unobservable ?? 'CLI 内置提示/厂商侧上下文不可观测',
  };
  if (execThread.type === 'external_unverified') {
    section.externalHonesty = 'Roundtable 只验证投递结果，无法验证其 profile/环境/权限/执行安全；delivered≠安全执行或任务完成';
  }
  return section;
}

// 机器可读装配清单：证明本次调用的上下文由 Roundtable 装配。
// 只记录变量名与存在性、材料哈希——绝不写入凭证值或认证文件内容。
export function buildManifest({ profile, cfg, argv, envNames, prompt, materials = null, capabilities = null, execThread = null, result = null }) {
  const iso = isolationFor(cfg, profile.cwdPolicy);
  return {
    generatedAt: new Date().toISOString(),
    profile: { id: profile.id, version: profile.version, hash: profile.hash, role: profile.role },
    cwdPolicy: profile.cwdPolicy,
    cwd: redactHome(profile.cwd),
    engine: { name: cfg.name ?? path.basename(String(cfg.command?.[0] ?? '')), argv: argv.map(value => safeEngineArg(value, execThread)) },
    envVarNames: envNames, // 只有名字，没有值
    materials: {
      promptSha256: sha256(prompt),
      promptBytes: Buffer.byteLength(prompt, 'utf8'),
      ...(materials ? { declared: materials } : {}),
    },
    // 会议模板与能力授权装配（capsManifest 产出：纯安全元数据+哈希，无本体、无秘密）
    ...(capabilities ? { capabilities } : {}),
    ...(execThread ? { executionThread: executionThreadSection(execThread, profile) } : {}),
    forbiddenAmbient: AMBIENT_SOURCES.map(s => ({
      source: s,
      enforcement: iso?.enforcement?.[s] ?? iso?.enforcement?.['*'] ?? 'best-effort (no verified CLI isolation for this engine; min-env + cwd policy only)',
    })),
    // CLI 内置系统提示与厂商侧注入不可观察——只声明装配层可控的部分
    runtimeTrusted: 'CLI built-in system prompt and vendor-side context are not observable from Roundtable; isolation claims cover only the assembly layer (env, cwd, CLI flags).',
    auth: result ? (result.ok ? 'available' : (result.error === 'auth' ? 'unavailable' : 'unknown')) : 'unknown',
  };
}
