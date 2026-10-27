// Only explicit structured replies count as ballots; prose never implies consent.
export function votingJson(text) {
  const value = String(text ?? '').trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(value);
  try { return JSON.parse(fence ? fence[1] : value); }
  catch { return null; }
}

export function parseProposals(text) {
  const proposals = votingJson(text)?.proposals;
  if (!Array.isArray(proposals) || proposals.some(p => !p || typeof p.text !== 'string' || !p.text.trim())) {
    throw new Error('主席提案格式無效，尚未進行投票；請重新開始討論');
  }
  return proposals.map((p, i) => ({ id: `P${i + 1}`, text: p.text.trim() }));
}

export function parseBallot(text, proposals) {
  const votes = votingJson(text)?.votes;
  return proposals.map(p => {
    const entries = Array.isArray(votes) ? votes.filter(v => v?.proposalId === p.id) : [];
    const v = entries[0];
    const valid = entries.length === 1 && ['agree', 'oppose', 'abstain'].includes(v.choice)
      && typeof v.reason === 'string' && !!v.reason.trim();
    return { proposalId: p.id, choice: valid ? v.choice : 'missing', reason: valid ? v.reason.trim() : '未回覆或選票格式無效，不計為同意' };
  });
}

export function tallyVotes(voting) {
  const threshold = Math.floor(voting.voters.length / 2) + 1;
  return voting.proposals.map(p => {
    const votes = voting.voters.map(id => ({ agentId: id,
      ...(voting.ballots[id]?.find(v => v.proposalId === p.id) ?? { proposalId: p.id, choice: 'missing', reason: '尚未收到選票' }) }));
    const count = choice => votes.filter(v => v.choice === choice).length;
    const agree = count('agree'), oppose = count('oppose'), abstain = count('abstain'), missing = count('missing');
    const status = agree >= threshold ? 'passed'
      : agree > 0 && agree === oppose ? 'tied'
        : oppose >= threshold ? 'rejected' : 'unresolved';
    return { ...p, threshold, agree, oppose, abstain, missing, status, votes };
  });
}

export function resolveTies(results, text) {
  const decisions = votingJson(text)?.decisions;
  return results.map(p => {
    if (p.status !== 'tied') return p;
    const entries = Array.isArray(decisions) ? decisions.filter(d => d?.proposalId === p.id) : [];
    const d = entries[0];
    const valid = entries.length === 1 && ['agree', 'oppose'].includes(d?.choice)
      && typeof d.reason === 'string' && !!d.reason.trim()
      && typeof d.evidence === 'string' && !!d.evidence.trim();
    return { ...p, status: valid ? d.choice === 'agree' ? 'passed' : 'rejected' : 'unresolved',
      ruling: valid ? { choice: d.choice, reason: d.reason.trim(), evidence: d.evidence.trim() }
        : { choice: 'unresolved', reason: '主席未提供有理由與證據的有效裁決，交使用者決定' } };
  });
}

export function votingReport(voting, nameOf = id => id) {
  const labels = { passed: '通過', rejected: '不通過', tied: '平票，待主席裁決', unresolved: '未決，交使用者決定' };
  const choices = { agree: '同意', oppose: '反對', abstain: '棄權', missing: '未回覆／無效' };
  return [
    '【系統投票結果】',
    `投票席位：${voting.voters.map(nameOf).join('、')}；每席一票，通過門檻 ${Math.floor(voting.voters.length / 2) + 1}/${voting.voters.length}。主席及未參與討論的施工席位不投一般票。`,
    ...(voting.results ?? tallyVotes(voting)).map(p => [
      `${p.id}｜${p.text}`,
      `結果：${labels[p.status]}；同意 ${p.agree}、反對 ${p.oppose}、棄權 ${p.abstain}、未回覆／無效 ${p.missing}`,
      ...p.votes.map(v => `  ${nameOf(v.agentId)}：${choices[v.choice]}；${v.reason}`),
      p.ruling ? `主席裁決：${p.ruling.reason}${p.ruling.evidence ? `；依據：${p.ruling.evidence}` : ''}` : '',
    ].filter(Boolean).join('\n')),
    !voting.proposals.length ? '沒有可表決的明確提案；不視為授權施工。' : '',
    '以上結果由系統計票。主席交接不得推翻結果；未決與不通過項目不可當成已核定施工，投票不擴大使用者授權。',
  ].filter(Boolean).join('\n\n');
}
