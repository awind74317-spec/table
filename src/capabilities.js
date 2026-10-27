// 会议模板与能力授权装配（v1）。
// 铁律：模板只能由用户显式选择——本模块没有、也不许添加任何「按议题猜模板」的逻辑；
// host 全程确定性：编译能力集、解析建议标记、等用户批准、重编译、记录。不做模型推理。
// 未授权能力：模型最多看到 Roundtable 策划的一行安全元数据（catalog.summary），
// 本体（Skill 指令文本）只有 enabled 或本场 granted 之后才装入 prompt。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

export const MEETING_TEMPLATE_IDS = ['basic_strategy', 'product_strategy_review', 'evidence_research', 'technical_review', 'execution_workbench'];
export const DEFAULT_TEMPLATE = 'basic_strategy'; // 通用入口默认；用户可显式切换，绝不因议题文本变化
export const RISK_LEVELS = ['core_discipline', 'analysis_framework', 'perspective', 'research_external', 'project_execution', 'commanding_or_ambient'];
// 需要用户明确确认才能装配的风险类别（core_discipline 可随模板 enabled 直接装）
const CONFIRM_RISKS = new Set(['analysis_framework', 'perspective', 'research_external', 'project_execution']);

const CATALOG_FILE = 'adapters/capabilities.json';
const TEMPLATES_FILE = 'adapters/meeting-templates.json';

const sha256 = s => createHash('sha256').update(s).digest('hex');
const pick = (v, lang) => (v && typeof v === 'object' ? (v[lang] ?? v.zh ?? v.en ?? '') : String(v ?? ''));

export function loadCapabilityConfig({ catalogFile = CATALOG_FILE, templatesFile = TEMPLATES_FILE } = {}) {
  const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'));
  const tpls = JSON.parse(readFileSync(templatesFile, 'utf8'));
  return { catalog: catalog.capabilities ?? {}, catalogVersion: catalog.catalogVersion ?? 1, templates: tpls.templates ?? {}, templatesFile };
}

export const normalizeTemplateId = id => (MEETING_TEMPLATE_IDS.includes(id) ? id : DEFAULT_TEMPLATE);

// 编译本场能力集：模板(enabled/recommendable/blocked/permissions) + 本场授权(grants) → 会话状态。
// grants 只接受该模板 recommendable 里的 id；blocked 与模板外一律拒绝（默认规则：模板外即拒绝）。
export function compileCaps({ templateId, grants = [], config, files }) {
  const cfg = config ?? loadCapabilityConfig(files ?? {});
  const tid = normalizeTemplateId(templateId);
  const tpl = cfg.templates[tid];
  const known = id => !!cfg.catalog[id];
  const enabled = (tpl.enabled ?? []).filter(known);
  const recommendable = (tpl.recommendable ?? []).filter(known);
  const blocked = (tpl.blocked ?? []).filter(known);
  const granted = [...new Set(grants)].filter(id => recommendable.includes(id)); // 模板外/blocked 的授权请求在 grant 入口就被拒，这里兜底再滤一次
  return {
    templateId: tid,
    templateVersion: tpl.version ?? 1,
    templateTitle: tpl.title,
    permissions: { ...(tpl.permissions ?? {}) },
    enabled, recommendable, blocked, granted,
    activeIds: [...enabled, ...granted],
    catalog: cfg.catalog,
    catalogVersion: cfg.catalogVersion,
  };
}

// 判断某能力能否被本场授权（grant 入口的守卫）——返回 null=可以，否则返回拒绝原因
export function grantError(caps, id, lang = 'zh') {
  if (!caps.catalog[id]) return lang === 'en' ? `Unknown capability: ${id} (not in the Roundtable catalog)` : `未知能力：${id}（不在 Roundtable 能力目录中）`;
  if (caps.enabled.includes(id) || caps.granted.includes(id)) return lang === 'en' ? `${id} is already active` : `${id} 已在本场生效`;
  if (caps.blocked.includes(id)) return lang === 'en' ? `${id} is blocked by template ${caps.templateId}` : `${id} 被模板 ${caps.templateId} 明确禁止`;
  if (!caps.recommendable.includes(id)) return lang === 'en' ? `${id} is outside template ${caps.templateId} — capabilities outside the template are rejected by default` : `${id} 不在模板 ${caps.templateId} 的可建议范围内——模板外能力默认拒绝`;
  return null;
}

