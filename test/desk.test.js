import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workbench, loadWorkbenchFromDisk, buildWorkbenchPrompt } from '../src/workbench.js';
import { buildProfileEnv } from '../src/profile.js';
import { subscriptionArgs, subscriptionStatus } from '../src/subscription.js';
import { runAgent } from '../src/runner.js';
import { makeProfile } from '../src/profile.js';

const deskHtml = readFileSync(new URL('../public/desk.html', import.meta.url), 'utf8');
const deskCss = readFileSync(new URL('../public/desk.css', import.meta.url), 'utf8');
const deskJs = readFileSync(new URL('../public/desk.js', import.meta.url), 'utf8');

test('startup resumes the saved table after a restart but does not reopen a user-archived table', async () => {
  const source = deskJs.slice(deskJs.indexOf('  async function loadSessions('), deskJs.indexOf('  function closeEvents('));
  const state = { benchId: null };
  let listing = [{ id: 'saved-directory', type: 'workbench', archived: true, explicitlyArchived: true }];
  const opened = [];
  const load = new Function('state', 'api', 'renderHistory', 'setConnection', 'localStorage', 'isWorkbenchSession', 'resumeWorkbench', 'openWorkbench', 'reportError', source + '; return loadSessions;')(
    state, async () => listing, () => {}, () => {}, { getItem: () => 'saved-directory' }, () => true,
    async id => opened.push(['resume', id]), async id => opened.push(['open', id]), error => { throw error; });
  await load({ openLatest: true });
  assert.deepEqual(opened, []);
  listing[0].explicitlyArchived = false;
  await load({ openLatest: true });
  assert.deepEqual(opened, [['resume', 'saved-directory']]);
  opened.length = 0;
  listing = [];
  await load({ openLatest: true });
  assert.deepEqual(opened, []);
});

test('conversation deletion needs an explicit confirmation each time, including after a previous deletion', async () => {
  let close;
  const dialog = { addEventListener(type, handler) { close = handler; }, showModal() {} };
  const label = {};
  const source = deskJs.slice(deskJs.indexOf('  function confirmConversationDeletion('), deskJs.indexOf('  async function manageConversation('));
  const confirm = new Function('$', 'setText', 'sessionTitle', source + '; return confirmConversationDeletion;')(
    id => id === 'deleteConversationDialog' ? dialog : label,
    (el, value) => { el.text = value; }, item => item.topic);
  const accepted = confirm({ topic: 'sample' });
  dialog.returnValue = 'delete'; close();
  assert.equal(await accepted, true);
  const cancelled = confirm({ topic: 'keep this' });
  assert.equal(dialog.returnValue, 'cancel');
  close();
  assert.equal(await cancelled, false);
  assert.match(label.text, /keep this/);
});

test('phone navigation selects one view and keeps closed drawers out of keyboard navigation', () => {
  const nodes = new Map(['navDiscussion', 'openSettings', 'openSidebar', 'settingsColumn', 'sidebar'].map(id => [id, {
    attributes: {}, setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; },
  }]));
  const window = { innerWidth: 390 };
  const source = deskJs.slice(deskJs.indexOf('  function updateMobileNavigation('), deskJs.indexOf('  function togglePanel('));
  const navigate = new Function('window', '$', source + '; return updateMobileNavigation;')(window, id => nodes.get(id));
  navigate('settings');
  assert.equal(nodes.get('openSettings').attributes['aria-current'], 'page');
  assert.equal(nodes.get('sidebar').inert, true);
  assert.equal(nodes.get('settingsColumn').inert, false);
  navigate('sidebar');
  assert.equal(nodes.get('openSettings').attributes['aria-current'], undefined);
  assert.equal(nodes.get('openSidebar').attributes['aria-current'], 'page');
  navigate();
  assert.equal(nodes.get('navDiscussion').attributes['aria-current'], 'page');
  assert.equal(nodes.get('settingsColumn').inert, true);
  window.innerWidth = 1440;
  navigate();
  assert.equal(nodes.get('settingsColumn').inert, false);
  assert.equal(nodes.get('sidebar').inert, false);
});

