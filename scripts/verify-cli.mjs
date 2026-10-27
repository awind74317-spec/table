import { readFileSync } from 'node:fs';
import { runAgent } from '../src/runner.js';
import { makeProfile } from '../src/profile.js';
import { subscriptionStatus } from '../src/subscription.js';
const agents=JSON.parse(readFileSync('adapters/agents.json','utf8'));
for (const [id,cfg] of Object.entries(agents)) {
  const auth=await subscriptionStatus(cfg,{fresh:true});
  console.log(JSON.stringify({id,auth}));
  if (!auth.ok) {process.exitCode=1;continue;}
  const result=await runAgent(cfg,'本機介面連線驗收。請只回覆「同桌連線成功」，不讀檔、不使用工具。', {profile:makeProfile({id:'desk:smoke',cwdPolicy:'scratch'})});
  console.log(JSON.stringify({id,ok:result.ok,error:result.error,text:result.text,durationMs:result.durationMs,stderr:result.ok?'':result.stderr.slice(-800)}));
  if(!result.ok)process.exitCode=1;
}
