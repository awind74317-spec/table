// 可控 mock CLI：按 prompt 首行指令行为，供全部测试复用
const { readFileSync, writeFileSync, appendFileSync } = require('node:fs');

// 测试可控延迟：存在 MOCK_DELAY_MS 时先睡再回显，默认 0 不影响其他测试
const delay = Number(process.env.MOCK_DELAY_MS ?? 0);

// 文件输入模式：node mock-cli.cjs --from-file <path>
if (process.argv[2] === '--from-file') {
  process.stdout.write(readFileSync(process.argv[3], 'utf8'));
  process.exit(0);
}

let input = '';
process.stdin.on('data', d => (input += d));
process.stdin.on('end', () => {
  // 执行线程测试模式：可写一个隔离副本文件、记录实收字节/argv，并吐 Claude/Codex 原生线程事件。
  if (process.env.MOCK_SESSION_MODE) {
    const sessionId = process.env.MOCK_SESSION_ID || 'mock-session-0001';
    if (process.env.MOCK_WRITE_FILE) writeFileSync(process.env.MOCK_WRITE_FILE, process.env.MOCK_WRITE_CONTENT || 'mock managed output');
    if (process.env.MOCK_CAPTURE_FILE) appendFileSync(process.env.MOCK_CAPTURE_FILE, JSON.stringify({ argv: process.argv.slice(2), input }) + '\n');
    let answer = process.env.MOCK_AGENT_TEXT || 'managed execution result';
    if (process.env.MOCK_ROUNDTABLE) {
      const phase = [...input.matchAll(/\[圓桌階段:([^\]]+)\]/g)].at(-1)?.[1];
      if (phase === 'proposals') answer = JSON.stringify({ proposals: [{ text: 'fixture proposal' }] });
      if (phase === 'vote') answer = JSON.stringify({ votes: [{ proposalId: 'P1', choice: 'agree', reason: 'fixture evidence' }] });
    }
    if (process.env.MOCK_SESSION_MODE === 'codex') {
      process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: sessionId }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'result', session_id: sessionId, result: answer }) + '\n');
    }
    process.exit(0);
  }
  // 测试可控固定输出：存在 MOCK_FIXED_OUTPUT 时忽略 stdin 内容，恒定输出该值
  // （用于构造"摘要内容与轮次无关"的场景，如假收敛守卫测试）
  if (process.env.MOCK_FIXED_OUTPUT !== undefined) {
    process.stdout.write(process.env.MOCK_FIXED_OUTPUT);
    process.exit(0);
  }
  const nl = input.indexOf('\n');
  const first = (nl === -1 ? input : input.slice(0, nl)).trim();
  const rest = nl === -1 ? '' : input.slice(nl + 1);
  if (first.startsWith('#fail')) {
    process.stderr.write('mock failure');
    process.exit(Number(first.split(/\s+/)[1] ?? 1));
  }
  if (first === '#auth') {
    process.stderr.write('please login: session expired');
    process.exit(1);
  }
  if (first === '#json') {
    process.stdout.write(JSON.stringify({ result: rest.trim() }));
    process.exit(0);
  }
  if (first === '#stream2') {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'assistant text piece' }] } }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'result', result: rest.trim() }) + '\n');
    process.exit(0);
  }
  if (first === '#stream') {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'result', result: rest.trim() }) + '\n');
    process.exit(0);
  }
  if (first.startsWith('#sleep')) {
    const ms = Number(first.split(/\s+/)[1] ?? 100);
    setTimeout(() => {
      process.stdout.write(rest);
      process.exit(0);
    }, ms);
    return;
  }
  if (first.startsWith('#env')) {
    process.stdout.write(String(process.env[first.split(/\s+/)[1]] ?? '<unset>'));
    process.exit(0);
  }
  if (first === '#cwd') { process.stdout.write(process.cwd()); process.exit(0); }
  if (first === '#echo') { process.stdout.write(rest); process.exit(0); }
  setTimeout(() => {
    process.stdout.write(input);
    process.exit(0);
  }, delay);
});
