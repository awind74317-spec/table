import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/desk.js', import.meta.url), 'utf8');
const formatterSource = source.slice(source.indexOf('  function discussionText('), source.indexOf('  function appendMessage('));
const discussionText = new Function(formatterSource + '; return discussionText;')();

test('voting replies read as proposals, opinions and rulings without exposing protocol JSON', () => {
  const votes = JSON.stringify({ votes: [{ proposalId: 'P1', choice: 'agree', reason: '改善閱讀效率' }] });
  assert.equal(discussionText(votes), '投票意見\n提案 1：同意\n理由：改善閱讀效率');
  assert.equal(discussionText('```json\n' + votes + '\n```'), discussionText(votes));
  assert.equal(discussionText('{"proposals":[{"text":"擴大閱讀區"}]}'), '待表決提案\n提案 1：擴大閱讀區');
  assert.equal(discussionText('{"decisions":[{"proposalId":"P1","choice":"oppose","reason":"成本太高","evidence":"討論中的估算"}]}'), '主席裁決\n提案 1：反對\n理由：成本太高\n依據：討論中的估算');
  assert.match(discussionText('{"votes":', { streaming: true }), /正在整理投票意見/);
  assert.match(discussionText('{"votes":'), /格式不完整/);
  assert.match(discussionText('{"votes":[{"proposalId":"P1","choice":"agree"}]}'), /未回覆／無效/);
  assert.match(discussionText('{"votes":[null]}'), /格式不完整/);
  assert.match(discussionText('{"votes":[{"proposalId":"P1","choice":"agree","reason":"理由"},{"proposalId":"P1","choice":"agree","reason":"重複"}]}'), /未回覆／無效/);
  assert.match(discussionText('{"decisions":[{"proposalId":"P1","choice":"agree","reason":"缺少證據"}]}'), /待你決定/);
  for (const text of ['一般討論內容', '<img src=x> 只作文字顯示', '例如 {"votes":[]} 是傳輸格式', '{"example":1}']) assert.equal(discussionText(text), text);
});

test('desk view switch retains the live conversation and draft; seat cards use current replies only', () => {
  const node = () => ({ children: [], dataset: {}, attrs: {}, listeners: {}, textContent: '',
    classList: { toggle() {} },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(key, callback) { this.listeners[key] = callback; },
    scrollTo({ top }) { this.scrollTop = top; },
  });
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const state = { benchId: 'live-table', bench: { name: 'Live conversation' },
    seats: [{ id: 'gpt', provider: 'gpt', name: 'Same name' }, { id: 'gpt2', provider: 'gpt', name: 'Same name' },
      { id: 'off', provider: 'gpt', name: 'Disabled', enabled: false }],
    order: ['gpt'], chairId: 'gpt2', streams: new Map([['gpt2', { text: 'Streaming reply' }]]),
    messages: [{ from: 'gpt', data: 'Old reply' }, { from: 'gpt', data: '<img src=x> Latest reply' }],
  };
  const originalMessages = state.messages;
  const originalSeats = state.seats;
  $('messageInput').value = 'Unsent private draft';
  const stored = new Map([['roundtable.desk-view', 'invalid-preference']]);
  const document = { body: node(), createElement: node };
  let observed;
  const initSource = source.slice(source.indexOf('  function initDeskViews()'), source.indexOf('  function bindEvents()'));
  const init = new Function('state', '$', 'document', 'localStorage', 'MutationObserver', 'requestAnimationFrame',
    'setText', 'isEnabledAgent', 'seatLabel', 'CHARACTERS', 'seatStyle', 'isExternalAgent', 'agentModel', 'seatStatusId', 'discussionText',
    initSource + '; return initDeskViews;')(
    state, $, document, { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    class { constructor(callback) { observed = callback; } observe() {} }, callback => callback(),
    (element, value) => { element.textContent = value; }, id => state.seats.some(s => s.id === id && s.enabled !== false),
    id => state.seats.find(s => s.id === id)?.name, { gpt: 'G' }, () => 'gpt', () => true, () => '', id => id + '-status', discussionText);
  init();
  assert.equal(document.body.dataset.deskView, 'workbench');
  const cards = $('deskSeatCards').children;
  assert.deepEqual(cards.map(c => c.dataset.viewSeat), ['gpt', 'gpt2']);
  assert.equal(cards[0].children[2].textContent, '<img src=x> Latest reply');
  assert.equal(cards[1].children[2].textContent, 'Streaming reply');
  assert.match(cards[1].children[0].children[2].textContent, /主席/);
  $('viewMeeting').listeners.click();
  assert.equal(document.body.dataset.deskView, 'meeting');
  assert.equal($('viewMeeting').attrs['aria-pressed'], 'true');
  assert.equal(stored.get('roundtable.desk-view'), 'meeting');
  assert.equal($('conversationScroll').scrollTop, 0);
  $('viewWorkbench').listeners.click();
  assert.equal(document.body.dataset.deskView, 'workbench');
  assert.equal(state.benchId, 'live-table');
  assert.equal(state.messages, originalMessages);
  assert.equal(state.seats, originalSeats);
  assert.equal($('messageInput').value, 'Unsent private draft');
  state.messages.push({ from: 'gpt', data: '{"votes":[{"proposalId":"P1","choice":"agree","reason":"改善閱讀效率"}]}' });
  observed();
  assert.equal($('deskSeatCards').children[0].children[2].textContent, '投票意見\n提案 1：同意\n理由：改善閱讀效率');
  assert.match(state.messages.at(-1).data, /"votes"/);
  state.streams.set('gpt2', { text: '{"votes":' });
  observed();
  assert.match($('deskSeatCards').children[1].children[2].textContent, /正在整理投票意見/);
  state.messages = []; state.streams.clear();
  observed();
  assert.match($('deskSeatCards').children[0].children[2].textContent, /還沒有回覆/);
  assert.match($('deskSeatCards').children[1].children[2].textContent, /還沒有回覆/);
});