// 读取能力本体（只在 enabled/granted 后由装配层调用）。返回 null 表示本体不可用。
function readBody(entry, lang) {
  const a = entry.assembly ?? {};
  if (a.type === 'permission-only') return ''; // 纯权限型能力：无本体文本
  const p = a.path ? (a.path.startsWith('~') ? path.join(homedir(), a.path.slice(1)) : a.path) : null;
  if (!p || !existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8');
  // 内联本体支持 <!-- lang:zh --> / <!-- lang:en --> 分节；无分节则整体注入
  const marker = `<!-- lang:${lang} -->`;
  if (raw.includes(marker)) {
    const start = raw.indexOf(marker) + marker.length;
    const next = raw.indexOf('<!-- lang:', start);
    return raw.slice(start, next === -1 ? raw.length : next).trim();
  }
  return raw.trim();
}

// 装配本场纪律块：只包含 enabled + granted 的本体。未授权能力的本体绝不出现在返回值中。
export function disciplineBlock(caps, lang = 'zh') {
  const parts = [];
  for (const id of caps.activeIds) {
    const entry = caps.catalog[id];
    const body = readBody(entry, lang);
    if (body === null) {
      parts.push(lang === 'en' ? `(capability ${id} is authorized but its body is unavailable on this machine)` : `（能力 ${id} 已授权但本体在本机不可用）`);
      continue;
    }
    if (body) parts.push(body);
  }
  if (!parts.length) return '';
  const head = lang === 'en'
    ? `=== Session discipline (meeting template: ${pick(caps.templateTitle, lang)}) ===`
    : `=== 本场纪律（会议模板：${pick(caps.templateTitle, lang)}）===`;
  return [head, ...parts, ''].join('\n');
}

// 建议菜单：只暴露 Roundtable 策划的安全元数据（名称/一行用途/风险/所需权限），
// 并给出确定性建议标记格式。没有可建议项时返回空串（模型无从建议）。
export function suggestionMenu(caps, lang = 'zh') {
  const items = caps.recommendable.filter(id => !caps.granted.includes(id));
  if (!items.length) return '';
  const lines = items.map(id => {
    const e = caps.catalog[id];
    const perms = (e.permissions ?? []).join(',') || (lang === 'en' ? 'none' : '无');
    return `- ${id}｜${pick(e.name, lang)}｜${pick(e.summary, lang)}｜${lang === 'en' ? 'risk' : '风险'}:${e.risk}｜${lang === 'en' ? 'permissions' : '所需权限'}:${perms}`;
  });
  return (lang === 'en'
    ? ['=== Suggestible capabilities (NOT loaded — metadata only) ===',
      'The following capabilities are not active. You only see this Roundtable-curated metadata, not their contents. If one would clearly help the current task, you may suggest it by writing on its own line:',
      '[SUGGEST-CAPABILITY:<id>|reason:<one sentence>]',
      'The user decides; never assume it is active before approval.',
      ...lines, '']
    : ['=== 可建议能力（未装配——仅元数据）===',
      '以下能力当前未启用。你只能看到 Roundtable 策划的元数据，看不到其内容。若某项对当前任务有明确帮助，可单独一行输出建议标记：',
      '【建议能力:<id>|理由:<一句话>】',
      '是否启用由用户决定；批准前不得假设该能力已生效。',
      ...lines, '']
  ).join('\n');
}

// 确定性解析模型输出中的建议标记（中英两种格式）。只认 recommendable 且未授权的 id；
// 其余（未知/已启用/blocked/模板外）原样丢弃并记为 rejected，host 不做任何语义理解。
export function parseCapSuggestions(text, caps) {
  const out = [];
  const rejected = [];
  const re = /(?:【建议能力:([\w-]+)\|理由:([^】]{0,300})】|\[SUGGEST-CAPABILITY:([\w-]+)\|reason:([^\]]{0,300})\])/g;
  for (const m of String(text ?? '').matchAll(re)) {
    const id = m[1] ?? m[3];
    const reason = (m[2] ?? m[4] ?? '').trim();
    if (caps.recommendable.includes(id) && !caps.granted.includes(id)) {
      if (!out.some(s => s.id === id)) out.push({ id, reason });
    } else {
      rejected.push({ id, reason: grantError(caps, id) ?? 'duplicate' });
    }
  }
  return { suggestions: out, rejected };
}

