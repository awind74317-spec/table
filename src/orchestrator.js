import { runAgent } from './runner.js';
import { makeProfile } from './profile.js';
import { compileCaps, disciplineBlock, capsManifest, DEFAULT_TEMPLATE } from './capabilities.js';
import { buildDebaterR1, buildDebaterRN, buildSummarizer, buildJudge, SCRIBE_MARKERS } from './prompts.js';
import { resolveInjection, expandHome } from './templates.js';
import { redact } from './redactor.js';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import * as store from './store.js';

// 聊天→会议跨界事件的合法类型（v1 冻结枚举）。事件只能来自受信 UI/API 的结构化字段，
// host 绝不从聊天/材料/模型文本里解析这类控制信息。
export const CROSSOVER_TYPES = ['supplement_material', 'correct_fact', 'answer_question', 'change_goal_or_constraint'];

export class Committee {
  constructor({ topic, materials, agents, roles, template, mode, maxRounds, baseDir, emit, origin = '', lang = 'zh', workspace = '', caps = null, capConfig = null, capFiles = null }) {
    Object.assign(this, { topic, materials, agents, roles, template, mode, maxRounds, baseDir, origin, lang, workspace }); // origin=来源工作台目录名；lang=会话语言（发给模型的提示词按此选中英文）
    // 能力授权（v1）：模板只来自用户显式选择或来源工作台的既有授权（升格继承）——绝不从议题猜。
    // 辩手/书记/仲裁共用这同一份授权状态；纪律注入走 call() 单一漏斗，任何角色无法私自扩权。
    this.capState = { templateId: caps?.templateId ?? DEFAULT_TEMPLATE, grants: caps?.grants ?? [] };
    this.caps = compileCaps({ templateId: this.capState.templateId, grants: this.capState.grants, config: capConfig ?? undefined, files: capFiles ?? undefined });
    this.emit = emit ?? (() => {});
    this.state = 'created';
    this.round = 0;
    this.history = [];
    this.userNote = '';
    this.dir = null;
    this.abort = null;
    this.errors = [];
    this.autoStopRequested = false;
    this.chatLog = [];
    this.chatSeq = 0;
    // 跨界交接状态（v1）：事件队列 + 会议状态版本 + 裁决新鲜度/版本表。全部随 meta 持久化。
    this.crossovers = []; // {id,type,text,sourceSeq,sourceBench,source,createdAt,plannedPhase,status,confirmations,appliedRound?,recipients?}
    this.stateVersion = 1; // 每次批准更新真正注入下一阶段时 +1
    this.verdictStatus = null; // null|'current'|'possibly_stale'（可能过期标记绝不静默消失）
    this.verdictVersions = []; // {version, at, round, status:'current'|'superseded', file}
  }

  // 从磁盘状态装配一个可继续辩论的 Committee：不新建目录（复用给定 dir），
  // 直接注入 round/history，state 置为 paused。调用方随后应 saveMeta('paused') 刷新磁盘状态。
  // workspace 必须随恢复带回：否则下一次 saveMeta 会把挂载信息抹掉，
  // 再恢复时静默降级为 scratch（实测故障——manifest 与 metadata 出现矛盾）
  static resume({ topic, materials, agents, roles, template, mode, maxRounds, baseDir, emit, dir, round, history, origin = '', lang = 'zh', workspace = '', caps = null, capFiles = null }) {
    const c = new Committee({ topic, materials, agents, roles, template, mode, maxRounds, baseDir, emit, origin, lang, workspace, caps, capFiles });
    c.dir = dir;
    c.round = round;
    c.history = history;
    c.state = 'paused';
    return c;
  }

  // 跨界交接状态随恢复带回（老会话无这些字段则用构造器默认值）
  restoreCrossoverState(meta = {}) {
    this.crossovers = Array.isArray(meta.crossovers) ? meta.crossovers : [];
    this.stateVersion = Number(meta.stateVersion) || 1;
    this.verdictStatus = meta.verdictStatus ?? null;
    this.verdictVersions = Array.isArray(meta.verdictVersions) ? meta.verdictVersions : [];
  }

