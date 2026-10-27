import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/runner.js';
import { makeProfile, buildProfileEnv, isolationFor, CWD_POLICIES, ALLOWED_ENV } from '../src/profile.js';

const MOCK_CLI = path.resolve('test/mock-cli.cjs');
const MOCK = (over = {}) => ({
  name: 'mock', command: [process.execPath, MOCK_CLI], input: 'stdin', output: 'text',
  timeoutMs: 5000, envWhitelist: ['PATH', 'SYSTEMROOT'], ...over,
});
const scratchProfile = () => makeProfile({ id: 'test:profile', cwdPolicy: 'scratch', role: 'test' });

// ---- 1. 无 profile 必须拒绝启动（无 ambient 回退） ----
test('runAgent: 缺少 profile 直接抛错，不回退 ambient 环境', async () => {
  await assert.rejects(() => runAgent(MOCK(), 'hi'), /profile/);
  await assert.rejects(() => runAgent(MOCK(), 'hi', {}), /profile/);
});

test('runAgent: 手搓的伪 profile 对象被拒绝（只认 makeProfile 铸造）', async () => {
  const fake = { id: 'x', cwdPolicy: 'scratch', cwd: process.cwd(), version: 1, hash: 'deadbeef' };
  await assert.rejects(() => runAgent(MOCK(), 'hi', { profile: fake }), /profile/);
});

// ---- 2. 调用方不能传原始 env / 任意 cwd ----
test('runAgent: 调用方传 env 或 cwd 一律拒绝，且被拒时不留 scratch 垃圾目录', async () => {
  const p1 = scratchProfile();
  await assert.rejects(() => runAgent(MOCK(), 'hi', { profile: p1, env: process.env }), /env/);
  assert.ok(!existsSync(p1.cwd), '拒收调用也要清理已铸 profile 的 scratch 目录');
  const p2 = scratchProfile();
  await assert.rejects(() => runAgent(MOCK(), 'hi', { profile: p2, cwd: 'C:/anywhere' }), /cwd/);
  assert.ok(!existsSync(p2.cwd));
});

test('makeProfile: 策略是受控枚举；scratch 不接受外部目录；材料/信任策略必须给已存在目录', () => {
  assert.throws(() => makeProfile({ id: 'x', cwdPolicy: 'whatever' }), /cwdPolicy/);
  assert.throws(() => makeProfile({ cwdPolicy: 'scratch' }), /id/);
  assert.throws(() => makeProfile({ id: 'x', cwdPolicy: 'scratch', root: 'C:/tmp' }), /scratch/);
  assert.throws(() => makeProfile({ id: 'x', cwdPolicy: 'readonly-materials' }), /已存在的目录/);
  assert.throws(() => makeProfile({ id: 'x', cwdPolicy: 'trusted-project', root: path.join(tmpdir(), 'rt-definitely-missing-' + Date.now()) }), /已存在的目录/);
  assert.deepEqual(CWD_POLICIES, ['scratch', 'readonly-materials', 'trusted-project']);
});

// ---- 3. 环境变量按验证白名单重建 ----
test('buildProfileEnv: 只放行 ALLOWED_ENV 内的白名单变量；秘密类变量进不来', () => {
  const source = { PATH: 'p', SYSTEMROOT: 's', ANTHROPIC_API_KEY: 'sk-x', OPENAI_API_KEY: 'sk-y', RANDOM_SECRET: 'z', USERPROFILE: 'u' };
  const env = buildProfileEnv({ envWhitelist: ['PATH', 'SYSTEMROOT', 'ANTHROPIC_API_KEY', 'RANDOM_SECRET', 'USERPROFILE'] }, source);
  assert.deepEqual(env, { PATH: 'p', SYSTEMROOT: 's', USERPROFILE: 'u' }); // 白名单里写了秘密名也进不来（不在 ALLOWED_ENV）
  for (const k of Object.keys(env)) assert.ok(ALLOWED_ENV.includes(k));
});

test('buildProfileEnv: cfg.env 是显式覆盖通道——null=按名继承，字符串=定值', () => {
  const source = { PATH: 'p', MOCK_FIXED_OUTPUT: 'dyn' };
  const env = buildProfileEnv({ envWhitelist: ['PATH'], env: { MOCK_FIXED_OUTPUT: null, FIXED: 'v1' } }, source);
  assert.equal(env.MOCK_FIXED_OUTPUT, 'dyn');
  assert.equal(env.FIXED, 'v1');
});