test('chair banner distinguishes waiting, running, finished and interrupted discussion', () => {
  const nodes = { discussionStatus: {}, discussionStatusText: {} };
  const state = { chairId: 'gpt3', busy: false, bench: {} };
  const source = deskJs.slice(deskJs.indexOf('  function renderDiscussionStatus('), deskJs.indexOf('  async function saveChair('));
  const render = new Function('state', '$', 'show', 'setText', 'seatLabel', source + '; return renderDiscussionStatus;')(
    state, id => nodes[id], (e, value) => { e.hidden = !value; }, (e, value) => { e.text = value; }, () => 'GPT 3');
  render(); assert.match(nodes.discussionStatusText.text, /待命/);
  state.bench.lastDiscussion = { status: 'finished' };
  state.busy = true; render(); assert.match(nodes.discussionStatusText.text, /處理中/);
  state.busy = false; render(); assert.match(nodes.discussionStatusText.text, /總結已完成/);
  state.bench.lastDiscussion.status = 'interrupted';
  render(); assert.match(nodes.discussionStatusText.text, /尚未完成總結/);
  state.chairId = null; render(); assert.equal(nodes.discussionStatus.hidden, true);
});

test('touch order arrows reuse the saved relay order and preserve the chair exclusion', () => {
  const element = () => ({ children: [], dataset: {}, listeners: {}, className: '',
    replaceChildren() { this.children = []; }, append(...items) { this.children.push(...items); },
    appendChild(item) { this.children.push(item); }, setAttribute(key, value) { this[key] = value; },
    addEventListener(key, callback) { this.listeners[key] = callback; } });
  const list = element();
  const chair = element();
  const state = { order: ['gpt', 'gpt2', 'gpt3'], chairId: 'gpt3', seats: ['gpt', 'gpt2', 'gpt3'].map(id => ({ id, name: id })), benchId: 'test' };
  let saved = 0;
  const source = deskJs.slice(deskJs.indexOf('  function moveOrderSeat('), deskJs.indexOf('  function renderDiscussionStatus('));
  const render = new Function('state', '$', 'document', 'isEnabledAgent', 'seatIds', 'seat', 'seatStyle', 'seatLabel', 'updateRouteHint', 'renderDiscussionStatus', 'saveRelayOrder', source + '; return renderOrder;')(
    state, id => id === 'orderList' ? list : chair, { createElement: element }, () => true,
    () => state.seats.map(s => s.id), id => state.seats.find(s => s.id === id), () => 'gpt', id => id,
    () => {}, () => {}, () => { saved++; });
  render();
  assert.deepEqual(state.order, ['gpt', 'gpt2']);
  const buttons = row => row.children.at(-1).children;
  assert.equal(buttons(list.children[0])[0].disabled, true);
  assert.equal(buttons(list.children[1])[1].disabled, true);
  buttons(list.children[0])[1].listeners.click({ preventDefault() {} });
  assert.deepEqual(state.order, ['gpt2', 'gpt']);
  assert.equal(saved, 1);
  buttons(list.children[1])[0].listeners.click({ preventDefault() {} });
  assert.deepEqual(state.order, ['gpt', 'gpt2']);
  assert.equal(saved, 2);
});

test('mobile moves view and chair controls into the reading scroll and restores them on desktop', () => {
  const column = {};
  const viewSwitch = { parentElement: column };
  const status = {};
  const moved = [];
  const scroll = {
    prepend(...nodes) { moved.push(nodes); viewSwitch.parentElement = scroll; },
    before(...nodes) { moved.push(nodes); viewSwitch.parentElement = column; },
  };
  const window = { innerWidth: 390 };
  let closed = 0;
  const source = deskJs.slice(deskJs.indexOf('  function arrangeMobileReading()'), deskJs.indexOf('  function resizeMobileViewport()'));
  const arrange = new Function('window', '$', 'document', 'closeRouteOptions', source + '; return arrangeMobileReading;')(
    window, id => id === 'conversationScroll' ? scroll : status,
    { querySelector: () => viewSwitch }, () => { closed++; });
  arrange(); arrange();
  assert.equal(viewSwitch.parentElement, scroll);
  assert.deepEqual(moved, [[viewSwitch, status]]);
  window.innerWidth = 1200;
  arrange(); arrange();
  assert.equal(viewSwitch.parentElement, column);
  assert.deepEqual(moved, [[viewSwitch, status], [viewSwitch, status]]);
  assert.equal(closed, 1);
});

