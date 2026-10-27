import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadCapabilityConfig, compileCaps, disciplineBlock, suggestionMenu, parseCapSuggestions,
  stripCapMarkers, capsManifest, grantError, writebackTemplate, normalizeTemplateId,
  DEFAULT_TEMPLATE, MEETING_TEMPLATE_IDS,
} from '../src/capabilities.js';
import { Workbench } from '../src/workbench.js';
import { Committee } from '../src/orchestrator.js';

const MOCK_CLI = path.resolve('test/mock-cli.cjs');
const MOCK_AGENTS = () => ({
  m1: { name: 'M1', command: [process.execPath, MOCK_CLI], input: 'stdin', output: 'text', timeoutMs: 5000, envWhitelist: ['PATH', 'SYSTEMROOT'], env: { MOCK_FIXED_OUTPUT: null } },
  m2: { name: 'M2', command: [process.execPath, MOCK_CLI], input: 'stdin', output: 'text', timeoutMs: 5000, envWhitelist: ['PATH', 'SYSTEMROOT'], env: { MOCK_FIXED_OUTPUT: null } },
});

// 造一套隔离的 catalog/模板文件：含一个「秘密本体」能力用来验证未授权不进 prompt
function makeFixtureConfig() {
  const dir = mkdtempSync(path.join(tmpdir(), 'rt-caps-'));
  const bodyDir = path.join(dir, 'bodies');
  cpSync('capabilities', bodyDir, { recursive: true });
  const secretBody = path.join(dir, 'secret-framework.md');
  writeFileSync(secretBody, 'SECRET_FRAMEWORK_BODY_TOKEN: 遇事先问祖师爷。');
  const catalogFile = path.join(dir, 'capabilities.json');
  const real = JSON.parse(readFileSync('adapters/capabilities.json', 'utf8'));
  real.capabilities['strategy-core'].assembly.path = path.join(bodyDir, 'strategy-core.md');
  real.capabilities['secret-framework'] = {
    name: { zh: '秘密框架', en: 'Secret framework' },
    summary: { zh: '一个需要确认的示例框架（测试用）', en: 'An example framework requiring confirmation (test)' },
    version: 3, source: 'user-skill', risk: 'analysis_framework', permissions: [],
    phases: ['discussion'], assembly: { type: 'user-skill', path: secretBody },
  };
  writeFileSync(catalogFile, JSON.stringify(real, null, 2));
  const templatesFile = path.join(dir, 'meeting-templates.json');
  const tpls = JSON.parse(readFileSync('adapters/meeting-templates.json', 'utf8'));
  tpls.templates.product_strategy_review.recommendable.push('secret-framework');
  writeFileSync(templatesFile, JSON.stringify(tpls, null, 2));
  return { dir, catalogFile, templatesFile, files: { catalogFile, templatesFile } };
}

// ---- 1/2/3. 模板只认显式选择：默认 basic_strategy，绝不按议题文本猜 ----
test('caps: 通用入口默认 basic_strategy；未知/空模板 id 归一化为默认', () => {
  assert.equal(normalizeTemplateId(''), DEFAULT_TEMPLATE);
  assert.equal(normalizeTemplateId('nonsense'), DEFAULT_TEMPLATE);
  for (const id of MEETING_TEMPLATE_IDS) assert.equal(normalizeTemplateId(id), id);
});

test('caps: 系统不根据议题文本猜模板——不同议题得到同一默认模板；显式选择正确生效', async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-capdef-'));
  // 议题文本明显是「技术评审」，但没显式选模板 → 仍是 basic_strategy
  const w1 = new Workbench({ name: '帮我做技术方案评审', agents: MOCK_AGENTS(), participants: ['m1'], baseDir, emit: () => {} });
  assert.equal(w1.caps.templateId, 'basic_strategy');
  const w2 = new Workbench({ name: '随便聊聊', agents: MOCK_AGENTS(), participants: ['m1'], baseDir, emit: () => {} });
  assert.equal(w2.caps.templateId, w1.caps.templateId);
  // 显式选择 → 对应模板
  const w3 = new Workbench({ name: 'x', agents: MOCK_AGENTS(), participants: ['m1'], baseDir, emit: () => {}, caps: { templateId: 'technical_review' } });
  assert.equal(w3.caps.templateId, 'technical_review');
  assert.ok(w3.caps.enabled.includes('tech-review-discipline'));
});

