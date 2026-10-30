import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { Store } from '../server/store.js';
import { mountMetaRoutes } from '../server/meta.js';
import { mountSocialRoutes,autoScheduleWarehousePosts } from '../server/social.js';
import { pageRows,postRows } from '../server/management.js';
import { parsePageImport,csvText } from '../shared/management.js';

async function fixture(t,count=3,overrides={}){
  const base=path.resolve('.verification'),root=path.join(base,`management-${randomUUID()}`);
  const store=new Store(root),project=store.createProject('Quản lý QA');
  const media=store.add('media',{projectId:project.id,kind:'video',file:path.join(root,'media','fixture.mp4'),name:'fixture.mp4'});
  await fs.writeFile(media.file,'synthetic video');
  const token='source-token-for-tests',hash=createHash('sha256').update(token).digest('hex');
  store.state.socialPages=Array.from({length:count},(_,i)=>({id:randomUUID(),externalId:String(100000+i),name:`Page ${String(i).padStart(4,'0')}`,archived:false,revision:1}));
  store.state.socialPosts=store.state.socialPages.map((p,i)=>({id:randomUUID(),projectId:project.id,pageId:p.id,pageGroupId:'active',title:`Bài ${i}`,caption:'Caption',firstComment:'Comment',mediaIds:[media.id],contentType:'product',status:'draft',revision:1,createdAt:new Date().toISOString()}));
  Object.assign(store.state.settings.meta,{enabled:true,accessToken:token,tokens:[{id:'token',token,status:'ACTIVE',name:'Token QA'}],pages:store.state.socialPages.map(p=>({id:p.externalId,name:p.name,accessToken:'page-secret-'+p.externalId,tokenBindings:{token:{status:'VERIFIED',pageToken:'page-secret-'+p.externalId,credentialFingerprint:hash}}})),pageGroups:[{id:'active',name:'Nhóm đăng',purpose:'active',pageIds:store.state.socialPages.map(p=>p.externalId),scheduleConfig:{enabled:false,autoPublish:false,times:['22:05'],timezone:'Asia/Bangkok'}},{id:'review',name:'Chờ xử lý',purpose:'review',pageIds:[],scheduleConfig:{enabled:false,autoPublish:false,times:[],timezone:'Asia/Bangkok'}}]});
  store.save();
  const calls=[];
  const client={pageStatus:async({pageId})=>{calls.push(['read',pageId]);return {id:pageId,name:'Page',is_published:true};},pages:async()=>({data:[{id:'777',name:'New Page',access_token:'private-page-token'},{id:'778',name:'Second Page',access_token:'second-private'}]}),...overrides};
  const app=express();app.use(express.json());mountSocialRoutes(app,store);const service=mountMetaRoutes(app,store,{client});
  app.use((e,req,res,next)=>res.status(e.status || 400).json({error:e.message}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const address=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await service.close();await new Promise(resolve=>server.close(resolve));assert.ok(root.startsWith(base+path.sep));await fs.rm(root,{recursive:true,force:true});});
  const request=async(url,body)=>{const r=await fetch(address+url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const pageItems=(ids)=>pageRows(store).filter(p=>!ids || ids.includes(p.id)).map(p=>({id:p.id,revision:p.revision}));
  const postItems=()=>postRows(store).map(p=>({id:p.id,revision:p.revision}));
  const waitCheck=async()=>{for(let i=0;i<100;i++){if(!store.state.settings.meta.managementChecks.some(j=>j.status==='running'))return;await new Promise(r=>setTimeout(r,30));}throw new Error('Check timed out');};
  return {store,request,pageItems,postItems,waitCheck,calls,media};
}

test('CSV and JSON Page imports handle Unicode, quoted fields, duplicates and invalid sources',()=>{
  const result=parsePageImport('\uFEFFid,name,source\r\n123,"Trang, Việt Nam",Đối tác\r\n123,duplicate,\r\nhttps://www.facebook.com/profile.php?id=456,Page hai,CSV\r\nhttps://evil.example/789,Bad,');
  assert.equal(result.rows.length,2);assert.equal(result.duplicates,1);assert.equal(result.errors.length,1);assert.equal(result.rows[0].name,'Trang, Việt Nam');
  assert.equal(parsePageImport('[{"pageId":"789","name":"JSON Page"}]').rows[0].id,'789');
  assert.throws(()=>parsePageImport('id,name\n123,"Broken'),/ngoặc kép/);
  assert.match(csvText([['=HYPERLINK("bad")']]),/"'=HYPERLINK/);
});

test('Page bulk preview is read-only; busy and stale entries are skipped without losing posts or media',async t=>{
  const f=await fixture(t);const s=f.store.state;
  s.socialPosts[0].status='scheduled';s.socialPosts[0].scheduledAt=new Date(Date.now()+60_000).toISOString();s.socialPosts[1].automationStatus='publishing';
  const items=f.pageItems(),snapshot=JSON.stringify(s);
  const preview=await f.request('/api/management/pages/bulk/preview',{items,action:'delete'});
  assert.equal(preview.body.changed,2);assert.equal(preview.body.failed,1);assert.equal(JSON.stringify(s),snapshot);
  const apply=await f.request('/api/management/pages/bulk',{items,action:'delete'});
  assert.equal(apply.body.changed,2);assert.equal(s.socialPosts[0].status,'draft');assert.equal(s.socialPosts[0].scheduledAt,null);assert.equal(s.socialPosts.length,3);assert.equal(s.media.length,1);await fs.access(f.media.file);
  assert.equal(pageRows(f.store)[0].lifecycle,'deleted');
  const stale=await f.request('/api/management/pages/bulk',{items:[items[0]],action:'restore'});assert.equal(stale.body.failed,1);
  const imported=await f.request('/api/management/pages/import',{text:'100000,Renamed'});assert.equal(imported.body.keptDeleted,1);assert.equal(pageRows(f.store)[0].lifecycle,'deleted');
  const restore=await f.request('/api/management/pages/bulk',{items:f.pageItems(['100000']),action:'restore'});assert.equal(restore.body.changed,1);assert.equal(pageRows(f.store)[0].lifecycle,'review');assert.equal(s.socialPosts[0].status,'draft');
});

test('review -> read check -> explicit resolution -> original group never enables posting',async t=>{
  const f=await fixture(t,1),s=f.store.state;
  s.settings.meta.pages[0].publishingHealth={blocked:true,message:'Confirm identity',details:{code:368,subcode:4854002}};
  assert.equal((await f.request('/api/management/pages/bulk',{items:f.pageItems(),action:'review',reviewAt:'2026-11-01T00:00:00Z',notes:'Waiting for owner'})).body.changed,1);
  assert.deepEqual(pageRows(f.store)[0].previousGroupIds,['active']);
  assert.equal((await f.request('/api/management/pages/check',{ids:['100000']})).status,202);await f.waitCheck();
  assert.equal(pageRows(f.store)[0].verification.status,'passed');assert.equal(pageRows(f.store)[0].health,'identity');assert.equal(f.calls.length,1);
  assert.equal((await f.request('/api/management/pages/bulk/preview',{items:f.pageItems(),action:'return_group'})).body.failed,1);
  const result=await f.request('/api/management/pages/bulk',{items:f.pageItems(),action:'return_group',confirmResolved:true});
  assert.equal(result.body.changed,1);assert.equal(pageRows(f.store)[0].lifecycle,'active');assert.deepEqual(pageRows(f.store)[0].groupIds,['active']);assert.equal(s.settings.meta.pages[0].publishingHealth.blocked,false);assert.equal(s.socialPosts[0].status,'draft');assert.equal(s.settings.meta.pageGroups[0].scheduleConfig.autoPublish,false);
});

test('adding group membership preserves schedules; removing one group only pauses its own posts',async t=>{
  const f=await fixture(t,1),s=f.store.state;
  s.settings.meta.pageGroups.push({id:'extra',name:'Extra',pageIds:[],purpose:'active',scheduleConfig:{autoPublish:false}});
  s.socialPosts[0].status='scheduled';s.socialPosts[0].scheduledAt='2026-12-01T10:00:00Z';
  await f.request('/api/management/pages/bulk',{items:f.pageItems(),action:'add_group',groupId:'extra'});
  assert.equal(s.socialPosts[0].status,'scheduled');
  await f.request('/api/management/pages/bulk',{items:f.pageItems(),action:'remove_group',groupId:'extra'});
  assert.equal(s.socialPosts[0].status,'scheduled');
  await f.request('/api/management/pages/bulk',{items:f.pageItems(),action:'remove_group',groupId:'active'});
  assert.equal(s.socialPosts[0].status,'draft');assert.equal(s.socialPosts[0].pageGroupId,'');
});

test('importing selected Pages from a token does not expose secrets or remove unrelated bindings',async t=>{
  const f=await fixture(t,1),before=structuredClone(f.store.state.settings.meta.pages[0].tokenBindings);
  const discovery=await f.request('/api/management/pages/discover',{tokenId:'token'});
  assert.equal(discovery.status,200);assert.equal(JSON.stringify(discovery.body).includes('private-page-token'),false);
  const result=await f.request('/api/management/pages/import',{discoveryId:discovery.body.discoveryId,pageIds:['777'],source:'Token import'});
  assert.equal(result.body.added,1);assert.equal(f.store.state.settings.meta.pages.some(p=>p.id==='778'),false);assert.deepEqual(f.store.state.settings.meta.pages[0].tokenBindings,before);
  const list=await f.request('/api/management/pages');assert.equal(JSON.stringify(list.body).includes('private-page-token'),false);
});

test('external Page review does not alter unassigned posts, and review groups cannot auto-schedule',async t=>{
  const f=await fixture(t,1),s=f.store.state;s.socialPosts[0].pageId='';s.socialPosts[0].pageGroupId='';
  await f.request('/api/management/pages/import',{text:'555,Manual Page',source:'Partner'});
  const before=JSON.stringify(s.socialPosts);
  await f.request('/api/management/pages/bulk',{items:f.pageItems(['555']),action:'review'});
  assert.equal(JSON.stringify(s.socialPosts),before);
  const group=s.settings.meta.pageGroups.find(g=>g.id==='review');group.scheduleConfig={enabled:true,autoPublish:true,times:['22:05'],timezone:'Asia/Bangkok'};
  assert.equal(autoScheduleWarehousePosts(f.store,'review').scheduled.length,0);
});

test('rate limiting stops a verification batch and never clears a publishing restriction',async t=>{
  let calls=0;const f=await fixture(t,3,{pageStatus:async()=>{calls++;const e=new Error('Rate limited');e.metaError={code:4,httpStatus:429,retryAfterSeconds:600};throw e;}});
  await f.request('/api/management/pages/check',{ids:['100000','100001','100002']});await f.waitCheck();
  assert.equal(calls,1);const job=f.store.state.settings.meta.managementChecks[0];assert.equal(job.status,'paused');assert.equal(job.done,1);assert.equal(job.results.length,1);
});

test('post bulk actions preserve published history, avoid restricted Pages and require explicit retry',async t=>{
  const f=await fixture(t,2),s=f.store.state;
  s.settings.meta.pages[0].publishingHealth={blocked:true,message:'Restricted',details:{code:368}};
  let result=await f.request('/api/management/posts/bulk',{items:f.postItems(),action:'retry'});
  assert.equal(result.body.changed,1);assert.equal(result.body.failed,1);assert.equal(s.socialPosts[0].status,'draft');assert.equal(s.socialPosts[1].status,'scheduled');
  result=await f.request('/api/management/posts/bulk',{items:f.postItems().slice(0,1),action:'assign',pageId:'100001'});
  assert.equal(result.body.changed,1);assert.equal(s.socialPosts[0].pageId,s.socialPages[1].id);assert.equal(s.socialPosts[0].status,'draft');
  s.settings.meta.publications.push({idempotencyKey:'published-once',postId:randomUUID(),externalPostId:'remote-post',pageId:'100001',status:'published',firstCommentStatus:'published',title:'Already posted'});
  const history=postRows(f.store).find(p=>p.isPublication);
  assert.equal((await f.request('/api/management/posts/bulk',{items:[{id:history.id,revision:history.revision}],action:'retry'})).body.failed,1);
  await f.request('/api/management/posts/bulk',{items:[{id:history.id,revision:history.revision}],action:'delete'});
  assert.equal(s.settings.meta.publications.length,1);assert.equal(postRows(f.store).find(p=>p.isPublication).stage,'deleted');assert.equal(s.media.length,1);
});

test('large lists remain complete beyond old publication caps and bulk selection has no page-size cap',async t=>{
  const f=await fixture(t,1100),s=f.store.state;
  s.settings.meta.publications=Array.from({length:350},(_,i)=>({idempotencyKey:`history-${i}`,pageId:'100000',status:'published',title:`History ${i}`}));
  const start=performance.now();assert.equal(pageRows(f.store).length,1100);assert.ok(performance.now()-start<2500);
  const listed=await f.request('/api/management/posts');assert.equal(listed.body.rows.length,1450);
  const result=await f.request('/api/management/pages/bulk',{items:f.pageItems().slice(0,150),action:'archive'});
  assert.equal(result.body.changed,150);assert.equal(pageRows(f.store).filter(p=>p.lifecycle==='archived').length,150);assert.equal(s.socialPosts.length,1100);
});

test('an in-flight comment retry cannot be edited by bulk operations; archived posts leave pending counts',async t=>{
  const f=await fixture(t,2),s=f.store.state;
  Object.assign(s.socialPosts[0],{automationStatus:'publishing',publication:{firstCommentStatus:'error',externalPostId:'already-posted'}});
  s.socialPosts[1].archivedAt=new Date().toISOString();
  assert.equal(postRows(f.store)[0].stage,'publishing');
  assert.equal(pageRows(f.store)[1].pendingCount,0);
  const before=JSON.stringify(s.socialPosts[0]);
  const result=await f.request('/api/management/posts/bulk',{items:f.postItems().slice(0,1),action:'delete'});
  assert.equal(result.body.failed,1);assert.equal(JSON.stringify(s.socialPosts[0]),before);
});

test('a Page deleted during a read check stays deleted and progress records the skipped result',async t=>{
  let finish;
  const f=await fixture(t,1,{pageStatus:({pageId})=>new Promise(resolve=>{finish=()=>resolve({id:pageId,is_published:true});})});
  await f.request('/api/management/pages/check',{ids:['100000']});
  await f.request('/api/management/pages/bulk',{items:f.pageItems(),action:'delete'});
  finish();await f.waitCheck();
  const job=f.store.state.settings.meta.managementChecks[0];
  assert.equal(job.done,1);assert.equal(job.results[0].status,'skipped');
  assert.equal(pageRows(f.store)[0].lifecycle,'deleted');assert.equal(pageRows(f.store)[0].verification,null);
});

test('cancelling a Page check prevents late responses and later Pages from being applied',async t=>{
  let finish,calls=0;
  const f=await fixture(t,2,{pageStatus:({pageId})=>new Promise(resolve=>{calls++;finish=()=>resolve({id:pageId,is_published:true});})});
  const started=await f.request('/api/management/pages/check',{ids:['100000','100001']});
  await f.request(`/api/management/pages/check/${started.body.job.id}/cancel`,{});
  finish();await new Promise(resolve=>setTimeout(resolve,20));
  const job=f.store.state.settings.meta.managementChecks[0];
  assert.equal(job.status,'cancelled');assert.equal(job.done,0);assert.equal(calls,1);
  assert.equal(pageRows(f.store).some(p=>p.verification),false);
});

test('bulk content editing previews all selected rows, preserves individual fields and skips busy/stale posts',async t=>{
  const f=await fixture(t,4),s=f.store.state,items=f.postItems();
  s.socialPosts[1].automationStatus='publishing';s.socialPosts[2].revision++;
  s.socialPosts[0].website={status:'published',url:'https://example.test/article'};
  const input={items,action:'edit',changes:{firstComment:'Common comment'},edits:{[items[0].id]:{caption:'Only first caption',title:'Changed title'},[items[3].id]:{caption:'Fourth caption'}}};
  const before=JSON.stringify(s);const preview=await f.request('/api/management/posts/bulk/preview',input);
  assert.equal(preview.body.changed,2);assert.equal(preview.body.failed,2);assert.equal(JSON.stringify(s),before);
  const result=await f.request('/api/management/posts/bulk',input);assert.equal(result.body.changed,2);
  assert.equal(s.socialPosts[0].caption,'Only first caption');assert.equal(s.socialPosts[3].caption,'Fourth caption');assert.equal(s.socialPosts[1].firstComment,'Comment');
  assert.equal(s.socialPosts[0].website.contentChanged,true);assert.equal(s.socialPosts[3].status,'draft');assert.equal(s.socialPosts[3].scheduledAt,null);
});

test('returning an error to the warehouse preserves content/media and needs explicit reassignment to reuse',async t=>{
  const f=await fixture(t,1),s=f.store.state,p=s.socialPosts[0],content={title:p.title,caption:p.caption,firstComment:p.firstComment,mediaIds:[...p.mediaIds]};
  Object.assign(p,{automationError:'Restricted',automationErrorDetails:{code:368},automationAttempts:4,automationRetryBlocked:true});
  const before=JSON.stringify(p);const input={items:f.postItems(),action:'return_warehouse'};
  const preview=await f.request('/api/management/posts/bulk/preview',input);assert.equal(preview.body.changed,1);assert.equal(JSON.stringify(p),before);
  const result=await f.request('/api/management/posts/bulk',input);assert.equal(result.body.changed,1);
  assert.equal(p.pageId,'');assert.equal(p.pageGroupId,'');assert.equal(p.warehouse.previousPageName,'Page 0000');assert.equal(postRows(f.store)[0].stage,'warehouse');assert.equal(p.warehouse.error,'Restricted');
  for(const [key,value]of Object.entries(content))assert.deepEqual(p[key],value);
  await fs.access(f.media.file);s.settings.meta.pageGroups[0].scheduleConfig.autoPublish=true;s.settings.meta.pageGroups[0].scheduleConfig.enabled=true;
  assert.equal(autoScheduleWarehousePosts(f.store,'active').scheduled.length,0);
  const assigned=await f.request('/api/management/posts/bulk',{items:f.postItems(),action:'assign',pageId:'100000'});
  assert.equal(assigned.body.changed,1);assert.equal(p.warehouse,null);assert.equal(p.lastDeliveryError,'Restricted');assert.equal(p.status,'draft');
  assert.equal(p.automationHold,true);assert.equal(autoScheduleWarehousePosts(f.store,'active').scheduled.length,0);
});

test('a persisted publication blocks returning a video to stock even before the draft received its publication field',async t=>{
  const f=await fixture(t,1),s=f.store.state,p=s.socialPosts[0];
  s.settings.meta.publications.push({postId:p.id,idempotencyKey:'crash-safe',externalPostId:'already-live',status:'published_comment_error'});
  assert.equal((await f.request('/api/management/posts/bulk',{items:f.postItems(),action:'return_warehouse'})).body.failed,1);
  assert.equal((await f.request('/api/management/posts/bulk',{items:f.postItems(),action:'edit',changes:{caption:'Must not overwrite live video'}})).body.failed,1);
  assert.equal((await f.request('/api/management/posts/bulk',{items:f.postItems(),action:'edit',changes:{firstComment:'Retry only the comment'}})).body.changed,1);
  assert.equal(p.caption,'Caption');
});