// 承重墙（结构层）：用户输入/外部材料里的控制类标记在进入任何 prompt 或存储前拆除引信。
// 原理：能力建议协议只属于「模型输出」信道；材料/聊天文本中的同形标记若原样入库，
// 会经「模型回显」洗白成模型信道内容——在源头改写使其永远无法匹配解析正则。
// 拆除后仍可读（标注「已拆除」），不丢用户内容。
export function defuseControlMarkers(text) {
  return String(text ?? '')
    .replaceAll('【建议能力:', '【建议能力(已拆除):')
    .replace(/\[SUGGEST-CAPABILITY:/gi, '[SUGGEST-CAPABILITY(defused):')
    // 执行线程控制标记同样拆除：回流的 CLI 输出/材料绝不能携带线程状态/工具/发送类标记
    // 经「模型回显」洗白成控制信道（与能力标记同源的间接注入面）。
    .replaceAll('【线程状态:', '【线程状态(已拆除):')
    .replace(/\[(TOOL-CALL|SEND-EXECUTION|HOST-COMMAND|THREAD-STATUS):/gi, '[$1(defused):');
}

// 建议标记从展示文本中剥离（用户看到的是卡片，不是原始标记）
export const stripCapMarkers = text =>
  String(text ?? '').replace(/(?:【建议能力:[\w-]+\|理由:[^】]{0,300}】|\[SUGGEST-CAPABILITY:[\w-]+\|reason:[^\]]{0,300}\])/g, '').replace(/\n{3,}/g, '\n\n').trim();

// manifest 的能力小节：全部为安全元数据与哈希，不含本体文本、不含秘密。
export function capsManifest(caps, { suggested = [], deniedLog = [], grantLog = [] } = {}) {
  const coreBody = (() => {
    const e = caps.catalog['strategy-core'];
    if (!e) return null;
    const body = readBody(e, 'zh');
    return body === null ? null : sha256(body);
  })();
  const meta = id => {
    const e = caps.catalog[id] ?? {};
    return { id, version: e.version ?? null, source: e.source ?? null, risk: e.risk ?? null };
  };
  return {
    meetingTemplate: { id: caps.templateId, version: caps.templateVersion },
    strategyCore: { version: caps.catalog['strategy-core']?.version ?? null, bodySha256: coreBody },
    enabled: caps.enabled.map(id => ({ ...meta(id), reason: 'template-enabled' })),
    granted: caps.granted.map(id => ({ ...meta(id), reason: 'session-grant' })),
    suggestedPending: suggested.map(s => ({ id: s.id, reason: s.reason })),
    deniedOrBlocked: [...caps.blocked.map(id => ({ id, reason: 'template-blocked' })), ...deniedLog],
    permissions: caps.permissions,
    authorizationHistory: grantLog,
    honesty: 'This section proves the Roundtable-controlled assembly layer only. CLI built-in prompts and vendor-side context are not observable; isolation is not claimed to be absolute.',
  };
}

// 模板写回（第二次确认后才调用）：版本 +1，追加不可变记录。本场授权绝不自动走到这里。
export function writebackTemplate({ templatesFile = TEMPLATES_FILE, catalogFile = CATALOG_FILE, templateId, capId, approvedBy = 'user', reason = '', phase = 'discussion', config }) {
  const cfg = config ?? loadCapabilityConfig({ templatesFile, catalogFile });
  const tid = normalizeTemplateId(templateId);
  const raw = JSON.parse(readFileSync(templatesFile, 'utf8'));
  const tpl = raw.templates[tid];
  if (!tpl) throw new Error(`未知模板: ${templateId}`);
  if (!cfg.catalog[capId]) throw new Error(`未知能力: ${capId}`);
  if ((tpl.enabled ?? []).includes(capId)) throw new Error(`能力 ${capId} 已在模板 ${tid} 中启用`);
  if (!(tpl.recommendable ?? []).includes(capId)) throw new Error(`能力 ${capId} 不在模板 ${tid} 的可建议范围内，不能写回`);
  const fromVersion = tpl.version ?? 1;
  tpl.enabled = [...(tpl.enabled ?? []), capId];
  tpl.recommendable = (tpl.recommendable ?? []).filter(x => x !== capId);
  tpl.version = fromVersion + 1;
  tpl.writebackHistory = [...(tpl.writebackHistory ?? []), {
    capId, capVersion: cfg.catalog[capId].version ?? null,
    approvedBy, reason, phase,
    at: new Date().toISOString(),
    templateVersion: { from: fromVersion, to: tpl.version },
  }];
  writeFileSync(templatesFile, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return tpl.writebackHistory.at(-1);
}
