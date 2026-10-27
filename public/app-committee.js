// ===== 委员会（会议）：辩手栏渲染 / 群聊 / 事件路由 / 会话生命周期 / 会议按钮 =====

// ---- 会议模块内部状态 ----
let roundDivs = {};
const badgeTimers = {}; // 运行计时器：running 徽标每秒更新耗时
let typingEls = {};     // agentId -> "正在输入…" 提示元素（群聊）
let arenaSideMode = localStorage.getItem('rt-arena-side');
if (arenaSideMode === '1') arenaSideMode = 'open';
else if (arenaSideMode === '0') arenaSideMode = 'closed';
else if (arenaSideMode !== 'closed' && arenaSideMode !== 'open' && arenaSideMode !== 'wide') {
  arenaSideMode = window.matchMedia('(max-width: 900px)').matches ? 'closed' : 'open';
}
let arenaSideLastOpenMode = arenaSideMode === 'wide' ? 'wide' : 'open';
let arenaSideUnread = 0;
let arenaLastUserChatQ = '';

function arenaSideIsNarrow() { return window.matchMedia('(max-width: 900px)').matches; }

function renderArenaSideToggle() {
  const btn = $('#arenaSideToggle');
  if (!btn) return;
  const label = btn.querySelector('.arena-side-toggle-label');
  if (label) label.textContent = t('arena.sideToggle');
  const expanded = arenaSideMode !== 'closed';
  btn.setAttribute('aria-expanded', String(expanded));
  const unreadText = t('arena.sideUnread', { n: arenaSideUnread });
  let unread = btn.querySelector('.unread-badge');
  if (!expanded && arenaSideUnread > 0) {
    if (!unread) {
      unread = document.createElement('span');
      unread.className = 'unread-badge';
      btn.appendChild(unread);
    }
    unread.textContent = String(arenaSideUnread);
    unread.setAttribute('aria-label', unreadText);
    btn.setAttribute('aria-label', t('arena.sideToggle') + ': ' + unreadText);
  } else {
    if (unread) unread.remove();
    btn.setAttribute('aria-label', t('arena.sideToggle'));
  }
  const widen = $('#arenaSideWiden');
  if (widen) {
    const wide = arenaSideMode === 'wide';
    const title = t(wide ? 'arena.sideNarrow' : 'arena.sideWiden');
    widen.textContent = wide ? '⤡' : '⤢';
    widen.title = title;
    widen.setAttribute('aria-label', title);
    widen.setAttribute('aria-pressed', String(wide));
  }
}

function arenaSideOnEscape(e) {
  if (e.key !== 'Escape' || arenaSideMode === 'closed' || !arenaSideIsNarrow()) return;
  toggleArenaSide(false);
  $('#arenaSideToggle')?.focus();
}

function setArenaSideMode(mode) {
  if (mode !== 'closed' && mode !== 'open' && mode !== 'wide') mode = 'closed';
  arenaSideMode = mode;
  if (arenaSideMode !== 'closed') arenaSideLastOpenMode = arenaSideMode;
  const side = $('#arenaSide');
  const scrim = $('#arenaScrim');
  const expanded = arenaSideMode !== 'closed';
  const drawerOpen = expanded && arenaSideIsNarrow();
  side.hidden = !expanded;
  side.classList.toggle('arena-side-drawer', arenaSideIsNarrow());
  side.classList.toggle('arena-side-wide', arenaSideMode === 'wide');
  side.setAttribute('aria-hidden', String(!expanded));
  scrim.hidden = !drawerOpen;
  scrim.setAttribute('aria-hidden', String(!drawerOpen));
  if (expanded) {
    arenaSideUnread = 0;
    $('#arenaSideLive').textContent = '';
  }
  localStorage.setItem('rt-arena-side', arenaSideMode);
  renderArenaSideToggle();
  document.removeEventListener('keydown', arenaSideOnEscape);
  if (drawerOpen) document.addEventListener('keydown', arenaSideOnEscape);
}

function toggleArenaSide(open) {
  setArenaSideMode(open ? arenaSideLastOpenMode : 'closed');
}

function incrementArenaSideUnread() {
  if (arenaSideMode !== 'closed') return;
  arenaSideUnread += 1;
  renderArenaSideToggle();
  $('#arenaSideLive').textContent = t('arena.sideUnread', { n: arenaSideUnread });
}

function resetArenaSideUI() {
  arenaSideUnread = 0;
  arenaLastUserChatQ = '';
  const saved = localStorage.getItem('rt-arena-side');
  let savedMode = saved;
  if (savedMode === '1') savedMode = 'open';
  else if (savedMode === '0') savedMode = 'closed';
  else if (savedMode !== 'closed' && savedMode !== 'open' && savedMode !== 'wide') {
    savedMode = arenaSideIsNarrow() ? 'closed' : 'open';
  }
  if (savedMode !== 'closed') arenaSideLastOpenMode = savedMode;
  setArenaSideMode(savedMode);
}

function appendArenaReplyAnchor(side, chatMessage) {
  const q = arenaLastUserChatQ.split(/\r?\n/, 1)[0].trim().slice(0, 30);
  if (!q) return;
  const anchor = document.createElement('button');
  anchor.type = 'button';
  anchor.className = 'reply-anchor';
  anchor.textContent = t('arena.replyAnchor', { q });
  anchor.onclick = () => {
    toggleArenaSide(true);
    $('#chatPanel').open = true;
    chatMessage.scrollIntoView({ block: 'center' });
  };
  feed(side).appendChild(anchor);
}