test('mobile viewport follows keyboard height and Safari pan, then resets on desktop', () => {
  const source = deskJs.slice(deskJs.indexOf('  function resizeMobileViewport()'), deskJs.indexOf('  let reconnecting'));
  const values = new Map();
  const document = { documentElement: { style: {
    setProperty: (key, value) => values.set(key, value),
    removeProperty: key => values.delete(key),
  } } };
  const window = { innerWidth: 390, innerHeight: 800, visualViewport: { height: 360, offsetTop: 180, scale: 1 } };
  const resize = new Function('window', 'document', source + '; return resizeMobileViewport;')(window, document);
  resize();
  assert.equal(values.get('--app-height'), '360px');
  assert.equal(values.get('--app-top'), '180px');
  Object.assign(window.visualViewport, { height: 800, offsetTop: 0 });
  resize();
  assert.equal(values.get('--app-height'), '800px');
  assert.equal(values.get('--app-top'), '0px');
  window.innerWidth = 1200;
  resize();
  assert.equal(values.size, 0);
});

test('desk exposes GPT as an external seat and includes it in the roundtable order', () => {
  assert.match(deskHtml, /同桌 · Claude × Codex × GPT/);
  assert.match(deskHtml, /data-agent="gpt"/);
  assert.match(deskHtml, /id="orderList"/);
  assert.match(deskJs, /label\.dataset\.orderAgent = id/);
  assert.match(deskHtml, /id="gptTaskPanel"/);
  assert.match(deskHtml, /id="gptCopyLaunch"/);
  assert.match(deskHtml, /id="gptOpenBrowser"/);
  assert.match(deskHtml, /開啟專用 GPT 瀏覽器/);
  assert.match(deskHtml, /id="gptConfirmLink"/);
  assert.doesNotMatch(deskHtml, /browser-extension|target="_blank"/);
  assert.doesNotMatch(deskHtml, /id="buildAgentSelect"/);
  assert.match(deskCss, /--gpt:/);
  assert.match(deskCss, /\.agent-card\.gpt-card/);
  assert.match(deskJs, /const CHAT_AGENTS = \['claude', 'codex'\]/);
  assert.match(deskJs, /participants: ALL_AGENTS/);
  assert.match(deskJs, /op: 'add', agentId: 'gpt'/);
  assert.match(deskJs, /event\.type === 'external-task'/);
  assert.match(deskJs, /event\.type === 'external-send'/);
  assert.doesNotMatch(deskJs, /relayAutoSend|relaySentTaskIds/);
  assert.match(deskJs, /status === 'interrupted'/);
  assert.match(deskJs, /\/api\/gpt-browser\/status\?chatUrl=/);
  assert.match(deskJs, /\/api\/gpt-browser\/open/);
  assert.match(deskJs, /\/gpt-send/);
  assert.match(deskJs, /chatUrl: gptChatUrl\(\), taskId: task\.taskId/);
  assert.doesNotMatch(deskJs, /text:\s*task\.launchText/);
  assert.doesNotMatch(deskJs, /postMessage|roundtable-extension|extensionRequest/);
  assert.match(deskJs, /CHAT_SEND_UNKNOWN/);
});

test('subscription mode excludes API credentials even from explicit adapter env', async () => {
  const cfg = { subscriptionOnly:true, family:'codex', env:{OPENAI_API_KEY:'fake',ANTHROPIC_API_KEY:'fake',CODEX_API_KEY:'fake',ANTHROPIC_BASE_URL:'http://wrong'},envWhitelist:['PATH'] };
  assert.deepEqual(buildProfileEnv(cfg,{PATH:'test'}), {PATH:'test'});
  assert.ok(subscriptionArgs(cfg).includes('forced_login_method="chatgpt"'));
  assert.equal((await subscriptionStatus({...cfg,unavailable:true})).ok,false);
});

