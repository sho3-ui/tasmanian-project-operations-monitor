import {test} from 'node:test';
import assert from 'node:assert/strict';
import {healthOf,probe,syncIncident,TARGET,confirmedProbe,monitorRun} from './monitor.mjs';
const response=(operations='ok',operationReasons=[])=>({ready:true,reasons:[],operations,operationReasons});
test('HTTP200/ready true must not hide revoked intake or unusable alarm delivery',()=>{
  assert.equal(healthOf(200,response('degraded',['intake_revoked','connection_lost','incident_notify_unavailable'])).ok,false);
  assert.equal(healthOf(200,response('degraded',['held_backlog'])).ok,true);
  assert.equal(healthOf(200,{ready:true,reasons:[]}).ok,false);
  assert.equal(healthOf(200,response('ok',['connection_lost'])).ok,false);
  assert.equal(healthOf(200,response('degraded',['untrusted_private_message'])).ok,false);
  assert.deepEqual(healthOf(503,response()).reasons,['service_not_ready']);
});
test('probe is a bounded anonymous read with no redirect or business action',async()=>{
  const h=await probe(async(url,options)=>{assert.equal(url,TARGET);assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.credentials,'omit');assert.equal(Object.keys(options.headers).join(','),'Accept');return new Response(JSON.stringify(response()));});
  assert.equal(h.ok,true);
  assert.equal((await probe(async()=>new Response('x'.repeat(20000)))).ok,false);
  assert.equal((await probe(async()=>{throw Error('private response');})).reasons[0],'probe_unreachable');
});
test('an outage opens once, repeats are silent, recovery comments once even after a lost answer',async()=>{
  const issues=[],comments=[],calls=[];
  let lost=false;
  const api=async(method,path,body)=>{
    calls.push([method,path]);
    if(path==='/labels/operations-watch')return {name:'operations-watch'};
    if(method==='GET'&&path.startsWith('/issues?')){assert.ok(path.includes('labels=operations-watch'));return issues.filter(x=>x.state==='open');}
    if(method==='PUT'&&path.endsWith('/lock')){issues[0].locked=true;return null;}
    if(method==='POST'&&path==='/issues'){issues.push({id:1,number:1,user:{login:'github-actions[bot]'},state:'open',...body});return issues[0];}
    if(method==='GET'&&path.includes('/comments'))return comments;
    if(method==='POST'&&path.includes('/comments')){comments.push({user:{login:'github-actions[bot]'},...body});if(lost){lost=false;throw Error('answer lost');}return{};}
    if(method==='PATCH'){issues[0].state=body.state;return{};}
    throw Error('unexpected call');
  };
  const bad={ok:false,reasons:['intake_revoked']},good={ok:true,reasons:[]};
  assert.equal(await syncIncident(bad,api),'created');
  assert.equal(await syncIncident(bad,api),'already_open');
  assert.equal(issues.length,1);
  lost=true;await assert.rejects(syncIncident(good,api));
  assert.equal(await syncIncident(good,api),'recovered');
  assert.equal(comments.length,1);
  assert.equal(await syncIncident(good,api),'healthy');
});
test('arbitrary public issues cannot masquerade as a monitor incident',async()=>{
  let created=0,locked=false;
  const forged={id:1,number:1,user:{login:'someone-else'},title:'【要確認】予約業務システムの自動処理・外部接続',body:'<!-- tasmanian-operations-watch-v1 -->'};
  await syncIncident({ok:false,reasons:['intake_revoked']},async(method,path,body)=>{if(path==='/labels/operations-watch')return {name:'operations-watch'};if(method==='GET')return[forged];if(method==='PUT'){locked=true;return null;}created++;return {...body,id:2,number:2,user:{login:'github-actions[bot]'}};});
  assert.equal(created,1);assert.equal(locked,true);
});
test('new critical codes alert once, including a posted comment whose response was lost',async()=>{
  let issue,comments=[],lost=false,locks=0;
  const api=async(method,path,body)=>{
    if(path==='/labels/operations-watch')return {name:'operations-watch'};
    if(method==='GET'&&path.startsWith('/issues?'))return issue?[issue]:[];
    if(method==='POST'&&path==='/issues')return issue={...body,id:8,number:8,user:{login:'github-actions[bot]'}};
    if(method==='PUT'){issue.locked=true;locks++;return null;}
    if(method==='GET'&&path.includes('/comments'))return comments;
    if(method==='POST'&&path.includes('/comments')){comments.push({...body,user:{login:'github-actions[bot]'}});if(lost){lost=false;throw Error('lost');}return {};}
    throw Error('unexpected call');
  };
  await syncIncident({ok:false,reasons:['connection_expiring']},api);
  lost=true;await assert.rejects(syncIncident({ok:false,reasons:['connection_expiring','intake_revoked']},api));
  assert.equal(await syncIncident({ok:false,reasons:['intake_revoked']},api),'already_open');
  assert.equal(comments.length,1);assert.equal(locks,1);
});
test('a temporary probe error gets one delayed check while hard auth faults notify immediately',async()=>{
  let n=0,waits=0;
  const fetcher=async()=>{n++;return n===1?new Response('bad',{status:503}):new Response(JSON.stringify(response()));};
  assert.equal((await confirmedProbe(fetcher,async ms=>{assert.equal(ms,30000);waits++;})).ok,true);
  assert.equal(n,3);assert.equal(waits,2);
  const h=await confirmedProbe(async()=>new Response(JSON.stringify(response('degraded',['intake_revoked']))),async()=>{throw Error('hard fault should not wait');});
  assert.deepEqual(h.reasons,['intake_revoked']);
  n=0;assert.equal((await confirmedProbe(async()=>{n++;throw Error('offline');},async()=>{})).ok,false);assert.equal(n,2);
});
test('heartbeat still executes when incident API fails and failure remains visible',async()=>{
  const calls=[];
  await assert.rejects(monitorRun({ok:false,reasons:['intake_revoked']},async(method,path)=>{
    calls.push([method,path]);if(path==='/labels/operations-watch')return {name:'operations-watch'};if(path.startsWith('/issues'))throw Error('issue down');if(method==='GET')return null;return {};
  }));
  assert.ok(calls.some(([method,path])=>method==='PUT'&&path==='/contents/data/heartbeat.json'));
});

test('missing monitor label never creates an issue',async()=>{
 let writes=0;await assert.rejects(syncIncident({ok:false,reasons:['intake_revoked']},async(method)=>{if(method==='GET')return null;writes++;}));assert.equal(writes,0);
});
test('healthy recovery is confirmed twice and a second hard fault wins',async()=>{
 let n=0;const h=await confirmedProbe(async()=>new Response(JSON.stringify(++n===1?response():response('degraded',['intake_revoked']))),async()=>{});assert.equal(n,2);assert.equal(h.ok,false);
});

test('failure then one healthy observation cannot prematurely close an incident',async()=>{
 let n=0;const h=await confirmedProbe(async()=>{n++;if(n===1)throw Error('offline');return new Response(JSON.stringify(n===2?response():response('degraded',['intake_revoked'])));},async()=>{});assert.equal(n,3);assert.equal(h.ok,false);
});
