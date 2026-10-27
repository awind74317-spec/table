// ===== 工作台（多模型群聊 + 互聊 + 动手/diff 审批 + 升格）=====

// ---- 工作台模块内部状态 ----
const wbTyping = {};      // agentId -> "正在输入…" 元素
let wbLiveBox = null;     // 动手实时输出盒（完成后移除，正式消息+diff 卡随 chat-message 到来）
// wbInfo 声明在 app-core.js（跨模块共享）；这里只读写
let wbLastSpeaker = null; // 隐式路由目标（前端镜像：跟随 chat-message 事件）
let wbConflictRefreshTimer = null;
const wbConflictDiscussTimers = new Map(); // path -> 5 秒兜底恢复 timer

// Execution handoff panel. It previews the current conclusion and copies only after a visible user action.
const wbHandoffUi = (() => {
  const state = {
    launchAvailability: {},
    previewText: '',
    hasGenerated: false,
    busy: null,
    copyHadError: false,
    lastCopySuccess: false,
    participants: [],      // [{ id, name }] —— 可选来做总结的模型
    selectedAgent: null,   // 当前选中的总结模型（null = 让后端用第一个参与者）
    feedback: { handoff: null, launch: null },
  };

  const escAttr = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // 总结模型下拉：选项随参与者变化重建；单选无强制默认——null 表示交给后端用第一个参与者。
  function renderAgentOptions() {
    const sel = $('#handoffAgent');
    if (!sel) return;
    if (state.participants.length && !state.participants.some(p => p.id === state.selectedAgent)) {
      state.selectedAgent = state.participants[0].id;
    }
    if (!state.participants.length) state.selectedAgent = null;
    sel.innerHTML = state.participants.map(p => `<option value="${escAttr(p.id)}">${escAttr(p.name)}</option>`).join('');
    sel.value = state.selectedAgent ?? '';
    sel.disabled = !!state.busy || state.participants.length === 0;
    const row = $('#handoffAgentRow');
    if (row) row.hidden = state.participants.length === 0;
  }

  const motionBehavior = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  const setFeedback = (slot, kind, text) => { state.feedback[slot] = { kind, text }; };

  function panelState() {
    if (state.busy === 'copy') return 'copying';
    if (state.busy === 'generate') return 'generating';
    if (state.lastCopySuccess) return 'success';
    if (Object.values(state.feedback).some(entry => entry?.kind === 'error')) return 'error';
    if (state.copyHadError) return 'error';
    if (state.hasGenerated && state.previewText.trim()) return 'ready';
    return 'empty';
  }

  async function postJson(pathname, body) {
    let response;
    try {
      response = await fetch(`/api/workbenches/${wbId}/${pathname}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(t('handoff.networkError', { msg: error.message }));
    }
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    return { ...data, httpStatus: response.status, httpOk: response.ok };
  }

  const responseError = result => result.error || t('handoff.requestFailed', { code: result.httpStatus });

  function renderFeedback(selector, entry, fallback = '') {
    const element = $(selector);
    if (!element) return;
    element.textContent = entry?.text ?? fallback;
    if (entry?.kind) element.dataset.state = entry.kind;
    else delete element.dataset.state;
  }

  function setButton(button, id, disabled = false, disabledReason = '') {
    const loading = state.busy === id;
    button.disabled = loading || disabled || (!!state.busy && !loading);
    button.setAttribute('aria-busy', loading ? 'true' : 'false');
    button.dataset.state = loading ? 'loading' : (state.copyHadError && id === 'copy' ? 'error' : 'default');
    button.title = button.disabled && !loading ? (disabledReason || t('handoff.waitForAction')) : '';
  }

  function renderLaunch() {
    $('#handoffLaunchClaude').parentElement.setAttribute('aria-label', t('handoff.launchGroup'));
    for (const provider of ['claude', 'codex']) {
      const button = $(`#handoffLaunch${provider === 'claude' ? 'Claude' : 'Codex'}`);
      const available = state.launchAvailability?.[provider]?.available === true;
      setButton(button, `launch-${provider}`, !available, t('handoff.launchUnavailable'));
    }
    renderFeedback('#handoffLaunchFeedback', state.feedback.launch,
      ['claude', 'codex'].some(provider => state.launchAvailability?.[provider]?.available)
        ? '' : t('handoff.launchUnavailable'));
  }

  function renderHandoff() {
    renderAgentOptions();
    const generating = state.busy === 'generate';
    const generate = $('#handoffGenerate');
    generate.textContent = t(generating ? 'handoff.summarizing' : 'handoff.generate');
    generate.setAttribute('aria-busy', generating ? 'true' : 'false');
    setButton(generate, 'generate');
    $('#handoffPreviewBlock').hidden = !state.hasGenerated;
    $('#handoffPreview').textContent = state.previewText;
    const copy = $('#handoffCopy');
    copy.textContent = t(state.busy === 'copy' ? 'handoff.copying'
      : state.copyHadError ? 'handoff.copyRetry'
      : state.lastCopySuccess ? 'handoff.copyAgain' : 'handoff.copy');
    const emptyReason = state.previewText.trim() ? '' : t('handoff.quickEmpty');
    setButton(copy, 'copy', !state.hasGenerated || !!emptyReason, emptyReason);
    renderFeedback('#handoffFeedback', state.feedback.handoff);
  }

  function render() {
    if (!$('#handoffPanel')) return;
    $('#handoffPanel').dataset.state = panelState();
    renderHandoff();
    renderLaunch();
  }

  async function handleGenerate() {
    if (state.busy) return;
    state.busy = 'generate';
    state.copyHadError = false;
    state.lastCopySuccess = false;
    setFeedback('handoff', 'loading', t('handoff.summarizing'));
    render();
    try {
      const result = await postJson('exec-package/summarize', state.selectedAgent ? { agentId: state.selectedAgent } : {});
      if (!result.httpOk || typeof result.text !== 'string') throw new Error(responseError(result));
      state.previewText = String(result.text ?? '');
      state.hasGenerated = true;
      const time = new Date().toLocaleTimeString(LANG === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setFeedback('handoff', state.previewText.trim() ? 'success' : 'warning',
        state.previewText.trim() ? t('handoff.summarizedBy', { name: result.name || '', time }) : t('handoff.quickEmpty'));
    } catch (error) {
      setFeedback('handoff', 'error', t('handoff.previewFailed', { msg: error.message }));
    } finally {
      state.busy = null;
      render();
      if (state.previewText.trim()) $('#handoffPreview').focus({ preventScroll: true });
    }
  }

  async function recordCopy(details) {
    const result = await postJson('handoff-copy-log', {
      taskId: details.fullTextSha256,
      fullTextSha256: details.fullTextSha256,
      fullTextBytes: details.fullTextBytes,
      copiedAt: details.copiedAt,
      writeOk: details.writeOk === true,
      readbackOk: details.readbackOk === true,
    });
    if (!result.httpOk || !result.copyRecord) throw new Error(responseError(result));
    return result.copyRecord;
  }

  function clipboardErrorText(error) {
    if (error.stage === 'write') return t('handoff.writeFailed');
    if (error.stage === 'read') return t('handoff.readFailed');
    if (error.stage === 'mismatch') return t('handoff.mismatch') + (error.diff ? ` [${error.diff}]` : '');
    return t('handoff.clipboardUnavailable');
  }


  async function handleCopy() {
    if (state.busy || !state.hasGenerated || !state.previewText.trim()) return;
    if (!window.RTHandoffClipboard) {
      state.copyHadError = true;
      setFeedback('handoff', 'error', t('handoff.quickUnavailable'));
      return render();
    }
    state.busy = 'copy';
    state.copyHadError = false;
    state.lastCopySuccess = false;
    setFeedback('handoff', 'loading', t('handoff.copying'));
    render();
    let clipboardVerified = false;
    try {
      const fullText = state.previewText;
      const fullTextBytes = window.RTHandoffClipboard.utf8Bytes(fullText);
      const fullTextSha256 = await window.RTHandoffClipboard.sha256Hex(fullText);
      const pkg = { fullText, fullTextBytes, fullTextSha256, userConfirmedAt: new Date().toISOString() };
      const proof = await window.RTHandoffClipboard.copyConfirmedText(pkg);
      clipboardVerified = true;
      const copiedAt = new Date().toISOString();
      await recordCopy({ ...pkg, ...proof, copiedAt });
      const time = new Date(copiedAt).toLocaleTimeString(LANG === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      state.lastCopySuccess = true;
      setFeedback('handoff', 'success', t('handoff.quickCopied', { time }));
    } catch (error) {
      state.copyHadError = true;
      setFeedback('handoff', 'error', clipboardVerified
        ? t('handoff.copyLogFailed', { msg: error.message })
        : clipboardErrorText(error));
    } finally {
      state.busy = null;
      render();
    }
  }

  async function handleLaunch(provider) {
    if (!state.launchAvailability?.[provider]?.available) return;
    state.busy = `launch-${provider}`;
    setFeedback('launch', 'loading', t('handoff.launching', { provider }));
    render();
    try {
      const result = await postJson('handoff-launch', { provider });
      if (!result.httpOk || !result.launched) throw new Error(responseError(result));
      setFeedback('launch', 'success', t('handoff.launched', { provider }));
    } catch (error) {
      setFeedback('launch', 'error', t('handoff.launchFailed', { provider, msg: error.message }));
    } finally {
      state.busy = null;
      render();
    }
  }

  function update(_summary, launchAvailability = null) {
    if (launchAvailability) state.launchAvailability = launchAvailability;
    render();
  }

  // 参与者名单变化时刷新总结模型下拉（成员进出后可选项跟着变）
  function setParticipants(participants = []) {
    state.participants = Array.isArray(participants) ? participants : [];
    render();
  }

  function attach(_summary, launchAvailability = {}, participants = []) {
    state.launchAvailability = launchAvailability ?? {};
    state.previewText = '';
    state.hasGenerated = false;
    state.busy = null;
    state.copyHadError = false;
    state.lastCopySuccess = false;
    state.participants = Array.isArray(participants) ? participants : [];
    state.selectedAgent = state.participants[0]?.id ?? null;
    state.feedback = { handoff: null, launch: null };
    $('#handoffBody').hidden = true;
    $('#handoffToggle').setAttribute('aria-expanded', 'false');
    $('.handoff-toggle-mark').textContent = '+';
    render();
  }

  // 打开面板只展开，绝不自动跑总结——总结必须由用户点「总结并生成预览」触发。
  function reveal(focusSelector = '#handoffGenerate') {
    $('#handoffBody').hidden = false;
    $('#handoffToggle').setAttribute('aria-expanded', 'true');
    $('.handoff-toggle-mark').textContent = '-';
    $('#handoffPanel').scrollIntoView({ block: 'start', behavior: motionBehavior() });
    $(focusSelector)?.focus({ preventScroll: true });
  }

  function bind() {
    $('#handoffToggle').onclick = () => {
      const body = $('#handoffBody');
      body.hidden = !body.hidden;
      $('#handoffToggle').setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
      $('.handoff-toggle-mark').textContent = body.hidden ? '+' : '-';
      // 展开不触发总结——只在用户点按钮时才跑
    };
    $('#handoffAgent').onchange = event => { state.selectedAgent = event.target.value || null; };
    $('#wbDispatchPointer').onclick = () => reveal();
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !$('#handoffBody').hidden && !$('#workbench').hidden) {
        $('#handoffBody').hidden = true;
        $('#handoffToggle').setAttribute('aria-expanded', 'false');
        $('.handoff-toggle-mark').textContent = '+';
        $('#handoffToggle').focus();
      }
    });
    $('#handoffGenerate').onclick = handleGenerate;
    $('#handoffCopy').onclick = handleCopy;
    $('#handoffLaunchClaude').onclick = () => handleLaunch('claude');
    $('#handoffLaunchCodex').onclick = () => handleLaunch('codex');
  }

  bind();
  return { attach, update, render, reveal, setParticipants };
})();
function closeWbEvents() {
  if (wbEs) { wbEs.close(); wbEs = null; }
  if (wbConflictRefreshTimer !== null) { clearTimeout(wbConflictRefreshTimer); wbConflictRefreshTimer = null; }
  for (const timer of wbConflictDiscussTimers.values()) clearTimeout(timer);
  wbConflictDiscussTimers.clear();
  wbId = null;
}