test('CLI reports quota and failed turn as failure even with exit code zero', async () => {
  const cfg={command:[process.execPath,path.resolve('test/mock-cli.cjs')],input:'stdin',output:'stream-json',timeoutMs:3000,env:{MOCK_FIXED_OUTPUT:JSON.stringify({type:'result',is_error:true,result:"You've hit your session limit · resets 10pm"})}};
  const result=await runAgent(cfg,'no model call',{profile:makeProfile({id:'quota-test',cwdPolicy:'scratch'})});
  assert.equal(result.ok,false);
  assert.match(result.error,/訂閱額度暫時用完/);
  const aborter=new AbortController();aborter.abort();
  const aborted=await runAgent(cfg,'no model call',{signal:aborter.signal,profile:makeProfile({id:'abort-test',cwdPolicy:'scratch'})});
  assert.equal(aborted.error,'aborted');
});

test('two fixture agents see each other in one thread, and relay follows the selected order', async () => {
  const baseDir=mkdtempSync(path.join(tmpdir(),'desk-relay-'));
  const cfg={command:[process.execPath,path.resolve('test/mock-cli.cjs')],input:'stdin',output:'stream-json',timeoutMs:5000};
  const agents={claude:{...cfg,name:'Claude fixture',env:{MOCK_SESSION_MODE:'claude',MOCK_AGENT_TEXT:'Plan code: MAPLE-742'}},codex:{...cfg,name:'Codex fixture'}};
  const events=[];
  const bench=new Workbench({name:'fixture-only',agents,participants:['claude','codex'],baseDir,emit:e=>events.push(e)});
  try {
    await bench.init();
    await bench.message('先規劃',['claude']);
    await bench.message('接續規劃',['codex']);
    assert.match(bench.messages.at(-1).text,/Plan code: MAPLE-742/);
    assert.match(bench.messages.at(-1).text,/\[Claude fixture\]/);
    const before=bench.messages.length;
    await bench.relay(1,['claude','codex'],'請彼此回應');
    assert.deepEqual(bench.messages.slice(before).filter(m=>m.from!=='user').map(m=>m.from),['claude','codex']);
  } finally {rmSync(baseDir,{recursive:true,force:true});}
});

test('native session resumes with only unseen messages across model switch and server restart', async () => {
  const baseDir=mkdtempSync(path.join(tmpdir(),'desk-delta-'));
  const capture=path.join(baseDir,'capture.jsonl');
  const cfg={name:'Claude fixture',family:'claude',model:'sonnet',models:[{id:'sonnet'},{id:'opus'}],command:[process.execPath,path.resolve('test/mock-cli.cjs')],input:'stdin',output:'stream-json',timeoutMs:3000,chatResumeArgs:['--resume','{SESSION_ID}'],env:{MOCK_SESSION_MODE:'claude',MOCK_SESSION_ID:'native-123',MOCK_AGENT_TEXT:'done',MOCK_CAPTURE_FILE:capture}};
  const bench=new Workbench({name:'delta',agents:{claude:cfg},participants:['claude'],baseDir});
  try {
    await bench.init(); await bench.message('FIRST UNIQUE SECRETLESS CANARY',['claude']);
    await bench.note('PEER RESULT ONLY ONCE');
    await bench.setModel('claude','opus');
    const disk=await loadWorkbenchFromDisk(bench.dir);
    const resumed=await Workbench.resume({name:'delta',agents:{claude:structuredClone(cfg)},participants:['claude'],baseDir,dir:bench.dir,messages:disk.messages,models:disk.meta.models,chatSessions:disk.meta.chatSessions});
    await resumed.message('NEXT TASK',['claude']);
    const calls=readFileSync(capture,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length,2); // One user request = one model call, no summarizer or bounce.
    assert.ok(calls[1].argv.includes('native-123'));
    assert.ok(calls[1].argv.includes('opus'));
    assert.doesNotMatch(calls[1].input,/FIRST UNIQUE/);
    assert.equal(calls[1].input.match(/PEER RESULT ONLY ONCE/g).length,1);
    assert.equal(calls[1].input.match(/NEXT TASK/g).length,1);
    assert.equal(resumed.messages.at(-1).sync.mode,'resume');
    assert.equal(resumed.messages.at(-1).sync.newMessages,2);
    assert.equal(resumed.chatSessions.claude.lastSeq,resumed.messages.length);
  } finally {rmSync(baseDir,{recursive:true,force:true});}
});

