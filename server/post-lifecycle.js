import fs from 'node:fs/promises';
import path from 'node:path';
import { StudioError } from './store.js';

export function publishedVideo(store, post) {
  return post.publication?.externalPostId || store.state.settings?.meta?.publications?.find(p=>p.postId===post.id && p.externalPostId)?.externalPostId || (post.status==='published' ? 'published' : '');
}

export function returnPostToWarehouse(store, post, {automatic=false, at=new Date().toISOString()}={}) {
  if (publishedVideo(store,post)) throw new StudioError('Video đã đăng. Chỉ tiếp tục bình luận trên video cũ, không trả về kho để đăng lại.','ALREADY_PUBLISHED',409);
  const page=store.state.socialPages?.find(p=>p.id===post.pageId);
  const previous=post.warehouse || {};
  const error=post.automationError || previous.error || post.lastDeliveryError || '';
  Object.assign(post,{
    warehouse:{...previous,returnedAt:at,automatic,previousPageId:post.pageId || previous.previousPageId || '',previousPageName:page?.name || previous.previousPageName || '',previousGroupId:post.pageGroupId || previous.previousGroupId || '',error,errorDetails:post.automationErrorDetails || previous.errorDetails || null,attempts:Number(post.automationAttempts || previous.attempts || 0)},
    pageId:'',pageGroupId:'',tokenGroupId:'',status:'draft',automationHold:true,scheduledAt:null,
    automationStatus:'warehouse',automationError:null,automationErrorDetails:post.automationErrorDetails || previous.errorDetails || null,automationRetryBlocked:true,
    automationBlockedReason:post.automationBlockedReason || 'warehouse_review',automationNextAttemptAt:null,
    lastDeliveryError:error || null,revision:Number(post.revision || 1)+1,updatedAt:at,
  });
  return post;
}

// Keep files that are still used elsewhere; never unlink a path outside the data directory.
export async function cleanupPublishedMedia(store, mediaId, postId) {
  const media=store.state.media.find(m=>m.id===mediaId);
  if(!media)return {removed:false,reason:'media_not_found'};
  media.metaPublishedAt ||= new Date().toISOString();
  const inTimeline=store.state.projects.some(p=>p.timeline?.clips?.some(c=>c.mediaId===mediaId) || p.timeline?.images?.some(c=>c.mediaId===mediaId) || p.timeline?.music?.mediaId===mediaId);
  const inJob=store.state.jobs.some(j=>['queued','scheduled','running','preparing','submitting','generating','rendering','downloading'].includes(j.status) && JSON.stringify(j.payload || {}).includes(mediaId));
  const inPost=store.state.socialPosts.some(p=>p.id!==postId && p.mediaIds?.includes(mediaId));
  if(inTimeline || inJob || inPost)return {removed:false,reason:'media_still_referenced',mediaId};
  try{
    const root=await fs.realpath(store.root);
    const files=[];
    for(const file of new Set([media.file,media.thumbnail,media.previewFile].filter(Boolean))){
      let actual;
      try{actual=await fs.realpath(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
      const relative=path.relative(root,actual);
      if(!relative || relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative))return {removed:false,reason:'outside_data_directory',mediaId};
      if(!(await fs.stat(actual)).isFile())return {removed:false,reason:'not_a_file',mediaId};
      for(const other of store.state.media.filter(m=>m.id!==mediaId)){
        for(const otherFile of [other.file,other.thumbnail,other.previewFile].filter(Boolean)){
          if(path.resolve(otherFile)===path.resolve(file))return {removed:false,reason:'media_still_referenced',mediaId};
        }
      }
      files.push(actual);
    }
    for(const file of files)await fs.rm(file,{force:true});
    store.state.media=store.state.media.filter(m=>m.id!==mediaId);
    return {removed:true,mediaId,name:media.name || ''};
  }catch{return {removed:false,reason:'media_cleanup_failed',mediaId};}
}
