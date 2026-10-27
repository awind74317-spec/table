(() => {
  'use strict';

  const DEFAULT_SEATS = [
    { id: 'claude', provider: 'claude', name: 'Claude', enabled: true },
    { id: 'codex', provider: 'codex', name: 'Codex', enabled: true },
    { id: 'gpt', provider: 'gpt', name: 'GPT 1', enabled: true },
  ];
  const CHAT_AGENTS = ['claude', 'codex'];
  const EXTERNAL_AGENTS = ['gpt'];
  const ALL_AGENTS = [...CHAT_AGENTS, ...EXTERNAL_AGENTS];
  const LABELS = { claude: 'Claude', codex: 'Codex', gpt: 'GPT 1' };
  const CHARACTERS = { claude: 'C', codex: 'X', gpt: 'G', user: '你' };
  const $ = id => document.getElementById(id);
  const seat = id => state.seats.find(item => item.id === id) || null;
  const seatProvider = id => seat(id)?.provider || (String(id).startsWith('gpt') ? 'gpt' : id);
  const seatIds = ({ enabledOnly = false } = {}) => state.seats.filter(item => !enabledOnly || item.enabled !== false).map(item => item.id);
  const chatSeatIds = () => state.seats.filter(item => item.provider !== 'gpt').map(item => item.id);
  const externalSeatIds = () => state.seats.filter(item => item.provider === 'gpt').map(item => item.id);
  const seatLabel = id => seat(id)?.name || state.bench?.agentNames?.[id] || state.config?.agents?.[id]?.name || LABELS[id] || id;
  const seatStatusId = id => `seat-${escapeForSelector(id)}-status`;
  const agentName = id => seatLabel(id);
  const agentModel = id => state.modelSelection[id] || state.bench?.models?.[id] || state.config?.agents?.[id]?.model || '';
  const currentAgentName = id => {
    const base = String(agentName(id)).split(' · ')[0];
    const model = agentModel(id);
    return model ? `${base} · ${model}` : base;
  };
  const isAgent = id => seatIds().includes(id);
  const isExternalAgent = id => seatProvider(id) === 'gpt';
  const isEnabledAgent = id => isAgent(id) && seat(id)?.enabled !== false;
  const seatStyle = id => seatProvider(id) === 'gpt' ? 'gpt' : seatProvider(id);
  const routeHintFor = id => isExternalAgent(id)
    ? gptChatUrl(id) ? `直接送到已連結的 ${seatLabel(id)} 對話` : `${seatLabel(id)} 首次送出會自動建立獨立對話`
    : `單聊：只有 ${seatLabel(id)} 回應`;
  const state = {
    config: { agents: {} },
    subscriptions: {},
    sessions: [],
    benchId: null,
    bench: null,
    events: null,
    messages: [],
    seats: DEFAULT_SEATS.map(item => ({ ...item })),
    seen: new Set(),
    streams: new Map(),
    route: ['gpt'],
    roundtable: false,
    order: ['claude', 'codex', 'gpt'],
    chairId: null,
    busy: false,
    modelSelection: {},
    loadingBench: false,
    gptStatus: null,
    gptStatusBySeat: {},
    gptStatusRequests: {},
    gptSeatId: 'gpt',
    gptStatusRequest: 0,
    sentGptTask: null,
  };

  function gptSeatId(agentId = state.gptSeatId) {
    const id = String(agentId || 'gpt');
    return isExternalAgent(id) ? id : externalSeatIds()[0] || 'gpt';
  }

  function gptChatUrl(agentId = state.gptSeatId) {
    const id = gptSeatId(agentId);
    const configured = seat(id)?.chatUrl;
    if (configured) return configured;
    if (id === 'gpt' && state.bench?.gptChatUrl) return state.bench.gptChatUrl;
    try {
      return localStorage.getItem(`roundtable.gpt-chat.${state.bench?.connection}.${id}`)
        || (id === 'gpt' ? localStorage.getItem('roundtable.gpt-chat.' + state.bench?.connection) : '')
        || '';
    } catch { return ''; }
  }

  const GPT_ERROR_MESSAGES = {
    BROWSER_NOT_INSTALLED: '找不到可用的 Chrome／Edge，請先確認專用 GPT 瀏覽器已安裝。',
    BROWSER_START_FAILED: '專用 GPT 瀏覽器啟動失敗，請稍後再試。',
    BROWSER_UNAVAILABLE: '專用 GPT 瀏覽器目前無法連線，請稍後再試。',
    BROWSER_DISCONNECTED: '專用 GPT 瀏覽器已斷線，請先查看任務是否送達；系統不會自動重送。',
    BROWSER_COMMAND_TIMEOUT: '未收到瀏覽器操作確認，請先查看專用 GPT 瀏覽器；系統不會自動重送。',
    NODE_WEBSOCKET_UNAVAILABLE: '專用 GPT 瀏覽器需要 Node.js 22 以上，請更新本機 Node.js。',
    GPT_TASK_CHANGED: '目前任務已變更，請查看最新的 GPT 任務。',
    GPT_CONNECTION_CHANGED: '這張桌的 GPT 連結已在另一台裝置變更，請重新整理。',
    GPT_CONNECTION_REQUIRED: '首次送出會自動建立這個 GPT 席位的獨立對話。',
    NO_WAITING_GPT_TASK: '目前沒有等待送出的 GPT 任務。',
    CHAT_URL_INVALID: '請貼上一般 Chat 對話網址（https://chatgpt.com/c/…）。',
    CHAT_NOT_OPEN: '找不到這次任務的專用 GPT 分頁；請取消目前任務後重新送出，系統會自動建立對話。',
    CHAT_MODE_NOT_CONFIRMED: '請先在專用 GPT 瀏覽器登入 ChatGPT，再按「送出目前任務」；不用貼網址。',
    CHAT_CHANGED: '專用 GPT 瀏覽器目前不是綁定的對話，尚未送出。',
    DRAFT_PRESENT: '專用 GPT 對話有未送出的草稿，請先處理；系統沒有覆蓋你的文字。',
    CHAT_IS_RUNNING: 'GPT 正在回覆上一則，稍後再按「送出目前任務」。',
    COMPOSER_NOT_FOUND: '找不到 GPT 輸入框，請確認已登入一般 Chat 對話。',
    COMPOSER_CHANGED: 'GPT 輸入框內容已變更，尚未送出；請先查看專用 GPT 瀏覽器。',
    SEND_BUTTON_NOT_FOUND_OR_DISABLED: '找不到可送出的 GPT 輸入框，請先查看專用 GPT 瀏覽器。',
    CHAT_SEND_UNKNOWN: '送出結果不確定，請先查看專用 GPT 瀏覽器；不要重送。',
    SEND_IN_PROGRESS: '已有 GPT 任務正在送出，請稍後查看結果。',
  };

  function gptError(error) {
    const code = error instanceof Error ? error.message : String(error ?? 'GPT 送出失敗');
    return GPT_ERROR_MESSAGES[code] || code;
  }

  function gptStatusLabel(url = gptChatUrl(), status = state.gptStatus) {
    if (!status) return url ? '尚未檢查專用 GPT 瀏覽器狀態' : '首次送出會自動建立獨立 GPT 對話';
    if (status.available === false) return '專用 GPT 瀏覽器不可用';
    if (!status.running) return url ? '專用 GPT 瀏覽器尚未啟動' : '首次送出會自動開啟專用瀏覽器並建立對話';
    if (!url) return '首次送出會自動建立並綁定獨立 GPT 對話';
    if (!status.ready) return '專用 GPT 瀏覽器已啟動 · 請登入並開啟指定對話';
    if (status.draft) return '已連線 · 對話有草稿，請先處理';
    if (status.busy) return '已連線 · GPT 回覆中，稍後再送';
    return '已連線 · 可送出';
  }

  async function refreshGptStatus({ agentId = state.gptSeatId, chatUrl = gptChatUrl(agentId), quiet = true } = {}) {
    const id = gptSeatId(agentId);
    const request = (state.gptStatusRequests[id] || 0) + 1;
    state.gptStatusRequests[id] = request;
    try {
      const status = await api(`/api/gpt-browser/status?chatUrl=${encodeURIComponent(chatUrl)}`);
      if (request === state.gptStatusRequests[id]) {
        state.gptStatusBySeat[id] = status;
        if (id === state.gptSeatId) state.gptStatus = status;
        renderGptConnection();
      }
      return status;
    } catch (error) {
      if (request === state.gptStatusRequests[id]) {
        state.gptStatusBySeat[id] = null;
        if (id === state.gptSeatId) state.gptStatus = null;
        renderGptConnection();
      }
      if (!quiet) throw error;
      return null;
    }
  }

  function renderGptConnection() {
    const select = $('gptSeatSelect');
    const gptSeats = state.seats.filter(item => item.provider === 'gpt');
    if (select) {
      const selected = gptSeatId(state.gptSeatId);
      select.replaceChildren();
      for (const item of gptSeats) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name || item.id;
        option.disabled = item.enabled === false;
        option.selected = item.id === selected;
        select.appendChild(option);
      }
      if (select.options.length && ![...select.options].some(option => option.value === selected && !option.disabled)) {
        const first = [...select.options].find(option => !option.disabled) || select.options[0];
        state.gptSeatId = first.value;
        select.value = first.value;
      } else state.gptSeatId = selected;
    }
    const id = gptSeatId(state.gptSeatId);
    const url = gptChatUrl(id);
    const input = $('gptChatUrl');
    if (input && document.activeElement !== input) input.value = url;
    $('gptSaveLink').disabled = !state.bench?.connection || !id;
    setText($('gptConnectionSummary'), seatLabel(id));
    const status = Object.prototype.hasOwnProperty.call(state.gptStatusBySeat, id) ? state.gptStatusBySeat[id] : state.gptStatus;
    setText($('gptConnectionStatus'), gptStatusLabel(url, status));
    const ready = !!status?.ready && !status?.busy && !status?.draft;
    $('gptConnectionStatus')?.classList.toggle('ready', ready);
  }

  async function saveGptConnection() {
    try {
      if (!state.bench?.connection) throw new Error('請先建立或選擇一段同桌對話');
      const agentId = gptSeatId($('gptSeatSelect')?.value);
      const value = $('gptChatUrl').value.trim();
      const url = new URL(value);
      if (url.origin !== 'https://chatgpt.com' || url.search || url.hash || !/^\/c\/[a-f0-9-]{36,64}\/?$/i.test(url.pathname)) throw new Error('請貼上已開啟的一般 Chat 對話網址（https://chatgpt.com/c/…）');
      const chatUrl = url.origin + url.pathname.replace(/\/$/, '');
      const duplicate = state.seats.find(item => item.provider === 'gpt' && item.id !== agentId && String(item.chatUrl || '').replace(/\/$/, '') === chatUrl);
      if (duplicate) throw new Error(`${seatLabel(duplicate.id)} 已使用這個 GPT 對話網址，請為每席設定不同網址。`);
      await post(`/api/workbenches/${encodeURIComponent(state.benchId)}/gpt-connection`, { agentId, chatUrl });
      const target = seat(agentId);
      if (target) target.chatUrl = chatUrl;
      if (state.bench && agentId === 'gpt') state.bench.gptChatUrl = chatUrl;
      state.gptSeatId = agentId;
      localStorage.removeItem(`roundtable.gpt-chat.${state.bench.connection}.${agentId}`);
      if (agentId === 'gpt') localStorage.removeItem('roundtable.gpt-chat.' + state.bench.connection);
      await post('/api/gpt-browser/open', { chatUrl });
      await refreshGptStatus({ agentId, chatUrl, quiet: false });
      showToast('已保存並開啟；登入後按「確認連線」');
    } catch (error) { reportError(new Error(gptError(error)), { toast: true }); }
  }

  async function requireGptConnection(agentId = state.gptSeatId) {
    const id = gptSeatId(agentId);
    const chatUrl = gptChatUrl(id);
    if (!chatUrl) {
      state.gptSeatId = id;
      renderGptConnection();
      return; // The server sends the first real task in a fresh Chat and stores its URL.
    }
    if (!seat(id)?.chatUrl) {
      await post(`/api/workbenches/${encodeURIComponent(state.benchId)}/gpt-connection`, { agentId: id, chatUrl });
      if (seat(id)) seat(id).chatUrl = chatUrl;
      if (id === 'gpt' && state.bench) state.bench.gptChatUrl = chatUrl;
      localStorage.removeItem(`roundtable.gpt-chat.${state.bench.connection}.${id}`);
    }
    state.gptSeatId = id;
    const status = await refreshGptStatus({ agentId: id, chatUrl });
    if (status?.available === false) throw new Error(gptError(new Error('BROWSER_NOT_INSTALLED')));
  }

  async function sendExternalTask() {
    const task = state.bench?.external;
    if (task?.status !== 'waiting') throw new Error('目前沒有等待送出的 GPT 任務');
    const agentId = gptSeatId(task.agentId || state.gptSeatId);
    if (!isEnabledAgent(agentId)) throw new Error('這個 GPT 席位目前已停用，請先重新啟用後再送出任務。');
    const chatUrl = task.chatUrl || gptChatUrl(agentId);
    await requireGptConnection(agentId);
    setText($('gptTaskSync'), '正在送到專用 GPT 瀏覽器…');
    try {
      const result = await post(`/api/workbenches/${encodeURIComponent(state.benchId)}/gpt-send`, {
        // Legacy single-seat shape: chatUrl: gptChatUrl(), taskId: task.taskId
        agentId, chatUrl, taskId: task.taskId,
      });
      if (!result.sent && !result.alreadySent) throw new Error('CHAT_SEND_UNKNOWN');
      state.sentGptTask = task.taskId;
      await refreshGptStatus({ agentId, chatUrl });
      renderExternalTask();
      showToast(result.alreadySent ? '這個任務已送出，沒有重複發送' : '已送給 GPT；成果會自動回到同桌');
    } catch (error) {
      await refreshGptStatus({ agentId, chatUrl });
      throw new Error(gptError(error));
    }
  }

  async function openGptBrowser(agentId = $('gptSeatSelect')?.value || state.gptSeatId) {
    agentId = gptSeatId(agentId);
    const chatUrl = gptChatUrl(agentId);
    try {
      await post('/api/gpt-browser/open', chatUrl ? { chatUrl } : {});
      state.gptSeatId = agentId;
      await refreshGptStatus({ agentId, chatUrl });
      showToast(chatUrl ? '已開啟指定 GPT 對話；登入後可確認連線' : '已開啟專用 GPT 瀏覽器；登入後可直接送出，不用貼網址');
    } catch (error) { reportError(new Error(gptError(error)), { toast: true }); }
  }

  async function confirmGptConnection() {
    try {
      const agentId = gptSeatId($('gptSeatSelect')?.value);
      state.gptSeatId = agentId;
      const status = await refreshGptStatus({ agentId, chatUrl: gptChatUrl(agentId), quiet: false });
      showToast(status?.ready ? 'GPT 已連線，可以送出任務' : gptStatusLabel());
    } catch (error) { reportError(new Error(gptError(error)), { toast: true }); }
  }

  async function refreshAfterGptDelivery(taskId) {
    // MCP delivery may arrive a few seconds before the web page finishes its final reply.
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      if (state.bench?.external?.taskId !== taskId) return;
      const taskAgentId = state.bench?.external?.agentId || state.gptSeatId;
      const status = await refreshGptStatus({ agentId: taskAgentId, chatUrl: state.bench?.external?.chatUrl || gptChatUrl(taskAgentId) });
      if (!status?.busy) return;
    }
  }

  function show(el, visible = true) {
    if (!el) return;
    el.hidden = !visible;
  }

  function setText(el, value) {
    if (el) el.textContent = String(value ?? '');
  }

  function escapeForSelector(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  async function api(path, options = {}) {
    const init = { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) } };
    const response = await fetch(path, init);
    let data = null;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok || data?.error) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  }

  function post(path, body) {
    return api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  }

  function reportError(error, { toast = false } = {}) {
    const message = error instanceof Error ? error.message : String(error ?? '未知錯誤');
    setText($('composerError'), message);
    show($('composerError'), true);
    if (toast) showToast(message);
    return message;
  }

  function clearError() {
    setText($('composerError'), '');
    show($('composerError'), false);
  }

  function showToast(message) {
    const el = $('toast');
    setText(el, message);
    show(el, true);
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => show(el, false), 3200);
  }

  function setConnection(online, label = '') {
    const dot = document.querySelector('.sidebar-foot .foot-dot');
    dot?.classList.toggle('online', online);
    setText($('connectionLabel'), label || (online ? '服務已連線' : '服務未連線'));
  }

  function normalizeModelOptions(agent) {
    const raw = Array.isArray(agent?.models) ? agent.models : [];
    const options = raw.map(item => typeof item === 'string' ? { id: item, label: item } : {
      id: String(item?.id ?? item?.value ?? ''), label: String(item?.label ?? item?.name ?? item?.id ?? ''),
    }).filter(item => item.id);
    const current = String(agent?.model ?? '');
    if (current && !options.some(item => item.id === current)) options.unshift({ id: current, label: current });
    if (!options.length) options.push({ id: current || 'default', label: current || '預設模型' });
    return options;
  }

  function renderModelSelect(id) {
    const agent = state.config.agents?.[id] || {};
    const select = $(`${id}Model`);
    if (!select) return;
    if (document.activeElement === select) return;
    const options = normalizeModelOptions(agent);
    const selected = state.bench?.models?.[id] || state.modelSelection[id] || agent.model || options[0].id;
    select.replaceChildren();
    for (const option of options) {
      const el = document.createElement('option');
      el.value = option.id;
      el.textContent = option.label;
      el.selected = option.id === selected;
      select.appendChild(el);
    }
    state.modelSelection[id] = select.value;
    setText($(`${id}Family`), agent.family || seatFamily(seat(id) || { id, provider: id }));
    const health = $(`${id}Health`);
    if (health) {
      health.classList.toggle('bad', !!agent.unavailable);
      health.classList.toggle('ok', !agent.unavailable && agent.smoke?.ok === true);
      health.title = agent.unavailable || (agent.smoke?.ok === true ? '就緒' : '尚未檢查');
    }
  }

  function renderModelSelects() {
    for (const id of chatSeatIds()) renderModelSelect(id);
  }

  function seatFamily(item) {
    const config = state.config.agents?.[item.provider] || state.config.agents?.[item.id] || {};
    return config.family || (item.provider === 'claude' ? '規劃與推理' : item.provider === 'codex' ? '執行與驗證' : '一般 Chat ＋ MCP');
  }

  function seatStatusText(item) {
    if (item.enabled === false) return '已停用 · 歷史仍保留';
    if (!state.bench) return '等待加入對話';
    const participants = state.bench.participants;
    if (Array.isArray(participants) && !participants.includes(item.id)) return '尚未加入對話';
    const model = state.bench.models?.[item.id] || state.modelSelection[item.id];
    return model && item.provider !== 'gpt' ? `已加入 · ${model}` : '已加入對話';
  }

  function renderSeats() {
    const list = $('seatList');
    if (!list) return;
    const active = document.activeElement;
    if (active?.closest('#seatList') && active.matches('input, textarea')) return;
    list.replaceChildren();
    for (const item of state.seats) {
      const style = seatStyle(item.id);
      const card = document.createElement('article');
      card.className = `agent-card ${style}-card ${item.enabled === false ? 'disabled' : ''}`;
      card.dataset.agentCard = item.id;
      const row = document.createElement('div');
      row.className = 'seat-row';
      card.appendChild(row);

      const head = document.createElement('div');
      head.className = 'agent-card-head';
      const avatar = document.createElement('span');
      avatar.className = `agent-avatar ${style}-avatar`;
      avatar.textContent = CHARACTERS[item.provider] || (item.provider === 'gpt' ? 'G' : String(item.name || item.id).slice(0, 1));
      const title = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = item.name || item.id;
      const family = document.createElement('small');
      family.textContent = seatFamily(item);
      title.append(strong, family);
      head.append(avatar, title);
      if (item.provider === 'gpt') {
        const badge = document.createElement('span');
        badge.className = 'external-badge';
        badge.textContent = '外部';
        head.appendChild(badge);
      }
      const health = document.createElement('span');
      health.className = 'health-dot';
      health.id = `${item.id}Health`;
      health.title = '尚未檢查';
      head.appendChild(health);
      row.appendChild(head);
      const details = document.createElement('details');
      details.className = 'seat-details';
      const summary = document.createElement('summary');
      summary.textContent = '⋯';
      summary.setAttribute('aria-label', `${item.name || item.id} 席位設定`);
      summary.title = '命名、連線與狀態';
      details.appendChild(summary);
      card.appendChild(details);

      const nameLabel = document.createElement('label');
      nameLabel.className = 'seat-name-label';
      nameLabel.textContent = '席位名稱';
      const nameInput = document.createElement('input');
      nameInput.className = 'seat-name-input';
      nameInput.type = 'text';
      nameInput.maxLength = 50;
      nameInput.disabled = state.busy;
      nameInput.value = item.name || item.id;
      nameInput.dataset.seatNameId = item.id;
      nameInput.setAttribute('aria-label', `${item.name || item.id} 席位名稱`);
      nameLabel.appendChild(nameInput);
      details.appendChild(nameLabel);

      const toggleLabel = document.createElement('label');
      toggleLabel.className = 'seat-toggle';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = item.enabled !== false;
      toggle.disabled = state.busy;
      toggle.dataset.seatEnabledId = item.id;
      toggle.setAttribute('aria-label', `${item.name || item.id} 啟用`);
      toggleLabel.appendChild(toggle);
      head.prepend(toggleLabel);

      let modelSelect = null;
      if (item.provider !== 'gpt') {
        const modelLabel = document.createElement('label');
        modelLabel.className = 'select-label';
        modelLabel.textContent = '模型';
        modelSelect = document.createElement('select');
        modelSelect.id = `${item.id}Model`;
        modelSelect.dataset.modelAgent = item.id;
        modelSelect.setAttribute('aria-label', `${item.name || item.id} 模型`);
        modelSelect.disabled = state.busy;
        modelLabel.appendChild(modelSelect);
        row.appendChild(modelLabel);
      } else {
        const model = document.createElement('span');
        model.className = 'seat-web-model';
        model.textContent = 'ChatGPT 網頁';
        row.appendChild(model);
        const connection = document.createElement('div');
        connection.className = 'external-seat-note';
        connection.textContent = item.chatUrl ? '已自動連結 GPT 對話' : '首次送出時自動建立獨立 GPT 對話';
        const configure = document.createElement('button');
        configure.type = 'button';
        configure.className = 'soft-button seat-configure-gpt';
        configure.textContent = '查看連線';
        configure.addEventListener('click', () => {
          state.gptSeatId = item.id;
          renderGptConnection();
          const editor = $('gptConnection');
          if (editor) editor.open = true;
          $('gptChatUrl')?.focus();
        });
        connection.appendChild(configure);
        details.appendChild(connection);
      }

      if (item.provider !== 'gpt') {
        const effortLabel = document.createElement('label');
        effortLabel.className = 'select-label';
        effortLabel.textContent = '推理程度';
        const effort = document.createElement('select');
        effort.dataset.seatEffortId = item.id;
        effort.setAttribute('aria-label', `${item.name || item.id} 推理程度`);
        effort.disabled = state.busy;
        const names = { '': '預設', low: '低', medium: '中', high: '高', xhigh: '特高', max: '最高' };
        for (const value of ['', ...(state.config.agents?.[item.provider]?.reasoningEfforts || [])]) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = names[value] || value;
          option.selected = value === (item.effort || '');
          effort.appendChild(option);
        }
        effort.addEventListener('change', () => updateSeat(item.id, { effort: effort.value }));
        effortLabel.appendChild(effort);
        row.appendChild(effortLabel);
      } else {
        const effort = document.createElement('button');
        effort.type = 'button';
        effort.className = 'seat-web-effort';
        effort.textContent = '網頁設定';
        effort.title = '推理程度沿用此 ChatGPT 對話的網頁設定';
        effort.setAttribute('aria-label', `${item.name || item.id} 推理程度：沿用網頁設定`);
        effort.addEventListener('click', () => {
          state.gptSeatId = item.id;
          renderGptConnection();
          $('gptConnection').open = true;
          showToast('GPT 推理程度請在此席位的 ChatGPT 網頁設定');
        });
        row.appendChild(effort);
      }

      const status = document.createElement('div');
      status.className = `seat-status ${item.provider === 'gpt' ? 'external-status' : ''}`;
      status.id = seatStatusId(item.id);
      const task = state.bench?.external;
      status.textContent = item.provider === 'gpt' && task?.agentId === item.id
        ? externalTaskStatusLabel(task.status)
        : seatStatusText(item);
      details.appendChild(status);
      list.appendChild(card);

      toggle.addEventListener('change', () => updateSeat(item.id, { enabled: toggle.checked }));
      nameInput.addEventListener('change', () => updateSeat(item.id, { name: nameInput.value.trim() || item.name || item.id }));
      nameInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); nameInput.blur(); }
      });
      modelSelect?.addEventListener('change', () => saveModel(item.id, modelSelect.value));
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'soft-button add-gpt-seat';
    add.id = 'addGptSeat';
    add.textContent = '＋新增 GPT 席位';
    add.disabled = !state.benchId;
    add.addEventListener('click', addGptSeat);
    list.appendChild(add);
    renderModelSelects();
    renderGptConnection();
  }

  function renderSubscriptions() {
    const row = $('subscriptionRow');
    if (!row) return;
    row.replaceChildren();
    for (const id of seatIds()) {
      const item = state.subscriptions?.[id] || {};
      const chip = document.createElement('div');
      chip.className = `subscription-chip ${isExternalAgent(id) ? 'external' : item.ok ? 'ok' : item.ok === false ? 'bad' : ''}`;
      const dot = document.createElement('span');
      dot.className = 'sub-dot';
      const name = document.createElement('strong');
      name.textContent = seatLabel(id);
      const detail = document.createElement('small');
      detail.textContent = isExternalAgent(id) ? 'Chat / MCP' : item.ok ? '已登入' : item.ok === false ? '需檢查' : '待確認';
      chip.append(dot, name, detail);
      chip.title = isExternalAgent(id)
        ? '一般 Chat / MCP；透過免擴充的專用瀏覽器送出。'
        : item.detail || item.method || '';
      row.appendChild(chip);
    }
  }

  function normalizeSeat(item, index = 0) {
    const id = String(item?.id || (item?.provider === 'gpt' ? `gpt${index + 1}` : item?.provider || '')).trim();
    const provider = String(item?.provider || (id.startsWith('gpt') ? 'gpt' : id));
    const gptIndex = provider === 'gpt' ? (id === 'gpt' ? 1 : Number(id.replace(/^gpt/, '')) || index + 1) : 0;
    return {
      ...item,
      id,
      provider,
      name: String(item?.name || (provider === 'gpt' ? `GPT ${gptIndex}` : LABELS[id] || provider)),
      enabled: item?.enabled !== false,
    };
  }

  function applySeatState(result) {
    if (Array.isArray(result?.seats)) state.seats = result.seats.map(normalizeSeat).filter(item => item.id);
    if (Object.prototype.hasOwnProperty.call(result || {}, 'chairId')) state.chairId = result.chairId || null;
    if (!state.seats.length) state.seats = DEFAULT_SEATS.map(item => ({ ...item }));
    const explicitOrder = Array.isArray(result?.relayOrder) ? result.relayOrder : null;
    if (explicitOrder) state.order = explicitOrder.filter(id => isEnabledAgent(id) && id !== state.chairId);
    if (state.gptSeatId && !isExternalAgent(state.gptSeatId)) state.gptSeatId = externalSeatIds()[0] || 'gpt';
    if (!isEnabledAgent(state.route[0])) state.route = [seatIds({ enabledOnly: true })[0] || state.seats[0]?.id || 'gpt'];
    renderRouteChips();
    renderSeats();
    renderOrder();
  }

  async function updateSeat(agentId, changes) {
    const target = seat(agentId);
    if (!target || !state.benchId) return;
    const previous = { ...target };
    Object.assign(target, changes);
    if (changes.enabled === false) {
      state.order = state.order.filter(id => id !== agentId);
      state.route = state.route.filter(id => id !== agentId);
      if (!state.route.length) state.route = [seatIds({ enabledOnly: true })[0] || 'gpt'];
    }
    const card = document.querySelector(`[data-agent-card="${escapeForSelector(agentId)}"]`);
    card?.classList.toggle('disabled', target.enabled === false);
    renderRouteChips();
    renderOrder();
    try {
      const result = await post(`/api/workbenches/${encodeURIComponent(state.benchId)}/seats`, { op: 'update', agentId, ...changes });
      applySeatState(result);
      showToast(`${target.name} 已更新`);
    } catch (error) {
      Object.assign(target, previous);
      applySeatState({ seats: state.seats, relayOrder: state.order });
      reportError(error, { toast: true });
    }
  }

  async function addGptSeat() {
    if (!state.benchId) return;
    try {
      const result = await post(`/api/workbenches/${encodeURIComponent(state.benchId)}/seats`, { op: 'add', provider: 'gpt' });
      applySeatState(result);
      const added = state.seats[state.seats.length - 1];
      if (added?.provider === 'gpt') {
        state.gptSeatId = added.id;
        renderGptConnection();
      }
      showToast(`${seatLabel(added?.id || 'gpt')} 已加入`);
    } catch (error) { reportError(error, { toast: true }); }
  }

  function sessionTitle(item) {
    return String(item.topic || item.name || '未命名對話').replace(/^\[工作台\]\s*/, '') || '未命名對話';
  }

  function sessionMeta(item) {
    if (item.archived) return '已封存';
    if (item.state === 'busy') return '處理中';
    return '討論中';
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric' }).format(date);
  }

  function isWorkbenchSession(item) {
    return item.type === 'workbench' || String(item.topic || '').startsWith('[工作台]');
  }

  function renderHistory() {
    const list = $('historyList');
    if (!list) return;
    const query = String($('historySearch')?.value || '').trim().toLowerCase();
    const filter = $('historyFilter')?.value || 'active';
    const items = state.sessions.filter(isWorkbenchSession)
      .filter(item => filter === 'all' || (filter === 'archived' ? item.archived : !item.archived))
      .filter(item => !query || sessionTitle(item).toLowerCase().includes(query));
    setText($('historyCount'), state.sessions.filter(isWorkbenchSession).length);
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = query ? '找不到相符的對話。' : filter === 'archived' ? '還沒有已封存的對話。' : '這裡沒有對話，可切換顯示範圍或建立新對話。';
      list.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'history-row';
      row.setAttribute('role', 'listitem');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `history-item ${item.id === state.benchId ? 'active' : ''} ${item.archived ? 'archived' : ''}`;
      const mark = document.createElement('span');
      mark.className = 'history-item-mark';
      const body = document.createElement('span');
      body.className = 'history-item-body';
      const title = document.createElement('span');
      title.className = 'history-item-title';
      title.textContent = sessionTitle(item);
      const meta = document.createElement('span');
      meta.className = 'history-item-meta';
      const stateText = document.createElement('span');
      stateText.textContent = sessionMeta(item);
      const date = document.createElement('span');
      date.textContent = formatDate(item.updatedAt);
      meta.append(stateText, date);
      body.append(title, meta);
      button.append(mark, body);
      button.addEventListener('click', () => item.archived ? resumeWorkbench(item.id) : openWorkbench(item.id));
      const menu = document.createElement('details');
      menu.className = 'history-menu';
      const summary = document.createElement('summary');
      summary.textContent = '⋯';
      summary.setAttribute('aria-label', `${sessionTitle(item)} 對話操作`);
      const actions = document.createElement('div');
      actions.className = 'history-actions';
      for (const [action, text] of [[item.archived ? 'resume' : 'archive', item.archived ? '恢復對話' : '封存對話'], ['delete', '刪除對話']]) {
        const control = document.createElement('button');
        control.type = 'button';
        control.textContent = text;
        control.disabled = item.state === 'busy' && !item.archived;
        control.addEventListener('click', () => { menu.open = false; void manageConversation(item, action); });
        actions.appendChild(control);
      }
      menu.append(summary, actions);
      row.append(button, menu);
      list.appendChild(row);
    }
    if (window.innerWidth <= 600) {
      const selected = list.querySelector('.selected');
      if (selected) list.scrollLeft = selected.offsetLeft - (list.clientWidth - selected.offsetWidth) / 2;
    }
  }

  function confirmConversationDeletion(item) {
    const dialog = $('deleteConversationDialog');
    setText($('deleteConversationText'), `確定刪除「${sessionTitle(item)}」？`);
    dialog.returnValue = 'cancel';
    return new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'delete'), { once: true });
      dialog.showModal();
    });
  }

  async function manageConversation(item, action) {
    if (action === 'resume') return resumeWorkbench(item.id);
    if (action === 'delete' && !(await confirmConversationDeletion(item))) return;
    try {
      const route = item.archived ? `/api/archive/${encodeURIComponent(item.id)}` : `/api/workbenches/${encodeURIComponent(item.id)}`;
      if (action === 'archive') await post(route + '/archive', {});
      else await api(route, { method: 'DELETE' });
      if (state.benchId === item.id) {
        closeEvents();
        state.benchId = null;
        state.bench = null;
        state.chairId = null;
        resetConversation();
        renderBenchInfo();
        clearError();
        try { localStorage.removeItem('roundtable.last-table'); } catch {}
      }
      await loadSessions();
      showToast(action === 'archive' ? '已封存，可從「已封存的對話」恢復' : '已刪除，內容保留在本機 sessions/.trash');
    } catch (error) { reportError(error, { toast: true }); }
  }

  async function loadSessions({ openLatest = false } = {}) {
    try {
      state.sessions = await api('/api/sessions');
      if (!Array.isArray(state.sessions)) state.sessions = [];
      renderHistory();
      setConnection(true);
      if (openLatest && !state.benchId) {
        let saved = '';
        try { saved = localStorage.getItem('roundtable.last-table') || ''; } catch {}
        const target = state.sessions.find(item => isWorkbenchSession(item) && !item.explicitlyArchived && (item.dirname === saved || item.id === saved))
          || state.sessions.find(item => isWorkbenchSession(item) && !item.archived);
        if (target?.archived) await resumeWorkbench(target.id);
        else if (target) await openWorkbench(target.id);
      }
    } catch (error) {
      state.sessions = [];
      renderHistory();
      setConnection(false, '服務未連線');
      reportError(error, { toast: true });
    }
  }

  function closeEvents() {
    if (state.events) state.events.close();
    state.events = null;
  }

  function resetConversation() {
    setBusy(false);
    state.messages = [];
    state.seen.clear();
    state.streams.clear();
    $('messageFeed')?.replaceChildren();
    show($('emptyFeed'), true);
    setText($('contextBannerText'), '所選席位會收到共用對話；圓桌會依右側順序逐席回應。');
    $('contextBanner')?.classList.remove('warn');
  }

  function externalTaskStatusLabel(status) {
    if (status === 'waiting') return state.sentGptTask === state.bench?.external?.taskId ? '已送出，等待 GPT 領取' : '等待送到 GPT';
    if (status === 'claimed') return '已接手，等待同步';
    if (status === 'delivered') return '已同步回桌';
    if (status === 'cancelled') return '已取消';
    if (status === 'interrupted') return '服務重啟後待處理';
    return '外部任務';
  }

  function renderExternalTask(task = state.bench?.external) {
    if (task?.kind === 'build') task = null;
    renderGptConnection();
    const status = $('gptStatus');
    const panel = $('gptTaskPanel');
    const stateEl = $('gptTaskState');
    const instruction = $('gptTaskInstruction');
    const kind = $('gptTaskKind');
    const sync = $('gptTaskSync');
    const copy = $('gptCopyLaunch');
    const open = $('gptOpenChat');
    const taskAgentId = task?.agentId && isAgent(task.agentId) ? task.agentId : state.gptSeatId;
    show($('gptSendTask'), task?.status === 'waiting' && isEnabledAgent(task?.agentId || state.gptSeatId));
    if (!status || !panel) return;
    if (!task || typeof task !== 'object') {
      status.className = 'seat-status external-status';
      status.textContent = '尚未建立外部任務';
      setText($('gptTaskSeat'), seatLabel(state.gptSeatId));
      const selectedSeat = seat(state.gptSeatId);
      setText($(seatStatusId(state.gptSeatId)), selectedSeat ? seatStatusText(selectedSeat) : '尚未建立外部任務');
      show(panel, false);
      return;
    }
    const taskStatus = String(task.status || 'waiting');
    const label = externalTaskStatusLabel(taskStatus);
    status.className = `seat-status external-status ${taskStatus}`;
    status.textContent = label;
    setText($(seatStatusId(taskAgentId)), label);
    show(panel, true);
    setText(kind, task.relay ? 'GPT 圓桌回合' : 'GPT 對話任務');
    setText($('gptTaskSeat'), seatLabel(taskAgentId));
    setText(stateEl, label);
    setText(instruction, task.instruction ? `任務：${task.instruction}` : '伺服器已建立外部任務。');
    if (copy) {
      copy.hidden = !String(task.launchText || '').trim();
      copy.disabled = taskStatus === 'interrupted' || !String(task.launchText || '').trim();
      copy.title = taskStatus === 'interrupted' ? '此任務因服務重啟待處理，請先取消後再建立新任務。' : '';
    }
    if (open) {
      open.hidden = taskStatus === 'interrupted' || taskStatus === 'cancelled';
      open.disabled = open.hidden;
    }
    if (taskStatus === 'interrupted') {
      setText(sync, '服務重啟後任務尚未完成；請先取消，再建立新的 GPT 任務。');
    } else if (taskStatus === 'waiting') {
      setText(sync, state.sentGptTask === task.taskId ? '已送入綁定的 GPT 對話，收到成果會自動更新。' : '正在自動建立或連接 GPT 對話；若提示需要登入，登入後再按「送出目前任務」。');
    } else if (taskStatus === 'delivered') {
      setText(sync, 'GPT 已回傳成果；下一則訊息可直接從同桌送出。');
    } else {
      setText(sync, 'GPT 正在一般 Chat 中處理，結果經 MCP 回到這張桌。');
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const focused = document.activeElement;
      const input = document.createElement('textarea');
      input.value = text;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      try {
        if (!document.execCommand('copy')) throw new Error('複製失敗，請長按回覆文字複製。');
      } finally { input.remove(); focused?.focus?.({ preventScroll: true }); }
    }
  }

  async function copyExternalLaunchText() {
    const text = String(state.bench?.external?.launchText || '').trim();
    if (!text || state.bench?.external?.status === 'interrupted') return;
    try { await copyText(text); }
    catch (error) { reportError(error, { toast: true }); return; }
    showToast('已複製 GPT 啟動文字');
  }

  function renderBenchInfo() {
    const bench = state.bench;
    const hasBench = !!bench && !!state.benchId;
    setText($('topbarTitle'), hasBench ? (bench.name || '未命名對話') : '還沒有選擇對話');
    show($('renameChat'), hasBench);
    if (hasBench) {
      const workspace = String(bench.workspace || '');
      if (document.activeElement !== $('workspaceInput')) $('workspaceInput').value = workspace;
      $('clearWorkspace').hidden = !workspace;
      setWorkspaceState(workspace);
      setText($('modePill'), bench.state === 'busy' ? '處理中' : '唯讀討論');
      for (const id of chatSeatIds()) {
        const status = $(seatStatusId(id));
        if (status && !status.classList.contains('busy') && !status.classList.contains('error')) status.textContent = `已加入 · ${bench.models?.[id] || state.modelSelection[id] || '預設模型'}`;
      }
    } else {
      if (document.activeElement !== $('workspaceInput')) $('workspaceInput').value = '';
      $('clearWorkspace').hidden = true;
      setWorkspaceState('');
      setText($('modePill'), '唯讀討論');
      for (const id of chatSeatIds()) setText($(seatStatusId(id)), '等待加入對話');
    }
    renderSeats();
    renderRouteChips();
    updateRouteHint();
    renderExternalTask(bench?.external);
    renderModelSelects();
    renderSubscriptions();
    renderHistory();
  }

  function setWorkspaceState(value) {
    const stateEl = $('workspaceState');
    if (!stateEl) return;
    const mounted = !!value;
    stateEl.textContent = mounted ? '已掛載' : '未掛載工作區';
    stateEl.classList.toggle('mounted', mounted);
    stateEl.classList.remove('invalid');
    $('clearWorkspace').hidden = !mounted;
    $('workspaceHelp').textContent = mounted ? 'Codex、Claude 可唯讀查看此專案，再把資訊帶回同桌討論；不會修改檔案。' : '聊天可留空；掛載資料夾即可唯讀討論，不需要 Git。';
  }

  function applyBenchInfo(info) {
    state.bench = info;
    state.chairId = info?.chairId || null;
    const sourceSeats = Array.isArray(info?.seats) && info.seats.length ? info.seats : state.seats.length ? state.seats : DEFAULT_SEATS;
    state.seats = sourceSeats.map(normalizeSeat).filter(item => item.id);
    if (info?.gptChatUrl) {
      const primary = state.seats.find(item => item.id === 'gpt');
      if (primary && !primary.chatUrl) primary.chatUrl = info.gptChatUrl;
    }
    const savedOrder = Array.isArray(info?.relayOrder) ? info.relayOrder : Array.isArray(info?.order) ? info.order : null;
    if (savedOrder) state.order = savedOrder.filter(id => isEnabledAgent(id));
    else {
      const previous = state.order.filter(id => isEnabledAgent(id));
      state.order = [...new Set([...previous, ...seatIds({ enabledOnly: true }).filter(id => !previous.includes(id))])];
    }
    state.modelSelection = { ...state.modelSelection, ...(info?.models || {}) };
    renderOrder();
    renderBenchInfo();
    renderVotingPanel();
  }

  async function fetchBench() {
    if (!state.benchId) return null;
    const info = await api(`/api/workbenches/${encodeURIComponent(state.benchId)}`);
    applyBenchInfo(info);
    return info;
  }

  async function ensureGptParticipant(agentId = state.gptSeatId) {
    const id = gptSeatId(agentId);
    if (!state.benchId || !isEnabledAgent(id) || state.bench?.participants?.includes(id)) return isEnabledAgent(id);
    try {
      // Legacy GPT participant payload: op: 'add', agentId: 'gpt'
      await post(`/api/workbenches/${encodeURIComponent(state.benchId)}/participants`, { op: 'add', agentId: id });
      await fetchBench();
      return true;
    } catch (error) {
      reportError(error, { toast: true });
      return false;
    }
  }

  async function openWorkbench(id) {
    if (!id || state.loadingBench) return;
    state.loadingBench = true;
    closeEvents();
    try {
      const info = await api(`/api/workbenches/${encodeURIComponent(id)}`);
      state.benchId = id;
      state.gptStatusBySeat = {};
      state.gptStatus = null;
      state.sentGptTask = null;
      try { localStorage.setItem('roundtable.last-table', info.connection); } catch {}
      if (!info.gptChatUrl && !info.seats?.find(item => item.id === 'gpt')?.chatUrl && info.state !== 'busy') {
        let legacy = '';
        try { legacy = localStorage.getItem('roundtable.gpt-chat.' + info.connection) || ''; } catch {}
        if (legacy) {
          try {
            await post(`/api/workbenches/${encodeURIComponent(id)}/gpt-connection`, { agentId: 'gpt', chatUrl: legacy });
            info.gptChatUrl = legacy;
            if (Array.isArray(info.seats)) {
              const primary = info.seats.find(item => item.id === 'gpt');
              if (primary) primary.chatUrl = legacy;
            }
            localStorage.removeItem('roundtable.gpt-chat.' + info.connection);
          } catch { /* Preserve the old local binding until it can be saved. */ }
        }
      }
      applyBenchInfo(info);
      resetConversation();
      renderBenchInfo();
      connectEvents(id);
      void refreshGptStatus();
      closeMobilePanels();
      clearError();
    } catch (error) {
      reportError(error, { toast: true });
      state.benchId = null;
      state.bench = null;
      renderBenchInfo();
    } finally {
      state.loadingBench = false;
    }
  }

  async function resumeWorkbench(dirname) {
    try {
      const result = await post('/api/workbenches/resume', { dirname });
      $('historyFilter').value = 'active';
      await loadSessions();
      await openWorkbench(result.id);
      showToast('已恢復這段對話');
    } catch (error) { reportError(error, { toast: true }); }
  }

  async function createWorkbench() {
    if (state.busy) return;
    const workspace = String($('workspaceInput')?.value || '').trim();
    clearError();
    try {
      const result = await post('/api/workbenches', {
        // Legacy default participant shape: participants: ALL_AGENTS
        name: '新對話', participants: seatIds(), workspace, lang: 'zh',
        seats: state.seats.map(({ id, provider, name, enabled, effort }) => ({ id, provider, name, enabled, effort: effort || '' })),
        relayOrder: state.order.slice(), chairId: state.chairId,
      });
      await loadSessions();
      await openWorkbench(result.id);
      for (const id of chatSeatIds()) {
        const selected = state.modelSelection[id];
        const defaultModel = state.config.agents?.[id]?.model;
        if (selected && selected !== defaultModel) await saveModel(id, selected, { quiet: true });
      }
      showToast('已建立新對話');
    } catch (error) { reportError(error, { toast: true }); }
  }

  async function ensureWorkbench() {
    if (state.benchId && state.bench) return true;
    await createWorkbench();
    return !!state.benchId;
  }

  function connectEvents(id) {
    const source = new EventSource(`/api/workbenches/${encodeURIComponent(id)}/events`);
    state.events = source;
    let connected = false;
    source.onopen = () => {
      if (connected) resetConversation(); // Reconnection replays the complete event stream.
      connected = true;
      setConnection(true);
    };
    source.onmessage = event => {
      let value;
      try { value = JSON.parse(event.data); } catch { return; }
      handleEvent(value);
    };
    source.onerror = () => setConnection(false, '連線重試中');
  }

  function eventKey(event) {
    if (event.type === 'chat-message') return `chat:${event.seq ?? `${event.from}:${event.data}:${event.build?.buildId || ''}`}`;
    if (event.type === 'participants') return `participants:${JSON.stringify(event.data)}`;
    if (event.type === 'external-task') return `external:${JSON.stringify(event.data)}`;
    return '';
  }

  function isDuplicate(event) {
    const key = eventKey(event);
    if (!key) return false;
    if (state.seen.has(key)) return true;
    state.seen.add(key);
    return false;
  }

  function handleEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'chat-message' && isDuplicate(event)) return;
    if (event.type === 'state') {
      return setBusy(event.data === 'busy');
    }
    if (event.type === 'chat-message') {
      removeStream(event.from);
      appendMessage(event);
      if (event.ctx) showContextWarning(event.ctx);
      return;
    }
    if (event.type === 'discussion-update') {
      if (state.bench) state.bench.lastDiscussion = event.data;
      renderDiscussionStatus();
      renderVotingPanel();
      return;
    }
    if (event.type === 'chat-chunk') return appendStream(event.agentId, event.data);
    if (event.type === 'gpt-connection') {
      const target = seat(event.agentId);
      if (target) target.chatUrl = event.chatUrl;
      if (state.bench && event.agentId === 'gpt') state.bench.gptChatUrl = event.chatUrl;
      if (state.bench?.external?.agentId === event.agentId) state.bench.external.chatUrl = event.chatUrl;
      renderGptConnection();
      updateRouteHint();
      return;
    }
    if (event.type === 'agent-status') return updateAgentStatus(event.agentId, event.data);
    if (event.type === 'external-task') {
      const previousStatus = state.bench?.external?.status;
      if (state.bench) state.bench.external = event.data || null;
      renderExternalTask(state.bench?.external);
      const task = state.bench?.external;
      if (task?.status === 'delivered' && previousStatus !== 'delivered') {
        void refreshAfterGptDelivery(task.taskId);
      }
      return;
    }
    if (event.type === 'external-send' && event.taskId === state.bench?.external?.taskId) {
      if (event.status === 'sent') state.sentGptTask = event.taskId;
      renderExternalTask();
      if (event.status === 'error' && state.bench?.external?.status === 'waiting') reportError(new Error(gptError(event.error)), { toast: true });
      return;
    }
    if (event.type === 'error') {
      if (event.agentId) removeStream(event.agentId);
      return appendSystem(event.data, true);
    }
    if (event.type === 'sys') return appendSystem(event.data);
    if (event.type === 'participants') {
      if (state.bench) state.bench.participants = Array.isArray(event.data) ? event.data : state.bench.participants;
      renderSeats();
      return;
    }
  }

  function setBusy(value) {
    const wasBusy = state.busy;
    state.busy = !!value;
    const interrupted = state.bench?.external?.status === 'interrupted';
    $('composerCard')?.classList.toggle('busy', state.busy);
    show($('busyLabel'), state.busy);
    show($('stopButton'), state.busy || interrupted);
    setText($('stopButton'), interrupted ? '取消任務' : '停止');
    $('sendButton').disabled = state.busy;
    $('roundtableMode').disabled = state.busy;
    renderRouteChips();
    renderOrder();
    document.querySelectorAll('[data-seat-enabled-id], [data-seat-name-id], [data-seat-effort-id], [data-model-agent]').forEach(input => { input.disabled = state.busy; });
    $('addGptSeat').disabled = state.busy || !state.benchId;
    if (wasBusy && !state.busy && state.benchId) void fetchBench().catch(error => reportError(error));
    setText($('modePill'), state.busy ? '處理中' : state.bench ? '唯讀討論' : '唯讀討論');
  }

  function updateAgentStatus(id, value) {
    if (!isAgent(id)) return;
    const el = $(seatStatusId(id));
    if (!el) return;
    el.className = 'seat-status';
    if (String(value) === 'running') { el.classList.add('busy'); el.textContent = '正在回應…'; }
    else if (String(value).startsWith('failed:')) { el.classList.add('error'); el.textContent = `錯誤：${String(value).slice(8)}`; }
    else if (value === 'done') { el.textContent = '已完成回應'; }
  }

  function messageClass(from) {
    return from === 'user' ? 'user' : isAgent(from) ? seatStyle(from) : 'system';
  }

  function discussionText(value, { streaming = false } = {}) {
    const text = String(value ?? '');
    const json = text.trim().replace(/^```(?:json)?\s*\n/i, '').replace(/\n```$/, '').trim();
    const kind = /^\{\s*"(proposals|votes|decisions)"\s*:/.exec(json)?.[1];
    if (!kind) return streaming && /^(?:```(?:json)?\s*)?\{/.test(text.trim()) ? '正在整理回覆…' : text;
    const titles = { proposals: '待表決提案', votes: '投票意見', decisions: '主席裁決' };
    const incomplete = streaming ? `正在整理${titles[kind]}…` : `${titles[kind]}格式不完整，請以「本場投票」的紀錄為準。`;
    let entries;
    try { entries = JSON.parse(json)[kind]; } catch { return incomplete; }
    if (!Array.isArray(entries) || entries.some(item => !item || typeof item !== 'object')) return incomplete;
    if (!entries.length) return kind === 'proposals' ? '沒有提出待表決的提案。' : `尚未提供${titles[kind]}，請查看「本場投票」。`;
    const choices = { agree: '同意', oppose: '反對', abstain: '棄權', unresolved: '待你決定' };
    const clean = value => typeof value === 'string' ? value.trim() : '';
    const lines = entries.map((item, index) => {
      if (kind === 'proposals') return clean(item.text) ? `提案 ${index + 1}：${item.text.trim()}` : '提案內容不完整，尚未送交表決。';
      const id = clean(item.proposalId);
      const name = /^P\d+$/.test(id) ? `提案 ${id.slice(1)}` : id || '未指定提案';
      const reason = clean(item.reason);
      const evidence = clean(item.evidence);
      const valid = id && reason && entries.filter(entry => entry.proposalId === id).length === 1
        && (kind === 'votes' ? ['agree', 'oppose', 'abstain'].includes(item.choice)
          : ['agree', 'oppose'].includes(item.choice) && evidence);
      return `${name}：${valid ? choices[item.choice] : kind === 'votes' ? '未回覆／無效' : '待你決定'}\n理由：${reason || '未提供有效理由'}${kind === 'decisions' && evidence ? `\n依據：${evidence}` : ''}`;
    });
    return `${titles[kind]}\n${lines.join('\n\n')}`;
  }

  function appendMessage(event) {
    const from = event.from || 'system';
    const message = document.createElement('article');
    message.className = `message ${messageClass(from)}`;
    message.dataset.agentId = from;
    const avatar = document.createElement('span');
    avatar.className = 'message-avatar';
    avatar.textContent = CHARACTERS[seatProvider(from)] || (isExternalAgent(from) ? 'G' : String(agentName(from)).slice(0, 1));
    const wrap = document.createElement('div');
    wrap.className = 'message-body-wrap';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const name = document.createElement('span');
    name.className = 'message-name';
    name.textContent = from === 'user' ? '你' : String(event.name || agentName(from));
    meta.appendChild(name);
    if (event.to?.length) {
      const target = document.createElement('span');
      target.className = 'message-target';
      target.textContent = `→ ${event.to.map(seatLabel).join('、')}`;
      meta.appendChild(target);
    }
    if (event.ts) {
      const date = new Date(event.ts);
      if (!Number.isNaN(date.getTime())) {
        const time = document.createElement('time');
        time.className = 'message-time';
        time.dateTime = date.toISOString();
        time.textContent = new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit' }).format(date);
        meta.appendChild(time);
      }
    }
    const body = document.createElement('div');
    body.className = 'message-body';
    body.textContent = isAgent(from) ? discussionText(event.data) : String(event.data ?? '');
    wrap.append(meta, body);
    if (isAgent(from)) {
      const actions = document.createElement('div');
      actions.className = 'message-actions';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'copy-message-button';
      copy.textContent = '複製';
      copy.setAttribute('aria-label', `複製 ${String(event.name || agentName(from))} 回覆`);
      copy.addEventListener('click', async () => {
        try {
          await copyText(body.textContent);
          copy.textContent = '已複製';
          showToast('已複製完整回覆');
          setTimeout(() => { copy.textContent = '複製'; }, 1500);
        } catch (error) { reportError(error, { toast: true }); }
      });
      actions.appendChild(copy);
      wrap.appendChild(actions);
    }
    if (event.to?.length && from === 'user') {
      const targetBadge = document.createElement('span');
      targetBadge.className = 'message-target-badge';
      targetBadge.textContent = `已送給 ${event.to.map(seatLabel).join('、')}`;
      wrap.appendChild(targetBadge);
    }
    if (Array.isArray(event.attachments) && event.attachments.length) {
      const attachments = document.createElement('div');
      attachments.className = 'attachment-line';
      attachments.textContent = event.attachments.map(item => `${item.kind === 'image' ? '▧' : '▤'} ${item.name}`).join('  ');
      wrap.appendChild(attachments);
    }
    if (event.ctx) {
      const chip = document.createElement('span');
      chip.className = 'context-chip';
      chip.textContent = `上下文已縮短 · ${event.ctx.shown} / ${event.ctx.total}`;
      wrap.appendChild(chip);
    }
    if (event.sync?.mode === 'resume' || event.sync?.mode === 'initial') {
      const chip = document.createElement('span');
      chip.className = 'context-chip sync-chip';
      const count = Number.isFinite(Number(event.sync.newMessages)) ? Number(event.sync.newMessages) : 0;
      chip.textContent = isExternalAgent(from)
        ? event.sync.mode === 'resume'
          ? `同一 Chat · 增量同步 · 補入 ${count} 則`
          : `首次同步 · 同步 ${count} 則`
        : event.sync.mode === 'resume'
          ? `CLI會話續接 · 補入 ${count} 則`
          : `首次接手 · 同步 ${count} 則`;
      wrap.appendChild(chip);
    }
    message.append(avatar, wrap);
    $('messageFeed')?.appendChild(message);
    state.messages.push(event);
    show($('emptyFeed'), false);
    scrollConversation();
  }

  function appendSystem(text, error = false) {
    if (!text) return;
    const message = document.createElement('article');
    message.className = `message system ${error ? 'error' : ''}`;
    const body = document.createElement('div');
    body.className = 'message-body';
    body.textContent = String(text);
    message.appendChild(body);
    $('messageFeed')?.appendChild(message);
    show($('emptyFeed'), false);
    scrollConversation();
  }

  function appendStream(agentId, chunk, label = '串流中') {
    if (!isAgent(agentId) || chunk == null) return;
    let record = state.streams.get(agentId);
    if (!record) {
      const message = document.createElement('article');
      message.className = `message agent ${agentId} streaming`;
      message.dataset.agentId = agentId;
      const avatar = document.createElement('span');
      avatar.className = 'message-avatar';
      avatar.textContent = CHARACTERS[seatProvider(agentId)] || (isExternalAgent(agentId) ? 'G' : String(agentName(agentId)).slice(0, 1));
      const wrap = document.createElement('div');
      wrap.className = 'message-body-wrap';
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      const name = document.createElement('span');
      name.className = 'message-name';
      name.textContent = currentAgentName(agentId);
      const target = document.createElement('span');
      target.className = 'message-target';
      target.textContent = label;
      meta.append(name, target);
      const body = document.createElement('div');
      body.className = 'message-body';
      wrap.append(meta, body);
      message.append(avatar, wrap);
      $('messageFeed')?.appendChild(message);
      record = { message, body, text: '' };
      state.streams.set(agentId, record);
    }
    record.text += String(chunk);
    record.body.textContent = discussionText(record.text, { streaming: true });
    scrollConversation();
    show($('emptyFeed'), false);
  }

  function removeStream(agentId) {
    const record = state.streams.get(agentId);
    if (!record) return;
    record.message.remove();
    state.streams.delete(agentId);
  }

  function showContextWarning(ctx) {
    const banner = $('contextBanner');
    if (!banner) return;
    banner.classList.add('warn');
    setText($('contextBannerText'), `共用上下文已縮短：這次傳給 Agent ${ctx.shown} / ${ctx.total} 則訊息；較早內容仍保留在本機對話。`);
  }

  function scrollConversation() {
    const scroll = $('conversationScroll');
    if (scroll) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  }

  async function saveModel(agentId, model, { quiet = false } = {}) {
    state.modelSelection[agentId] = model;
    if (!state.benchId) return;
    try {
      const result = await post(`/api/workbenches/${encodeURIComponent(state.benchId)}/model`, { agentId, model });
      if (state.bench) {
        state.bench.models = result.models || { ...(state.bench.models || {}), [agentId]: model };
        const base = String(seatLabel(agentId)).split(' · ')[0];
        state.bench.agentNames = result.agentNames || { ...(state.bench.agentNames || {}), [agentId]: `${base} · ${model}` };
      }
      renderModelSelects();
      if (!quiet) showToast(`${seatLabel(agentId)} 已切換模型`);
    } catch (error) {
      reportError(error, { toast: true });
      renderModelSelects();
    }
  }

  async function saveWorkspace() {
    const path = String($('workspaceInput')?.value || '').trim();
    clearError();
    if (!state.benchId) {
      await createWorkbench();
      return;
    }
    try {
      const result = await post(`/api/workbenches/${encodeURIComponent(state.benchId)}/workspace`, { path });
      if (state.bench) {
        state.bench.workspace = result.workspace || '';
        state.bench.roles = result.roles || state.bench.roles;
      }
      setWorkspaceState(result.workspace || '');
      showToast(result.workspace ? '工作區已掛載' : '已清除工作區');
    } catch (error) {
      $('workspaceState').classList.add('invalid');
      reportError(error, { toast: true });
    }
  }

  function renameWorkbench() {
    if (!state.benchId) return;
    const dialog = $('renameDialog');
    const input = $('renameInput');
    if (!dialog || !input) return;
    input.value = state.bench?.name || '';
    input.setCustomValidity('');
    dialog.showModal();
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }

  async function saveRename(event) {
    event.preventDefault();
    if (!state.benchId) return;
    const dialog = $('renameDialog');
    const name = String($('renameInput')?.value || '').trim();
    if (!name) {
      $('renameInput')?.setCustomValidity('請輸入對話名稱');
      $('renameInput')?.reportValidity();
      return;
    }
    $('renameInput')?.setCustomValidity('');
    try {
      await post(`/api/workbenches/${encodeURIComponent(state.benchId)}/rename`, { name });
      if (state.bench) state.bench.name = name;
      renderBenchInfo();
      await loadSessions();
      dialog?.close();
    } catch (error) { reportError(error, { toast: true }); }
  }

  async function sendMessage(text, to = state.route) {
    const content = String(text ?? '').trim();
    if (!content || state.busy) return false;
    const targets = [...new Set((Array.isArray(to) ? to : [to]).filter(isEnabledAgent))];
    if (!targets.length) {
      reportError(new Error('請先選擇至少一個已啟用的席位。'), { toast: true });
      return false;
    }
    if (!(await ensureWorkbench())) return false;
    if (targets.length === 1 && isExternalAgent(targets[0]) && state.bench?.external?.status === 'interrupted') {
      reportError(new Error('GPT 任務因服務重啟待處理，請先取消，再建立新的任務。'), { toast: true });
      return false;
    }
    if (targets.some(isExternalAgent)) {
      for (const id of targets.filter(isExternalAgent)) if (!(await ensureGptParticipant(id))) return false;
    }
    clearError();
    try {
      if (targets.length === 1 && isExternalAgent(targets[0])) await requireGptConnection(targets[0]);
      await post(`/api/workbenches/${encodeURIComponent(state.benchId)}/message`, { text: content, to: targets });
      if (targets.some(isExternalAgent)) await fetchBench();
      return true;
    } catch (error) { reportError(error, { toast: true }); return false; }
  }

  async function startRelay(seed) {
    const content = String(seed ?? '').trim();
    if (!content || state.busy) return false;
    if (!(await ensureWorkbench())) return false;
    const rounds = Math.min(8, Math.max(1, Number($('roundsInput').value) || 1));
    const order = state.order.filter(isEnabledAgent);
    if (!order.length) {
      reportError(new Error('請先在右側勾選圓桌席位。'), { toast: true });
      return false;
    }
    for (const id of [...order, ...(state.chairId ? [state.chairId] : [])].filter(isExternalAgent)) {
      if (!(await ensureGptParticipant(id))) return false;
      try { await requireGptConnection(id); }
      catch (error) { reportError(error, { toast: true }); return false; }
    }
    clearError();
    try {
      await post(`/api/workbenches/${encodeURIComponent(state.benchId)}/relay`, { rounds, order, seed: content });
      return true;
    } catch (error) {
      reportError(error, { toast: true });
      return false;
    }
  }

  async function sendFromComposer() {
    const text = String($('messageInput').value || '').trim();
    if (!text) return;
    const sent = state.roundtable ? await startRelay(text) : await sendMessage(text, state.route);
    if (sent) $('messageInput').value = '';
  }

  function updateRouteHint() {
    const selected = state.order.filter(isEnabledAgent);
    setText($('routeHint'), state.roundtable
      ? selected.length ? `圓桌：${selected.map(seatLabel).join(' → ')}${state.chairId ? ` → 主席 ${seatLabel(state.chairId)}` : ''}` : '圓桌：尚未選擇席位'
      : routeHintFor(state.route[0]));
  }

  function renderRouteChips() {
    setText($('routeSelection'), state.roundtable ? '圓桌' : seatLabel(state.route[0]));
    const list = $('routeChips');
    if (!list) return;
    list.replaceChildren();
    for (const item of state.seats) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `route-chip ${seatStyle(item.id)} ${item.enabled === false ? 'disabled' : ''}`;
      button.dataset.agent = item.id;
      button.disabled = item.enabled === false || state.busy;
      const dot = document.createElement('span');
      dot.className = 'agent-dot';
      button.append(dot, document.createTextNode(item.name || item.id));
      button.classList.toggle('selected', !state.roundtable && state.route[0] === item.id);
      button.addEventListener('click', () => setRoute(item.id));
      list.appendChild(button);
    }
  }

  function setRoute(agentId) {
    if (!isEnabledAgent(agentId)) return;
    state.roundtable = false;
    state.route = [agentId];
    renderRouteChips();
    $('roundtableMode')?.classList.remove('active');
    show($('roundsControl'), false);
    setText($('routeHint'), routeHintFor(agentId));
    closeRouteOptions();
  }

  function toggleRoundtable() {
    state.roundtable = !state.roundtable;
    $('roundtableMode')?.classList.toggle('active', state.roundtable);
    renderRouteChips();
    show($('roundsControl'), state.roundtable);
    updateRouteHint();
    closeRouteOptions();
  }

  function closeRouteOptions() {
    $('composerCard')?.classList.remove('route-open');
    $('routeToggle')?.setAttribute('aria-expanded', 'false');
  }

  async function saveRelayOrder() {
    if (!state.benchId) return;
    try {
      const result = await post(`/api/workbenches/${encodeURIComponent(state.benchId)}/seats`, { op: 'order', order: state.order.slice() });
      applySeatState(result);
    } catch (error) { reportError(error, { toast: true }); }
  }

  function toggleOrderSeat(agentId, checked) {
    if (!isEnabledAgent(agentId) || agentId === state.chairId) return;
    state.order = checked
      ? [...state.order.filter(id => id !== agentId), agentId]
      : state.order.filter(id => id !== agentId);
    renderOrder();
    updateRouteHint();
    void saveRelayOrder();
  }

  function moveOrderSeat(agentId, beforeId) {
    if (!isEnabledAgent(agentId) || !state.order.includes(agentId) || agentId === beforeId) return;
    const next = state.order.filter(id => id !== agentId);
    const index = next.indexOf(beforeId);
    next.splice(index < 0 ? next.length : index, 0, agentId);
    state.order = next;
    renderOrder();
    updateRouteHint();
    void saveRelayOrder();
  }

  function renderOrder() {
    const list = $('orderList');
    if (!list) return;
    state.order = state.order.filter(id => isEnabledAgent(id) && id !== state.chairId);
    const chair = $('chairSelect');
    if (chair) {
      chair.replaceChildren();
      for (const item of [{ id: '', name: '不安排主席' }, ...state.seats.filter(item => item.enabled !== false)]) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name;
        option.selected = item.id === (state.chairId || '');
        chair.appendChild(option);
      }
      chair.disabled = state.busy || !state.benchId;
    }
    list.replaceChildren();
    const ordered = [...state.order, ...seatIds({ enabledOnly: true }).filter(id => !state.order.includes(id)), ...state.seats.filter(item => item.enabled === false).map(item => item.id)];
    for (const id of ordered) {
      const item = seat(id);
      if (!item) continue;
      const selected = state.order.includes(id);
      const label = document.createElement('label');
      label.className = `order-seat ${seatStyle(id)}-order ${selected ? 'selected' : ''} ${item.enabled === false ? 'disabled' : ''}`;
      label.dataset.orderAgent = id;
      label.draggable = selected;
      const number = document.createElement('span');
      number.className = 'order-number';
      number.textContent = selected ? String(state.order.indexOf(id) + 1) : '–';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected;
      checkbox.disabled = item.enabled === false || state.busy || id === state.chairId;
      checkbox.addEventListener('change', event => { event.stopPropagation(); toggleOrderSeat(id, checkbox.checked); });
      const dot = document.createElement('span');
      dot.className = 'agent-dot';
      const name = document.createElement('span');
      name.textContent = (item.name || id) + (id === state.chairId ? ' · 主席' : '');
      const hint = document.createElement('span');
      hint.className = 'drag-hint';
      hint.textContent = selected ? '↕' : '';
      label.append(number, checkbox, dot, name, hint);
      if (selected) {
        const controls = document.createElement('span');
        controls.className = 'order-controls';
        const index = state.order.indexOf(id);
        for (const [direction, symbol] of [[-1, '↑'], [1, '↓']]) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = symbol;
          button.setAttribute('aria-label', `${seatLabel(id)} ${direction < 0 ? '往前' : '往後'}一席`);
          button.disabled = state.busy || index + direction < 0 || index + direction >= state.order.length;
          button.addEventListener('click', event => { event.preventDefault(); moveOrderSeat(id, state.order[index + (direction < 0 ? -1 : 2)]); });
          controls.appendChild(button);
        }
        label.appendChild(controls);
      }
      label.addEventListener('dragstart', event => {
        if (!selected) { event.preventDefault(); return; }
        event.dataTransfer?.setData('text/plain', id);
      });
      label.addEventListener('dragover', event => { if (selected) event.preventDefault(); });
      label.addEventListener('drop', event => {
        event.preventDefault();
        moveOrderSeat(event.dataTransfer?.getData('text/plain'), id);
      });
      list.appendChild(label);
    }
    updateRouteHint();
    renderDiscussionStatus();
  }

  function renderDiscussionStatus() {
    show($('discussionStatus'), !!state.chairId);
    if (!state.chairId) return;
    const status = state.bench?.lastDiscussion?.status;
    const phase = state.bench?.lastDiscussion?.phase;
    const phases = { discussion: '討論處理中', proposals: '主席整理表決提案中', voting: '各席逐案投票中', 'tie-break': '平票，主席依證據裁決中', handoff: '主席整理討論結論中' };
    const text = state.busy ? phases[phase] || '討論處理中，主席在結束後總結'
      : status === 'finished' ? state.bench?.lastDiscussion?.voting && !state.bench.lastDiscussion.voting.results?.some(p => p.status === 'passed') ? '主席總結已完成，沒有通過的提案' : '主席總結已完成'
        : status === 'interrupted' ? '討論已中斷，尚未完成總結'
          : '主席待命，討論後列案、投票與總結';
    setText($('discussionStatusText'), `${seatLabel(state.chairId)} · ${text}`);
  }

  function renderVotingPanel() {
    const panel = $('votingPanel');
    if (!panel) return;
    const voting = state.bench?.lastDiscussion?.voting;
    panel.replaceChildren();
    show(panel, !!voting);
    if (!voting) return;
    const title = document.createElement('h2');
    title.textContent = '本場投票';
    const help = document.createElement('p');
    help.textContent = '投票權：' + voting.voters.map(seatLabel).join('、') + '；過半門檻 ' + (Math.floor(voting.voters.length / 2) + 1) + '/' + voting.voters.length + '。主席不投一般票。';
    panel.append(title, help);
    if (!voting.proposals.length) {
      const empty = document.createElement('p'); empty.textContent = '沒有可表決的明確提案。'; panel.appendChild(empty);
    }
    const labels = { passed: '通過', rejected: '不通過', tied: '平票，待主席裁決', unresolved: '未決，交你決定' };
    const choices = { agree: '同意', oppose: '反對', abstain: '棄權', missing: '未回覆／無效' };
    for (const proposal of voting.proposals) {
      const result = voting.results?.find(p => p.id === proposal.id);
      const item = document.createElement('div'); item.className = 'voting-proposal';
      const name = document.createElement('strong'); name.textContent = proposal.id + ' · ' + proposal.text;
      const status = document.createElement('p');
      const pending = state.bench.lastDiscussion.phase === 'voting' && state.bench.lastDiscussion.status === 'running';
      const interrupted = state.bench.lastDiscussion.status === 'interrupted';
      status.textContent = result ? (interrupted ? '投票流程已中斷' : pending ? '計票中' : labels[result.status]) + ' · 同意 ' + result.agree + '／反對 ' + result.oppose + '／棄權 ' + result.abstain + '／未回覆或無效 ' + result.missing : '等待投票';
      item.append(name, status);
      for (const id of voting.voters) {
        const vote = voting.ballots[id]?.find(v => v.proposalId === proposal.id);
        const line = document.createElement('p');
        line.textContent = seatLabel(id) + '：' + (vote ? choices[vote.choice] + '；' + vote.reason : '尚未投票');
        item.appendChild(line);
      }
      if (result?.ruling) {
        const ruling = document.createElement('p');
        ruling.textContent = '主席裁決：' + result.ruling.reason + (result.ruling.evidence ? '；依據：' + result.ruling.evidence : '');
        item.appendChild(ruling);
      }
      panel.appendChild(item);
    }
  }

  async function saveChair() {
    if (!state.benchId) return;
    try {
      const result = await post(`/api/workbenches/${encodeURIComponent(state.benchId)}/seats`, { op: 'chair', agentId: $('chairSelect').value });
      applySeatState(result);
      showToast(state.chairId ? `${seatLabel(state.chairId)} 擔任主席，討論後列案、投票與總結` : '已取消主席');
    } catch (error) { renderOrder(); reportError(error, { toast: true }); }
  }

  function closeMobilePanels() {
    $('appShell')?.classList.remove('sidebar-open', 'settings-open');
    show($('mobileScrim'), false);
    $('openSidebar')?.setAttribute('aria-expanded', 'false');
    $('openSettings')?.setAttribute('aria-expanded', 'false');
    updateMobileNavigation();
  }

  function updateMobileNavigation(panel = '') {
    const mobile = window.innerWidth <= 930;
    for (const [id, name] of [['navDiscussion', ''], ['openSettings', 'settings'], ['openSidebar', 'sidebar']]) {
      const button = $(id);
      if (name === panel) button?.setAttribute('aria-current', 'page');
      else button?.removeAttribute('aria-current');
    }
    for (const [id, name] of [['settingsColumn', 'settings'], ['sidebar', 'sidebar']]) {
      const element = $(id);
      if (element) element.inert = mobile && name !== panel;
    }
  }

  function togglePanel(panel) {
    closeRouteOptions();
    const shell = $('appShell');
    if (!shell) return;
    const className = panel === 'sidebar' ? 'sidebar-open' : 'settings-open';
    const other = panel === 'sidebar' ? 'settings-open' : 'sidebar-open';
    shell.classList.toggle(className);
    shell.classList.remove(other);
    show($('mobileScrim'), shell.classList.contains(className));
    $('openSidebar')?.setAttribute('aria-expanded', String(shell.classList.contains('sidebar-open')));
    $('openSettings')?.setAttribute('aria-expanded', String(shell.classList.contains('settings-open')));
    updateMobileNavigation(shell.classList.contains(className) ? panel : '');
  }

  function arrangeMobileReading() {
    const scroll = $('conversationScroll');
    const viewSwitch = document.querySelector('.desk-view-switch');
    const status = $('discussionStatus');
    if (window.innerWidth <= 930) {
      if (viewSwitch.parentElement !== scroll) scroll.prepend(viewSwitch, status);
    } else if (viewSwitch.parentElement === scroll) {
      scroll.before(viewSwitch, status);
      closeRouteOptions();
    }
  }

  function resizeMobileViewport() {
    const viewport = window.visualViewport;
    if (window.innerWidth <= 930 && (!viewport || viewport.scale === 1)) {
      document.documentElement.style.setProperty('--app-height', `${Math.round(viewport?.height || window.innerHeight)}px`);
      document.documentElement.style.setProperty('--app-top', `${Math.round(viewport?.offsetTop || 0)}px`);
    } else {
      document.documentElement.style.removeProperty('--app-height');
      document.documentElement.style.removeProperty('--app-top');
    }
  }

  let reconnecting = false;
  async function restoreVisibleConversation() {
    if (document.hidden || reconnecting || state.loadingBench) return;
    reconnecting = true;
    const id = state.benchId;
    const connection = state.bench?.connection;
    try {
      if (!id) { await loadSessions({ openLatest: true }); return; }
      try { await api(`/api/workbenches/${encodeURIComponent(id)}`); await openWorkbench(id); }
      catch {
        await loadSessions();
        const found = state.sessions.find(item => item.dirname === connection || item.id === connection);
        if (found && !found.explicitlyArchived) {
          if (found.archived) await resumeWorkbench(connection);
          else await openWorkbench(found.id);
        } else {
            closeEvents(); state.benchId = null; state.bench = null; state.chairId = null;
            resetConversation(); renderBenchInfo();
        }
      }
    } finally { reconnecting = false; }
  }

  async function refreshAll() {
    clearError();
    try {
      const [config, subscriptions] = await Promise.all([
        api('/api/config'), api('/api/subscriptions').catch(() => ({})),
      ]);
      state.config = config || { agents: {} };
      state.subscriptions = subscriptions || {};
      renderModelSelects();
      renderSubscriptions();
      if (state.benchId) {
        await fetchBench();
      }
      await loadSessions();
      showToast('已重新整理桌面狀態');
    } catch (error) { reportError(error, { toast: true }); }
  }

  function initDeskViews() {
    let view = 'workbench';
    try { if (localStorage.getItem('roundtable.desk-view') === 'meeting') view = 'meeting'; } catch {}
    const selectView = value => {
      view = value;
      document.body.dataset.deskView = value;
      $('viewMeeting').setAttribute('aria-pressed', String(value === 'meeting'));
      $('viewWorkbench').setAttribute('aria-pressed', String(value === 'workbench'));
      setText($('deskViewTitle'), value === 'meeting' ? '大家的想法，都在桌上' : '把不同觀點放在一起看');
      try { localStorage.setItem('roundtable.desk-view', value); } catch {}
    };
    $('viewMeeting').addEventListener('click', () => { selectView('meeting'); $('conversationScroll').scrollTo({ top: 0, behavior: 'instant' }); });
    $('viewWorkbench').addEventListener('click', () => { selectView('workbench'); $('conversationScroll').scrollTo({ top: 0, behavior: 'instant' }); });
    selectView(view);
    const render = () => {
      const activeSeats = state.seats.filter(item => item.enabled !== false);
      document.body.classList.toggle('has-conversation', !!state.benchId);
      setText($('deskSeatCount'), `${activeSeats.length} 席入座`);
      setText($('meetingTopic'), state.bench?.name || '一起把問題想清楚');
      setText($('meetingOrder'), state.order.filter(isEnabledAgent).map(seatLabel).join(' → ') || '從下方選擇發言對象');
      const cards = activeSeats.map(item => {
        const card = document.createElement('article');
        card.className = 'desk-seat-card' + (item.id === state.chairId ? ' is-chair' : '');
        card.dataset.viewSeat = item.id;
        const header = document.createElement('div');
        header.className = 'desk-seat-head';
        const avatar = document.createElement('span');
        avatar.className = `agent-avatar ${seatStyle(item.id)}-avatar`;
        avatar.textContent = CHARACTERS[item.provider] || item.name.slice(0, 1);
        const title = document.createElement('strong');
        title.textContent = item.name;
        const role = document.createElement('span');
        role.className = 'desk-seat-role';
        const index = state.order.indexOf(item.id);
        role.textContent = item.id === state.chairId ? '主席 · 不投一般票' : index >= 0 ? `順序 ${index + 1}` : '未加入圓桌';
        header.append(avatar, title, role);
        const model = document.createElement('p');
        model.className = 'desk-seat-model';
        model.textContent = isExternalAgent(item.id) ? '模型與推理 · 由網頁設定' : agentModel(item.id) || '預設模型';
        let latest;
        for (let i = state.messages.length - 1; i >= 0; i--) {
          if (state.messages[i].from === item.id) { latest = state.messages[i]; break; }
        }
        const streaming = state.streams.get(item.id);
        const text = discussionText(streaming?.text || latest?.data || '', { streaming: !!streaming });
        const excerpt = document.createElement('p');
        excerpt.className = 'desk-seat-excerpt' + (text ? '' : ' is-empty');
        excerpt.textContent = text ? text.slice(0, 360) + (text.length > 360 ? '…' : '') : '這席還沒有回覆。選擇對象、寫下問題，就能開始。';
        const foot = document.createElement('div');
        foot.className = 'desk-seat-foot';
        const status = document.createElement('span');
        status.textContent = streaming ? '正在回應…' : $(seatStatusId(item.id))?.textContent || '等待回應';
        const action = document.createElement('button');
        action.type = 'button';
        action.textContent = text ? '查看完整回覆 ↓' : '席位設定';
        action.setAttribute('aria-label', `${item.name} ${text ? '查看完整回覆' : '席位設定'}`);
        action.addEventListener('click', () => {
          if (text) {
            const messages = [...$('messageFeed').querySelectorAll('[data-agent-id]')];
            messages.filter(node => node.dataset.agentId === item.id).at(-1)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } else {
            if (window.innerWidth <= 930) togglePanel('settings');
            const original = [...$('seatList').querySelectorAll('[data-agent-card]')].find(node => node.dataset.agentCard === item.id);
            if (original) { original.querySelector('details').open = true; original.scrollIntoView({ block: 'nearest' }); }
          }
        });
        foot.append(status, action);
        card.append(header, model, excerpt, foot);
        return card;
      });
      $('deskSeatCards').replaceChildren(...cards);
    };
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; render(); });
    });
    for (const id of ['messageFeed', 'seatList', 'orderList', 'discussionStatus']) {
      observer.observe($(id), { childList: true, subtree: true, characterData: true });
    }
    render();
  }

  function bindEvents() {
    $('newChat').addEventListener('click', createWorkbench);
    $('refreshAll').addEventListener('click', refreshAll);
    $('historySearch').addEventListener('input', renderHistory);
    $('historyFilter').addEventListener('change', renderHistory);
    $('renameChat').addEventListener('click', renameWorkbench);
    $('renameForm').addEventListener('submit', saveRename);
    $('renameCancel').addEventListener('click', () => $('renameDialog').close());
    $('sendButton').addEventListener('click', sendFromComposer);
    $('gptCopyLaunch').addEventListener('click', copyExternalLaunchText);
    $('gptSaveLink').addEventListener('click', saveGptConnection);
    $('gptOpenBrowser').addEventListener('click', () => openGptBrowser(state.gptSeatId));
    $('gptOpenChat').addEventListener('click', () => openGptBrowser(state.bench?.external?.agentId || state.gptSeatId));
    $('gptConfirmLink').addEventListener('click', confirmGptConnection);
    $('gptSeatSelect').addEventListener('change', event => {
      state.gptSeatId = event.target.value;
      state.gptStatus = state.gptStatusBySeat[state.gptSeatId] || null;
      renderGptConnection();
      void refreshGptStatus({ agentId: state.gptSeatId });
    });
    $('gptSendTask').addEventListener('click', () => sendExternalTask().catch(error => reportError(error, { toast: true })));
    $('stopButton').addEventListener('click', async () => {
      if (!state.benchId) return;
      try { await post(`/api/workbenches/${encodeURIComponent(state.benchId)}/stop`, {}); await fetchBench().catch(() => null); } catch (error) { reportError(error, { toast: true }); }
    });
    $('saveWorkspace').addEventListener('click', saveWorkspace);
    $('clearWorkspace').addEventListener('click', () => { $('workspaceInput').value = ''; saveWorkspace(); });
    $('roundtableMode').addEventListener('click', toggleRoundtable);
    $('routeToggle').addEventListener('click', () => {
      const open = $('composerCard').classList.toggle('route-open');
      $('routeToggle').setAttribute('aria-expanded', String(open));
    });
    $('messageInput').addEventListener('focus', closeRouteOptions);
    $('chairSelect').addEventListener('change', saveChair);
    document.querySelectorAll('.route-chip').forEach(button => button.addEventListener('click', () => setRoute(button.dataset.agent)));
    $('messageInput').addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); sendFromComposer(); }
    });
    $('openSidebar').addEventListener('click', () => togglePanel('sidebar'));
    $('openSettings').addEventListener('click', () => togglePanel('settings'));
    $('navDiscussion').addEventListener('click', closeMobilePanels);
    $('sidebarClose').addEventListener('click', closeMobilePanels);
    $('settingsClose').addEventListener('click', closeMobilePanels);
    $('mobileScrim').addEventListener('click', closeMobilePanels);
  }

  async function init() {
    bindEvents();
    initDeskViews();
    setRoute('gpt');
    resizeMobileViewport();
    arrangeMobileReading();
    updateMobileNavigation();
    window.visualViewport?.addEventListener('resize', resizeMobileViewport);
    window.visualViewport?.addEventListener('scroll', resizeMobileViewport);
    window.addEventListener('resize', () => {
      resizeMobileViewport();
      arrangeMobileReading();
      const shell = $('appShell');
      updateMobileNavigation(window.innerWidth > 930 ? '' : shell.classList.contains('sidebar-open') ? 'sidebar' : shell.classList.contains('settings-open') ? 'settings' : '');
    });
    window.addEventListener('online', restoreVisibleConversation);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void restoreVisibleConversation(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { closeMobilePanels(); closeRouteOptions(); } });
    void refreshGptStatus();
    renderOrder();
    renderModelSelects();
    renderSubscriptions();
    renderBenchInfo();
    try {
      const [configResult, subscriptionResult] = await Promise.allSettled([
        api('/api/config'), api('/api/subscriptions'),
      ]);
      if (configResult.status === 'fulfilled') state.config = configResult.value || { agents: {} };
      if (subscriptionResult.status === 'fulfilled') state.subscriptions = subscriptionResult.value || {};
      renderModelSelects();
      renderSubscriptions();
      await loadSessions({ openLatest: true });
    } catch (error) { reportError(error, { toast: true }); }
  }

  window.addEventListener('beforeunload', closeEvents);
  init();
})();