test('model switch preserves shared history and native resume, survives disk and workspace changes', async () => {
  const baseDir=mkdtempSync(path.join(tmpdir(),'desk-test-'));
  const agents={claude:{name:'Claude',model:'sonnet',models:[{id:'sonnet'},{id:'opus'}]},codex:{name:'Codex',model:'m1',models:[{id:'m1'},{id:'m2'}]}};
  const bench=new Workbench({name:'test',agents:structuredClone(agents),participants:['claude','codex'],baseDir,writeAgents:structuredClone(agents)});
  try {
    await bench.init();
    await bench.note('請記得驗收代號 MAPLE-742');
    bench.buildSessions.codex={sessionId:'old',lastSeq:1};
    await bench.setModel('codex','m2');
    assert.equal(bench.messages[0].text,'請記得驗收代號 MAPLE-742');
    assert.equal(bench.writeAgents.codex.model,'m2');
    assert.equal(bench.buildSessions.codex.sessionId,'old');
    await assert.rejects(bench.setModel('claude','m2'));
    bench.state='busy'; await assert.rejects(bench.setModel('claude','opus')); bench.state='idle';
    const disk=await loadWorkbenchFromDisk(bench.dir);
    const resumed=await Workbench.resume({name:'test',agents:structuredClone(agents),participants:['claude','codex'],baseDir,dir:bench.dir,messages:disk.messages,models:disk.meta.models,writeAgents:structuredClone(agents)});
    assert.equal(resumed.models.codex,'m2');
    await resumed.setWorkspace('',structuredClone(agents),structuredClone(agents));
    assert.equal(resumed.agents.codex.model,'m2');
    const prompt=buildWorkbenchPrompt({selfName:resumed.nameOf('codex'),participantNames:['Claude','Codex'],messages:resumed.messages,text:'接續規劃',limit:2000});
    assert.match(prompt.prompt,/MAPLE-742/);
  } finally { rmSync(baseDir,{recursive:true,force:true}); }
});

test('voting panel shows explicit seat ballots, authoritative counts, tie evidence and unresolved items', () => {
  const element = () => ({ children: [], textContent: '', append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); }, replaceChildren() { this.children = []; } });
  const panel = element();
  const state = { bench: { lastDiscussion: { phase: 'finished', voting: { voters: ['gpt', 'gpt2'],
    proposals: [{ id: 'P1', text: 'Keep files' }, { id: 'P2', text: 'Unknown' }],
    ballots: { gpt: [{ proposalId: 'P1', choice: 'agree', reason: 'Evidence' }] },
    results: [{ id: 'P1', status: 'passed', agree: 1, oppose: 1, abstain: 0, missing: 0,
      ruling: { reason: 'Preserve data', evidence: 'Seat discussion' } },
      { id: 'P2', status: 'unresolved', agree: 0, oppose: 0, abstain: 2, missing: 0 }],
  } } } };
  const source = deskJs.slice(deskJs.indexOf('  function renderVotingPanel('), deskJs.indexOf('  async function saveChair('));
  const render = new Function('state', '$', 'document', 'show', 'seatLabel', source + '; return renderVotingPanel;')(
    state, () => panel, { createElement: element }, (node, value) => { node.hidden = !value; }, id => id);
  const textOf = node => [node.textContent, ...node.children.map(textOf)].join(' ');
  render();
  assert.equal(panel.hidden, false);
  const text = textOf(panel);
  assert.match(text, /過半門檻 2\/2/); assert.match(text, /通過/);
  assert.match(text, /gpt：同意；Evidence/); assert.match(text, /gpt2：尚未投票/);
  assert.match(text, /主席裁決：Preserve data；依據：Seat discussion/);
  assert.match(text, /未決，交你決定/);
  state.bench.lastDiscussion.phase = 'voting'; state.bench.lastDiscussion.status = 'running'; render(); assert.match(textOf(panel), /計票中/);
  state.bench.lastDiscussion.status = 'interrupted'; render(); assert.match(textOf(panel), /投票流程已中斷/);
  state.bench.lastDiscussion = {}; render(); assert.equal(panel.hidden, true);
});