// ---- 4. 模板外能力默认拒绝 ----
test('caps: 模板外/blocked/未知能力一律拒绝授权', () => {
  const fx = makeFixtureConfig();
  const caps = compileCaps({ templateId: 'basic_strategy', files: fx.files });
  assert.match(grantError(caps, 'secret-framework'), /不在模板/); // basic 模板外
  assert.match(grantError(caps, 'no-such-cap'), /未知能力/);
  const exec = compileCaps({ templateId: 'execution_workbench', files: fx.files });
  assert.match(grantError(exec, 'web-research'), /明确禁止/); // blocked
  // compileCaps 对越权 grants 兜底过滤
  const sneaky = compileCaps({ templateId: 'basic_strategy', grants: ['secret-framework'], files: fx.files });
  assert.deepEqual(sneaky.granted, []);
});

// ---- 5. 未授权本体不进 prompt；6. 只暴露策划元数据 ----
test('caps: 未授权 Skill 本体绝不进入纪律块；建议菜单只含安全元数据', () => {
  const fx = makeFixtureConfig();
  const caps = compileCaps({ templateId: 'product_strategy_review', files: fx.files });
  const block = disciplineBlock(caps, 'zh');
  assert.ok(block.includes('独立判断')); // strategy-core 本体已装配
  assert.ok(!block.includes('SECRET_FRAMEWORK_BODY_TOKEN'), '未授权本体不得出现');
  const menu = suggestionMenu(caps, 'zh');
  assert.ok(menu.includes('secret-framework')); // id 与安全元数据可见
  assert.ok(menu.includes('需要确认的示例框架'));
  assert.ok(!menu.includes('SECRET_FRAMEWORK_BODY_TOKEN'), '菜单只含 Roundtable 策划元数据');
  assert.ok(!menu.includes('祖师爷'));
});

// ---- 7. 本场授权后才装配本体 ----
test('caps: 本场授权后本体才进入纪律块，且建议菜单移除该项', () => {
  const fx = makeFixtureConfig();
  const caps = compileCaps({ templateId: 'product_strategy_review', grants: ['secret-framework'], files: fx.files });
  const block = disciplineBlock(caps, 'zh');
  assert.ok(block.includes('SECRET_FRAMEWORK_BODY_TOKEN'), '授权后本体应装配');
  assert.ok(!suggestionMenu(caps, 'zh').includes('secret-framework'));
});

// ---- 建议标记确定性解析 ----
test('caps: 建议标记解析——只认 recommendable，未知/模板外丢弃并记拒绝；中英格式都认', () => {
  const fx = makeFixtureConfig();
  const caps = compileCaps({ templateId: 'product_strategy_review', files: fx.files });
  const text = '我觉得可以。【建议能力:secret-framework|理由:需要框架】另外[SUGGEST-CAPABILITY:web-research|reason:need web]和【建议能力:secret-framework|理由:重复】';
  const { suggestions, rejected } = parseCapSuggestions(text, caps);
  assert.deepEqual(suggestions.map(s => s.id), ['secret-framework']); // web-research 不在该模板 → 拒；重复去重
  assert.ok(rejected.some(r => r.id === 'web-research'));
  const stripped = stripCapMarkers(text);
  assert.ok(!stripped.includes('建议能力') && !stripped.includes('SUGGEST-CAPABILITY'));
  assert.ok(stripped.includes('我觉得可以。'));
});