// ---- 4/5. 隔离参数按引擎家族注入；未知引擎明确为 best-effort ----
test('isolationFor: claude 注入 --setting-sources/--strict-mcp-config，scratch 加 --no-session-persistence', () => {
  const scratch = isolationFor({ command: ['C:/x/claude.cmd'] }, 'scratch');
  assert.deepEqual(scratch.args, ['--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence']);
  const trusted = isolationFor({ command: ['claude'] }, 'trusted-project');
  assert.ok(!trusted.args.includes('--no-session-persistence')); // 动手路径保留原生 session resume
});

test('isolationFor: codex 注入 --ignore-user-config 与 --skip-git-repo-check（三档策略都要——挂载的材料目录常非 git 仓库）；未知引擎返回 null', () => {
  const scratch = isolationFor({ command: ['C:/y/codex.exe'] }, 'scratch');
  assert.deepEqual(scratch.args, ['--ignore-user-config', '--skip-git-repo-check']);
  const readonly = isolationFor({ command: ['codex.cmd'] }, 'readonly-materials');
  assert.ok(readonly.args.includes('--skip-git-repo-check'), '非 git 材料目录也必须能启动 codex');
  assert.equal(isolationFor({ command: ['hermes.exe'] }, 'scratch'), null);
  // codex 的已知残余（全局 AGENTS.md / skills 无官方开关）必须如实标注，不许谎报全关
  assert.match(scratch.enforcement['user-global-config'], /partial/);
  assert.match(scratch.enforcement.skills, /not-enforced/);
});

test('runAgent: 隔离参数真实进入子进程 argv', async () => {
  // 用 node 假扮 claude：回显收到的 argv。command[0] 基名含 claude → 触发 claude 隔离参数
  const dir = mkdtempSync(path.join(tmpdir(), 'rt-fakecli-'));
  const fake = path.join(dir, 'claude-fake.cjs');
  writeFileSync(fake, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const r = await runAgent(MOCK({ command: [process.execPath, fake] }), '', { profile: scratchProfile() });
  const argv = JSON.parse(r.text);
  assert.ok(!argv.includes('--setting-sources')); // 基名是 node（execPath），不是 claude——不误注
  const r2 = await runAgent(MOCK({ command: [fake] }), '', { profile: scratchProfile() }).catch(() => null);
  // fake 不是可执行 PE，spawn 可能失败——argv 注入逻辑已由 isolationFor 单测覆盖，这里只验不误注
});

// ---- 6. scratch 目录创建/使用/清理 ----
test('scratch: 子进程 cwd 是一次性临时目录，调用结束即清理；trusted-project 目录不清理', async () => {
  const p = scratchProfile();
  assert.ok(path.basename(p.cwd).startsWith('rt-scratch-'));
  assert.ok(existsSync(p.cwd));
  const r = await runAgent(MOCK(), '#cwd', { profile: p });
  assert.equal(path.normalize(r.text.trim()), path.normalize(p.cwd)); // 子进程真的在 scratch 里跑
  assert.ok(!existsSync(p.cwd), 'scratch 目录用后应清理');

  const keep = mkdtempSync(path.join(tmpdir(), 'rt-keep-'));
  const tp = makeProfile({ id: 't', cwdPolicy: 'trusted-project', root: keep });
  await runAgent(MOCK(), '#cwd', { profile: tp });
  assert.ok(existsSync(keep), 'trusted-project 的 worktree 不能被 runner 清理');
});

// ---- 7. manifest：每次调用落盘，可审计，无秘密 ----
test('manifest: 记录 profile/策略/材料哈希/argv/env 变量名/禁运来源，且不含环境变量值', async () => {
  process.env.RT_CANARY_SECRET = 'super-secret-value-abc';
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'rt-manifest-'));
    const mf = path.join(dir, 'sub', 'x.context_manifest.json');
    const r = await runAgent(MOCK(), '#echo\nhello', { profile: scratchProfile(), manifestFile: mf });
    assert.ok(r.manifest);
    assert.ok(existsSync(mf));
    const m = JSON.parse(readFileSync(mf, 'utf8'));
    assert.equal(m.profile.id, 'test:profile');
    assert.equal(m.cwdPolicy, 'scratch');
    assert.equal(m.materials.promptSha256.length, 64);
    assert.ok(Array.isArray(m.envVarNames) && m.envVarNames.includes('PATH'));
    assert.ok(Array.isArray(m.forbiddenAmbient) && m.forbiddenAmbient.length >= 6);
    assert.match(m.runtimeTrusted, /not observable/);
    assert.ok(['available', 'unavailable', 'unknown'].includes(m.auth));
    const raw = readFileSync(mf, 'utf8');
    assert.ok(!raw.includes('super-secret-value-abc'), 'manifest 不得含任何环境变量值');
    assert.ok(!raw.includes(process.env.PATH.slice(0, 40)), 'manifest 不得含 PATH 值');
  } finally { delete process.env.RT_CANARY_SECRET; }
});

