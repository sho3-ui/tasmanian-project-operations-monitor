import { pathToFileURL } from 'node:url';

export const TARGET = 'https://runtime-trial.up.railway.app/readyz';
export const REPOSITORY = 'sho3-ui/tasmanian-project-operations-monitor';
const OWNER = 'sho3-ui';
export const MARKER = '<!-- tasmanian-operations-watch-v1 -->';
const TITLE = '【要確認】予約業務システムの自動処理・外部接続';
const KNOWN = new Set(['intake_never_synced','intake_stale','intake_revoked','intake_paused','intake_needs_reconciliation','intake_storage',
  'held_backlog','send_failed','business_stopped','cleaning_stopped','bookings_stale','bookings_storage','square_token_renewal',
  'connection_lost','connection_expiring','storage_low','storage_unknown','notify_store_unavailable','incident_notify_unavailable','health_unavailable']);
const sorted = xs => [...new Set(xs)].sort();

/** Never regards HTTP200/ready:true alone as proof that booking operations work. Unknown responses fail closed. */
export function healthOf(status, body) {
  const bad = { ok:false, reasons:['probe_invalid'] };
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.ready !== 'boolean'
    || !Array.isArray(body.reasons) || !Array.isArray(body.operationReasons)
    || !['ok','degraded','not_configured'].includes(body.operations)) return bad;
  if (body.reasons.some(x=>typeof x!=='string'||!/^[a-z_]{2,40}$/.test(x))
    || body.operationReasons.some(x=>typeof x!=='string'||!KNOWN.has(x))) return bad;
  if (status!==200 || !body.ready) return {ok:false,reasons:['service_not_ready']};
  if (body.operations==='not_configured') return {ok:false,reasons:['monitor_not_configured']};
  if (body.reasons.length) return {ok:false,reasons:['service_not_ready']};
  // A staff task waiting for a person is not a connection outage. Every other known operation issue is actionable for the administrator.
  const reasons=sorted(body.operationReasons.filter(x=>x!=='held_backlog'));
  if (body.operations==='ok' && body.operationReasons.length) return bad;
  if (body.operations==='degraded' && !body.operationReasons.length) return bad;
  return {ok:reasons.length===0,reasons};
}