// ---- 8/9. 本场批准不写回模板；写回是独立流程且版本化 ----
test('caps: 本场授权不改模板文件；writeback 独立确认后版本 +1 并留不可变记录', async () => {
  const fx = makeFixtureConfig();
  const before = readFileSync(fx.templatesFile, 'utf8');
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-capgrant-'));
  const w = new Workbench({
    name: 'g', agents: MOCK_AGENTS(), participants: ['m1'], baseDir, emit: () => {},
    caps: { templateId: 'product_strategy_review' }, capFiles: fx.files,
  });
  await w.init();
  await w.grantCapability('secret-framework');
  assert.ok(w.caps.granted.includes('secret-framework'));
  assert.equal(readFileSync(fx.templatesFile, 'utf8'), before, '本场授权绝不自动写回模板');
  // 独立写回
  const rec = writebackTemplate({ templatesFile: fx.templatesFile, catalogFile: fx.catalogFile, templateId: 'product_strategy_review', capId: 'secret-framework', reason: '测试写回', phase: 'discussion' });
  const after = JSON.parse(readFileSync(fx.templatesFile, 'utf8')).templates.product_strategy_review;
  assert.equal(after.version, 2);
  assert.ok(after.enabled.includes('secret-framework'));
  assert.ok(!after.recommendable.includes('secret-framework'));
  assert.equal(after.writebackHistory.length, 1);
  assert.deepEqual(rec.templateVersion, { from: 1, to: 2 });
  assert.equal(rec.capVersion, 3);
  assert.ok(rec.at && rec.approvedBy === 'user' && rec.reason === '测试写回');
  // 二次写回同一能力应报错（已启用）
  assert.throws(() => writebackTemplate({ templatesFile: fx.templatesFile, catalogFile: fx.catalogFile, templateId: 'product_strategy_review', capId: 'secret-framework' }), /已在模板/);
});

// ---- 工作台集成：prompt 装配 + 建议事件 + 授权后生效 ----
test('caps: 工作台 prompt 含已授权纪律、不含未授权本体；模型建议→事件→授权→下一条才装配', async () => {
  const fx = makeFixtureConfig();
  const baseDir = mkdtempSync(path.join(tmpdir(), 'wb-capflow-'));
  const events = [];
  const w = new Workbench({
    name: 'f', agents: MOCK_AGENTS(), participants: ['m1'], baseDir, emit: e => events.push(e),
    caps: { templateId: 'product_strategy_review' }, capFiles: fx.files,
  });
  await w.init();
  // mock 回显完整 prompt → 回复内容即 prompt，可直接断言装配情况
  await w.message('你好', ['m1']);
  const echoed = w.messages[1].text;
  assert.ok(echoed.includes('独立判断'), 'strategy-core 已装配');
  assert.ok(echoed.includes('secret-framework'), '可建议菜单含 id');
  assert.ok(!echoed.includes('SECRET_FRAMEWORK_BODY_TOKEN'), '未授权本体不在 prompt');
  // 模型输出建议标记 → cap-suggestion 事件，展示文本剥离标记，且不自动装配
  process.env.MOCK_FIXED_OUTPUT = '同意。【建议能力:secret-framework|理由:该任务需要框架】';
  try { await w.message('继续', ['m1']); } finally { delete process.env.MOCK_FIXED_OUTPUT; }
  const sug = events.find(e => e.type === 'cap-suggestion');
  assert.ok(sug && sug.data.id === 'secret-framework');
  assert.equal(sug.data.reason, '该任务需要框架');
  assert.ok(!w.messages.at(-1).text.includes('建议能力'), '展示文本剥离标记');
  assert.ok(!w.caps.granted.length, '建议绝不自动授权');
  // 用户授权 → 下一条 prompt 才含本体
  await w.grantCapability('secret-framework');
  await w.message('再来', ['m1']);
  assert.ok(w.messages.at(-1).text.includes('SECRET_FRAMEWORK_BODY_TOKEN'), '授权后本体装配进 prompt');
});