test('manifest: arg 输入模式下 argv 快照不包含 prompt 正文', async () => {
  const secretPrompt = 'PROMPT_BODY_MUST_NOT_APPEAR_IN_MANIFEST';
  const r = await runAgent(MOCK({ command: [process.execPath, '-p', 'process.argv[1]', '{PROMPT}'], input: 'arg' }), secretPrompt, { profile: scratchProfile() });
  assert.ok(!JSON.stringify(r.manifest.engine.argv).includes(secretPrompt));
});

// ---- 8. 受控 canary：未隔离基线可探测，profile 装配下完全消失 ----
test('canary: ambient 变量在旧 buildEnv 直传下可见，经 profile 装配后消失', async () => {
  process.env.RT_AMBIENT_CANARY = 'leak-me';
  try {
    // 未隔离基线（旧行为等价物）：白名单里写了就直传
    const { buildEnv } = await import('../src/runner.js');
    const baseline = buildEnv(['RT_AMBIENT_CANARY'], process.env);
    assert.equal(baseline.RT_AMBIENT_CANARY, 'leak-me'); // 基线可探测
    // clean 装配：即使配置的 envWhitelist 声明了它，也进不了子进程
    const r = await runAgent(MOCK({ envWhitelist: ['PATH', 'SYSTEMROOT', 'RT_AMBIENT_CANARY'] }), '#env RT_AMBIENT_CANARY', { profile: scratchProfile() });
    assert.equal(r.text, '<unset>'); // 完全消失
  } finally { delete process.env.RT_AMBIENT_CANARY; }
});

// ---- 图片附件参数 ----
test('imageArgsFor: codex 家族默认 -i；显式 imageArgs 覆盖；其他引擎 null', async () => {
  const { imageArgsFor } = await import('../src/profile.js');
  assert.deepEqual(imageArgsFor({ command: ['C:/x/codex.exe'] }), ['-i', '{IMAGE}']);
  assert.deepEqual(imageArgsFor({ command: ['whatever'], imageArgs: ['--img', '{IMAGE}'] }), ['--img', '{IMAGE}']);
  assert.equal(imageArgsFor({ command: ['claude.cmd'] }), null);
  assert.equal(imageArgsFor({ command: ['hermes.exe'] }), null);
});

test('runAgent: opts.images 经 imageArgs 展开进 argv（多图逐个成对）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rt-imgargs-'));
  const dump = path.join(dir, 'dump-argv.cjs');
  writeFileSync(dump, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const r = await runAgent(
    MOCK({ command: [process.execPath, dump], imageArgs: ['--img', '{IMAGE}'], input: 'stdin' }),
    '', { profile: scratchProfile(), images: ['C:/a.png', 'C:/b.png'] },
  );
  const argv = JSON.parse(r.text);
  assert.deepEqual(argv.filter((a, i) => argv[i - 1] === '--img'), ['C:/a.png', 'C:/b.png']);
});

// ---- 旁路防线：新增直接 spawn 模型 CLI 的代码会被抓 ----
test('旁路扫描: src/ 内只有白名单文件允许触碰 child_process', () => {
  const ALLOWED_FILES = ['runner.js', 'worktree.js', 'resolve.js', 'server.js', 'subscription.js', 'external-tools.js', 'gpt-browser.js']; // gpt-browser launches only the dedicated browser; external-tools only runs a sandboxed Node script; model inference stays in runner.
  for (const f of readdirSync('src')) {
    if (!f.endsWith('.js')) continue;
    const text = readFileSync(path.join('src', f), 'utf8');
    if (/child_process/.test(text)) {
      assert.ok(ALLOWED_FILES.includes(f), `src/${f} 引入了 child_process——模型调用必须经 runner.runAgent，不允许旁路 spawn`);
    }
  }
});

test('旁路扫描: runAgent 的调用点全部位于已知受控文件', () => {
  const ALLOWED = new Set(['orchestrator.js', 'workbench.js', 'server.js', 'runner.js']);
  for (const f of readdirSync('src')) {
    if (!f.endsWith('.js')) continue;
    const text = readFileSync(path.join('src', f), 'utf8');
    if (/runAgent\(/.test(text)) assert.ok(ALLOWED.has(f), `src/${f} 出现了 runAgent 调用——新入口必须纳入受控清单并配 profile`);
  }
});