  setState(s) { this.state = s; this.emit({ type: 'state', data: s }); }
  agentName(id) { return this.agents[id].name; }
  // 模板的 format 字段支持本地化 {zh,en} 或旧的纯字符串——按会话语言取
  templateFormat(key) {
    const v = this.template[key];
    if (v && typeof v === 'object') return v[this.lang] ?? v.zh ?? v.en ?? '';
    return v ?? '';
  }
  // 辩手角色跟随席位而非 agent 身份：同一 agent 换席后应获得新席位的职责视角
  seatBriefOf(agentId) {
    const [debaterA, debaterB] = this.roles.debaters;
    const key = agentId === debaterA ? 'debaterA' : agentId === debaterB ? 'debaterB' : '';
    if (!key) return '';
    const v = this.template.roleBriefs?.[key];
    if (v && typeof v === 'object') return v[this.lang] ?? v.zh ?? v.en ?? '';
    return v ?? '';
  }
  latestSummary() { return this.history.at(-1)?.summary ?? ''; }
  // 追加而非覆盖：下一轮开跑前的多次插话都要保留（自动跑轮间插话是常规操作）
  interject(text) { this.userNote = this.userNote ? this.userNote + '\n' + text : text; }

  async init() {
    this.dir = await store.createSessionDir(this.baseDir, this.topic.slice(0, 30));
    await store.saveProblem(this.dir, {
      topic: this.topic, materials: this.materials, templateName: this.template.name,
      roles: this.roles, mode: this.mode, maxRounds: this.maxRounds, lang: this.lang,
    });
    await this.saveMeta('created');
  }

  async saveMeta(status) {
    await store.saveMetadata(this.dir, {
      status, topic: this.topic, template: this.template.name, roles: this.roles,
      mode: this.mode, maxRounds: this.maxRounds, rounds: this.round, workspace: this.workspace, origin: this.origin, lang: this.lang,
      caps: this.capState, // 能力授权状态（模板+本场授权）随会议持久化
      crossovers: this.crossovers, stateVersion: this.stateVersion,
      verdictStatus: this.verdictStatus, verdictVersions: this.verdictVersions,
      agents: this.agents, errors: this.errors, updatedAt: new Date().toISOString(),
    });
  }

  // ---- 聊天 ↔ 会议跨界交接（v1）----
  // 事件只能由受信 UI/API 用结构化字段创建；任何轮次运行中都只进队列，绝不进当前轮上下文。
  async addCrossover({ type, text, sourceSeq = null, sourceBench = '' }) {
    if (!CROSSOVER_TYPES.includes(type)) throw new Error(this.tr(`未知跨界事件类型: ${type}`, `Unknown crossover type: ${type}`));
    const body = String(text ?? '').trim();
    if (!body) throw new Error(this.tr('内容不能为空', 'Content must not be empty'));
    const ev = {
      id: 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type, text: body, sourceSeq, sourceBench, source: 'workbench-ui',
      createdAt: new Date().toISOString(),
      targetMeeting: path.basename(this.dir ?? ''),
      plannedPhase: 'next-round',
      status: 'pending', confirmations: [],
    };
    this.crossovers.push(ev);
    this.emit({ type: 'crossover', data: this.crossoverSummary() });
    await this.saveMeta(this.state);
    return ev;
  }

  // 批准/拒绝：只在非运行状态可操作（轮末暂停时确认——对称注入的前提）
  async resolveCrossover(id, approve) {
    if (['running', 'judging'].includes(this.state)) throw new Error(this.tr('当前轮进行中，轮末再确认待纳入更新', 'A round is in progress — confirm pending updates at the round boundary'));
    const ev = this.crossovers.find(x => x.id === id);
    if (!ev) throw new Error(this.tr('事件不存在', 'No such event'));
    if (ev.status !== 'pending') throw new Error(this.tr('该事件已处理过', 'Event already resolved'));
    ev.status = approve ? 'approved' : 'rejected';
    ev.confirmations.push({ by: 'user', action: ev.status, at: new Date().toISOString() });
    // 保守重审规则：更正事实/改目标一经批准，已有裁决立刻标记可能过期（绝不静默保持有效）
    if (approve && ['correct_fact', 'change_goal_or_constraint'].includes(ev.type) && this.verdictVersions.length) {
      this.verdictStatus = 'possibly_stale';
      this.emit({ type: 'verdict-status', data: { status: this.verdictStatus } });
    }
    this.emit({ type: 'crossover', data: this.crossoverSummary() });
    await this.saveMeta(this.state);
    return ev;
  }