async function boundedJson(response) {
  const reader=response.body?.getReader();
  if (!reader) throw new Error('empty_body');
  const chunks=[];let length=0;
  try { for(;;){const r=await reader.read();if(r.done)break;length+=r.value.byteLength;if(length>16384)throw new Error('body_limit');chunks.push(r.value);} }
  finally {await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(length);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.byteLength;}
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function probe(fetcher=fetch) {
  try {
    const r=await fetcher(TARGET,{method:'GET',redirect:'manual',credentials:'omit',headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});
    return healthOf(r.status,await boundedJson(r));
  } catch {return {ok:false,reasons:['probe_unreachable']};}
}

function validIssue(x){return x && Number.isSafeInteger(x.number) && x.number>0 && Number.isSafeInteger(x.id)
  && Array.isArray(x.labels) && x.labels.some(l=>(typeof l==='string'?l:l?.name)==='operations-watch')
  && x.user?.login==='github-actions[bot]' && x.title===TITLE && typeof x.body==='string' && x.body.startsWith(MARKER) && !x.pull_request;}

/** One open incident; repeats do not post or mail again. Reconciliation first also covers an earlier accepted write whose answer was lost. */
export async function syncIncident(health,api) {
  const label=await api('GET','/labels/operations-watch');
  if(label?.name!=='operations-watch')throw new Error('monitor_label_missing');
  const issues=await api('GET','/issues?state=open&labels=operations-watch&per_page=100&sort=created&direction=desc');
  if(!Array.isArray(issues)||issues.length>=100)throw new Error('issue_list_unbounded');
  const own=issues.filter(validIssue);
  if(own.length>1)throw new Error('duplicate_incident');
  const issue=own[0];
  if(issue && !issue.locked)await api('PUT','/issues/'+issue.number+'/lock',{});
  const comments=issue?await api('GET','/issues/'+issue.number+'/comments?per_page=100'):[];
  if(!Array.isArray(comments)||comments.length>=100)throw new Error('comment_list_unbounded');
  const codeMarker=xs=>'<!-- operations-codes:'+sorted(xs).join(',')+' -->';
  if(!health.ok){
    if(issue){
      const known=new Set();
      for(const body of [issue.body,...comments.filter(c=>c.user?.login==='github-actions[bot]').map(c=>c.body)])
        if(typeof body==='string')for(const m of body.matchAll(/<!-- operations-codes:([a-z_,]+) -->/g))for(const c of m[1].split(','))known.add(c);
      const fresh=health.reasons.filter(c=>!known.has(c));
      if(fresh.length){await api('POST','/issues/'+issue.number+'/comments',{body:codeMarker(fresh)+'\n@'+OWNER+' 追加で異常を検知しました。管理者画面を確認してください。\n検知コード：'+sorted(fresh).join(', ')});return 'updated';}
      return 'already_open';
    }
    const created=await api('POST','/issues',{title:TITLE,body:MARKER+'\n'+codeMarker(health.reasons)+'\n@'+OWNER+' 自動処理または外部接続に問題を検知しました。\n\n管理者画面の「運用の状態」と「Googleの接続」を確認してください。\nhttps://runtime-trial.up.railway.app/staff/admin\n\nGmailの送信権限を使わない外部監視です。予約の取込・清掃・LINEを再実行する機能ではありません。\n\n検知コード：'+sorted(health.reasons).join(', '),assignees:[OWNER],labels:['operations-watch']});
    if(!validIssue(created))throw new Error('created_issue_invalid');
    await api('PUT','/issues/'+created.number+'/lock',{});
    return 'created';
  }
  if(!issue)return 'healthy';
  const recoveryMarker='<!-- operations-recovery:'+issue.id+' -->';
  if(!comments.some(c=>c.user?.login==='github-actions[bot]'&&typeof c.body==='string'&&c.body.startsWith(recoveryMarker)))
    await api('POST','/issues/'+issue.number+'/comments',{body:recoveryMarker+'\n外部監視で、取込・外部接続を止める異常コードが解消したことを確認しました。個々の予約や清掃の完了を保証する確認ではありません。'});
  await api('PATCH','/issues/'+issue.number,{state:'closed',state_reason:'completed'});
  return 'recovered';
}

function githubApi(token) {
  return async(method,path,body)=>{
    if(!/^\/(issues(?:\?|\/|$)|labels\/operations-watch$|contents\/data\/heartbeat\.json(?:\?|$))/.test(path))throw new Error('github_path');
    const r=await fetch('https://api.github.com/repos/'+REPOSITORY+path,{method,redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    if(r.status===404 && method==='GET' && path.startsWith('/contents/'))return null;
    if(!r.ok)throw new Error('github_request_failed');
    // Do not log response text, headers, credentials or arbitrary issue contents.
    return r.status===204?null:await r.json();
  };
}

/** A daily, non-secret heartbeat records liveness; schedule enablement still needs operational monitoring. */
async function heartbeat(api,health) {
  const date=new Date().toISOString().slice(0,10),path='/contents/data/heartbeat.json';
  const old=await api('GET',path);
  if(old){
    if(old.type!=='file'||typeof old.sha!=='string'||!/^[a-f0-9]{40}$/.test(old.sha)||typeof old.content!=='string')throw new Error('heartbeat_invalid');
    try {if(JSON.parse(Buffer.from(old.content,'base64').toString()).date===date)return;}catch{throw new Error('heartbeat_invalid');}
  }
  const content=Buffer.from(JSON.stringify({date,status:health.ok?'ok':'attention'})+'\n').toString('base64');
  await api('PUT',path,{message:'Record daily external monitor heartbeat',content,...(old?{sha:old.sha}:{})});
}

export async function confirmedProbe(fetcher=fetch,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))) {
  const first=await probe(fetcher);
  if(first.ok || first.reasons.every(c=>['probe_unreachable','service_not_ready','probe_invalid'].includes(c))){
    await pause(30000);const second=await probe(fetcher);
    if(!first.ok && second.ok){await pause(30000);return probe(fetcher);}
    return second;
  }
  return first;
}

export async function monitorRun(health,api){
  let incident,error;
  try {incident=await syncIncident(health,api);}catch(e){error=e;}
  try {await heartbeat(api,health);}catch(e){error??=e;}
  if(error)throw error;
  return incident;
}

export async function main() {
  const health=await confirmedProbe();
  if(process.env.GITHUB_ACTIONS!=='true'){console.log(JSON.stringify({mode:'read_only',...health}));return;}
  if(process.env.GITHUB_REPOSITORY!==REPOSITORY||!process.env.GITHUB_TOKEN)throw new Error('github_context');
  const api=githubApi(process.env.GITHUB_TOKEN);
  const incident=await monitorRun(health,api);
  console.log(JSON.stringify({mode:'external_monitor',ok:health.ok,incident,reasons:health.reasons}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('External monitor failed; inspect the GitHub Actions run. No raw response was logged.');process.exitCode=1;});