// 建台选人：勾选参与 + 入场即定角色（讨论者/提案者/仲裁者）。无安全写模式的引擎固定为讨论者
function renderWbParticipantPicker() {
  const el = $('#wbParticipants');
  el.innerHTML = '';
  for (const [id, a] of Object.entries(cfg.agents)) {
    const label = document.createElement('label');
    label.className = 'wb-pick';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = id;
    cb.disabled = !!a.unavailable;
    cb.checked = !a.unavailable && ['claude', 'codex'].includes(id);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + a.name + (a.unavailable ? t('dyn.unavailable') : '')));
    if (a.write && !a.unavailable) {
      const sel = document.createElement('select');
      sel.className = 'wb-role';
      sel.dataset.agent = id;
      for (const role of ['talk', 'propose']) {
        const o = document.createElement('option');
        o.value = role;
        o.textContent = t('role.' + role);
        sel.appendChild(o);
      }
      sel.value = 'propose'; // 有写能力默认提案者
      sel.onclick = e => e.preventDefault(); // 防 label 点击串到 checkbox
      label.appendChild(sel);
      // 仲裁是叠加职责：任一能力都可兼任（纯裁判=讨论者+仲裁）
      const arb = document.createElement('label');
      arb.className = 'wb-perm';
      const acb = document.createElement('input');
      acb.type = 'checkbox';
      acb.className = 'wb-arbiter';
      acb.dataset.agent = id;
      acb.onclick = e => e.stopPropagation(); // 防串到参与勾选
      acb.onchange = () => { // 仲裁至多一位：勾选即从他人处转移（单选语义）
        if (acb.checked) document.querySelectorAll('#wbParticipants input.wb-arbiter').forEach(o => { if (o !== acb) o.checked = false; });
      };
      arb.append(acb, ' ' + t('role.arbiter'));
      arb.title = t('wb.arbiterTip');
      label.appendChild(arb);
    } else if (!a.unavailable) {
      const tag = document.createElement('span');
      tag.className = 'wb-role-fixed';
      tag.textContent = t('role.talk');
      tag.title = t('wb.roleNoWrite');
      label.appendChild(tag);
    }
    el.appendChild(label);
  }
}

function setWbBusy(busy) {
  $('#wbSend').disabled = busy;
  $('#wbSend').textContent = busy ? t('dyn.replying') : t('wb.send');
  $('#wbRelay').disabled = busy;
  $('#wbStop').hidden = !busy;
}

// markdown-lite：标题/列表/代码块/**粗体**/`行内码`。逐行 createElement + textContent 构建，
// 模型输出绝不进 innerHTML（与全站同一条防 XSS 底线）；表格等其余语法保持原文
function renderRichText(container, text) {
  const inline = (parent, s) => {
    for (const tok of s.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)) {
      if (!tok) continue;
      if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) {
        const b = document.createElement('strong');
        b.textContent = tok.slice(2, -2);
        parent.appendChild(b);
      } else if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) {
        const c = document.createElement('code');
        c.textContent = tok.slice(1, -1);
        parent.appendChild(c);
      } else parent.appendChild(document.createTextNode(tok));
    }
  };
  let codeBlock = null;
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) {
      if (codeBlock) { codeBlock = null; } // 结束围栏
      else { codeBlock = document.createElement('pre'); codeBlock.className = 'md-code'; container.appendChild(codeBlock); }
      continue;
    }
    if (codeBlock) { codeBlock.appendChild(document.createTextNode(line + '\n')); continue; }
    const h = /^(#{1,4})\s+(.*)/.exec(line);
    const li = /^([-*]|\d+[.、])\s+(.*)/.exec(line);
    const row = document.createElement('div');
    if (h) { row.className = 'md-h'; inline(row, h[2]); }
    else if (li) {
      row.className = 'md-li';
      const marker = document.createElement('span');
      marker.className = 'md-marker';
      marker.textContent = /^[-*]$/.test(li[1]) ? '•' : li[1];
      row.appendChild(marker);
      const rest = document.createElement('span');
      inline(rest, li[2]);
      row.appendChild(rest);
    } else if (line.trim() === '') { row.className = 'md-gap'; }
    else { row.className = 'md-p'; inline(row, line); }
    container.appendChild(row);
  }
}

