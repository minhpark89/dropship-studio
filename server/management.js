import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { StudioError } from './store.js';
import { syncMetaPages, validatePostPayload } from './social.js';
import { publishedVideo, returnPostToWarehouse } from './post-lifecycle.js';
import { classifyMetaFailure } from './meta-errors.js';
import { pageHealth, postStage, parsePageImport, managedPageUnavailable } from '../shared/management.js';

const now=()=>new Date().toISOString();
const fingerprint=value=>createHash('sha256').update(value).digest('hex');
const purpose=g=>g.purpose || (g.id.startsWith('pgrp_hold_')?'review':'active');
const selections=z.array(z.object({id:z.string().min(1).max(250),revision:z.number().int().nonnegative()})).min(1).max(5000);
const editFields=z.object({title:z.string().trim().min(1).max(200).optional(),caption:z.string().max(20000).optional(),firstComment:z.string().max(10000).optional(),articleBody:z.string().max(60000).optional(),notes:z.string().max(5000).optional()}).strict();
const bulkSchema=z.object({items:selections,action:z.string(),groupId:z.string().optional(),pageId:z.string().optional(),name:z.string().trim().min(1).max(200).optional(),source:z.string().trim().max(120).optional(),notes:z.string().max(5000).optional(),reviewAt:z.string().datetime({offset:true}).nullable().optional(),scheduledAt:z.string().datetime({offset:true}).optional(),confirmResolved:z.boolean().optional(),changes:editFields.optional(),edits:z.record(z.string(),editFields).optional()});

export function pageRows(store) {
  const state=store.state, meta=state.settings.meta;
  const localById=new Map(state.socialPages.filter(p=>p.externalId).map(p=>[String(p.externalId),p]));
  const metaIds=new Set(meta.pages.map(p=>String(p.id)));
  const tokens=new Map(meta.tokens.map(t=>[t.id,{...t,fingerprint:t.token?fingerprint(t.token):''}]));
  const queued=new Map(),published=new Map(),memberships=new Map();
  for(const p of state.socialPosts){const entry=queued.get(p.pageId)||{count:0,publishing:0};if(!p.deletedAt && !p.archivedAt && p.status!=='published')entry.count++;if(p.automationStatus==='publishing')entry.publishing++;queued.set(p.pageId,entry);}
  for(const p of meta.publications)published.set(String(p.pageId),(published.get(String(p.pageId))||0)+1);
  for(const g of meta.pageGroups)for(const id of g.pageIds){const entries=memberships.get(String(id))||[];entries.push(g.id);memberships.set(String(id),entries);}
  const sources=[...meta.pages.map(p=>({meta:p,local:localById.get(String(p.id))})),...state.socialPages.filter(p=>!p.externalId || !metaIds.has(String(p.externalId))).map(local=>({local}))];
  return sources.map(({meta:page,local})=>{
    const owner=page || local, management=owner.management || local?.management || {};
    const id=String(page?.id || local?.externalId || `local:${local.id}`);
    const bindings=Object.entries(page?.tokenBindings || {});
    const usable=bindings.filter(([id,b])=>{const t=tokens.get(id);return t?.status==='ACTIVE' && t.token && b.pageToken && b.status==='VERIFIED' && (!b.credentialFingerprint || b.credentialFingerprint===t.fingerprint);});
    const counts=queued.get(local?.id)||{count:0,publishing:0};
    const row={id,localId:local?.id || '',externalId:page?.id || local?.externalId || '',name:page?.name || local?.name || id,url:page?.id || local?.externalId ? `https://www.facebook.com/${page?.id || local.externalId}` : '',revision:Number(management.revision || 0),lifecycle:management.status || (local?.archived?'archived':page?.publishingHealth?.blocked?'review':'active'),source:management.source || (bindings.length?'Token':'Thủ công'),sourceKind:management.sourceKind || (bindings.length?'token':'manual'),tokenIds:bindings.map(([id])=>id),hasUsableToken:usable.length>0 || Boolean(page?.accessToken && !bindings.length),groupIds:memberships.get(id)||[],notes:management.notes ?? local?.notes ?? '',reviewAt:management.reviewAt || null,lastCheckedAt:owner.verification?.checkedAt || owner.publishingCheckedAt || null,verification:owner.verification || null,publishingHealth:page?.publishingHealth || null,isPublished:page?.isPublished,previousGroupIds:management.previousGroupIds || [],history:management.history || [],pendingCount:counts.count,publishingCount:counts.publishing,publishedCount:published.get(id)||0};
    row.health=pageHealth(row);
    row.error=page?.publishingHealth?.blocked ? page.publishingHealth.message : owner.verification?.message || '';
    return row;
  });
}

