import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.js';
import {cleanupPublishedMedia,returnPostToWarehouse} from '../server/post-lifecycle.js';
import {createContentFromMedia} from '../server/content.js';

async function setup(t){
  const base=path.resolve('.verification'),root=path.join(base,'lifecycle-'+randomUUID()),store=new Store(root),project=store.createProject('Lifecycle QA');
  t.after(async()=>{assert.ok(root.startsWith(base+path.sep));await fs.rm(root,{recursive:true,force:true});});
  const file=path.join(root,'media','video.mp4');await fs.writeFile(file,'fixture');
  const media=store.add('media',{kind:'video',generated:true,file,projectId:project.id,name:'video.mp4'});
  return {store,media,file,root};
}
test('successful media cleanup removes only unreferenced workspace files',async t=>{
  const {store,media,file}=await setup(t);
  assert.equal((await cleanupPublishedMedia(store,media.id,'posted')).removed,true);
  assert.equal(store.state.media.length,0);await assert.rejects(fs.access(file));
});
test('shared published video remains usable by another draft but cannot be auto-created as new stock',async t=>{
  const {store,media,file}=await setup(t);
  store.state.socialPosts.push({id:'another-post',mediaIds:[media.id]});
  const result=await cleanupPublishedMedia(store,media.id,'posted');assert.equal(result.reason,'media_still_referenced');await fs.access(file);assert.ok(media.metaPublishedAt);
  store.state.socialPosts=[];
  await assert.rejects(createContentFromMedia(store,media.id,{source:'warehouse-sync'}),e=>e.code==='MEDIA_ALREADY_PUBLISHED');
});
test('cleanup refuses a tracked path outside the data directory without deleting anything',async t=>{
  const {store,media,file,root}=await setup(t);
  const external=path.join(path.dirname(root),'outside-'+randomUUID()+'.mp4');await fs.writeFile(external,'outside');
  t.after(()=>fs.rm(external,{force:true}));media.previewFile=external;
  assert.equal((await cleanupPublishedMedia(store,media.id,'posted')).reason,'outside_data_directory');
  await fs.access(file);await fs.access(external);assert.equal(store.state.media.length,1);
});
test('returning a post keeps its full content and stable error history across repeated returns',async t=>{
  const {store,media}=await setup(t);store.state.socialPages.push({id:'local-page',name:'Previous Page'});
  const post={id:'draft',pageId:'local-page',pageGroupId:'old-group',status:'scheduled',revision:1,articleBody:'Full article',caption:'Caption',firstComment:'Comment',mediaIds:[media.id],automationError:'Security restriction',automationErrorDetails:{code:368},automationAttempts:3};
  returnPostToWarehouse(store,post);returnPostToWarehouse(store,post);
  assert.equal(post.warehouse.previousPageName,'Previous Page');assert.equal(post.warehouse.previousGroupId,'old-group');assert.equal(post.articleBody,'Full article');assert.equal(post.warehouse.attempts,3);assert.equal(post.warehouse.errorDetails.code,368);assert.equal(post.status,'draft');assert.equal(post.scheduledAt,null);
});