  crossoverSummary() {
    return {
      pending: this.crossovers.filter(x => x.status === 'pending').map(({ id, type, text, createdAt }) => ({ id, type, text: text.slice(0, 400), createdAt })),
      approvedUnapplied: this.crossovers.filter(x => x.status === 'approved' && !x.appliedRound).length,
      stateVersion: this.stateVersion,
      verdictStatus: this.verdictStatus,
    };
  }

  // 已批准未注入的事件 → 渲染为下一阶段的对称注入块（辩手双方一字不差同一份）
  #consumeApprovedCrossovers() {
    const ready = this.crossovers.filter(x => x.status === 'approved' && !x.appliedRound);
    if (!ready.length) return '';
    const typeLabel = {
      supplement_material: this.tr('补充材料', 'Supplementary material'),
      correct_fact: this.tr('更正事实', 'Fact correction'),
      answer_question: this.tr('回答会议提问', 'Answer to the meeting'),
      change_goal_or_constraint: this.tr('目标/约束变更', 'Goal/constraint change'),
    };
    const parts = ready.map(ev => {
      const note = ev.type === 'supplement_material'
        ? this.tr('（注意：此前各轮结论形成于该材料加入之前）', '(note: earlier conclusions were formed before this material was added)')
        : ev.type === 'correct_fact' || ev.type === 'change_goal_or_constraint'
          ? this.tr('（注意：以此为准，此前与之冲突的前提作废）', '(note: this supersedes any conflicting earlier premise)')
          : '';
      return `[${typeLabel[ev.type]}]${note}\n${ev.text}`;
    });
    const round = this.round + 1; // 调用点在 runNextRound 自增前
    for (const ev of ready) {
      ev.appliedRound = round;
      ev.recipients = [...this.roles.debaters];
      ev.status = 'applied';
    }
    this.stateVersion += 1;
    this.emit({ type: 'crossover', data: this.crossoverSummary() });
    return this.tr(`【用户确认的跨界更新（会议状态版本 v${this.stateVersion}）】\n`, `[User-confirmed crossover updates (meeting state v${this.stateVersion})]\n`) + parts.join('\n\n');
  }

  tr(zh, en) { return this.lang === 'en' ? en : zh; }

  // 从 summary 提取给某辩手的质询行（zh「问 <辩手名>」/ en「Ask <debater>」，与 scribeTask 约定的格式一致）
  questionsFor(agentId) {
    const name = this.agentName(agentId);
    const pats = (SCRIBE_MARKERS[this.lang] ?? SCRIBE_MARKERS.zh).ask(name);
    return this.latestSummary().split('\n')
      .filter(l => pats.some(p => l.includes(p))).join('\n');
  }

  async buildBrief(agentId, opponentId) {
    const seatBrief = this.seatBriefOf(agentId);
    const injection = [await resolveInjection(this.template, agentId), seatBrief].filter(Boolean).join('\n\n');
    if (this.round === 1) {
      // clean room：R1 构建路径上没有任何对手数据可引用
      return buildDebaterR1({
        topic: this.topic, materials: this.materials, injection,
        format: this.templateFormat('debaterFormat'), userNote: this.userNote, lang: this.lang,
      });
    }
    const prev = this.history.at(-1);
    return buildDebaterRN({
      topic: this.topic, round: this.round, summary: prev.summary,
      opponentName: this.agentName(opponentId),
      opponentText: prev.outputs[opponentId]?.text || (this.lang === 'en' ? '(opponent absent last round)' : '（对方上一轮缺席）'),
      questions: this.questionsFor(agentId), injection,
      format: this.templateFormat('debaterFormat'), userNote: this.userNote, lang: this.lang,
    });
  }

  async call(agentId, label, prompt) {
    // 本场纪律统一在这里前置：call() 是辩手/书记/仲裁的唯一漏斗，
    // 所有控制链角色因此共享同一份授权装配，任何角色无法私自获得额外能力。
    prompt = disciplineBlock(this.caps, this.lang) + prompt;
    await store.savePrompt(this.dir, label, agentId, prompt);
    this.emit({ type: 'agent-status', agentId, label, data: 'running' });
    const cfg = this.agents[agentId];
    // 辩手/书记/仲裁全部走同一隔离入口：挂载了工作区就是只读材料策略，否则干净房 scratch
    const r = await runAgent(cfg, prompt, {
      profile: makeProfile({
        id: `committee:${label}:${agentId}`, role: label,
        cwdPolicy: cfg.contextRoot ? 'readonly-materials' : 'scratch',
        ...(cfg.contextRoot ? { root: cfg.contextRoot } : {}),
      }),
      manifestFile: path.join(this.dir, 'manifests', `${label}-${agentId}.context_manifest.json`),
      capabilities: capsManifest(this.caps),
      // 跨界交接审计：事件全量（原文+状态+确认记录+注入轮次+接收者）、状态版本、裁决新鲜度
      materials: {
        crossovers: this.crossovers, stateVersion: this.stateVersion,
        verdictStatus: this.verdictStatus, verdictVersions: this.verdictVersions,
      },
      onChunk: s => this.emit({ type: 'chunk', agentId, label, data: s }),
      signal: this.abort?.signal,
    });
    await store.saveRaw(this.dir, label, agentId,
      r.ok ? r.text : `[${r.error}]\n${r.text}\n--- stderr ---\n${r.stderr}`);
    if (!r.ok) {
      this.errors.push({ label, agentId, error: r.error, at: new Date().toISOString() });
      this.emit({ type: 'error', agentId, label, data: r.error });
    }
    this.emit({ type: 'agent-status', agentId, label, data: r.ok ? 'done' : 'failed:' + r.error });
    // 辩手发言完成即广播全文：回流不等整轮、不等书记、更不等裁决——
    // 半途离会回到对话时，已说出口的内容一段都不少（统一容器回流铁律）
    if (r.ok && /^r\d+$/.test(label) && this.roles.debaters.includes(agentId)) {
      this.emit({ type: 'statement', round: Number(label.slice(1)), agentId, name: this.agentName(agentId), data: r.text });
    }
    return r;
  }

  async runNextRound() {
    if (!['created', 'paused'].includes(this.state)) throw new Error(this.tr('当前状态不能开始新一轮: ', 'Cannot start a new round in state: ') + this.state);
    // 已批准的跨界更新在轮次边界统一注入：走 userNote（主持人）通道——双方简报天然拿到
    // 同一份全文，杜绝"一方先看到"的不对称。运行中新到的事件只进队列，不影响本轮。
    const xoverBlock = this.#consumeApprovedCrossovers();
    if (xoverBlock) this.userNote = this.userNote ? xoverBlock + '\n' + this.userNote : xoverBlock;
    this.round += 1;
    this.abort = new AbortController();
    this.setState('running');
    const [a, b] = this.roles.debaters;
    const briefs = { [a]: await this.buildBrief(a, b), [b]: await this.buildBrief(b, a) };
    this.userNote = '';
    const label = 'r' + this.round;
    const [ra, rb] = await Promise.all([this.call(a, label, briefs[a]), this.call(b, label, briefs[b])]);
    if ([ra, rb].some(r => r.error === 'aborted')) return null; // stopRound 已处理状态与轮次回退
    const entry = { briefs, outputs: { [a]: ra, [b]: rb }, summary: '' };
    this.history.push(entry);
    await this.summarizeRound();
    this.setState('paused');
    this.emit({ type: 'round-done', round: this.round });
    await this.saveMeta('paused');
    return entry;
  }

  async summarizeRound() {
    const entry = this.history.at(-1);
    const roundTexts = {};
    for (const d of this.roles.debaters) {
      const o = entry.outputs[d];
      roundTexts[this.agentName(d)] = o?.ok ? o.text : (this.lang === 'en' ? `(absent this round: ${o?.error ?? 'skipped'})` : `（本轮缺席：${o?.error ?? 'skipped'}）`);
    }
    const prompt = buildSummarizer({
      topic: this.topic, round: this.round, roundTexts,
      previousSummary: this.history.at(-2)?.summary ?? '', lang: this.lang,
    });
    const r = await this.call(this.roles.summarizer, `r${this.round}summary`, prompt);
    entry.summary = r.ok ? r.text : (this.lang === 'en' ? '(summary failed: ' + r.error + ')' : '（本轮摘要失败：' + r.error + '）');
    // 会诊裁决 2026-07-15：书记调用成功但缺关键结构时不再静默——下游收敛判定与阅读体验会悄悄劣化
    const tableMark = (SCRIBE_MARKERS[this.lang] ?? SCRIBE_MARKERS.zh).table;
    if (r.ok && !entry.summary.includes(tableMark))
      this.emit({ type: 'error', agentId: this.roles.summarizer, label: `r${this.round}summary`, data: this.tr(
        '书记输出缺少「分歧分类表」结构，摘要质量可能下降（可点「重新生成本轮摘要」）',
        `Scribe output is missing the "${tableMark}" structure — summary quality may degrade (you can hit "Regenerate this round's summary")`) });
    await store.saveSummary(this.dir, this.round, entry.summary);
    await store.saveDisagreements(this.dir, entry.summary);
    this.emit({ type: 'summary', round: this.round, data: entry.summary });
  }

  // 会话内群聊：会后/轮间与参会 AI 自由讨论，AI 回答延续其会上立场（若为辩手，引用其最新一轮发言）
  async chat(text, agentIds) {
    if (['running', 'judging'].includes(this.state)) throw new Error(this.tr('辩论进行中，稍后再聊', 'Debate in progress — chat later'));
    if (this.state === 'created') throw new Error(this.tr('尚无会议内容可聊，请先开始第 1 轮', 'Nothing to discuss yet — start round 1 first'));
    const modName = this.tr('主持人', 'Moderator');
    const userMsg = { from: 'user', name: modName, text, at: new Date().toISOString() };
    this.chatLog.push(userMsg);
    this.emit({ type: 'chat-message', from: 'user', name: modName, data: text });
    for (const agentId of agentIds) {
      this.chatSeq += 1;
      const label = 'chat' + this.chatSeq;
      const prompt = this.buildChatPrompt(agentId, text);
      const r = await this.call(agentId, label, prompt);
      if (r.ok) {
        const name = this.agentName(agentId);
        this.chatLog.push({ from: agentId, name, text: r.text, at: new Date().toISOString() });
        this.emit({ type: 'chat-message', from: agentId, name, data: r.text });
      }
      // 失败时 call() 已发出 error 事件，此处无需重复处理
    }
    await this.saveChatLog();
  }

  buildChatPrompt(agentId, text) {
    const name = this.agentName(agentId);
    const summary = this.latestSummary().slice(0, 3000);
    const last = this.history.at(-1);
    const isDebater = this.roles.debaters.includes(agentId);
    const lastOutput = last?.outputs?.[agentId];
    const stance = isDebater && lastOutput?.ok ? lastOutput.text.slice(0, 2000) : '';
    const recent = this.chatLog.slice(-10).map(m => `${m.name}${this.tr('：', ': ')}${m.text}`).join('\n');
    if (this.lang === 'en') return [
      `You are "${name}", a participant in a decision-committee meeting; this is the free discussion between/after rounds.`,
      `# Topic: ${this.topic}`,
      `# Meeting summary: ${summary}`,
      stance ? `# Your latest stance in the debate (stay consistent): ${stance}` : '',
      `# Recent group chat:\n${recent}`,
      `# The moderator just said: ${text}`,
      "Reply conversationally and concisely (a few sentences to a short paragraph, no fixed structure), continuing your stance and perspective; you may cite meeting content. For facts beyond this meeting, say you don't know. Reply in English, even if your personal/global CLI configuration defaults to another language.",
    ].filter(Boolean).join('\n\n');
    return [
      `你是决策委员会会议的参会者「${name}」，现在是会后/轮间的自由讨论环节。`,
      `# 议题：${this.topic}`,
      `# 会议摘要：${summary}`,
      stance ? `# 你在辩论中的最新立场（保持一致性）：${stance}` : '',
      `# 最近群聊记录：\n${recent}`,
      `# 主持人刚刚说：${text}`,
      '请以对话方式简明回应（几句话到一小段，无需固定结构），延续你的立场与视角，可引用会议内容；被问到超出会议范围的事实请照实说不知道。全程用中文回复（即使你的个人/全局 CLI 配置默认了其他语言）。',
    ].filter(Boolean).join('\n\n');
  }

  async saveChatLog() {
    const lines = this.chatLog.map(m => redact(JSON.stringify(m))).join('\n') + '\n';
    await writeFile(path.join(this.dir, 'chat.jsonl'), lines, 'utf8');
  }

  async retrySide(agentId) {
    const entry = this.history.at(-1);
    if (!entry) throw new Error(this.tr('尚无可重试的轮次', 'No round to retry yet'));
    this.abort = new AbortController();
    const r = await this.call(agentId, `r${this.round}retry`, entry.briefs[agentId]);
    entry.outputs[agentId] = r;
    if (r.ok) await store.saveRaw(this.dir, 'r' + this.round, agentId, r.text);
    await this.summarizeRound();
    await this.saveMeta(this.state);
    return r;
  }

  async skipSide(agentId) {
    const entry = this.history.at(-1);
    if (!entry) throw new Error(this.tr('尚无可跳过的轮次', 'No round to skip yet'));
    this.abort = new AbortController();
    entry.outputs[agentId] = { ok: false, error: 'skipped', text: '' };
    this.emit({ type: 'agent-status', agentId, label: 'r' + this.round, data: 'skipped' });
    await this.summarizeRound();
  }

  stopRound() {
    this.autoStopRequested = true;
    this.abort?.abort();
    if (this.state === 'running') {
      this.round -= 1; // 本轮作废
      this.setState('paused');
    }
  }

  async savePartial() {
    await store.assembleSessionMd(this.dir);
    await this.saveMeta('partial');
    this.state = 'partial';
  }

  requestAutoStop() { this.autoStopRequested = true; }

  // 全体重审：在保存历史的前提下产出新的裁决版本（不是重放历史轮次）。
  // 只能由用户显式触发；不重审时 possibly_stale 标记持续存在，绝不静默恢复有效。
  async rejudge() {
    if (!this.verdictVersions.length) throw new Error(this.tr('尚无裁决，无从重审——请先「进入裁决」', 'No verdict yet — run "Go to verdict" first'));
    if (['running', 'judging'].includes(this.state)) throw new Error(this.tr('当前有轮次或裁决在进行中', 'A round or verdict is already in progress'));
    this.crossovers.push({
      id: 'rj' + Date.now().toString(36), type: 'rejudge-requested', text: '', source: 'workbench-ui',
      createdAt: new Date().toISOString(), status: 'applied', confirmations: [{ by: 'user', action: 'rejudge', at: new Date().toISOString() }],
    });
    return await this.runJudge();
  }

  // 摘要失败（如书记 agent 出错）后重跑本轮摘要——换新 AbortController，避免复用已 spent 的信号
  async resummarize() {
    if (!this.history.length) throw new Error(this.tr('尚无可重新摘要的轮次', 'No round to re-summarize yet'));
    this.abort = new AbortController();
    await this.summarizeRound();
    await this.saveMeta(this.state);
  }

  async runAuto() {
    this.autoStopRequested = false;
    let converged = false;
    while (this.round < this.maxRounds && !this.autoStopRequested) {
      const entry = await this.runNextRound();
      if (!entry) return; // 被 stopRound 中止
      const [s1, s2] = [this.history.at(-2)?.summary, this.history.at(-1)?.summary];
      const b1 = extractDisagreementBlock(s1 ?? ''), b2 = extractDisagreementBlock(s2 ?? '');
      if (b1 && b2 && b1 === b2) { converged = true; break; } // 分歧收敛（双方分歧块非空且一致才算收敛，防止双空块假收敛）
    }
    // 「自动跑完」只跑轮次，绝不自动进入裁决——裁决是用户的拍板动作（分歧不默判），
    // 且要花一次真实仲裁额度。跑完停在暂停态，明示下一步由用户选择（实测故障修复）。
    if (this.autoStopRequested) return;
    this.emit({ type: 'sys', data: converged
      ? this.tr(`第 ${this.round} 轮后双方分歧已收敛。你可以点「进入裁决」产出裁决卡，或继续追问/插话`, `Disagreements converged after round ${this.round}. Hit "Go to verdict" to produce the verdict card, or keep probing/interjecting`)
      : this.tr(`已自动跑完 ${this.round} 轮。你可以点「进入裁决」产出裁决卡、增加轮数继续，或先插话再战`, `Auto-run finished ${this.round} rounds. Hit "Go to verdict" for the verdict card, raise the round cap to continue, or interject first`) });
  }

  async runJudge() {
    this.setState('judging');
    const finalStatements = {};
    const last = this.history.at(-1);
    for (const d of this.roles.debaters) {
      const o = last.outputs[d];
      finalStatements[this.agentName(d)] = o?.ok ? o.text : (this.lang === 'en' ? '(absent in final round)' : '（最终轮缺席）');
    }
    const prompt = buildJudge({
      topic: this.topic, summary: this.latestSummary(), finalStatements,
      format: this.templateFormat('judgeFormat'), lang: this.lang,
    });
    const r = await this.call(this.roles.judge, 'judge', prompt);
    if (r.ok) {
      // 裁决版本化：旧卡改名归档（judge-card-vN.md），新卡成为当前版；历史绝不覆盖
      if (this.verdictVersions.length) {
        const prev = this.verdictVersions.at(-1);
        const archived = `judge-card-v${prev.version}.md`;
        try { await rename(path.join(this.dir, 'judge-card.md'), path.join(this.dir, archived)); prev.file = archived; } catch { /* 旧卡文件缺失不阻塞新裁决 */ }
        prev.status = 'superseded';
      }
      this.verdictVersions.push({ version: this.verdictVersions.length + 1, at: new Date().toISOString(), round: this.round, status: 'current', file: 'judge-card.md' });
      this.verdictStatus = 'current'; // 重审完成/首次裁决：过期标记只有在这里（真实重审）才解除
      await store.saveJudgeCard(this.dir, r.text);
      this.emit({ type: 'judge-card', data: r.text });
      this.emit({ type: 'verdict-status', data: { status: this.verdictStatus, version: this.verdictVersions.at(-1).version } });
      // 若模板设置了 copyJudgeCardTo，则额外落盘一份到该目录
      if (this.template.copyJudgeCardTo) {
        const dest = expandHome(this.template.copyJudgeCardTo);
        await mkdir(dest, { recursive: true });
        const name = path.basename(this.dir) + '.md';
        await writeFile(path.join(dest, name), redact(this.tr(`# 裁决卡：${this.topic}\n\n来源会话：${this.dir}\n\n${r.text}`, `# Verdict card: ${this.topic}\n\nSource session: ${this.dir}\n\n${r.text}`)), 'utf8');
      }
    }
    await store.assembleSessionMd(this.dir);
    this.setState(r.ok ? 'done' : 'partial');
    await this.saveMeta(this.state);
    return r;
  }
}

// 从 summary 文本中截取「分歧分类表」段落（用于 runAuto 判断分歧是否已收敛）。
// 两种语言标记都认——按会话语言的书记理应输出对应标记，但双认更稳，且此函数无 lang 上下文。
export function extractDisagreementBlock(summary) {
  const lines = String(summary).split('\n');
  const start = lines.findIndex(l => l.includes(SCRIBE_MARKERS.zh.table) || l.includes(SCRIBE_MARKERS.en.table));
  if (start === -1) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- /.test(lines[i])) break; // 下一个顶层条目
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}