const api = (action, body) => fetch(`/api/sessions/${sid}/${action}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).catch(e => setStatebar(t('dyn.netErr', { msg: e.message }), true));

// 项目对话侧的 AI 通过 POST /api/draft 预存议题+简报，并打开 /#draft=<id>——这里取回填入表单
async function applyDraftFromHash() {
  const m = /[#&]draft=([a-z0-9]+)/.exec(location.hash);
  if (!m) return;
  try {
    const d = await (await fetch('/api/draft/' + m[1])).json();
    if (d.error) return setStatebar(t('dyn.draftExpired'), true);
    $('#topic').value = d.topic ?? '';
    $('#materials').value = d.materials ?? '';
    // 发起方建议的模板也一并选好（例如项目会诊）——模板选错会导致顾问输出结构完全不对题
    if (d.template && [...$('#tpl').options].some(o => o.value === d.template)) $('#tpl').value = d.template;
    // 升格草稿继承来源工作台的能力模板与本场授权（会议与工作台共用同一份授权清单）
    if (d.capTemplate && [...$('#capTpl').options].some(o => o.value === d.capTemplate)) $('#capTpl').value = d.capTemplate;
    draftCapGrants = Array.isArray(d.capGrants) ? d.capGrants : [];
    if (d.workspace) $('#workspace').value = d.workspace;
    showSetup(); // 统一容器后默认落地页是建台页——草稿链路要显式切到会议表单
    draftOrigin = d.originBench ?? null;
    draftLang = d.lang === 'en' || d.lang === 'zh' ? d.lang : null; // 升格草稿带来源工作台的会话语言，建会时优先于 UI 语言
    setStatebar(t('dyn.draftFilled'));
  } catch { /* 服务波动时静默，用户可手动填 */ }
  history.replaceState(null, '', location.pathname); // 用后清掉 hash，防刷新重复提示
}

function feed(side) { return $(side === 'A' ? '#colA .feed' : '#colB .feed'); }
function badge(side) { return $(side === 'A' ? '#colA .badge' : '#colB .badge'); }

function startBadgeTimer(side) {
  const t0 = Date.now();
  badge(side).textContent = t('dyn.running', { t: '0s' });
  badgeTimers[side] = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    badge(side).textContent = t('dyn.running', { t: (s >= 60 ? Math.floor(s / 60) + 'm' + (s % 60) + 's' : s + 's') });
  }, 1000);
}
function stopBadgeTimer(side) { if (badgeTimers[side]) { clearInterval(badgeTimers[side]); delete badgeTimers[side]; } }

// ===== 简明视图（默认开）：流式期间轮次保持展开（此时还没有提炼物），
// 书记摘要一到就折叠该轮原文——中栏滚动摘要即每轮的提炼层，原文点开可看 =====
let denseMode = localStorage.getItem('rt-dense') !== '0';

function collapseRounds() {
  document.querySelectorAll('details.round').forEach(d => { d.open = false; });
}

function applyViewMode() {
  const btn = $('#viewToggle');
  btn.textContent = denseMode ? t('arena.viewFull') : t('arena.viewDense');
  btn.title = t('arena.viewToggleTitle');
  if (denseMode) collapseRounds();
  else document.querySelectorAll('details.round').forEach(d => { d.open = true; });
}

function ensureRoundDiv(side, label) {
  const key = side + label;
  if (!roundDivs[key]) {
    // 整轮用 <details> 包裹：可整体折叠
    const d = document.createElement('details');
    d.className = 'round';
    d.open = true;
    const sum = document.createElement('summary');
    sum.textContent = label;
    const pre = document.createElement('pre');
    d.appendChild(sum);
    d.appendChild(pre);
    feed(side).appendChild(d);
    roundDivs[key] = pre;
    // 栏头加该轮的快速跳转按钮（栏头是 sticky 的，按钮始终可见）
    const nav = $(side === 'A' ? '#colA .roundnav' : '#colB .roundnav');
    const btn = document.createElement('button');
    btn.textContent = label.replace(/\D/g, '') || label; // 「第 2 轮」/「Round 2」→「2」
    btn.title = t('dyn.jumpTo', { label });
    btn.onclick = () => { d.open = true; d.scrollIntoView({ block: 'start' }); }; // 不用 smooth：部分环境平滑滚动不执行
    nav.appendChild(btn);
  }
  return roundDivs[key];
}

// 发言完成后按「## 小节标题」拆成可折叠小节；流式期间保持纯文本追加。
// 全部经 createElement + textContent 构建——模型输出绝不进 innerHTML。
function sectionizeRound(side, label) {
  const pre = roundDivs[side + label];
  if (!pre || !pre.parentElement) return;
  const raw = pre.dataset.raw ?? pre.textContent;
  const lines = raw.split('\n');
  const sections = [];
  let cur = { title: '', body: [] };
  for (const line of lines) {
    const m = /^##\s+(.+)/.exec(line);
    if (m) { if (cur.title || cur.body.join('').trim()) sections.push(cur); cur = { title: m[1].trim(), body: [] }; }
    else cur.body.push(line);
  }
  if (cur.title || cur.body.join('').trim()) sections.push(cur);
  if (sections.length < 2) return; // 无结构或只有一段——保持原样
  const wrap = document.createElement('div');
  wrap.className = 'sections';
  wrap.dataset.raw = raw; // 保留原文：retry 等再来 chunk 时可还原为纯文本继续追加
  for (const s of sections) {
    if (!s.title) { // 首个无标题小节（导语）直接平铺
      const p = document.createElement('pre');
      p.textContent = s.body.join('\n').trim();
      if (p.textContent) wrap.appendChild(p);
      continue;
    }
    const det = document.createElement('details');
    det.className = 'section';
    det.open = true;
    const sum = document.createElement('summary');
    sum.textContent = s.title;
    const body = document.createElement('pre');
    body.textContent = s.body.join('\n').trim();
    det.appendChild(sum);
    det.appendChild(body);
    wrap.appendChild(det);
  }
  pre.replaceWith(wrap);
  roundDivs[side + label] = wrap; // 后续 chunk 到来时由 chunk 处理路径检测并还原
}

const isDebaterCall = label => /^r\d+(retry)?$/.test(label ?? ''); // r1、r2retry 等辩手轮次调用；r1summary/judge 等不路由进辩手栏
// 从 label（r1 / r2retry 等）解析轮次标题；retry 与初次调用同轮号 → 落入同一个 round div（追加而非新建）
const roundTitleOf = label => { const m = /^r(\d+)/.exec(label ?? ''); return m ? t('dyn.roundTitle', { n: m[1] }) : (label ?? ''); };

// ---- 会话内群聊 ----
const isChatCall = label => /^chat\d+$/.test(label ?? '');

function showTyping(agentId) {
  hideTyping(agentId);
  const name = cfg.agents[agentId]?.name ?? agentId;
  const div = document.createElement('div');
  div.className = 'chat-msg chat-agent chat-typing';
  div.textContent = t('dyn.typing', { name });
  $('#chatLog').appendChild(div);
  typingEls[agentId] = div;
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
}
function hideTyping(agentId) {
  const el = typingEls[agentId];
  if (el) { el.remove(); delete typingEls[agentId]; }
}

// from: 'user' | agentId；全部经 textContent 渲染，杜绝模型/用户输出触发 XSS
function appendChatMessage(from, name, text) {
  const arenaReplySide = from !== 'user' ? sideOf[from] : null;
  hideTyping(from);
  const div = document.createElement('div');
  div.className = 'chat-msg ' + (from === 'user' ? 'chat-user' : 'chat-agent');
  const nameEl = document.createElement('div');
  nameEl.className = 'chat-name';
  nameEl.textContent = name;
  const bodyEl = document.createElement('div');
  bodyEl.className = 'chat-body';
  bodyEl.textContent = text;
  div.appendChild(nameEl);
  div.appendChild(bodyEl);
  $('#chatLog').appendChild(div);
  if (arenaReplySide) appendArenaReplyAnchor(arenaReplySide, div);
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
  $('#chatPanel').open = true; // 有新消息时自动展开
}

// ===== 仲裁/书记常驻状态芯片：辩手有整栏状态，这两位此前只在状态栏一闪而过，
// 失败后没有可见入口重试。芯片状态由 agent-status 事件驱动，失败可点击重试
// （仲裁→重跑裁决，书记→重新生成本轮摘要）。=====
let staffState = null; // { judge: {id, name, st}, scribe: {id, name, st} }；st: idle|running|done|failed:<err>

function initStaffStatus(roles, agentNames) {
  staffState = {
    judge: { id: roles.judge, name: agentNames[roles.judge] ?? roles.judge, st: 'idle' },
    scribe: { id: roles.summarizer, name: agentNames[roles.summarizer] ?? roles.summarizer, st: 'idle' },
  };
  renderStaffStatus();
}

function renderStaffStatus() {
  const el = $('#staffStatus');
  if (!el || !staffState) return;
  el.hidden = false;
  el.innerHTML = '';
  for (const [role, s] of Object.entries(staffState)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'as-chip';
    const dot = document.createElement('span');
    const failed = s.st.startsWith('failed:');
    dot.className = 'as-dot ' + (failed ? 'as-bad' : s.st === 'running' ? 'as-checking' : s.st === 'done' ? 'as-ok' : '');
    const stText = failed ? s.st.slice(7) : t('staff.' + s.st);
    chip.append(dot, document.createTextNode(`${t('staff.' + role)} ${s.name} · ${stText}`));
    if (failed) {
      chip.title = t('staff.retryTip');
      chip.onclick = () => {
        s.st = 'running';
        renderStaffStatus();
        if (role === 'judge') api('judge');
        else { $('#resummarize').hidden = true; api('resummarize'); }
      };
    } else { chip.disabled = true; }
    el.appendChild(chip);
  }
}

function updateStaffFromEvent(ev) {
  if (!staffState || ev.type !== 'agent-status') return;
  const role = ev.label === 'judge' ? 'judge' : /summary$/.test(ev.label ?? '') ? 'scribe' : null;
  if (!role) return;
  staffState[role].st = ev.data === 'running' ? 'running' : ev.data === 'done' ? 'done' : ev.data;
  renderStaffStatus();
}

// 重建收件人多选：该会话全部参会 agent（辩手+仲裁+书记去重），默认勾选第一个辩手
function renderChatRecipients(roles, agentNames) {
  const ids = [...new Set([roles.debaters[0], roles.debaters[1], roles.judge, roles.summarizer])];
  const el = $('#chatRecipients');
  el.innerHTML = '';
  for (const id of ids) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = id;
    cb.checked = id === roles.debaters[0];
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + (agentNames[id] ?? id)));
    el.appendChild(label);
  }
}

// ---- 决策侧栏：逐轮小结的只读解析与安全 DOM 渲染 ----
const arenaRoundSummaryView = (() => {
  const roundSectionKinds = [
    { kind: 'consensus', labels: ['当前共识', 'Current consensus'], icon: '✓' },
    { kind: 'disagreement', labels: ['分歧分类表', 'Disagreement table'], icon: '⇄' },
    { kind: 'verified', labels: ['已证实事实', 'Verified facts'], icon: '▪' },
    { kind: 'unverified', labels: ['未证实假设', 'Unverified assumptions'], icon: '?' },
    { kind: 'kill', labels: ['证伪点', 'Kill conditions'], icon: '⚠' },
    { kind: 'questions', labels: ['下一轮待问问题', 'Questions for next round'], icon: '→' },
  ];
  const judgeSectionKinds = [
    { kind: 'consensus', labels: ['一致', 'Agreed conclusions'], icon: '✓' },
    { kind: 'revision', labels: ['修正', 'Revisions accepted'], icon: '✎' },
    { kind: 'disagreement', labels: ['遗留分歧', '分歧逐条处置', 'Disagreements, one by one'], icon: '⇄' },
    { kind: 'kill', labels: ['证伪', 'Combined kill conditions'], icon: '⚠' },
    { kind: 'action', labels: ['行动', '下一步', 'Action', 'Next step', 'Minimal verifiable next step'], icon: '→' },
  ];
  const roundProfile = { sectionKinds: roundSectionKinds, disagreementTable: true, emphasizeQuestions: true };
  const judgeProfile = { sectionKinds: judgeSectionKinds, showYourCall: true };

  function kindOf(title, profile) {
    const normalized = title.toLocaleLowerCase();
    return profile.sectionKinds.find(item => item.labels.some(label => normalized.includes(label.toLocaleLowerCase())))
      ?? { kind: 'default', icon: '▪' };
  }
  // 公共纯函数：优先识别 ### 分节；完全没有 ### 时才识别顶层扁平节名。
  function parseStructuredText(sourceText, skipLine) {
    const source = String(sourceText ?? '');
    const lines = source.split(/\r?\n/);
    const hasMarkdownSections = lines.some(line => /^###\s+/.test(line));
    const sections = [];
    const preamble = [];
    let current = null;

    for (const line of lines) {
      if (skipLine?.(line)) continue;
      const match = hasMarkdownSections
        ? /^###\s+(.+?)\s*$/.exec(line)
        : /^- (.+?)[：:]\s*(.*)$/.exec(line);
      if (match) {
        current = { title: match[1], lines: [] };
        if (!hasMarkdownSections && match[2]) current.lines.push(match[2]);
        sections.push(current);
      } else if (current) {
        current.lines.push(line);
      } else {
        preamble.push(line);
      }
    }
    return {
      mode: hasMarkdownSections ? 'headings' : 'flat',
      structured: sections.length >= 2,
      preamble,
      sections,
    };
  }

  function parse(summaryText) {
    return parseStructuredText(summaryText, line => line.startsWith('## Rolling Summary'));
  }

  function parseJudgeCard(cardText) {
    return parseStructuredText(cardText);
  }
  function splitTableRow(line) {
    let row = line.trim();
    if (row.startsWith('|')) row = row.slice(1);
    if (row.endsWith('|')) row = row.slice(0, -1);
    return row.split('|').map(cell => cell.trim());
  }

  function isTableSeparator(cells) {
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
  }

  // 纯函数：只消费第一段连续竖线行；任一数据行少于四格即判整表失败。
  function parseDisagreementTable(lines) {
    const start = lines.findIndex(line => line.trimStart().startsWith('|'));
    if (start < 0) return null;
    let end = start;
    while (end < lines.length && lines[end].trimStart().startsWith('|')) end += 1;

    const rows = [];
    let sawData = false;
    for (let i = start; i < end; i += 1) {
      const cells = splitTableRow(lines[i]);
      if (isTableSeparator(cells)) continue;
      const isHeader = !sawData && cells.some(cell => {
        const label = cell.replaceAll('**', '').trim();
        return label.includes('类型') || /^type$/i.test(label);
      });
      if (isHeader) continue;
      if (cells.length < 4) return null;
      rows.push(cells.length === 4
        ? cells
        : [cells[0], cells[1], cells[2], cells.slice(3).join(' | ')]);
      sawData = true;
    }

    return rows.length ? { start, end, rows } : null;
  }

  // 纯函数：只有成对 ** 才转成 strong 片段；奇数个标记时逐字保留。
  function inlineParts(text) {
    const source = String(text ?? '');
    const markerCount = source.match(/\*\*/g)?.length ?? 0;
    if (!markerCount || markerCount % 2 !== 0) return [{ text: source, strong: false }];
    return source.split('**').map((part, index) => ({ text: part, strong: index % 2 === 1 }));
  }

  function appendInline(target, text, emphasizeQuestion) {
    const parts = inlineParts(text);
    const visibleText = parts.map(part => part.text).join('');
    const questionMatch = emphasizeQuestion
      ? /^(\s*)(问\s+[^：:\n]+|Ask\s+[^:\n]+)(?=[：:])/i.exec(visibleText)
      : null;
    const questionStart = questionMatch ? questionMatch[1].length : -1;
    const questionEnd = questionMatch ? questionStart + questionMatch[2].length : -1;
    let offset = 0;

    for (const part of parts) {
      const partStart = offset;
      const partEnd = partStart + part.text.length;
      const cuts = [partStart, partEnd];
      if (questionStart > partStart && questionStart < partEnd) cuts.push(questionStart);
      if (questionEnd > partStart && questionEnd < partEnd) cuts.push(questionEnd);
      cuts.sort((a, b) => a - b);
      for (let i = 0; i < cuts.length - 1; i += 1) {
        const start = cuts[i];
        const end = cuts[i + 1];
        if (end <= start) continue;
        const segment = part.text.slice(start - partStart, end - partStart);
        const questionStrong = questionMatch && start >= questionStart && end <= questionEnd;
        if (part.strong || questionStrong) {
          const strong = document.createElement('strong');
          strong.textContent = segment;
          target.appendChild(strong);
        } else {
          target.appendChild(document.createTextNode(segment));
        }
      }
      offset = partEnd;
    }
  }

  function renderRawLines(target, lines) {
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = line ? 'summary-line' : 'summary-line summary-line-empty';
      row.textContent = line;
      target.appendChild(row);
    }
  }

  function renderSectionLines(target, lines, emphasizeQuestions) {
    let list = null;
    let lastItem = null;
    let nestedList = null;
    for (const line of lines) {
      const nestedBullet = /^ {2,}[*-]\s+(.*)$/.exec(line);
      if (nestedBullet && lastItem) {
        if (!nestedList) {
          nestedList = document.createElement('ul');
          nestedList.className = 'summary-list summary-list-nested';
          lastItem.appendChild(nestedList);
        }
        const nestedItem = document.createElement('li');
        appendInline(nestedItem, nestedBullet[1], emphasizeQuestions);
        nestedList.appendChild(nestedItem);
        continue;
      }

      if (/^ {2,}\S/.test(line) && lastItem) {
        lastItem.appendChild(document.createElement('br'));
        const nested = document.createElement('span');
        nested.className = 'summary-list-continuation';
        appendInline(nested, line.trimStart(), emphasizeQuestions);
        lastItem.appendChild(nested);
        continue;
      }

      const ordered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
      const unordered = ordered ? null : /^\s*-\s+(.*)$/.exec(line);
      if (ordered || unordered) {
        const tag = ordered ? 'ol' : 'ul';
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = document.createElement(tag);
          list.className = 'summary-list';
          if (ordered && Number(ordered[1]) !== 1) list.start = Number(ordered[1]);
          target.appendChild(list);
        }
        lastItem = document.createElement('li');
        nestedList = null;
        appendInline(lastItem, ordered ? ordered[2] : unordered[1], emphasizeQuestions);
        list.appendChild(lastItem);
        continue;
      }

      list = null;
      lastItem = null;
      nestedList = null;
      const paragraph = document.createElement('div');
      paragraph.className = line ? 'summary-paragraph' : 'summary-paragraph summary-line-empty';
      appendInline(paragraph, line, emphasizeQuestions);
      target.appendChild(paragraph);
    }
  }

  function renderDisagreementTable(parsedTable, title) {
    const labels = [
      t('arena.dtType'),
      t('arena.dtIssue'),
      t('arena.dtStances'),
      t('arena.dtNext'),
    ];
    const table = document.createElement('div');
    table.className = 'summary-dt';
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', title);

    const head = document.createElement('div');
    head.className = 'summary-dt-head';
    head.setAttribute('role', 'row');
    for (const label of labels) {
      const cell = document.createElement('div');
      cell.setAttribute('role', 'columnheader');
      cell.textContent = label;
      head.appendChild(cell);
    }
    table.appendChild(head);

    for (const cells of parsedTable.rows) {
      const row = document.createElement('div');
      row.className = 'summary-dt-row';
      row.setAttribute('role', 'row');
      cells.forEach((text, index) => {
        const cell = document.createElement('div');
        cell.className = `summary-dt-cell summary-dt-cell-${index + 1}`;
        cell.setAttribute('role', 'cell');
        cell.setAttribute('data-label', labels[index]);
        if (index === 0) {
          const pill = document.createElement('span');
          pill.className = 'summary-dt-type';
          appendInline(pill, text, false);
          cell.appendChild(pill);
        } else {
          appendInline(cell, text, false);
        }
        row.appendChild(cell);
      });
      table.appendChild(row);
    }
    return table;
  }

  function renderSection(section, profile) {
    const semantic = kindOf(section.title, profile);
    const wrapper = document.createElement('details');
    wrapper.className = `summary-section summary-section-${semantic.kind}`;
    wrapper.open = true;

    const heading = document.createElement('summary');
    heading.className = 'summary-section-title';
    const icon = document.createElement('span');
    icon.className = 'summary-section-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = semantic.icon;
    const title = document.createElement('span');
    title.className = 'summary-section-label';
    title.textContent = section.title;
    const dot = document.createElement('span');
    dot.className = 'summary-section-dot';
    dot.setAttribute('aria-hidden', 'true');
    heading.append(icon, title);
    if (profile.showYourCall && (section.title.includes('拍板') || /(?:owner|user).*(?:decid|call)/i.test(section.title))) {
      const yourCall = document.createElement('span');
      yourCall.className = 'summary-your-call';
      yourCall.textContent = t('arena.yourCall');
      heading.appendChild(yourCall);
    }
    heading.appendChild(dot);
    wrapper.appendChild(heading);

    const body = document.createElement('div');
    body.className = 'summary-section-body';
    if (profile.disagreementTable && semantic.kind === 'disagreement') {
      const parsedTable = parseDisagreementTable(section.lines);
      if (!parsedTable) {
        body.className += ' summary-lines summary-section-fallback';
        renderRawLines(body, section.lines);
      } else {
        renderSectionLines(body, section.lines.slice(0, parsedTable.start), false);
        body.appendChild(renderDisagreementTable(parsedTable, section.title));
        renderSectionLines(body, section.lines.slice(parsedTable.end), false);
      }
    } else {
      renderSectionLines(body, section.lines, profile.emphasizeQuestions && semantic.kind === 'questions');
    }
    wrapper.appendChild(body);
    return wrapper;
  }

  function renderStructuredContent(content, parsed, source, profile, extraClass) {
    content.className = [
      'summary-content',
      extraClass,
      parsed.structured ? '' : 'summary-lines summary-fallback',
    ].filter(Boolean).join(' ');
    content.replaceChildren();

    if (parsed.structured) {
      if (parsed.preamble.some(line => line.trim())) {
        const preamble = document.createElement('div');
        preamble.className = 'summary-preamble summary-lines';
        renderRawLines(preamble, parsed.preamble);
        content.appendChild(preamble);
      }
      for (const section of parsed.sections) content.appendChild(renderSection(section, profile));
    } else {
      renderRawLines(content, source.split(/\r?\n/));
    }
  }

  function render(roundSummary, roundNumber, summaryText) {
    const source = String(summaryText ?? '');
    const parsed = parse(source);
    const roundHeading = document.createElement('summary');
    roundHeading.textContent = t('arena.roundSummaryTitle', { n: roundNumber });
    const content = document.createElement('div');
    renderStructuredContent(content, parsed, source, roundProfile);

    const raw = document.createElement('details');
    raw.className = 'summary-raw';
    const rawHeading = document.createElement('summary');
    rawHeading.textContent = t('arena.viewRaw');
    const rawText = document.createElement('pre');
    rawText.textContent = source;
    raw.append(rawHeading, rawText);
    roundSummary.replaceChildren(roundHeading, content, raw);
    return parsed;
  }

  function renderJudgeCard(judgeHost, cardText) {
    const source = String(cardText ?? '');
    const parsed = parseJudgeCard(source);
    renderStructuredContent(judgeHost, parsed, source, judgeProfile, 'judge-structured');
    return parsed;
  }

  return { parse, parseJudgeCard, parseDisagreementTable, inlineParts, render, renderJudgeCard };
})();
// ---- 决策侧栏逐轮小结渲染结束 ----

function onEvent(ev) {
  if (ev.type === 'summary' || ev.type === 'judge-card' || ev.type === 'verdict-status' || ev.type === 'crossover') incrementArenaSideUnread();
  if (ev.type === 'chunk') {
    const side = sideOf[ev.agentId];
    if (!side || !isDebaterCall(ev.label)) return; // 非辩手轮次（如同一 agent 兼任的 summarizer/judge）的流不进辩手栏
    const title = roundTitleOf(ev.label);
    let node = ensureRoundDiv(side, title);
    if (node.classList?.contains('sections')) {
      // 该轮已分节展示（如 retry 再次来流）——还原为纯文本继续追加
      const pre = document.createElement('pre');
      pre.textContent = node.dataset.raw ?? '';
      node.replaceWith(pre);
      roundDivs[side + title] = pre;
      node = pre;
    }
    node.textContent += ev.data;            // textContent：天然防 XSS
    if (node.offsetParent) node.scrollIntoView({ block: 'end' }); // 折叠中的轮次不滚动（简明视图回放时）
  }
  if (ev.type === 'agent-status') {
    updateStaffFromEvent(ev);
    const name = cfg.agents[ev.agentId]?.name ?? ev.agentId;
    if (sideOf[ev.agentId] && isDebaterCall(ev.label)) {
      // 辩手徽标：running 时带计时器（阶段性反馈——至少让人知道跑了多久、没有卡死）
      const side = sideOf[ev.agentId];
      stopBadgeTimer(side);
      if (ev.data === 'running') startBadgeTimer(side);
      else {
        badge(side).textContent = ev.data;
        if (ev.data === 'done') sectionizeRound(side, roundTitleOf(ev.label)); // 发言完成→按小节折叠展示
      }
    } else if (ev.label === 'judge') {
      // 仲裁运行时显示身份（此前只有干巴巴的 judging 状态）
      if (ev.data === 'running') setStatebar(t('dyn.judgeRunning', { name }));
    } else if (/summary$/.test(ev.label ?? '')) {
      if (ev.data === 'running') setStatebar(t('dyn.scribeRunning', { name }));
    } else if (isChatCall(ev.label)) {
      if (ev.data === 'running') showTyping(ev.agentId); else hideTyping(ev.agentId); // 消息本身由 chat-message 事件追加，失败则由 error 事件提示
    }
  }
  if (ev.type === 'chat-message') appendChatMessage(ev.from, ev.name, ev.data);
  if (ev.type === 'summary') {
    const summaryHost = $('#summary');
    const priorRoundSummaries = [...summaryHost.children].filter(el => el.classList.contains('round-summary'));
    const lastRoundNumber = priorRoundSummaries.reduce((max, el) => {
      const n = Number(el.dataset.round);
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, 0);
    const roundNumber = Number.isFinite(ev.round) ? ev.round : lastRoundNumber + 1;
    let roundSummary = priorRoundSummaries.find(el => el.dataset.round === String(roundNumber));
    if (!roundSummary) {
      roundSummary = document.createElement('details');
      roundSummary.className = 'round-summary';
      roundSummary.dataset.round = String(roundNumber);
      summaryHost.appendChild(roundSummary);
    }

    const summaryText = String(ev.data ?? '');
    arenaRoundSummaryView.render(roundSummary, roundNumber, summaryText);
    for (const el of summaryHost.children) el.open = el === roundSummary;

    const allRoundSummaries = [...summaryHost.children].filter(el => el.classList.contains('round-summary'));
    const latestRound = allRoundSummaries[allRoundSummaries.length - 1];
    const latestText = latestRound?.lastElementChild?.textContent ?? '';
    $('#resummarize').hidden = !/摘要失败|summary failed/.test(latestText);
    if (denseMode) collapseRounds(); // 提炼物已就位，原文退场
  }
  if (ev.type === 'sys') setStatebar(ev.data); // 编排层提示（如：自动跑完后的下一步指引）
  if (ev.type === 'crossover') renderXoverQueue(ev.data);
  if (ev.type === 'verdict-status') renderVerdictStatus(ev.data?.status ?? null);
  if (ev.type === 'round-done') {
    const pendingCount = lastXoverSummary?.pending?.length ?? 0;
    setStatebar(pendingCount
      ? t('xover.roundDonePending', { round: ev.round, n: pendingCount })
      : t('dyn.roundDone', { round: ev.round }));
    refreshSessionList();
  }
  if (ev.type === 'state') {
    setStatebar(t('dyn.state', { data: ev.data }));
    // 跑轮/裁决进行中禁用轮次控制——不给用户点出「当前状态不能开始新一轮」的机会
    const busy = ev.data === 'running' || ev.data === 'judging';
    for (const sel of ['#next', '#auto', '#dojudge']) { const el = $(sel); if (el) el.disabled = busy; }
    meetingRunning = busy;
    renderXoverQueue(lastXoverSummary); // 批准按钮随轮次运行态启停
  }
  if (ev.type === 'error') {
    const hint = ev.data === 'auth' ? t('dyn.authHint') : '';
    const nm = ev.agentId ? (cfg.agents[ev.agentId]?.name ?? ev.agentId) : '';
    setStatebar((ev.agentId ? t('dyn.errWith', { name: nm, msg: ev.data }) : t('dyn.errPlain', { msg: ev.data })) + hint, true);
  }
  if (ev.type === 'judge-card') {
    $('#judgecard').hidden = false;
    $('#judgeRaw').textContent = ev.data;
    arenaRoundSummaryView.renderJudgeCard($('#judgeStructured'), ev.data);
    populateFlowbackTargets(); // 裁决已自动落回来源；投放面向任意工作台再分发
    refreshSessionList();
  }
}

// 裁决卡再分发：列出全部工作台（活动+归档）供选择
async function populateFlowbackTargets() {
  let list;
  try { list = await (await fetch('/api/sessions')).json(); } catch { return; }
  const benches = list.filter(s => s.type === 'workbench');
  const wrap = $('#flowbackAnyWrap');
  if (!benches.length) { wrap.hidden = true; return; }
  const sel = $('#flowbackTarget');
  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = t('arena.flowbackPick');
  sel.appendChild(ph);
  for (const b of benches) {
    const o = document.createElement('option');
    o.value = b.archived ? b.id : b.dirname; // 两种形态统一为目录名寻址
    o.textContent = (b.topic || '').replace(/^\[工作台\] /, '') || o.value;
    if (o.value) sel.appendChild(o);
  }
  wrap.hidden = false;
}

async function sendNote({ announce = false } = {}) {
  const text = $('#note').value.trim();
  if (!text) return;
  await api('interject', { text });
  $('#note').value = '';
  // 单独点「插话」时给确认反馈；随「下一轮/自动跑完」一起发时按钮本身就是反馈，不重复报
  if (announce) setStatebar(t('dyn.noteQueued'));
}

// 会场常驻显示"在讨论什么、前提是什么"——会一开跑建会表单就没了，这里是唯一入口
function setBrief(topic, materials) {
  $('#brief').hidden = false;
  $('#briefTopic').textContent = topic ?? '';
  $('#briefMaterials').textContent = (materials ?? '').trim() || t('arena.noMaterials');
  $('#briefDetails').open = false;
}

// ---- 跨界交接（聊天→会议）：待纳入队列 + 裁决新鲜度 ----
let meetingRunning = false; // 由 state 事件维护：running/judging 时批准按钮禁用（轮末才确认）
let lastXoverSummary = null; // 最近一次队列快照（state 变化时按新运行态重绘）

function renderXoverQueue(summary) {
  const box = $('#xoverQueue');
  if (!box) return;
  if (summary !== undefined) lastXoverSummary = summary;
  const pending = lastXoverSummary?.pending ?? [];
  box.hidden = !pending.length;
  box.replaceChildren();
  if (!pending.length) return;
  const h = document.createElement('strong');
  h.textContent = `${t('xover.queueTitle')}（${pending.length}）`;
  box.appendChild(h);
  if (pending.length >= 2) {
    const approveAll = document.createElement('button');
    const approveAllBusy = box.dataset.approveAllBusy === 'true';
    approveAll.type = 'button';
    approveAll.textContent = t('xover.approveAll');
    approveAll.disabled = meetingRunning || approveAllBusy;
    if (approveAllBusy) approveAll.setAttribute('aria-busy', 'true');
    approveAll.onclick = async () => {
      box.dataset.approveAllBusy = 'true';
      approveAll.disabled = true;
      approveAll.setAttribute('aria-busy', 'true');
      let latestCrossover = lastXoverSummary;
      for (const ev of pending) {
        let r;
        try {
          const response = await api('crossover-resolve', { id: ev.id, approve: true });
          if (!response) {
            delete box.dataset.approveAllBusy;
            renderXoverQueue(lastXoverSummary ?? latestCrossover);
            return; // api 已报告网络错误；恢复剩余队列供重试
          }
          r = await response.json();
        } catch (e) {
          r = { error: t('dyn.netErr', { msg: e.message }) };
        }
        if (r.crossover) {
          latestCrossover = r.crossover;
          lastXoverSummary = r.crossover;
        }
        if (r.error) {
          delete box.dataset.approveAllBusy;
          renderXoverQueue(r.crossover ?? lastXoverSummary ?? latestCrossover);
          setStatebar(r.error, true);
          return;
        }
      }
      delete box.dataset.approveAllBusy;
      renderXoverQueue(latestCrossover);
    };
    box.append(document.createTextNode(' '), approveAll);
  }
  if (meetingRunning) {
    const hint = document.createElement('div');
    hint.className = 'xover-hint';
    hint.textContent = t('xover.busyHint');
    box.appendChild(hint);
  }
  for (const ev of pending) {
    const row = document.createElement('div');
    row.className = 'xover-row';
    const txt = document.createElement('span');
    txt.textContent = `[${t('xover.t.' + ev.type)}] ${ev.text}`;
    row.appendChild(txt);
    for (const [label, approve] of [[t('xover.approve'), true], [t('xover.reject'), false]]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.disabled = meetingRunning;
      b.onclick = async () => {
        b.disabled = true;
        b.setAttribute('aria-busy', 'true');
        let r;
        try { r = await (await api('crossover-resolve', { id: ev.id, approve })).json(); }
        catch (e) { r = { error: t('dyn.netErr', { msg: e.message }) }; }
        b.disabled = false;
        b.removeAttribute('aria-busy');
        if (r.error) return setStatebar(r.error, true); // 失败保留行可重试
        renderXoverQueue(r.crossover);
      };
      row.appendChild(b);
    }
    box.appendChild(row);
  }
}

function renderVerdictStatus(status) {
  const el = $('#verdictStatus');
  if (!el) return;
  el.hidden = status !== 'possibly_stale'; // 过期标记只随真实重审消失，绝不静默复原
  el.replaceChildren();
  if (el.hidden) return;
  const warn = document.createElement('span');
  warn.textContent = t('xover.stale');
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'accent-outline';
  go.textContent = t('xover.rejudge');
  go.onclick = async () => { go.disabled = true; go.setAttribute('aria-busy', 'true'); await api('rejudge'); };
  const later = document.createElement('button');
  later.type = 'button';
  later.className = 'linklike';
  later.textContent = t('xover.rejudgeLater');
  later.title = t('xover.rejudgeLaterHint');
  later.onclick = () => setStatebar(t('xover.rejudgeLaterHint'));
  el.append(warn, go, later);
}

// ---- 重置会话相关 UI 状态（新会话 / 重连前调用）----
function resetSessionUI() {
  resetArenaSideUI();
  stopBadgeTimer('A'); stopBadgeTimer('B');
  $('#brief').hidden = true; $('#briefTopic').textContent = ''; $('#briefMaterials').textContent = '';
  $('#colA .roundnav').innerHTML = ''; $('#colB .roundnav').innerHTML = '';
  $('#colA .feed').innerHTML = ''; $('#colB .feed').innerHTML = '';
  $('#colA .badge').textContent = ''; $('#colB .badge').textContent = '';
  $('#colA .name').textContent = ''; $('#colB .name').textContent = '';
  $('#summary').replaceChildren();
  $('#judgecard').hidden = true; $('#judgeRaw').textContent = ''; $('#judgeStructured').replaceChildren();
  const xq = $('#xoverQueue'); if (xq) { xq.hidden = true; xq.innerHTML = ''; delete xq.dataset.approveAllBusy; }
  lastXoverSummary = null; meetingRunning = false;
  const vs = $('#verdictStatus'); if (vs) { vs.hidden = true; vs.innerHTML = ''; }
  sessionOrigin = '';
  $('#flowbackAnyWrap').hidden = true;
  const statebar = $('#statebar'); statebar.textContent = ''; statebar.hidden = true; statebar.classList.remove('err');
  const setupbar = $('#setupbar'); setupbar.textContent = ''; setupbar.hidden = true; setupbar.classList.remove('err');
  roundDivs = {};
  sideOf = {};
  staffState = null;
  const staff = $('#staffStatus'); staff.hidden = true; staff.innerHTML = '';
  $('#chatLog').innerHTML = '';
  $('#chatRecipients').innerHTML = '';
  $('#chatInput').value = '';
  $('#chatPanel').open = false;
  typingEls = {};
}

function closeEvents() { if (es) { es.close(); es = null; } }
function connectEvents() {
  closeEvents();
  es = new EventSource(`/api/sessions/${sid}/events`);
  es.onmessage = e => onEvent(JSON.parse(e.data));
  es.onerror = () => setStatebar(t('dyn.streamBrokenShort'), true);
}

// ---- 重连活动会话 ----
async function attach(id) {
  let detail;
  try { detail = await (await fetch(`/api/sessions/${id}`)).json(); } catch (e) { return setStatebar(t('dyn.noServer', { msg: e.message }), true); }
  if (detail.error) return setStatebar(detail.error, true);
  closeWbEvents();
  resetSessionUI();
  sid = id;
  sideOf = { [detail.roles.debaters[0]]: 'A', [detail.roles.debaters[1]]: 'B' };
  sessionOrigin = detail.origin ?? '';
  setBrief(detail.topic, detail.materials);
  $('#colA .name').textContent = detail.agentNames?.[detail.roles.debaters[0]] ?? detail.roles.debaters[0];
  $('#colB .name').textContent = detail.agentNames?.[detail.roles.debaters[1]] ?? detail.roles.debaters[1];
  renderChatRecipients(detail.roles, detail.agentNames ?? {});
  initStaffStatus(detail.roles, detail.agentNames ?? {});
  renderXoverQueue(detail.crossover ?? null);
  renderVerdictStatus(detail.crossover?.verdictStatus ?? null);
  showArena();
  connectEvents(); // 回放缓冲事件重建全部内容
  await refreshSessionList();
}

// ---- 历史会话只读查看 ----
async function openArchive(dirname) {
  let data;
  try { data = await (await fetch(`/api/archive/${encodeURIComponent(dirname)}`)).json(); } catch (e) { return setStatebar(t('dyn.readArchiveFail', { msg: e.message }), true); }
  if (data.error) return setStatebar(data.error, true);
  archiveDirname = dirname;
  showArchiveView(data.topic, data.sessionMd);
}

// ---- 恢复归档会话继续辩论：从磁盘状态重新装配 Committee，attach 到重建的活动会话 ----
async function resumeSession(dirname) {
  let r;
  try { r = await (await fetch(`/api/archive/${encodeURIComponent(dirname)}/resume`, { method: 'POST' })).json(); }
  catch (e) { return setStatebar(t('dyn.resumeFail', { msg: e.message }), true); }
  if (r.error) return setStatebar(r.error, true);
  await attach(r.id);
  await refreshSessionList();
}

// ---- 会议按钮绑定 ----
$('#archiveBack').onclick = () => { sid ? showArena() : showSetup(); };
$('#archiveResume').onclick = () => { if (archiveDirname) resumeSession(archiveDirname); };

$('#start').onclick = async () => {
  const roles = { debaters: [$('#debA').value, $('#debB').value], judge: $('#judge').value, summarizer: $('#summ').value };
  if (roles.debaters[0] === roles.debaters[1]) return setStatebar(t('dyn.sameDebater'), true);
  if (!$('#topic').value.trim()) return setStatebar(t('dyn.needTopic'), true);
  const btn = $('#start');
  btn.disabled = true;
  const oldLabel = btn.textContent;
  btn.textContent = t('dyn.creatingBtn');
  setStatebar(t('dyn.creating'));
  let r;
  try {
    r = await (await fetch('/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: $('#topic').value, materials: $('#materials').value, template: $('#tpl').value, capTemplate: $('#capTpl').value, capGrants: draftCapGrants, workspace: $('#workspace').value.trim(), roles, mode: 'manual', origin: draftOrigin ?? '', lang: draftLang ?? LANG }),
    })).json();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = oldLabel;
    return setStatebar(t('dyn.createFail', { msg: e.message }), true);
  }
  btn.disabled = false;
  btn.textContent = oldLabel;
  if (r.error) {
    return showWorkspaceError($('#setupbar'), $('#workspace'), r);
  }
  closeWbEvents();
  sid = r.id;
  resetSessionUI();
  sessionOrigin = draftOrigin ?? '';
  draftOrigin = null; // 已随建会提交，防止串到下一场手建会议
  draftCapGrants = []; // 同上：授权继承只随本次升格生效
  draftLang = null;
  setBrief($('#topic').value, $('#materials').value);
  $('#setup').hidden = true; // setupbar 已在 resetSessionUI 中清空隐藏
  sideOf = { [roles.debaters[0]]: 'A', [roles.debaters[1]]: 'B' };
  $('#colA .name').textContent = cfg.agents[roles.debaters[0]].name;
  $('#colB .name').textContent = cfg.agents[roles.debaters[1]].name;
  const agentNames = Object.fromEntries(Object.entries(cfg.agents).map(([id, a]) => [id, a.name]));
  renderChatRecipients(roles, agentNames);
  initStaffStatus(roles, agentNames);
  $('#arena').hidden = false;
  connectEvents();
  await refreshSessionList();
  await api('round');
};
$('#next').onclick = async () => { await sendNote(); await api('round'); };
$('#auto').onclick = async () => { await sendNote(); await api('auto', { maxRounds: Number($('#maxR').value) }); };
// 独立插话入口：自动跑期间「下一轮/自动跑完」不可用，这是轮间投放插话的唯一通道
$('#sendNoteBtn').onclick = () => sendNote({ announce: true });
$('#viewToggle').onclick = () => {
  denseMode = !denseMode;
  localStorage.setItem('rt-dense', denseMode ? '1' : '0');
  applyViewMode();
};
applyViewMode(); // 初始按钮文案与状态
$('#note').addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'Enter') sendNote({ announce: true }); });
$('#stop').onclick = () => api('stop');
$('#dojudge').onclick = () => api('judge');
$('#partial').onclick = () => api('save-partial');
$('#resummarize').onclick = () => { $('#resummarize').hidden = true; api('resummarize'); };
$('#chatSend').onclick = async () => {
  const text = $('#chatInput').value.trim();
  if (!text) return;
  const to = [...$('#chatRecipients').querySelectorAll('input:checked')].map(cb => cb.value);
  if (!to.length) return setStatebar(t('dyn.needRecipient'), true);
  arenaLastUserChatQ = text;
  $('#chatInput').value = '';
  await api('chat', { text, to });
};
$('#chatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#chatSend').onclick(); }
});
$('#arenaSideToggle').onclick = () => toggleArenaSide(arenaSideMode === 'closed');
$('#arenaSideClose').onclick = () => { toggleArenaSide(false); $('#arenaSideToggle').focus(); };
$('#arenaSideWiden').onclick = () => setArenaSideMode(arenaSideMode === 'wide' ? 'open' : 'wide');
$('#arenaScrim').onclick = () => { toggleArenaSide(false); $('#arenaSideToggle').focus(); };
window.addEventListener('resize', () => setArenaSideMode(arenaSideMode));
setArenaSideMode(arenaSideMode);
$('#copycard').onclick = () => navigator.clipboard.writeText($('#judgeRaw').textContent);
async function doFlowback(target) {
  setStatebar(t('dyn.flowbackBusy')); // 归档目标要先从磁盘恢复，可能有一两秒——给进行中反馈
  let r;
  try { r = await (await fetch(`/api/sessions/${sid}/flowback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(target ? { target } : {}) })).json(); }
  catch (e) { return setStatebar(t('dyn.flowbackFail', { msg: e.message }), true); }
  if (r.error) return setStatebar(r.error, true);
  await attachWorkbench(r.benchId); // 裁决卡已贴回，切到工作台接着聊
}
$('#flowbackGo').onclick = async () => {
  const v = $('#flowbackTarget').value;
  if (!v) return setStatebar(t('dyn.flowbackPickFirst'), true); // 没选目标必须有提示，不能静默
  $('#flowbackGo').disabled = true;
  try { await doFlowback(v); } finally { $('#flowbackGo').disabled = false; }
};
for (const [sel, side] of [['#colA', 'A'], ['#colB', 'B']]) {
  $(sel + ' .retry').onclick = () => api('retry', { agentId: Object.keys(sideOf).find(k => sideOf[k] === side) });
  $(sel + ' .skip').onclick = () => api('skip', { agentId: Object.keys(sideOf).find(k => sideOf[k] === side) });
}