export function postRows(store) {
  const s=store.state, meta=s.settings.meta;
  const enrich=(p,isPublication=false)=>{
    const local=isPublication?s.socialPages.find(l=>String(l.externalId)===String(p.pageId)):s.socialPages.find(l=>l.id===p.pageId);
    const externalId=isPublication?String(p.pageId):local?.externalId || '';
    const row={...p,id:isPublication?`pub:${p.idempotencyKey || p.externalPostId}`:p.id,isPublication,revision:isPublication?Number(p.managementRevision || 0):Number(p.revision || 1),externalPageId:externalId,pageName:local?.name || p.pageName || '',groupIds:p.pageGroupId?[p.pageGroupId]:meta.pageGroups.filter(g=>g.pageIds.includes(externalId)).map(g=>g.id),projectName:s.projects.find(v=>v.id===p.projectId)?.name || '',date:p.publishedAt || p.scheduledAt || p.updatedAt || p.createdAt,error:p.automationError || p.firstCommentError || p.warehouse?.error || '',errorKind:p.automationErrorDetails?.kind || p.firstCommentErrorDetails?.kind || p.warehouse?.errorDetails?.kind || '',attempts:Number(p.automationAttempts || 0)};
    row.stage=postStage(row);return row;
  };
  return [...s.socialPosts.map(p=>enrich(p)),...meta.publications.filter(p=>!s.socialPosts.some(s=>s.id===p.postId)).map(p=>enrich(p,true))];
}