// ---- 变更卡账本（右栏）：聊天流只留轻量引用，完整卡片在 #wbChangesList ----
const wbChangeNo = {}; // buildId -> 序号（按到达顺序）
function changeNoOf(buildId) {
  if (!(buildId in wbChangeNo)) wbChangeNo[buildId] = Object.keys(wbChangeNo).length + 1;
  return wbChangeNo[buildId];
}

function upsertChangeCard(build) {
  const list = $('#wbChangesList');
  const no = changeNoOf(build.buildId);
  const wrap = document.createElement('div');
  wrap.className = 'wb-change';
  const head = document.createElement('div');
  head.className = 'wb-change-head';
  head.textContent = t('wb.changeNo', { n: no });
  wrap.appendChild(head);
  wrap.appendChild(renderBuildCard(build));
  const old = list.querySelector(`.wb-change[data-build-id="${CSS.escape(build.buildId)}"]`);
  wrap.dataset.buildId = build.buildId;
  if (old) old.replaceWith(wrap);
  else list.prepend(wrap); // 最新在上
  $('#wbChanges').hidden = false; // 有卡必有家
}

function appendChangeRef(buildId, stat) {
  const div = document.createElement('div');
  div.className = 'chat-sys wb-change-ref';
  const a = document.createElement('a');
  a.href = 'javascript:void(0)';
  a.textContent = t('wb.changeRef', { n: changeNoOf(buildId), stat: stat ?? '' });
  a.onclick = () => {
    const card = $('#wbChangesList').querySelector(`.wb-change[data-build-id="${CSS.escape(buildId)}"]`);
    if (card) { card.scrollIntoView({ block: 'start' }); card.classList.add('wb-change-flash'); setTimeout(() => card.classList.remove('wb-change-flash'), 1200); }
  };
  div.appendChild(a);
  $('#wbLog').appendChild(div);
  $('#wbLog').scrollTop = $('#wbLog').scrollHeight;
}

function clearWbConflictDiscussBusy(path) {
  const timer = wbConflictDiscussTimers.get(path);
  if (timer !== undefined) clearTimeout(timer);
  wbConflictDiscussTimers.delete(path);
  document.querySelectorAll('#wbConflicts .wb-conflict-discuss').forEach(btn => {
    if (btn.dataset.path !== path) return;
    btn.disabled = false;
    btn.textContent = t('wb.discussBtn');
    btn.removeAttribute('aria-busy');
  });
}

function syncWbConflictAuthority() {
  const participantIds = wbInfo?.participants ?? [];
  const hasArbiter = participantIds.some(id => wbInfo.roles?.[id]?.arbiter === true);
  const hasDecidingArbiter = participantIds.some(id => wbInfo.roles?.[id]?.arbiter === true && wbInfo.roles[id].decide === true);
  document.querySelectorAll('#wbConflicts [data-conflict-authority]').forEach(btn => {
    if (btn.getAttribute('aria-busy') === 'true') return;
    const needsDecide = btn.dataset.conflictAuthority === 'decide';
    btn.disabled = !hasArbiter || (needsDecide && !hasDecidingArbiter);
    btn.title = !hasArbiter ? t('wb.needArbiterTip') : (needsDecide && !hasDecidingArbiter ? t('wb.needDecideTip') : '');
  });
}

async function postWbConflictRequest(endpoint, body) {
  let result;
  try {
    result = await (await fetch(`/api/workbenches/${wbId}/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })).json();
  } catch (e) {
    appendWbError(t('dyn.netErr', { msg: e.message }));
    return false;
  }
  if (result.error) { appendWbError(result.error); return false; }
  return true;
}

function scheduleWbConflictRefresh() {
  if (!wbId || wbConflictRefreshTimer !== null) return;
  wbConflictRefreshTimer = setTimeout(() => {
    wbConflictRefreshTimer = null;
    refreshWbConflicts();
  }, 0);
}

async function refreshWbConflicts() {
  if (!wbId) return;
  const requestedWbId = wbId;
  let result;
  try { result = await (await fetch(`/api/workbenches/${requestedWbId}/conflicts`)).json(); }
  catch (e) {
    if (wbId === requestedWbId) appendWbError(t('dyn.netErr', { msg: e.message }));
    return;
  }
  if (wbId !== requestedWbId) return; // 切台后的旧请求不得覆盖当前台
  if (result.error) { appendWbError(result.error); return; }

  const panel = $('#wbConflicts');
  const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
  panel.replaceChildren();
  document.querySelectorAll('#wbChangesList .wb-conflict-badge').forEach(badge => badge.remove());
  if (!conflicts.length) { panel.hidden = true; return; }

  panel.hidden = false;
  const title = document.createElement('h4');
  title.className = 'wb-conflicts-title';
  title.textContent = t('wb.conflictsTitle');
  panel.appendChild(title);
  const conflictBuildIds = new Set();

  for (const conflict of conflicts) {
    const path = String(conflict.path ?? '');
    const item = document.createElement('section');
    item.className = 'wb-conflict-item';
    const head = document.createElement('div');
    head.className = 'wb-conflict-head';
    const warning = document.createElement('span');
    warning.textContent = '⚠';
    warning.setAttribute('aria-hidden', 'true');
    const pathEl = document.createElement('code');
    pathEl.textContent = path;
    head.append(warning, pathEl);
    item.appendChild(head);

    const involves = document.createElement('div');
    involves.className = 'wb-conflict-involves';
    const involvesLabel = document.createElement('span');
    involvesLabel.textContent = t('wb.conflictInvolves');
    involves.appendChild(involvesLabel);
    const refs = document.createElement('div');
    refs.className = 'wb-conflict-refs';
    for (const build of (Array.isArray(conflict.builds) ? conflict.builds : [])) {
      const buildId = String(build.buildId ?? '');
      if (!buildId) continue;
      conflictBuildIds.add(buildId);
      const ref = document.createElement('button');
      ref.type = 'button';
      ref.className = 'wb-conflict-change';
      const actorName = build.actorName ?? wbInfo.agentNames?.[build.actorId] ?? build.actorId ?? '';
      ref.textContent = t('wb.changeNo', { n: changeNoOf(buildId) }) + ' · ' + actorName;
      ref.onclick = () => {
        const card = $('#wbChangesList').querySelector(`.wb-change[data-build-id="${CSS.escape(buildId)}"]`);
        if (!card) return;
        card.scrollIntoView({ block: 'start' });
        card.classList.add('wb-change-flash');
        setTimeout(() => card.classList.remove('wb-change-flash'), 1200);
      };
      refs.appendChild(ref);
    }
    involves.appendChild(refs);
    item.appendChild(involves);

    const actions = document.createElement('div');
    actions.className = 'wb-conflict-actions';
    const discussBtn = document.createElement('button');
    discussBtn.type = 'button';
    discussBtn.className = 'wb-conflict-discuss';
    discussBtn.dataset.path = path;
    const discussBusy = wbConflictDiscussTimers.has(path);
    discussBtn.disabled = discussBusy;
    discussBtn.textContent = t(discussBusy ? 'wb.discussBusy' : 'wb.discussBtn');
    if (discussBusy) discussBtn.setAttribute('aria-busy', 'true');
    discussBtn.onclick = async () => {
      discussBtn.disabled = true;
      discussBtn.textContent = t('wb.discussBusy');
      discussBtn.setAttribute('aria-busy', 'true');
      const priorTimer = wbConflictDiscussTimers.get(path);
      if (priorTimer !== undefined) clearTimeout(priorTimer);
      wbConflictDiscussTimers.set(path, setTimeout(() => clearWbConflictDiscussBusy(path), 5000));
      const ok = await postWbConflictRequest('conflict-discuss', { path });
      if (!ok) clearWbConflictDiscussBusy(path);
    };
    actions.appendChild(discussBtn);

    for (const action of [
      { key: 'wb.mergeBtn', decide: false, authority: 'arbiter' },
      { key: 'wb.decideBtn', decide: true, authority: 'decide' },
    ]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.conflictAuthority = action.authority;
      btn.textContent = t(action.key);
      btn.onclick = async () => {
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        await postWbConflictRequest('conflict-merge', { path, decide: action.decide, note: '' });
        btn.removeAttribute('aria-busy');
        syncWbConflictAuthority();
      };
      actions.appendChild(btn);
    }
    item.appendChild(actions);
    panel.appendChild(item);
  }

  const hint = document.createElement('p');
  hint.className = 'wb-conflict-hint';
  hint.textContent = t('wb.conflictHint');
  panel.appendChild(hint);
  syncWbConflictAuthority();

  for (const buildId of conflictBuildIds) {
    const card = $('#wbChangesList').querySelector(`.wb-change[data-build-id="${CSS.escape(buildId)}"]`);
    const head = card?.querySelector('.wb-change-head');
    if (!head) continue;
    const badge = document.createElement('span');
    badge.className = 'wb-conflict-badge';
    badge.textContent = t('wb.conflictBadge');
    head.appendChild(badge);
  }
}

// 聊天→会议显式交接：消息行内小按钮展开四种事件类型（结构化字段直达 API，无文本推断）
const XOVER_TYPES = ['supplement_material', 'correct_fact', 'answer_question', 'change_goal_or_constraint'];
function makeXoverControl(seq) {
  const wrap = document.createElement('span');
  wrap.className = 'xover-ctl';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'linklike xover-trigger';
  trigger.textContent = t('xover.send');
  trigger.title = t('xover.sendTitle');
  const menu = document.createElement('span');
  menu.className = 'xover-menu';
  menu.hidden = true;
  trigger.onclick = () => { menu.hidden = !menu.hidden; };
  for (const type of XOVER_TYPES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t('xover.t.' + type);
    b.onclick = async () => {
      const old = b.textContent;
      b.disabled = true;
      b.setAttribute('aria-busy', 'true');
      b.textContent = t('xover.sending');
      let r;
      try { r = await (await fetch(`/api/workbenches/${wbId}/crossover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seq, type }) })).json(); }
      catch (e) { r = { error: t('dyn.netErr', { msg: e.message }) }; }
      b.disabled = false;
      b.removeAttribute('aria-busy');
      b.textContent = old;
      if (r.error) return appendWbError(r.error); // 失败保留菜单可重试
      menu.hidden = true;
    };
    menu.appendChild(b);
  }
  wrap.append(trigger, menu);
  return wrap;
}

