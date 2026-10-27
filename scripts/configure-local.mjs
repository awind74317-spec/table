import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'adapters', 'agents.json');
const home = homedir();
const bins = path.join(home, 'AppData/Local/OpenAI/Codex/bin');
const bundled = existsSync(bins) ? readdirSync(bins).map(d => path.join(bins, d, 'codex.exe')).filter(existsSync).sort((a,b) => statSync(b).mtimeMs-statSync(a).mtimeMs)[0] : null;
const codex = process.env.CODEX_CLI_PATH || bundled || 'codex';
const claudeNative = path.join(home, '.local/bin/claude.exe');
const claude = existsSync(claudeNative) ? claudeNative : 'claude';
const common = { input: 'stdin', output: 'stream-json', timeoutMs: 600000, subscriptionOnly: true,
  envWhitelist: ['PATH','SYSTEMROOT','SYSTEMDRIVE','COMSPEC','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','PATHEXT'],
  roles: ['debater','judge','summarizer'] };
const claudeArgs = ['-p','--output-format','stream-json','--verbose','--restricted','--permission-prompts','none'];
const agents = {
  claude: { ...common, name: 'Claude', family: 'claude', model: 'sonnet',
    models: [{id:'sonnet',label:'Sonnet · 日常規劃'},{id:'opus',label:'Opus · 深入推敲'},{id:'haiku',label:'Haiku · 輕量回覆'}],
    command: [claude,...claudeArgs,'--tools',''],
    workspaceArgs: [...claudeArgs,'--tools','Read,Glob,Grep','--permission-mode','plan'],
    chatResumeArgs: ['--resume','{SESSION_ID}'],
    isolationArgs: ['--setting-sources','','--strict-mcp-config','--disable-slash-commands'] },
  codex: { ...common, name: 'Codex', family: 'codex', model: 'gpt-6.1-sol',
    models: [{id:'gpt-6.1-sol',label:'GPT-6.1 Sol'},{id:'gpt-6-astra',label:'GPT-6 Astra'},{id:'gpt-6-luna',label:'GPT-6 Luna'},{id:'gpt-6-sol',label:'GPT-6 Sol'}],
    command: [codex,'exec','--json','--sandbox','read-only'],
    chatResumeArgs: ['exec','resume','{SESSION_ID}','--json','-c','sandbox_mode="read-only"','-'],
    isolationArgs: ['--ignore-user-config','--skip-git-repo-check','-c','windows.sandbox="elevated"'] }
};
if (!existsSync(file)) {
  writeFileSync(file, JSON.stringify(agents, null, 2) + '\n', 'utf8');
  console.log('Created local subscription-only CLI configuration.');
} else {
  // Refresh only a missing bundled executable after an app update.
  const existing = JSON.parse(readFileSync(file, 'utf8'));
  if (existing.codex && !existsSync(existing.codex.command[0]) && path.isAbsolute(codex)) {
    existing.codex.command[0] = codex;
    writeFileSync(file, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  }
}