// ---- 10/11. 控制链共享同一授权；角色不能私自扩权 ----
test('caps: 辩手/书记/仲裁共用同一授权装配（call 单一漏斗），并进 manifest', async () => {
  const fx = makeFixtureConfig();
  const baseDir = mkdtempSync(path.join(tmpdir(), 'cm-caps-'));
  const agents = {
    a: { name: 'A', command: [process.execPath, MOCK_CLI], input: 'stdin', output: 'text', timeoutMs: 5000, envWhitelist: ['PATH', 'SYSTEMROOT'], roles: ['debater', 'judge', 'summarizer'] },
    b: { name: 'B', command: [process.execPath, MOCK_CLI], input: 'stdin', output: 'text', timeoutMs: 5000, envWhitelist: ['PATH', 'SYSTEMROOT'], roles: ['debater', 'judge', 'summarizer'] },
    s: { name: 'S', command: [process.execPath, MOCK_CLI], input: 'stdin', output: 'text', timeoutMs: 5000, envWhitelist: ['PATH', 'SYSTEMROOT'], roles: ['summarizer'] },
  };
  const c = new Committee({
    topic: '测试', materials: '', agents, roles: { debaters: ['a', 'b'], judge: 'a', summarizer: 's' },
    template: { name: 'general', injections: {}, debaterFormat: '', judgeFormat: '' }, mode: 'manual', maxRounds: 2,
    baseDir, emit: () => {}, caps: { templateId: 'technical_review' }, capFiles: fx.files,
  });
  await c.init();
  await c.runNextRound();
  // 辩手 a、b 与书记 s 的 prompt（mock 回显）都含同一份纪律，且都没有未授权本体
  const r1 = c.history.at(-1);
  for (const id of ['a', 'b']) {
    assert.ok(r1.outputs[id].text.includes('可行性'), `辩手 ${id} 装配技术评审纪律`);
    assert.ok(!r1.outputs[id].text.includes('SECRET_FRAMEWORK_BODY_TOKEN'));
  }
  assert.ok(r1.summary.includes('可行性'), '书记同样装配同一纪律');
  // manifest 记录能力小节
  const mf = JSON.parse(readFileSync(path.join(c.dir, 'manifests', 'r1-a.context_manifest.json'), 'utf8'));
  assert.equal(mf.capabilities.meetingTemplate.id, 'technical_review');
  assert.ok(mf.capabilities.enabled.some(e => e.id === 'strategy-core'));
  assert.match(mf.capabilities.honesty, /assembly layer/);
});

// ---- 12. manifest 记录完整且无秘密 ----
test('caps: capsManifest 记录启用/建议/拒绝/授权史与哈希，不含本体与秘密', () => {
  const fx = makeFixtureConfig();
  const caps = compileCaps({ templateId: 'product_strategy_review', grants: ['secret-framework'], files: fx.files });
  const m = capsManifest(caps, {
    suggested: [{ id: 'x', reason: 'r' }],
    deniedLog: [{ id: 'web-research', reason: 'user-denied' }],
    grantLog: [{ id: 'secret-framework', action: 'session-grant', by: 'user', at: '2026-07-23T00:00:00Z' }],
  });
  assert.equal(m.meetingTemplate.id, 'product_strategy_review');
  assert.equal(m.strategyCore.bodySha256.length, 64);
  assert.ok(m.granted.some(g => g.id === 'secret-framework' && g.version === 3 && g.reason === 'session-grant'));
  assert.ok(m.suggestedPending.length === 1 && m.deniedOrBlocked.length >= 1 && m.authorizationHistory.length === 1);
  const raw = JSON.stringify(m);
  assert.ok(!raw.includes('SECRET_FRAMEWORK_BODY_TOKEN'), 'manifest 不含本体');
  assert.ok(!raw.includes('独立判断'), 'manifest 不含 strategy-core 本体文本（只有哈希）');
});

// ---- 13/16/17. 隔离不回归：catalog 元数据无祈使命令；codex 残余仍如实 best-effort ----
test('caps: 出厂 catalog 元数据不含祈使命令/隐藏指令；codex 残余标注未被伪装', () => {
  const cfg = loadCapabilityConfig();
  for (const [id, e] of Object.entries(cfg.catalog)) {
    for (const lang of ['zh', 'en']) {
      const s = (e.summary?.[lang] ?? '') + (e.name?.[lang] ?? '');
      assert.ok(!/必须先调用|你必须|You must call|Always invoke|IMPORTANT:/i.test(s), `catalog ${id} 元数据不得含强制命令`);
    }
    assert.ok(e.risk && e.version && e.source, `catalog ${id} 元数据字段齐全`);
  }
  // 隔离层诚实性复查（与 profile.js 联动）：codex 的全局 AGENTS.md/skills 残余仍标 partial/not-enforced
  return import('../src/profile.js').then(({ isolationFor }) => {
    const iso = isolationFor({ command: ['codex.exe'] }, 'scratch');
    assert.match(iso.enforcement['user-global-config'], /partial/);
    assert.match(iso.enforcement.skills, /not-enforced/);
  });
});