function appendWbMessage(from, name, to, text, ctx, build, meeting, attachments, seq) {
  const el = wbTyping[from]; if (el) { el.remove(); delete wbTyping[from]; }
  if (meeting) {
    const card = document.createElement('div');
    card.className = 'wb-meeting-card';
    card.dataset.kind = meeting.kind;

    const title = document.createElement('div');
    title.className = 'wb-meeting-title';
    title.textContent = '⚖ ' + (meeting.kind === 'verdict' ? t('wb.meetingVerdict')
      : meeting.kind === 'round' ? t('wb.meetingRound', { n: meeting.round ?? '?' })
      : meeting.kind === 'statement' ? t('wb.meetingStatement', { n: meeting.round ?? '?', name: meeting.speaker ?? '' })
      : t('wb.meetingStarted'));

    const topic = document.createElement('div');
    topic.className = 'wb-meeting-topic';
    topic.textContent = meeting.topic ?? '';

    card.appendChild(title);
    card.appendChild(topic);

    if (meeting.kind === 'verdict' || meeting.kind === 'round' || meeting.kind === 'statement') {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = t(meeting.kind === 'verdict' ? 'wb.meetingVerdictExpand' : meeting.kind === 'round' ? 'wb.meetingRoundExpand' : 'wb.meetingStatementExpand');
      const verdict = document.createElement('pre');
      verdict.textContent = text;
      details.appendChild(summary);
      details.appendChild(verdict);
      card.appendChild(details);
    }

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'wb-meeting-open';
    openBtn.textContent = t('wb.openMeeting');
    openBtn.onclick = async () => {
      openBtn.disabled = true;
      openBtn.setAttribute('aria-busy', 'true');
      try { await openMeetingByDirname(meeting.dir); }
      finally {
        openBtn.disabled = false;
        openBtn.removeAttribute('aria-busy');
      }
    };
    card.appendChild(openBtn);

    $('#wbLog').appendChild(card);
    $('#wbLog').scrollTop = $('#wbLog').scrollHeight;
    return;
  }

  const div = document.createElement('div');
  div.className = 'chat-msg ' + (from === 'user' ? 'chat-user' : 'chat-agent');
  const nameEl = document.createElement('div');
  nameEl.className = 'chat-name';
  nameEl.textContent = name + (to?.length ? ' → ' + to.join('、') : '');
  const bodyEl = document.createElement('div');
  bodyEl.className = 'chat-body';
  if (from === 'user') bodyEl.textContent = text;
  else renderRichText(bodyEl, text); // 模型回复常带 markdown——富渲染提升可读性
  div.appendChild(nameEl);
  div.appendChild(bodyEl);
  if (attachments?.length) { // 附件行：与后端给模型的标注一致，用户可见自己发了什么
    const attEl = document.createElement('div');
    attEl.className = 'chat-atts';
    attEl.textContent = attachments.map(a => `${a.kind === 'image' ? '🖼' : '📄'} ${a.name}`).join('  ');
    // 附件旁只保留一个显式入口，打开交接面板并从本场结论生成预览。
    const toTask = document.createElement('button');
    toTask.type = 'button';
    toTask.className = 'linklike';
    toTask.textContent = t('handoff.generate');
    toTask.onclick = () => {
      wbHandoffUi.reveal('#handoffGenerate');
    };
    attEl.appendChild(toTask);
    div.appendChild(attEl);
  }
  if (seq !== undefined) div.querySelector('.chat-name')?.appendChild(makeXoverControl(seq));
  if (ctx) { // 截断明示（裁决卡：禁止静默截断）
    const chip = document.createElement('div');
    chip.className = 'ctx-chip';
    chip.textContent = t('dyn.ctxChip', { shown: ctx.shown, total: ctx.total });
    div.appendChild(chip);
  }
  if (build) { upsertChangeCard(build); appendChangeRef(build.buildId, build.stat); }
  $('#wbLog').appendChild(div);
  $('#wbLog').scrollTop = $('#wbLog').scrollHeight;
}

async function openMeetingByDirname(dirname) {
  let sessions;
  try { sessions = await (await fetch('/api/sessions')).json(); }
  catch { return appendWbError(t('wb.meetingGone')); }
  if (!Array.isArray(sessions)) return appendWbError(t('wb.meetingGone'));

  const active = sessions.find(s => !s.archived && s.type !== 'workbench' && s.dirname === dirname);
  if (active) return attach(active.id);

  const archived = sessions.find(s => s.archived && s.id === dirname);
  if (archived) return resumeSession(dirname);

  appendWbError(t('wb.meetingGone'));
}

// 与后端 splitPatchByFile 同逻辑：按 diff --git 头切文件段
function splitPatchClient(patch) {
  return (patch || '').split(/(?=^diff --git )/m).filter(s => s.trim()).map(seg => {
    const m = /^diff --git "?a\/(.+?)"? "?b\//.exec(seg);
    return { path: m ? m[1] : '(unknown)', patch: seg };
  });
}

function coloredPatchPre(text) {
  const pre = document.createElement('pre');
  pre.className = 'build-patch';
  for (const line of (text || t('dyn.patchMissing')).split('\n')) {
    const span = document.createElement('span');
    span.textContent = line + '\n';
    if (/^\+(?!\+\+)/.test(line)) span.className = 'dl-add';
    else if (/^-(?!--)/.test(line)) span.className = 'dl-del';
    else if (/^(diff |@@)/.test(line)) span.className = 'dl-meta';
    pre.appendChild(span);
  }
  return pre;
}

