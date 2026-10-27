import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(String(value), 'utf8').digest('hex');
const normalizeNewlines = value => String(value ?? '').replace(/\r\n?/g, '\n');
const normalizeBlock = value => normalizeNewlines(value).trim();

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

const stableJson = value => JSON.stringify(stableValue(value));
const asText = value => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return stableJson(value);
  return normalizeBlock(value);
};
const asList = value => {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean);
  if (value === null || value === undefined || value === '') return [];
  return normalizeNewlines(value).split('\n').map(asText).filter(Boolean);
};
const nullableText = value => {
  const text = asText(value);
  return text || null;
};

export const sha256Text = value => digest(value);
export const utf8Bytes = value => Buffer.byteLength(String(value), 'utf8');

const PACKAGE_LABELS = Object.freeze({
  zh: {
    title: '执行交接', source: '来源', meetingId: '会议', decisionVersion: '裁决版本',
    objective: '目标', confirmedFacts: '已确认事实', assumptions: '假设', decisions: '决策',
    scope: '范围', allowedPaths: '允许路径', allowedOperations: '允许操作',
    forbiddenOperations: '禁止操作', acceptanceCriteria: '验收标准', constraints: '约束',
    requiredChecks: '必需检查', unresolved: '未决', empty: '（无）',
  },
  en: {
    title: 'Execution Handoff', source: 'Source', meetingId: 'Meeting', decisionVersion: 'Decision version',
    objective: 'Objective', confirmedFacts: 'Confirmed Facts', assumptions: 'Assumptions', decisions: 'Decisions',
    scope: 'Scope', allowedPaths: 'Allowed Paths', allowedOperations: 'Allowed Operations',
    forbiddenOperations: 'Forbidden Operations', acceptanceCriteria: 'Acceptance Criteria', constraints: 'Constraints',
    requiredChecks: 'Required Checks', unresolved: 'Unresolved', empty: '(none)',
  },
});

const renderList = (items, empty) => (items.length
  ? items.map(item => `- ${item.replaceAll('\n', '\n  ')}`).join('\n')
  : empty);

function normalizeFields(input = {}) {
  const context = input.context ?? {};
  return {
    taskVersion: Number(input.taskVersion),
    meetingId: nullableText(input.meetingId),
    decisionVersion: nullableText(input.decisionVersion),
    objective: asText(input.objective),
    confirmedFacts: asList(input.confirmedFacts ?? context.confirmedFacts),
    assumptions: asList(input.assumptions ?? context.assumptions),
    decisions: asList(input.decisions ?? context.decisions),
    scope: {
      allowedPaths: asList(input.scope?.allowedPaths),
      allowedOperations: asList(input.scope?.allowedOperations),
      forbiddenOperations: asList(input.scope?.forbiddenOperations),
    },
    acceptanceCriteria: asList(input.acceptanceCriteria),
    constraints: asList(input.constraints),
    requiredChecks: asList(input.requiredChecks),
    unresolved: asList(input.unresolved ?? context.unresolved),
    createdAt: nullableText(input.createdAt),
    lang: input.lang === 'en' ? 'en' : 'zh',
  };
}

export function renderExecutionBody(input = {}) {
  const fields = normalizeFields(input);
  const labels = PACKAGE_LABELS[fields.lang];
  return [
    `# ${labels.title}`,
    `## ${labels.source}`,
    `- ${labels.meetingId}: ${fields.meetingId ?? labels.empty}`,
    `- ${labels.decisionVersion}: ${fields.decisionVersion ?? labels.empty}`,
    `## ${labels.objective}`,
    fields.objective || labels.empty,
    `## ${labels.confirmedFacts}`,
    renderList(fields.confirmedFacts, labels.empty),
    `## ${labels.assumptions}`,
    renderList(fields.assumptions, labels.empty),
    `## ${labels.decisions}`,
    renderList(fields.decisions, labels.empty),
    `## ${labels.scope}`,
    `### ${labels.allowedPaths}`,
    renderList(fields.scope.allowedPaths, labels.empty),
    `### ${labels.allowedOperations}`,
    renderList(fields.scope.allowedOperations, labels.empty),
    `### ${labels.forbiddenOperations}`,
    renderList(fields.scope.forbiddenOperations, labels.empty),
    `## ${labels.acceptanceCriteria}`,
    renderList(fields.acceptanceCriteria, labels.empty),
    `## ${labels.constraints}`,
    renderList(fields.constraints, labels.empty),
    `## ${labels.requiredChecks}`,
    renderList(fields.requiredChecks, labels.empty),
    `## ${labels.unresolved}`,
    renderList(fields.unresolved, labels.empty),
  ].join('\n');
}