export function mountManagementRoutes(app,store,{client,postPreflight}) {
  const meta=store.state.settings.meta;
  let migrated=false;
  for(const post of store.state.socialPosts){
    if(post.automationRetryBlocked && post.automationStatus==='meta_error' && post.automationError && !post.warehouse && !post.archivedAt && !post.deletedAt && !publishedVideo(store,post)){
      returnPostToWarehouse(store,post,{automatic:true});migrated=true;
    }
  }
  if(migrated)store.save();
  meta.managementChecks ||= [];
  for(const job of meta.managementChecks)if(['queued','running'].includes(job.status)){job.status='interrupted';job.message='Ứng dụng đã đóng. Chọn các Page chưa kiểm tra để tiếp tục.';}
  const discoveries=new Map();let pending=null,closed=false,controller=null;
  const groups=()=>meta.pageGroups.map(g=>({id:g.id,name:g.name,pageIds:g.pageIds,purpose:purpose(g),autoPublish:g.scheduleConfig?.autoPublish===true}));
  const ownerFor=row=>meta.pages.find(p=>String(p.id)===row.id) || store.state.socialPages.find(p=>p.id===row.localId);
  const touch=(row,action,fields={})=>{
    const owner=ownerFor(row);owner.management ||= {};
    Object.assign(owner.management,fields,{revision:row.revision+1,updatedAt:now()});
    owner.management.history=[...(owner.management.history || []),{at:now(),action,groupId:fields.groupId || '',note:fields.notes || ''}].slice(-30);
    const local=store.state.socialPages.find(p=>p.id===row.localId);
    if(local){local.revision=Number(local.revision || 1)+1;local.updatedAt=now();if(fields.status)local.archived=['archived','deleted'].includes(fields.status);}
  };
  const halt=(row,groupId='',onlyGroup=null)=>{
    if(!row.localId)return;
    for(const p of store.state.socialPosts.filter(p=>p.pageId===row.localId && (!onlyGroup || p.pageGroupId===onlyGroup))){
      p.status='draft';p.automationHold=true;p.scheduledAt=null;p.automationNextAttemptAt=null;p.pageGroupId=groupId;p.revision=Number(p.revision||1)+1;p.updatedAt=now();
    }
  };
  const reviewGroup=()=>{
    let g=meta.pageGroups.find(g=>purpose(g)==='review');
    if(!g){g={id:`pgrp_hold_${randomUUID().slice(0,8)}`,name:'Page chờ xử lý',pageIds:[],purpose:'review',createdAt:now(),scheduleConfig:{enabled:false,autoPublish:false,times:[],timezone:'Asia/Bangkok',staggerMinutes:5,dailyLimit:0}};meta.pageGroups.push(g);}
    g.purpose='review';g.scheduleConfig={...g.scheduleConfig,enabled:false,autoPublish:false};return g;
  };
  const refreshMembership=()=>{for(const p of meta.pages)p.groupIds=meta.pageGroups.filter(g=>g.pageIds.includes(p.id)).map(g=>g.id);};
  const error=(message,code='MANAGEMENT_INVALID')=>new StudioError(message,code,409);
  const checkRevision=(row,item)=>{if(!row)throw error('Mục đã bị xóa hoặc không tồn tại.');if(row.revision!==item.revision)throw error('Dữ liệu đã thay đổi. Làm mới rồi chọn lại.','STALE_REVISION');};

  app.get('/api/management/pages',(req,res)=>res.json({rows:pageRows(store),groups:groups(),tokens:meta.tokens.map(t=>({id:t.id,name:t.name,status:t.status})),checks:meta.managementChecks.slice(-5)}));
  app.get('/api/management/posts',(req,res)=>res.json({rows:postRows(store),groups:groups(),pages:pageRows(store).filter(p=>p.lifecycle==='active' && p.hasUsableToken && !['restricted','identity','unpublished'].includes(p.health)),projects:store.state.projects.map(p=>({id:p.id,name:p.name}))}));

  const pageBulk=(input,apply)=>{
    const valid=new Set(['review','move_group','add_group','remove_group','archive','delete','restore','return_group','notes']);
    if(!valid.has(input.action))throw error('Thao tác Page không hợp lệ.');
    const rows=new Map(pageRows(store).map(r=>[r.id,r])),seen=new Set(),results=[];
    for(const item of input.items){
      if(seen.has(item.id))continue;seen.add(item.id);
      try{
        const row=rows.get(item.id);checkRevision(row,item);
        if(row.publishingCount)throw error('Page có bài đang đăng; chờ tác vụ kết thúc.');
        if(row.lifecycle==='deleted' && input.action!=='restore')throw error('Khôi phục Page từ thùng rác trước.');
        const target=input.groupId?meta.pageGroups.find(g=>g.id===input.groupId):null;
        if(['move_group','add_group','remove_group'].includes(input.action) && !target)throw error('Chọn nhóm cần thao tác.');
        if(['move_group','add_group'].includes(input.action) && purpose(target)!=='review' && (row.lifecycle!=='active' || ['identity','restricted','unpublished','token'].includes(row.health)))throw error('Page chưa sẵn sàng. Chuyển sang nhóm chờ xử lý hoặc kiểm tra lại trước.');
        const destinations=input.action==='return_group'?(target?[target]:meta.pageGroups.filter(g=>row.previousGroupIds.includes(g.id) && purpose(g)!=='review')):[];
        if(input.action==='return_group'){
          if(!row.hasUsableToken || row.isPublished===false || !(row.verification?.status==='passed' || row.publishingHealth?.lastSucceededAt))throw error('Kiểm tra lại Page thành công trước khi đưa về nhóm đăng.');
          if(row.publishingHealth?.blocked && !input.confirmResolved)throw error('Xác nhận đã xử lý hạn chế trên Facebook trước khi bỏ trạng thái chặn.');
          if(!destinations.length || destinations.some(g=>purpose(g)==='review'))throw error('Chọn nhóm đăng để đưa Page trở lại.');
        }
        if(apply){
          const fields={};const owner=ownerFor(row);
          if(['review','archive','delete'].includes(input.action)){
            fields.previousGroupIds=[...new Set([...row.previousGroupIds,...row.groupIds.filter(id=>purpose(meta.pageGroups.find(g=>g.id===id))!=='review')])];
            for(const g of meta.pageGroups)g.pageIds=g.pageIds.filter(id=>id!==row.id);
            fields.status=input.action==='review'?'review':input.action==='archive'?'archived':'deleted';
            const g=input.action==='review'?reviewGroup():null;if(g)g.pageIds.push(row.id);halt(row,g?.id || '');
          }else if(['move_group','add_group','remove_group'].includes(input.action)){
            if(input.action==='move_group')for(const g of meta.pageGroups)g.pageIds=g.pageIds.filter(id=>id!==row.id);
            if(input.action==='remove_group')target.pageIds=target.pageIds.filter(id=>id!==row.id);else target.pageIds=[...new Set([...target.pageIds,row.id])];
            fields.groupId=target.id;
            if(purpose(target)==='review' && input.action!=='remove_group'){fields.status='review';fields.previousGroupIds=[...new Set([...row.previousGroupIds,...row.groupIds.filter(id=>id!==target.id)])];}
            if(input.action==='remove_group')halt(row,'',target.id);
            else if(input.action==='move_group' || purpose(target)==='review')halt(row,target.id);
          }else if(input.action==='restore') {fields.status='review';const g=reviewGroup();g.pageIds=[...new Set([...g.pageIds,row.id])];halt(row,g.id);}
          else if(input.action==='return_group'){
            for(const g of meta.pageGroups)g.pageIds=g.pageIds.filter(id=>id!==row.id);
            for(const g of destinations)g.pageIds=[...new Set([...g.pageIds,row.id])];
            fields.status='active';fields.reviewAt=null;
            if(owner.publishingHealth)owner.publishingHealth={...owner.publishingHealth,blocked:false,resumedAt:now(),confirmedResolved:input.confirmResolved===true};
            halt(row,destinations[0].id);
          }
          if(input.notes!==undefined)fields.notes=input.notes;
          if(input.reviewAt!==undefined)fields.reviewAt=input.reviewAt;
          if(input.action==='notes' && input.items.length===1){
            if(input.name){owner.name=input.name;const local=store.state.socialPages.find(p=>p.id===row.localId);if(local)local.name=input.name;}
            if(input.source!==undefined)fields.source=input.source;
          }
          touch(row,input.action,fields);
        }
        results.push({id:row.id,name:row.name,ok:true});
      }catch(e){results.push({id:item.id,name:rows.get(item.id)?.name || item.id,ok:false,error:e.message});}
    }
    if(apply){refreshMembership();store.save();}
    return {results,changed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length,preview:!apply};
  };
  app.post('/api/management/pages/bulk/preview',(req,res)=>res.json(pageBulk(bulkSchema.parse(req.body),false)));
  app.post('/api/management/pages/bulk',(req,res)=>res.json(pageBulk(bulkSchema.parse(req.body),true)));

  app.post('/api/management/pages/discover',async(req,res)=>{
    const entry=meta.tokens.find(t=>t.id===req.body?.tokenId);
    if(!entry?.token)throw error('Chọn token đã lưu trong app.');
    const response=await client.pages(entry.token);
    const pages=(response?.data || []).filter(p=>/^\d{1,40}$/.test(String(p.id)) && p.access_token);
    const id=randomUUID();
    for(const [key,value]of discoveries)if(Date.now()-value.at>15*60_000)discoveries.delete(key);
    if(discoveries.size>=10)discoveries.delete(discoveries.keys().next().value);
    discoveries.set(id,{at:Date.now(),tokenId:entry.id,fingerprint:fingerprint(entry.token),pages});
    res.json({discoveryId:id,pages:pages.map(p=>({id:String(p.id),name:p.name || String(p.id),exists:meta.pages.some(m=>m.id===String(p.id))}))});
  });
  app.post('/api/management/pages/import',(req,res)=>{
    const input=z.object({text:z.string().max(2_000_000).optional(),source:z.string().max(120).default('Nhập danh sách'),discoveryId:z.string().optional(),pageIds:z.array(z.string()).max(5000).optional(),preview:z.boolean().default(false)}).parse(req.body);
    let parsed,entry=null,discovery=null;
    if(input.discoveryId){
      discovery=discoveries.get(input.discoveryId);entry=meta.tokens.find(t=>t.id===discovery?.tokenId);
      if(!discovery || Date.now()-discovery.at>15*60_000 || !entry?.token || fingerprint(entry.token)!==discovery.fingerprint)throw error('Danh sách token đã hết hạn hoặc token đã đổi. Tải lại danh sách.');
      const allowed=new Set(input.pageIds || []);
      if([...allowed].some(id=>!discovery.pages.some(p=>String(p.id)===id)))throw error('Danh sách có Page không thuộc token đã chọn.');
      parsed={rows:discovery.pages.filter(p=>allowed.has(String(p.id))).map(p=>({id:String(p.id),name:p.name || String(p.id)})),errors:[],duplicates:0};
    }else parsed=parsePageImport(input.text);
    const result={...parsed,added:0,updated:0,keptDeleted:0};
    if(input.preview){res.json(result);return;}
    for(const row of parsed.rows){
      let page=meta.pages.find(p=>String(p.id)===row.id);
      if(!page){page={id:row.id,name:row.name,tokenBindings:{},groupIds:[],tasks:[]};meta.pages.push(page);result.added++;}else result.updated++;
      page.management ||= {};page.management.revision=Number(page.management.revision||0)+1;
      if(page.management.status==='deleted')result.keptDeleted++;
      page.management.source=row.source || input.source || (entry?'Token':'Nhập danh sách');page.management.sourceKind=entry?'token':'import';
      page.name=row.name;
      const local=store.state.socialPages.find(p=>String(p.externalId)===row.id);if(local){local.name=row.name;local.revision=Number(local.revision||1)+1;}
      if(entry){const source=discovery.pages.find(p=>String(p.id)===row.id);page.tokenBindings ||= {};page.tokenBindings[entry.id]={tokenId:entry.id,pageToken:source.access_token,status:'VERIFIED',credentialFingerprint:fingerprint(entry.token),verifiedAt:now(),tasks:source.tasks || []};page.accessToken=source.access_token;}
    }
    store.save();res.json(result);
  });

  app.post('/api/management/pages/check',(req,res)=>{
    if(pending)throw error('Một đợt kiểm tra đang chạy. Chờ hoàn tất hoặc bấm Dừng.');
    const ids=[...new Set(z.array(z.string()).min(1).max(5000).parse(req.body?.ids))];
    const checkRows=new Map(pageRows(store).filter(p=>p.lifecycle!=='deleted').map(p=>[p.id,p]));
    const available=new Set(checkRows.keys());
    if(ids.some(id=>!available.has(id)))throw error('Danh sách kiểm tra có Page đã bị xóa.');
    const job={id:randomUUID(),status:'running',total:ids.length,done:0,passed:0,failed:0,startedAt:now(),results:[]};
    meta.managementChecks.push(job);meta.managementChecks=meta.managementChecks.slice(-10);controller=new AbortController();store.save();
    const run=async()=>{
      for(const id of ids){
        if(closed || job.status==='cancelled')break;
        const row=checkRows.get(id);if(!row)continue;
        const owner=ownerFor(row),page=meta.pages.find(p=>String(p.id)===id);
        if(!owner || owner.management?.status==='deleted'){job.done++;job.results.push({id,name:row.name,status:'skipped',message:'Page đã bị xóa khỏi danh sách trong lúc kiểm tra.'});store.save();continue;}
        let credential='';
        try{
          const pool=meta.tokenGroups.find(g=>g.pageTokenBindings?.[id]);
          const preferred=pool?.pageTokenBindings?.[id];
          const binding=Object.entries(page?.tokenBindings || {}).filter(([key,b])=>meta.tokens.some(t=>t.id===key && t.status==='ACTIVE' && t.token && (!b.credentialFingerprint || b.credentialFingerprint===fingerprint(t.token))) && b.pageToken).sort(([a],[b])=>(b===preferred)-(a===preferred))[0];
          credential=binding?.[1].pageToken || page?.accessToken || '';
          if(!credential)throw error('Page chưa có token. Nhập từ token hoặc đồng bộ token có quyền Page.');
          const result=await client.pageStatus({token:credential,pageId:id,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)])});
          if(String(result.id)!==id)throw error('Token không trả về đúng Page đã chọn.');
          if(closed || job.status==='cancelled')break;
          if(owner.management?.status==='deleted'){job.done++;job.results.push({id,name:row.name,status:'skipped',message:'Page đã bị xóa trong lúc kiểm tra.'});store.save();continue;}
          page.isPublished=result.is_published;
          owner.verification={checkedAt:now(),status:result.is_published===true?'passed':'unpublished',message:result.is_published===true?'Đọc được Page công khai. Hạn chế đăng đã ghi nhận chỉ được bỏ khi bạn xác nhận đã xử lý.':'Page chưa công khai trên Facebook.',readOnly:true};
          if(result.is_published===true)job.passed++;else job.failed++;
        }catch(e){
          if(closed || job.status==='cancelled')break;
          const details=classifyMetaFailure(e);
          owner.verification={checkedAt:now(),status:'error',message:String(e.message).replaceAll(credential || '\0','[đã ẩn]'),details,readOnly:true};job.failed++;
          if(details.kind==='security_restriction' && page)page.publishingHealth={blocked:true,message:owner.verification.message,details,failedAt:now()};
          if(details.kind==='rate_limit'){job.status='paused';job.message='Meta giới hạn lượt kiểm tra. Đã dừng; các Page còn lại chưa được gọi.';}
        }
        owner.management ||= {};owner.management.revision=Number(owner.management.revision||0)+1;
        job.done++;job.results.push({id,name:row.name,...owner.verification});store.save();
        if(job.status==='paused')break;
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      if(job.status==='running')job.status=closed?'interrupted':'completed';job.finishedAt=now();store.save();
    };
    pending=run().catch(e=>{job.status='failed';job.message=e.message;store.save();}).finally(()=>{pending=null;controller=null;});
    res.status(202).json({job});
  });
  app.post('/api/management/pages/check/:id/cancel',(req,res)=>{const job=meta.managementChecks.find(j=>j.id===req.params.id);if(job?.status==='running'){job.status='cancelled';controller?.abort();store.save();}res.json({job});});

  const postBulk=(input,apply)=>{
    if(!['edit','return_warehouse','pause','assign','retry','schedule','archive','delete','restore'].includes(input.action))throw error('Thao tác bài không hợp lệ.');
    const rows=new Map(postRows(store).map(p=>[p.id,p])),pages=pageRows(store),results=[],seen=new Set();
    const targetGroup=input.groupId?meta.pageGroups.find(g=>g.id===input.groupId):null;
    const targets=pages.filter(p=>p.lifecycle==='active' && p.hasUsableToken && !['identity','restricted','unpublished','token'].includes(p.health) && (input.pageId?p.id===input.pageId:targetGroup && purpose(targetGroup)!=='review' && targetGroup.pageIds.includes(p.id)));
    for(const item of input.items){
      if(seen.has(item.id))continue;seen.add(item.id);
      try{
        const row=rows.get(item.id);checkRevision(row,item);
        if(row.stage==='publishing')throw error('Bài đang đăng; chờ tác vụ kết thúc.');
        if(['edit','return_warehouse','pause','assign','retry','schedule'].includes(input.action) && (row.isPublication || row.stage==='published' || row.deletedAt || row.archivedAt))throw error('Thao tác này chỉ dùng cho bài đang trong hàng đợi.');
        const post=row.isPublication?meta.publications.find(p=>`pub:${p.idempotencyKey || p.externalPostId}`===row.id):store.state.socialPosts.find(p=>p.id===row.id);
        const changes={};
        if(input.action==='edit'){
          const edited={...input.changes,...input.edits?.[row.id]};
          const different=Object.fromEntries(Object.entries(edited).filter(([key,value])=>value!==(post[key] || '')));
          if(!Object.keys(different).length)throw error('Chưa có nội dung thay đổi.');
          if(publishedVideo(store,post) && Object.keys(different).some(key=>!['firstComment','notes'].includes(key)))throw error('Video đã đăng; chỉ có thể sửa bình luận chưa gửi và ghi chú.');
          Object.assign(changes,different,{status:'draft',automationHold:true,scheduledAt:null,automationNextAttemptAt:null,exportRevision:null,exportedAt:null});
          if(post.website?.status==='published' && ['title','articleBody'].some(key=>key in different))changes.website={...post.website,contentChanged:true};
          validatePostPayload(store,{...post,...changes},{existing:post});
        }else if(input.action==='return_warehouse'){
          if(publishedVideo(store,post))throw error('Video đã đăng; chỉ tiếp tục bình luận, không trả về kho.');
          if(apply)returnPostToWarehouse(store,post);
        }else if(input.action==='assign'){
          if(publishedVideo(store,post))throw error('Video đã đăng; chỉ thử lại bình luận, không chuyển Page.');
          if(!targets.length)throw error('Chọn Page hoặc nhóm có Page sẵn sàng.');
          const target=targets[(seen.size-1)%targets.length];
          let local=store.state.socialPages.find(p=>p.externalId===target.id);
          if(apply && !local){syncMetaPages(store,[target.id]);local=store.state.socialPages.find(p=>p.externalId===target.id);}
          Object.assign(changes,{pageId:local?.id || '',pageGroupId:targetGroup?.id || '',warehouse:null,status:'draft',automationHold:true,scheduledAt:null,automationStatus:null,automationError:null,automationErrorDetails:null,automationRetryBlocked:false,automationNextAttemptAt:null,automationAttempts:0,lastDeliveryError:post.automationError || post.warehouse?.error || post.lastDeliveryError || null});
        }else if(['retry','schedule'].includes(input.action)){
          const local=store.state.socialPages.find(p=>p.id===post.pageId),page=meta.pages.find(p=>p.id===local?.externalId);
          if(managedPageUnavailable(page,local))throw error('Page đang chờ xử lý hoặc bị hạn chế. Chọn Page khác hoặc xử lý Page trước.');
          const check=postPreflight(store,{...post,status:'ready'},meta);if(!check.ready)throw error(check.checks.filter(c=>!c.ok).map(c=>c.message).join(' '));
          const time=input.action==='retry'?Date.now()+5000:Date.parse(input.scheduledAt);
          if(!Number.isFinite(time) || time<=Date.now())throw error('Chọn thời gian đăng trong tương lai.');
          Object.assign(changes,{warehouse:null,automationHold:false,status:'scheduled',scheduledAt:new Date(time+(seen.size-1)*60_000).toISOString(),automationStatus:null,automationError:null,automationErrorDetails:null,automationRetryBlocked:false,automationBlockedReason:null,automationNextAttemptAt:null,automationAttempts:0});
        }else if(input.action==='pause')Object.assign(changes,{status:'draft',automationHold:true,scheduledAt:null,automationNextAttemptAt:null});
        else if(input.action==='archive')Object.assign(changes,{archivedAt:now(),...(!row.isPublication?{status:'draft',scheduledAt:null,automationNextAttemptAt:null}:{})});
        else if(input.action==='delete')Object.assign(changes,{deletedAt:now(),...(!row.isPublication?{status:'draft',scheduledAt:null,automationNextAttemptAt:null}:{})});
        else if(input.action==='restore')Object.assign(changes,{archivedAt:null,deletedAt:null,...(!row.isPublication?{status:'draft',automationHold:true,scheduledAt:null}:{})});
        if(apply)Object.assign(post,changes,{[row.isPublication?'managementRevision':'revision']:row.revision+1,updatedAt:now()});
        results.push({id:row.id,name:row.title,ok:true});
      }catch(e){results.push({id:item.id,name:rows.get(item.id)?.title || item.id,ok:false,error:e.message});}
    }
    if(apply)store.save();return {results,changed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length,preview:!apply};
  };
  app.post('/api/management/posts/bulk/preview',(req,res)=>res.json(postBulk(bulkSchema.parse(req.body),false)));
  app.post('/api/management/posts/bulk',(req,res)=>res.json(postBulk(bulkSchema.parse(req.body),true)));
  return {close:async()=>{closed=true;controller?.abort();await pending;}};
}