const buildAction = (buildId, action, files) =>
  fetch(`/api/workbenches/${wbId}/builds/${buildId}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(files ? { files } : {}),
  }).then(r => r.json())
    .then(r => { if (r.error) appendWbError((action === 'apply' ? t('dyn.applyFail') : '') + r.error + (action === 'apply' ? t('dyn.applyConflictHint') : '')); })
    .catch(e => appendWbError(t('dyn.netErr', { msg: e.message })));

// 动手 diff 卡片：按文件分节（每个文件独立 折叠diff+应用/丢弃）+ 顶部整体操作
function renderBuildCard(build) {
  const card = document.createElement('div');
  card.className = 'build-card';
  card.dataset.buildId = build.buildId;
  const statEl = document.createElement('pre');
  statEl.className = 'build-stat';
  statEl.textContent = build.stat;
  card.appendChild(statEl);

  const segs = splitPatchClient(build.patch);
  const files = build.files?.length ? build.files : [{ path: '(全部)', status: build.status }];
  const fileRows = new Map();
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'build-file';
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'bf-path';
    nameSpan.textContent = f.path;
    const stSpan = document.createElement('span');
    stSpan.className = 'bf-st';
    const applyBtn = document.createElement('button');
    applyBtn.textContent = t('dyn.applyOne');
    applyBtn.title = t('dyn.applyOneTitle');
    applyBtn.onclick = e => { e.preventDefault(); e.stopPropagation(); buildAction(build.buildId, 'apply', f.path === '(全部)' ? null : [f.path]); };
    const discardBtn = document.createElement('button');
    discardBtn.textContent = t('dyn.discardOne');
    discardBtn.onclick = e => { e.preventDefault(); e.stopPropagation(); buildAction(build.buildId, 'discard', f.path === '(全部)' ? null : [f.path]); };
    sum.appendChild(nameSpan);
    sum.appendChild(stSpan);
    sum.appendChild(applyBtn);
    sum.appendChild(discardBtn);
    det.appendChild(sum);
    const seg = segs.find(s => s.path === f.path);
    det.appendChild(coloredPatchPre(seg ? seg.patch : build.patch));
    row.appendChild(det);
    card.appendChild(row);
    fileRows.set(f.path, { stSpan, applyBtn, discardBtn });
  }

  const bar = document.createElement('div');
  bar.className = 'build-bar';
  const status = document.createElement('span');
  status.className = 'build-status';
  const applyAll = document.createElement('button');
  applyAll.className = 'primary';
  applyAll.textContent = t('dyn.applyAll');
  applyAll.onclick = () => buildAction(build.buildId, 'apply', null);
  const discardAll = document.createElement('button');
  discardAll.textContent = t('dyn.discardAll');
  discardAll.onclick = () => buildAction(build.buildId, 'discard', null);
  const checkBtn = document.createElement('button');
  checkBtn.textContent = t('dyn.check');
  checkBtn.title = t('dyn.checkTitle');
  checkBtn.onclick = async () => {
    const cmd = prompt(t('dyn.checkPrompt'), localStorage.getItem('rt-check-cmd') || 'npm test');
    if (cmd === null || !cmd.trim()) return;
    localStorage.setItem('rt-check-cmd', cmd.trim());
    let r;
    try { r = await (await fetch(`/api/workbenches/${wbId}/builds/${build.buildId}/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: cmd.trim() }) })).json(); }
    catch (e) { return appendWbError(t('dyn.netErr', { msg: e.message })); }
    if (r.error) appendWbError(r.error);
  };
  bar.appendChild(applyAll);
  bar.appendChild(discardAll);
  bar.appendChild(checkBtn);
  bar.appendChild(status);
  card.appendChild(bar);

  const setStatus = (st, fileStates) => {
    status.textContent = st === 'pending' ? t('dyn.stPending') : (st === 'applied' ? t('dyn.stApplied') : (st === 'partial' ? t('dyn.stPartial') : t('dyn.stDiscarded')));
    status.dataset.st = st;
    const done = st === 'applied' || st === 'discarded';
    applyAll.hidden = done;
    discardAll.hidden = done;
    checkBtn.hidden = done;
    for (const f of (fileStates ?? files)) {
      const row = fileRows.get(f.path);
      if (!row) continue;
      row.stSpan.textContent = f.status === 'pending' ? '' : (f.status === 'applied' ? t('dyn.fApplied') : t('dyn.fDiscarded'));
      row.stSpan.dataset.st = f.status;
      row.applyBtn.hidden = f.status !== 'pending';
      row.discardBtn.hidden = f.status !== 'pending';
    }
  };
  card.updateStatus = setStatus;
  setStatus(build.status, files);
  return card;
}

function appendWbError(text) {
  const div = document.createElement('div');
  div.className = 'wb-error';
  div.textContent = text;
  $('#wbLog').appendChild(div);
  $('#wbLog').scrollTop = $('#wbLog').scrollHeight;
}

function ensureLiveBox(agentName) {
  if (wbLiveBox) return wbLiveBox.querySelector('pre');
  wbLiveBox = document.createElement('div');
  wbLiveBox.className = 'build-live';
  const head = document.createElement('div');
  head.className = 'build-live-head';
  head.textContent = t('dyn.buildLive', { name: agentName });
  const pre = document.createElement('pre');
  wbLiveBox.appendChild(head);
  wbLiveBox.appendChild(pre);
  $('#wbLog').appendChild(wbLiveBox);
  return pre;
}
function removeLiveBox() { if (wbLiveBox) { wbLiveBox.remove(); wbLiveBox = null; } }

function onWbEvent(ev) {
  if (ev.type === 'chat-message') {
    removeLiveBox();
    appendWbMessage(ev.from, ev.name, ev.to, ev.data, ev.ctx, ev.build, ev.meeting, ev.attachments, ev.seq);
    if (ev.build) scheduleWbConflictRefresh();
    const messageText = String(ev.data ?? '');
    if (messageText.includes('【冲突对比')) {
      for (const path of [...wbConflictDiscussTimers.keys()]) {
        if (messageText.includes(`【冲突对比 · ${path}】`)) clearWbConflictDiscussBusy(path);
      }
    }
    if (ev.from !== 'user') { wbLastSpeaker = ev.from; updateWbRouteHint(); } // 隐式路由目标随发言实时可见
  }
  if (ev.type === 'participants' && wbInfo) {
    // 成员变化事件（含重连回放）——与本地一致则跳过，避免与 changeParticipants 的响应刷新互踩
    const same = ev.data.length === wbInfo.participants.length && ev.data.every(p => wbInfo.participants.includes(p));
    if (!same) {
      wbInfo.participants = ev.data; renderWbMembers(); renderWbRecipients();
      wbHandoffUi.setParticipants(wbInfo.participants.map(id => ({ id, name: wbInfo.agentNames?.[id] ?? cfg.agents?.[id]?.name ?? id })));
    }
  }
  if (ev.type === 'build-progress') {
    const pre = ensureLiveBox(cfg.agents[ev.agentId]?.name ?? ev.agentId);
    pre.appendChild(document.createTextNode(ev.data));
    // 只留末尾 ~12KB，防长任务把 DOM 撑爆
    while (pre.textContent.length > 12000 && pre.firstChild) pre.removeChild(pre.firstChild);
    wbLiveBox.scrollTop = wbLiveBox.scrollHeight;
    $('#wbLog').scrollTop = $('#wbLog').scrollHeight;
  }
  if (ev.type === 'check-result') {
    const card = document.createElement('div');
    card.className = 'check-card ' + (ev.ok ? 'check-ok' : 'check-fail');
    const head = document.createElement('div');
    head.className = 'check-head';
    head.textContent = (ev.timedOut ? t('dyn.checkTimeout') : (ev.ok ? t('dyn.checkPass') : t('dyn.checkFail', { code: ev.code }))) + ' · ' + ev.cmd;
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = t('dyn.viewOutput');
    const pre = document.createElement('pre');
    pre.textContent = ev.output || t('dyn.noOutput');
    det.appendChild(sum);
    det.appendChild(pre);
    card.appendChild(head);
    card.appendChild(det);
    $('#wbLog').appendChild(card);
    $('#wbLog').scrollTop = $('#wbLog').scrollHeight;
  }
  if (ev.type === 'build-status') {
    const card = $('#wbChangesList').querySelector(`.build-card[data-build-id="${ev.buildId}"]`);
    if (card?.updateStatus) card.updateStatus(ev.status, ev.files);
    scheduleWbConflictRefresh();
  }
  if (ev.type === 'state') { setWbBusy(ev.data === 'busy'); if (ev.data === 'idle') removeLiveBox(); }
  if (ev.type === 'agent-status') {
    const name = cfg.agents[ev.agentId]?.name ?? ev.agentId;
    const chipDot = $('#wbMembers')?.querySelector(`.member-chip[data-agent="${ev.agentId}"] .st-dot`);
    if (chipDot) chipDot.className = 'st-dot ' + (ev.data === 'running' ? 'st-live' : 'st-idle');
    if (ev.data === 'running') {
      const div = document.createElement('div');
      div.className = 'chat-msg chat-agent chat-typing';
      div.textContent = t('dyn.typing', { name });
      $('#wbLog').appendChild(div);
      $('#wbLog').scrollTop = $('#wbLog').scrollHeight;
      wbTyping[ev.agentId] = div;
    } else {
      const el = wbTyping[ev.agentId]; if (el) { el.remove(); delete wbTyping[ev.agentId]; }
    }
  }
  if (ev.type === 'error') { const nm = ev.agentId ? (cfg.agents[ev.agentId]?.name ?? ev.agentId) : ''; appendWbError(ev.agentId ? t('dyn.errWith', { name: nm, msg: ev.data }) : t('dyn.errPlain', { msg: ev.data })); }
  if (ev.type === 'sys') {
    const div = document.createElement('div');
    div.className = 'wb-sys';
    div.textContent = ev.data;
    $('#wbLog').appendChild(div);
    $('#wbLog').scrollTop = $('#wbLog').scrollHeight;
  }
  if (ev.type === 'cap-suggestion') renderCapSuggestion(ev.data);
  if (ev.type === 'caps-changed') { if (wbInfo) wbInfo.caps = ev.data; renderWbCaps(); }
  if (ev.type === 'handoff') {
    if (wbInfo) wbInfo.handoff = ev.data;
    wbHandoffUi.update(ev.data);
  }
}