function taskIdFor(meetingId, bodySha256) {
  const meetingShort = String(meetingId ?? 'local')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 12) || 'local';
  return `rt-${meetingShort}-${bodySha256.slice(0, 8)}`;
}

function checkedTaskId(value, meetingId, bodySha256) {
  const taskId = asText(value) || taskIdFor(meetingId, bodySha256);
  if (!/^[A-Za-z0-9._-]{3,96}$/.test(taskId)) {
    throw new Error('execution package: taskId must use only letters, numbers, dot, underscore, or hyphen');
  }
  return taskId;
}

export function makeExecutionPackage(input = {}) {
  const fields = normalizeFields(input);
  if (!Number.isSafeInteger(fields.taskVersion) || fields.taskVersion < 1) {
    throw new Error('execution package: taskVersion must be a positive integer');
  }
  const body = renderExecutionBody(fields);
  const bodySha256 = digest(body);
  const bodyBytes = utf8Bytes(body);
  const taskId = checkedTaskId(input.taskId, fields.meetingId, bodySha256);
  const fullText = [
    `ROUND TABLE TASK · ${taskId} · v${fields.taskVersion} · SHA-256 ${bodySha256.slice(0, 8)}`,
    '',
    body,
    '',
    `END RT TASK · ${taskId} · ${bodyBytes} BYTES`,
  ].join('\n');
  const fullTextSha256 = digest(fullText);
  const fullTextBytes = utf8Bytes(fullText);
  const executionPackageId = `execpkg_${digest(stableJson({
    taskId,
    taskVersion: fields.taskVersion,
    meetingId: fields.meetingId,
    decisionVersion: fields.decisionVersion,
    fullTextSha256,
  })).slice(0, 24)}`;
  return {
    executionPackageId,
    taskId,
    ...fields,
    context: {
      confirmedFacts: [...fields.confirmedFacts],
      assumptions: [...fields.assumptions],
      decisions: [...fields.decisions],
      unresolved: [...fields.unresolved],
    },
    body,
    bodySha256,
    bodyBytes,
    fullText,
    fullTextSha256,
    fullTextBytes,
    contentHash: fullTextSha256,
    createdBy: 'roundtable',
    userConfirmedAt: null,
  };
}

export function verifyPackageHash(pkg) {
  if (!pkg || typeof pkg !== 'object') return false;
  if (typeof pkg.body !== 'string' || typeof pkg.fullText !== 'string') return false;
  if (renderExecutionBody(pkg) !== pkg.body) return false;
  const bodySha256 = digest(pkg.body);
  const bodyBytes = utf8Bytes(pkg.body);
  if (pkg.bodySha256 !== bodySha256 || pkg.bodyBytes !== bodyBytes) return false;
  const expectedFullText = [
    `ROUND TABLE TASK · ${pkg.taskId} · v${pkg.taskVersion} · SHA-256 ${bodySha256.slice(0, 8)}`,
    '',
    pkg.body,
    '',
    `END RT TASK · ${pkg.taskId} · ${bodyBytes} BYTES`,
  ].join('\n');
  if (pkg.fullText !== expectedFullText) return false;
  const fullTextSha256 = digest(expectedFullText);
  return pkg.fullTextSha256 === fullTextSha256
    && pkg.contentHash === fullTextSha256
    && pkg.fullTextBytes === utf8Bytes(expectedFullText);
}

export function confirmPackage(pkg, at) {
  if (!verifyPackageHash(pkg)) throw new Error('execution package hash mismatch: content changed before confirmation');
  const confirmedAt = nullableText(at);
  if (!confirmedAt) throw new Error('execution package confirmation time is required');
  return { ...structuredClone(pkg), userConfirmedAt: confirmedAt };
}
