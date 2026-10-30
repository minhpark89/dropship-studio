import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Store } from '../server/store.js';
import { mountMetaRoutes, publicMeta } from '../server/meta.js';
import { autoScheduleWarehousePosts } from '../server/social.js';

async function fixture(overrides = {}) {
  const root = path.resolve('.verification', `publishing-health-${randomUUID()}`);
  const store = new Store(root);
  const project = store.createProject('Posting health QA');
  const localPage = store.add('socialPages', { name:'Page QA', externalId:'123', archived:false });
  const file = path.join(root, 'media', 'video.mp4');
  await fs.writeFile(file, 'fake-video');
  const media = store.add('media', { projectId:project.id, file, kind:'video', name:'video.mp4' });
  const post = store.add('socialPosts', { projectId:project.id, pageId:localPage.id, title:'Test', caption:'Caption', firstComment:'Comment', mediaIds:[media.id], status:'ready', revision:1 });
  Object.assign(store.state.settings.meta, {
    enabled:true, accessToken:'user-token',
    tokens:[{ id:'token-1', token:'user-token', status:'ACTIVE' }],
    pages:[{ id:'123', name:'Page QA', accessToken:'page-token', tokenBindings:{ 'token-1':{ pageToken:'page-token', status:'VERIFIED' } } }],
    pageGroups:[{ id:'group-1', name:'Group', pageIds:['123'], scheduleConfig:{ times:['22:05'], enabled:true, autoPublish:true, timezone:'Asia/Bangkok' } }],
  });
  store.save();
  const calls = [];
  const client = {
    startReel:async()=>{calls.push('start'); return { video_id:'video-1', upload_url:'https://upload.test/1' };},
    uploadChunk:async()=>{calls.push('upload'); return { success:true };},
    finishReel:async()=>{calls.push('finish'); return { id:'video-1' };},
    videoStatus:async()=>({ status:{ video_status:'ready', publishing_phase:{ publish_status:'published' } } }),
    comment:async()=>{calls.push('comment'); return { id:'comment-1' };},
    ...overrides,
  };
  const app = express(); app.use(express.json());
  const service = mountMetaRoutes(app, store, { client });
  app.use((error,req,res,next)=>res.status(error.status || 400).json({ error:error.message }));
  return { store,post,service,app,calls };
}

test('a real-shaped security rejection blocks the Page, stops another upload and can be pruned without deleting it', async t => {
  let starts = 0;
  const {store,post,service,app} = await fixture({ startReel:async()=>{
    starts++;
    const error = new Error('Security restriction');
    error.metaError = { code:368, subcode:1404112, httpStatus:400 };
    throw error;
  }});
  await assert.rejects(service.publishReel({ postId:post.id, idempotencyKey:'security-attempt-1' }));
  assert.equal(store.state.settings.meta.pages[0].publishingHealth.blocked,true);
  assert.equal(post.pageId,'');assert.equal(post.warehouse.previousPageName,'Page QA');assert.equal(post.warehouse.errorDetails.code,368);
  assert.equal(publicMeta(store.state.settings.meta).pages[0].health,'ERROR');
  assert.equal(autoScheduleWarehousePosts(store,'group-1').scheduled.length,0);
  await assert.rejects(service.publishReel({ postId:post.id, idempotencyKey:'security-attempt-2' }));
  assert.equal(starts,1);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const pruned=await (await fetch(base+'/api/meta/page-groups/group-1/prune',{method:'POST'})).json();
  assert.deepEqual(pruned.removedPageIds,['123']);
  assert.equal(store.state.settings.meta.pages.length,1);
  const resumed=await fetch(base+'/api/meta/pages/123/resume-publishing',{method:'POST'});
  assert.equal(resumed.status,200);
  assert.equal(store.state.settings.meta.pages[0].publishingHealth.blocked,false);
  assert.equal(starts,1);
});

for(const mode of ['processing','comment-edge']) test(`first-comment ${mode} delay preserves the Reel and retries only the comment`, async()=>{
  let statusCalls=0, commentCalls=0;
  const {store,post,service,calls}=await fixture({
    videoStatus:async()=>{
      statusCalls++;
      return {status:{ video_status:mode==='processing' && statusCalls===1 ? 'processing':'ready', publishing_phase:{publish_status:'published'} }};
    },
    comment:async()=>{
      commentCalls++;
      if(mode==='comment-edge' && commentCalls===1){ const error=new Error('Object is not visible yet'); error.metaError={code:100,subcode:33,httpStatus:400}; throw error; }
      return {id:'comment-1'};
    },
  });
  const first=await service.publishReel({postId:post.id,idempotencyKey:'processing-original'});
  assert.equal(first.status,'published_comment_error');
  assert.equal(first.firstCommentErrorDetails.kind,'video_processing');
  assert.equal(first.firstCommentErrorDetails.retryable,true);
  assert.equal(store.state.settings.meta.publications.length,1);
  const second=await service.publishReel({postId:post.id,idempotencyKey:'processing-manual-retry'});
  assert.equal(second.status,'published');
  assert.equal(store.state.settings.meta.publications.length,1);
  assert.equal(calls.filter(c=>c==='start').length,1);
  assert.equal(calls.filter(c=>c==='finish').length,1);
  assert.equal(commentCalls,mode==='processing'?1:2);
});