function wbAgentHealthState(agent) {
  return agent?.unavailable ? 'bad' : (agent?.smoke ? (agent.smoke.ok ? 'ok' : 'bad') : 'unknown');
}

async function checkWbAgent(agentId, chip, dot) {
  chip.disabled = true;
  chip.setAttribute('aria-busy', 'true');
  dot.className = 'as-dot as-checking';
  dot.title = t('diag.checking');
  try { await smokeAgent(agentId); }
  finally { renderWbMembers(); }
}

async function editWbWorkspace(button) {
  const workspacePath = prompt(t('wb.wsPrompt'), wbInfo.workspace ?? '');
  if (workspacePath === null) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = t('wb.wsSaving');
  let result;
  try {
    result = await (await fetch(`/api/workbenches/${wbId}/workspace`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: workspacePath }),
    })).json();
  } catch (e) { result = { error: t('dyn.netErr', { msg: e.message }) }; }
  if (result.error) {
    appendWbError(result.error);
    renderWbMembers();
    return;
  }
  Object.assign(wbInfo, { workspace: result.workspace, writeCapable: result.writeCapable, roles: result.roles });
  renderWbMembers();
  renderWbActionPanel();
}

function renderWbMembers() {
  const members = $('#wbMembers');
  if (!members || !wbInfo) return;
  members.replaceChildren();
  for (const agentId of wbInfo.participants) {
    const agent = cfg.agents[agentId] ?? {};
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'member-chip';
    chip.dataset.agent = agentId;
    const activity = document.createElement('i');
    activity.className = 'st-dot ' + (wbTyping[agentId] ? 'st-live' : 'st-idle');
    activity.setAttribute('aria-hidden', 'true');
    const health = document.createElement('span');
    health.className = 'as-dot as-' + wbAgentHealthState(agent);
    health.title = agentDiagnosticText(agent);
    health.setAttribute('aria-label', agentDiagnosticText(agent));
    chip.title = agentDiagnosticText(agent);
    chip.append(activity, health, document.createTextNode(wbInfo.agentNames[agentId] ?? agent.name ?? agentId));
    chip.onclick = () => checkWbAgent(agentId, chip, health);
    members.appendChild(chip);
  }
  const workspaceButton = document.createElement('button');
  workspaceButton.type = 'button';
  workspaceButton.className = 'wb-ws' + (wbInfo.workspace ? '' : ' wb-ws-empty');
  workspaceButton.textContent = wbInfo.workspace
    ? (wbInfo.workspace.split(/[\\/]/).filter(Boolean).at(-1) || wbInfo.workspace)
    : t('wb.wsMount');
  workspaceButton.title = t('wb.wsEditTip');
  workspaceButton.onclick = () => editWbWorkspace(workspaceButton);
  members.appendChild(workspaceButton);
}

// ===== 能力授权装配（v1）：chip + 面板 + 建议卡（全部只展示安全元数据，host 只做确定性动作） =====
function capMetaLine(c) {
  const perms = (c.permissions ?? []).join(',') || t('caps.none');
  return `${localizeField(c.name)}｜${localizeField(c.summary)}｜${t('caps.risk')}:${c.risk}｜${t('caps.perms')}:${perms}`;
}

async function wbCapOp(body) {
  let r;
  try { r = await (await fetch(`/api/workbenches/${wbId}/capabilities`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(); }
  catch (e) { r = { error: t('dyn.netErr', { msg: e.message }) }; }
  if (r.error) { appendWbError(r.error); return null; }
  if (r.caps && wbInfo) { wbInfo.caps = r.caps; renderWbCaps(); }
  return r;
}

function renderWbCaps() {
  const caps = wbInfo?.caps;
  const chip = $('#wbCapsChip');
  if (!chip) return;
  if (!caps) { chip.hidden = true; $('#wbCapsPanel').hidden = true; return; }
  chip.hidden = false;
  chip.textContent = `⛭ ${localizeField(caps.templateTitle)} · ${caps.enabled.length + caps.granted.length}`;
  if (!$('#wbCapsPanel').hidden) renderWbCapsPanel();
}

function renderWbCapsPanel() {
  const caps = wbInfo?.caps;
  const panel = $('#wbCapsPanel');
  if (!caps) return;
  panel.replaceChildren();
  const h = document.createElement('div');
  h.className = 'caps-head';
  const title = document.createElement('strong');
  title.textContent = `${t('caps.panelTitle')} — ${localizeField(caps.templateTitle)} v${caps.templateVersion}`;
  h.appendChild(title);
  // 模板切换：显式选择器 + 确认框里列出能力与权限将变成什么
  const sel = document.createElement('select');
  sel.innerHTML = Object.entries(cfg.capTemplates ?? {}).map(([tid, tp]) => `<option value="${tid}"${tid === caps.templateId ? ' selected' : ''}>${localizeField(tp.title)}</option>`).join('');
  sel.setAttribute('aria-label', t('caps.switch'));
  sel.onchange = async () => {
    const tid = sel.value;
    if (tid === caps.templateId) return;
    const tp = cfg.capTemplates?.[tid];
    const enabledNames = (tp?.enabled ?? []).map(c => localizeField(c.name)).join('、') || t('caps.none');
    const permsOn = Object.entries(tp?.permissions ?? {}).filter(([, v]) => v === true).map(([k]) => k).join(',') || t('caps.none');
    if (!confirm(t('caps.switchConfirm', { tpl: localizeField(tp?.title), enabled: enabledNames, perms: permsOn }))) { sel.value = caps.templateId; return; }
    sel.disabled = true;
    const r = await wbCapOp({ op: 'set-template', templateId: tid });
    sel.disabled = false;
    if (!r) sel.value = caps.templateId; // 失败回弹，会议内容不受影响
  };
  h.appendChild(sel);
  const close = document.createElement('button');
  close.className = 'linklike';
  close.textContent = t('caps.close');
  close.onclick = () => { panel.hidden = true; };
  h.appendChild(close);
  panel.appendChild(h);
  const section = (label, items, mk) => {
    const wrap = document.createElement('div');
    wrap.className = 'caps-section';
    const lab = document.createElement('em');
    lab.textContent = label;
    wrap.appendChild(lab);
    if (!items.length) { const s = document.createElement('span'); s.textContent = ' ' + t('caps.none'); wrap.appendChild(s); }
    for (const c of items) {
      const row = document.createElement('div');
      row.className = 'caps-row';
      const txt = document.createElement('span');
      txt.textContent = `${c.id} v${c.version} — ${capMetaLine(c)}`;
      row.appendChild(txt);
      if (mk) mk(row, c);
      wrap.appendChild(row);
    }
    panel.appendChild(wrap);
  };
  section(t('caps.enabled'), caps.enabled);
  section(t('caps.granted'), caps.granted, (row, c) => {
    const wb = document.createElement('button');
    wb.textContent = t('caps.writeback');
    wb.onclick = async () => {
      // 模板写回＝独立第二次确认；本场授权绝不自动落盘到模板
      if (!confirm(t('caps.writebackConfirm', { cap: localizeField(c.name), tpl: localizeField(caps.templateTitle) }))) return;
      wb.disabled = true;
      const r = await wbCapOp({ op: 'writeback', id: c.id, reason: 'user-confirmed in caps panel' });
      wb.disabled = false;
      if (r) renderWbCapsPanel();
    };
    row.appendChild(wb);
  });
  section(t('caps.recommendable'), caps.recommendable);
}

function renderCapSuggestion(d) {
  const div = document.createElement('div');
  div.className = 'wb-sys wb-cap-suggest';
  const head = document.createElement('div');
  head.textContent = t('caps.suggestCard', { name: wbInfo?.agentNames?.[d.from] ?? d.from, cap: `${localizeField(d.name)}（${d.id}）` });
  const meta = document.createElement('div');
  meta.textContent = `${localizeField(d.summary)}｜${t('caps.risk')}:${d.risk}｜${t('caps.perms')}:${(d.permissions ?? []).join(',') || t('caps.none')}${d.reason ? '｜' + d.reason : ''}`;
  const note = document.createElement('div');
  note.textContent = t('caps.sessionOnlyNote');
  const actions = document.createElement('div');
  const ok = document.createElement('button');
  ok.className = 'primary';
  ok.textContent = t('caps.approve');
  const no = document.createElement('button');
  no.textContent = t('caps.deny');
  ok.onclick = async () => {
    ok.disabled = no.disabled = true;
    ok.textContent = t('caps.approving');
    const r = await wbCapOp({ op: 'grant', id: d.id });
    if (r) div.remove();
    else { ok.disabled = no.disabled = false; ok.textContent = t('caps.approve'); } // 失败保留卡片可重试
  };
  no.onclick = async () => {
    ok.disabled = no.disabled = true;
    const r = await wbCapOp({ op: 'deny', id: d.id });
    if (r) div.remove(); else { ok.disabled = no.disabled = false; }
  };
  actions.append(ok, no);
  div.append(head, meta, note, actions);
  $('#wbLog').appendChild(div);
  $('#wbLog').scrollTop = $('#wbLog').scrollHeight;
}

async function attachWorkbench(id) {
  let info;
  try { info = await (await fetch('/api/workbenches/' + id)).json(); } catch (e) { return setStatebar(t('dyn.noServer', { msg: e.message }), true); }
  if (info.error) return setStatebar(info.error, true);
  closeEvents();
  closeWbEvents();
  sid = null;
  wbId = id;
  wbInfo = info;
  $('#wbTitle').textContent = info.name || t('dyn.unnamedWb');
  // 成员状态条：运行态与引擎健康态分离；成员灯和工作区芯片都可就地复查/修改
  renderWbMembers();
  $('#wbCapsPanel').hidden = true;
  renderWbCaps();
  wbPendingAttachments = []; // 待发附件不跨台
  renderWbAttachRow();
  $('#wbLog').innerHTML = '';
  $('#wbChangesList').innerHTML = '';
  $('#wbConflicts').replaceChildren();
  $('#wbConflicts').hidden = true;
  for (const k of Object.keys(wbChangeNo)) delete wbChangeNo[k]; // 变更序号按台重置
  wbInfo = info;
  wbLastSpeaker = null;
  renderWbRecipients();
  wbHandoffUi.attach(info.handoff, info.launchAvailability, info.participants.map(id => ({ id, name: info.agentNames?.[id] ?? cfg.agents?.[id]?.name ?? id })));
  showView('#workbench');
  wbEs = new EventSource(`/api/workbenches/${id}/events`);
  wbEs.onmessage = e => onWbEvent(JSON.parse(e.data));
  wbEs.onerror = () => appendWbError(t('dyn.streamBroken'));
  await refreshSessionList();
  await refreshWbConflicts();
}

// ===== 收件人区：勾选框 + 每人 ✕ 移出 + 「＋」中途加人 + 隐式路由提示 =====
function renderWbRecipients() {
  const info = wbInfo;
  const rc = $('#wbRecipients');
  rc.innerHTML = '';
  for (const p of info.participants) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = p;
    cb.onchange = updateWbRouteHint;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + (info.agentNames[p] ?? p))); // 名字保持干净；能力与角色在「变更」栏管理
    if (info.participants.length > 1) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'wb-remove';
      x.textContent = '✕';
      x.title = t('wb.removeTitle');
      x.onclick = e => { e.preventDefault(); changeParticipants('remove', p); };
      label.appendChild(x);
    }
    rc.appendChild(label);
  }
  // 「＋」加人：候选 = 全局配置里可用且未在场的引擎
  const candidates = Object.entries(cfg.agents).filter(([id, a]) => !a.unavailable && !info.participants.includes(id));
  if (candidates.length) {
    const sel = document.createElement('select');
    sel.className = 'wb-add';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = t('wb.addAgent');
    sel.appendChild(ph);
    for (const [id, a] of candidates) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = a.name;
      sel.appendChild(o);
    }
    sel.onchange = () => { if (sel.value) changeParticipants('add', sel.value); };
    rc.appendChild(sel);
  }
  const hint = document.createElement('span');
  hint.id = 'wbRouteHint';
  hint.className = 'wb-route-hint';
  rc.appendChild(hint);
  updateWbRouteHint();
}

function updateWbRouteHint() {
  const hint = $('#wbRouteHint');
  if (!hint || !wbInfo) return;
  const anyChecked = [...$('#wbRecipients').querySelectorAll('input:checked')].length > 0;
  if (anyChecked) hint.textContent = '';
  else {
    const target = wbInfo.participants.includes(wbLastSpeaker) ? wbLastSpeaker : wbInfo.participants[0];
    hint.textContent = t('wb.routeHint', { name: wbInfo.agentNames[target] ?? target });
  }
  renderWbActionPanel(); // 成员/能力变化同步动手面板
}

// 「变更」右栏：角色配置 + 变更卡列表（diff 全生命周期的账本）
function renderWbActionPanel() {
  const panel = $('#wbChanges');
  if (!wbInfo) { panel.hidden = true; return; }
  wbHandoffUi.render();
  // 挂了工作区就显示右栏（历史变更卡也要有家）
  panel.hidden = !wbInfo.workspace;
  syncWbConflictAuthority();
  if (panel.hidden) return;
  renderWbRoleRows();
  $('#wbAssign').hidden = !$('#wbPermRows').childElementCount;
}

// 角色行（叠加制）：能力下拉（讨论者/提案者）+「仲裁」勾选；勾了仲裁再露出「替我决断」档
function renderWbRoleRows() {
  const box = $('#wbPermRows');
  box.innerHTML = '';
  for (const id of wbInfo.participants) {
    const capable = (wbInfo.writeCapable ?? []).includes(id);
    const r = wbInfo.roles?.[id] ?? { role: capable ? 'propose' : 'talk', arbiter: false, decide: false };
    const row = document.createElement('div');
    row.className = 'wb-perm-row';
    const name = document.createElement('span');
    name.className = 'wb-perm-name';
    name.textContent = wbInfo.agentNames[id] ?? id;
    row.appendChild(name);
    const sel = document.createElement('select');
    sel.className = 'wb-role';
    for (const role of ['talk', 'propose']) {
      const o = document.createElement('option');
      o.value = role;
      o.textContent = t('role.' + role);
      sel.appendChild(o);
    }
    sel.value = r.role;
    sel.disabled = !capable;
    sel.title = capable ? t('wb.roleTip') : t('wb.roleNoWrite');
    sel.onchange = () => setWbRole(id, sel.value, r.arbiter, r.decide);
    row.appendChild(sel);
    const arb = document.createElement('label');
    arb.className = 'wb-perm';
    const acb = document.createElement('input');
    acb.type = 'checkbox';
    acb.checked = !!r.arbiter;
    acb.disabled = !capable;
    acb.onchange = () => setWbRole(id, sel.value, acb.checked, false);
    arb.append(acb, ' ' + t('role.arbiter'));
    arb.title = capable ? t('wb.arbiterTip') : t('wb.roleNoWrite');
    row.appendChild(arb);
    if (r.arbiter && capable) {
      const label = document.createElement('label');
      label.className = 'wb-perm';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!r.decide;
      cb.onchange = () => setWbRole(id, sel.value, true, cb.checked);
      label.append(cb, ' ' + t('wb.decide'));
      label.title = t('wb.decideTip');
      row.appendChild(label);
    }
    box.appendChild(row);
  }
}

async function setWbRole(agentId, role, arbiter, decide) {
  let r;
  try { r = await (await fetch(`/api/workbenches/${wbId}/role`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId, role, arbiter, decide }) })).json(); }
  catch (e) { r = { error: e.message }; }
  if (r.error) { appendWbError(r.error); } else { wbInfo.roles = r.roles; }
  renderWbActionPanel();
}

async function changeParticipants(op, agentId) {
  let r;
  try { r = await (await fetch(`/api/workbenches/${wbId}/participants`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, agentId }) })).json(); }
  catch (e) { return appendWbError(t('dyn.netErr', { msg: e.message })); }
  if (r.error) return appendWbError(r.error);
  Object.assign(wbInfo, r); // participants/agentNames/writeCapable 局部刷新
  renderWbMembers();
  renderWbRecipients(); // 动手面板随 updateWbRouteHint 链同步
}

async function resumeWorkbench(dirname) {
  let r;
  try { r = await (await fetch('/api/workbenches/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dirname }) })).json(); }
  catch (e) { return setStatebar(t('dyn.resumeFail', { msg: e.message }), true); }
  if (r.error) return setStatebar(r.error, true);
  await attachWorkbench(r.id);
}

// ===== 附件：上传后暂存为待发列表，随下一条消息一起提交 =====
let wbPendingAttachments = []; // [{file, name, kind, size}]（file=服务端存储名）

function renderWbAttachRow() {
  const row = $('#wbAttachRow');
  row.replaceChildren();
  row.hidden = !wbPendingAttachments.length;
  for (const a of wbPendingAttachments) {
    const chip = document.createElement('span');
    chip.className = 'wb-att-chip' + (a.uploading ? ' wb-att-uploading' : '');
    chip.textContent = `${a.kind === 'image' ? '🖼' : '📄'} ${a.name}${a.uploading ? ' …' : ` (${Math.max(1, Math.round(a.size / 1024))}KB)`}`;
    if (!a.uploading) {
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '✕';
      x.setAttribute('aria-label', t('wb.attRemove'));
      x.onclick = () => { wbPendingAttachments = wbPendingAttachments.filter(p => p !== a); renderWbAttachRow(); };
      chip.appendChild(x);
    }
    row.appendChild(chip);
  }
}

async function uploadWbFiles(files) {
  for (const f of files) {
    const staged = { name: f.name, kind: '', size: f.size, uploading: true };
    wbPendingAttachments.push(staged);
    renderWbAttachRow();
    let r;
    try {
      r = await (await fetch(`/api/workbenches/${wbId}/upload`, {
        method: 'POST', headers: { 'x-rt-filename': encodeURIComponent(f.name) }, body: f,
      })).json();
    } catch (e) { r = { error: t('dyn.netErr', { msg: e.message }) }; }
    if (r.error) {
      wbPendingAttachments = wbPendingAttachments.filter(p => p !== staged);
      renderWbAttachRow();
      appendWbError(`${f.name}: ${r.error}`);
      continue;
    }
    Object.assign(staged, r, { uploading: false });
    renderWbAttachRow();
  }
}

async function sendWbMessage() {
  const text = $('#wbInput').value.trim();
  const attachments = wbPendingAttachments.filter(a => !a.uploading).map(({ file, name, kind, size }) => ({ file, name, kind, size }));
  if ((!text && !attachments.length) || !wbId) return;
  const to = [...$('#wbRecipients').querySelectorAll('input:checked')].map(cb => cb.value);
  $('#wbInput').value = '';
  wbPendingAttachments = [];
  renderWbAttachRow();
  let r;
  try { r = await (await fetch(`/api/workbenches/${wbId}/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, to, attachments }) })).json(); }
  catch (e) { return appendWbError(t('dyn.netErr', { msg: e.message })); }
  if (r.error) appendWbError(r.error);
}

// ---- 工作台按钮绑定 ----
$('#wbCreate').onclick = async () => {
  const participants = [...$('#wbParticipants').querySelectorAll('input:checked:not(.wb-arbiter)')].map(cb => cb.value); // 仲裁勾选框不是参与勾选
  const bar = $('#wbSetupBar');
  const err = msg => { bar.hidden = false; bar.textContent = msg; bar.classList.add('err'); };
  if (!participants.length) return err(t('dyn.pickParticipant'));
  // 入场即定角色：能力下拉 + 仲裁叠加勾选（无控件=纯讨论者,由后端默认处理）
  const roles = {};
  for (const sel of $('#wbParticipants').querySelectorAll('select.wb-role')) {
    if (participants.includes(sel.dataset.agent)) roles[sel.dataset.agent] = { role: sel.value };
  }
  for (const cb of $('#wbParticipants').querySelectorAll('input.wb-arbiter')) {
    if (roles[cb.dataset.agent]) roles[cb.dataset.agent].arbiter = cb.checked;
  }
  let r;
  try { r = await (await fetch('/api/workbenches', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: $('#wbName').value.trim(), workspace: $('#wbWorkspace').value.trim(), participants, roles, capTemplate: $('#wbCapTpl').value, lang: LANG }) })).json(); }
  catch (e) { return err(t('dyn.createFail', { msg: e.message })); }
  if (r.error) return showWorkspaceError(bar, $('#wbWorkspace'), r);
  await attachWorkbench(r.id);
};
$('#wbSend').onclick = sendWbMessage;
$('#wbAttachBtn').onclick = () => $('#wbAttachInput').click();
$('#wbAttachInput').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = ''; // 允许再次选择同一文件
  if (files.length && wbId) await uploadWbFiles(files);
});
$('#wbRelay').onclick = async () => {
  if (!wbId) return;
  const checked = [...$('#wbRecipients').querySelectorAll('input:checked')].map(cb => cb.value);
  const order = checked.length >= 2 ? checked : []; // 勾了 ≥2 个就按勾选圈子聊，否则全体参与
  const seed = $('#wbInput').value.trim(); // 输入框里的话＝本场讨论的题面，一并带上
  $('#wbInput').value = '';
  const restore = msg => { if (seed && !$('#wbInput').value) $('#wbInput').value = seed; appendWbError(msg); }; // 没开成别把用户写的话吞掉
  let r;
  try { r = await (await fetch(`/api/workbenches/${wbId}/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rounds: Number($('#wbRounds').value) || 2, order, seed }) })).json(); }
  catch (e) { return restore(t('dyn.netErr', { msg: e.message })); }
  if (r.error) restore(r.error);
};
$('#wbStop').onclick = () => { if (wbId) fetch(`/api/workbenches/${wbId}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); };
$('#wbInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendWbMessage(); }
});
$('#wbCapsChip').onclick = () => {
  const p = $('#wbCapsPanel');
  p.hidden = !p.hidden;
  if (!p.hidden) renderWbCapsPanel();
};
$('#wbPromote').onclick = async () => {
  if (!wbId) return;
  let r;
  try { r = await (await fetch(`/api/workbenches/${wbId}/promote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json(); }
  catch (e) { return appendWbError(t('dyn.promoteFail', { msg: e.message })); }
  if (r.error) return appendWbError(r.error);
  showSetup();
  location.hash = '#draft=' + r.id; // 触发 hashchange → 预填建会表单
};
