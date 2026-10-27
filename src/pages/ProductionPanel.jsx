import { useState } from "react";
import { ArrowRight, RefreshCw, Sparkles, Video } from "lucide-react";
import { api } from "../api.js";
import { Button, Field, Notice } from "../components.jsx";

export function ProductionPanel({data,project,mode,notify,navigate}) {
  const [topic,setTopic]=useState("");
  const [sourceUrl,setSourceUrl]=useState("");
  const [productName,setProductName]=useState("");
  const [productBrief,setProductBrief]=useState("");
  const [productUrl,setProductUrl]=useState("");
  const [autoResearch,setAutoResearch]=useState(true);
  const [count,setCount]=useState(1);
  const [engine,setEngine]=useState("dreamface");
  const [accountId,setAccountId]=useState("auto");
  const [references,setReferences]=useState([]);
  const [feeds,setFeeds]=useState("");
  const [fontStyle,setFontStyle]=useState("news");
  const [busy,setBusy]=useState(false);
  const [requestId,setRequestId]=useState(()=>crypto.randomUUID());
  const accounts=(data.accounts || []).filter(account=>account.provider==="dreamface");
  const newsMediaIds=new Set((data.researchResults || []).filter(result=>result.projectId===project.id).flatMap(result=>result.imageMediaIds || []));
  const newsMcIds=new Set((data.accounts || []).filter(account=>account.provider==="dreamface" && account.avatarMediaId).map(account=>account.avatarMediaId));
  const images=(data.media || []).filter(media=>media.kind==="image" && media.projectId===project.id).filter(media=>{
    const type=String(media.mediaType || "").toLowerCase();
    const name=String(media.name || "");
    const editorial=Boolean(media.sourceUrl || media.attribution || media.license);
    return !newsMediaIds.has(media.id) && !newsMcIds.has(media.id) && !["news-editorial","news-mc","news-video"].includes(type) && media.production?.contentType !== "news" && !(media.generated && /news|broadcast|mc host/i.test(name)) && !(editorial && type !== "product");
  });
  const batches=(data.productionBatches || []).filter(batch=>batch.projectId===project.id && batch.request.contentType===mode).slice().reverse().slice(0,6);
  const start=async event=>{
    event.preventDefault(); if(busy)return; setBusy(true);
    try {
      const batch = await api("/production/batches",{requestId,projectId:project.id,contentType:mode,autoResearch:mode==="news" || autoResearch,topic,productName,productBrief,productUrl,sourceUrl:mode==="news"?sourceUrl:"",count:Number(count),engine:mode==="product"?"dreamface":engine,accountId,references:mode==="product"?references:[],feeds:feeds.split(/\r?\n/).map(value=>value.trim()).filter(Boolean),variationPolicy:"visual-unique",fontStyle:mode==="news"?fontStyle:"news"});
      setRequestId(crypto.randomUUID());
      notify(`${batch.items?.length || count} video${Number(count)===1?"":"s"} đang được chuẩn bị. Nếu LLM hoặc ảnh lỗi, lỗi sẽ hiện ngay trong batch để Retry.`);
      navigate?.("editor");
    } catch(error){notify(error.message,"error");} finally{setBusy(false);}
  };
  const retry=async batch=>{try{await api(`/production/batches/${batch.id}/retry`,{});notify("Đã chạy lại bước chuẩn bị News.");}catch(error){notify(error.message,"error");}};
  return <section className="production-panel workspace-hub">
    <div className="hub-panel-heading"><div><span className="hub-kicker">BATCH PRODUCTION · ENGLISH (US)</span><h2>{mode==="news"?"Turn a niche into news videos":"Turn products into video variations"}</h2><p className="muted small">{mode==="news"?"Research today's reports → create videos → write complete articles in Content.":"Research a product niche or add your own product → create videos → write store-link comments in Content."}</p></div></div>
    <form onSubmit={start}>
      {mode==="product" && <div className="content-filter-tabs production-source-tabs"><button type="button" className={autoResearch?"active":""} onClick={()=>setAutoResearch(true)}>Auto research</button><button type="button" className={!autoResearch?"active":""} onClick={()=>setAutoResearch(false)}>My product</button></div>}
      <div className="production-inputs">
        {mode==="news" || autoResearch ? <Field label={mode==="news"?"News niche":"Product niche"}><input required={mode!=="news" || !sourceUrl} minLength={mode==="news" && sourceUrl ? undefined : 2} maxLength={200} value={topic} onChange={event=>setTopic(event.target.value)} placeholder={mode==="news"?"US technology, space, business…":"Kitchen gadgets, pet accessories…"}/></Field> : <Field label="Product name"><input required maxLength={200} value={productName} onChange={event=>setProductName(event.target.value)} placeholder="Portable blender"/></Field>}
        <Field label="Number of videos"><input type="number" min="1" max="50" required value={count} onChange={event=>setCount(event.target.value)}/></Field>
        {mode==="news" && <Field label="Font / style"><select value={fontStyle} onChange={event=>setFontStyle(event.target.value)}><option value="news">News chuẩn · Barlow Condensed</option><option value="viral">Viral mạnh · Anton + Barlow</option><option value="minimal">Viral sạch · Be Vietnam Pro</option></select></Field>}
      </div>
      {mode==="news" && <Field label="Link bài news (tuỳ chọn)" hint="Dán link bài viết để dùng đúng bài đó; bỏ trống để tự research theo từ khóa."><input type="url" value={sourceUrl} onChange={event=>setSourceUrl(event.target.value)} placeholder="https://news.example.com/article" /></Field>}
      {mode==="product" && <><div className="form-grid"><Field label="Product facts / creative brief"><textarea value={productBrief} maxLength={4000} onChange={event=>setProductBrief(event.target.value)} placeholder="Verified features and the style you want. No invented offers." rows={3}/></Field><Field label="Product or store link" hint="Leave blank to use the store link from Settings."><input type="url" value={productUrl} onChange={event=>setProductUrl(event.target.value)} placeholder={data.settings?.content?.storeUrl || "https://your-store.com/products/…"}/></Field></div>{images.length>0 && <Field label="Product reference images" hint="Choose up to 10 images from this project's Library. News/editorial images are hidden."><div className="production-images">{images.map(media=><label key={media.id}><input type="checkbox" checked={references.includes(media.id)} disabled={!references.includes(media.id)&&references.length>=10} onChange={()=>setReferences(current=>current.includes(media.id)?current.filter(id=>id!==media.id):[...current,media.id])}/><img src={media.thumbnailUrl||media.url} alt=""/><span>{media.name}</span></label>)}</div></Field>}</>}
      <details className="production-options"><summary>Sources, profile &amp; render rules</summary><div className="form-grid"><Field label="RSS sources (optional)"><textarea rows={2} value={feeds} onChange={event=>setFeeds(event.target.value)} placeholder="One RSS URL per line. Blank: search current US English news."/></Field><Field label="DreamFace profile"><select value={accountId} onChange={event=>setAccountId(event.target.value)}><option value="auto">Auto · daily rotation</option>{accounts.map(account=><option key={account.id} value={account.id}>{account.name} · {account.status}</option>)}</select></Field></div><div className="production-render-rules"><strong>0.5.6 render rules</strong><span>One selected profile keeps the same MC across the batch.</span><span>Auto rotates healthy profiles when no MC is pinned.</span><span>Each item gets a different image order, camera motion and visual opening while facts stay the same.</span><span>Every completed video creates its own Content draft for Page distribution.</span></div></details>
      {!data.settings?.llm?.enabled && <Notice>Configure and enable your LLM in Settings to start automatic production.</Notice>}
      {(mode==="product" || engine==="dreamface") && !accounts.some(account=>account.status==="ready") && <p className="small muted">DreamFace MC videos wait in Queue until a verified profile is ready. <button type="button" className="inline-link" onClick={()=>navigate?.("accounts")}>Open accounts</button></p>}
      <div className="production-actions"><span className="small muted">Each video keeps its own source and Content draft.</span><Button type="submit" variant="primary" busy={busy} disabled={!data.settings?.llm?.enabled}><Sparkles size={16}/> Create {count || 1} video{Number(count)===1?"":"s"}</Button></div>
    </form>
    {batches.length>0 && <div className="production-batches">{batches.map(batch=>{
      const jobs=batch.items.map(item=>(data.jobs || []).findLast(job=>job.production?.batchId===batch.id && job.production?.itemIndex===item.index) || (data.jobs || []).find(job=>job.id===item.jobId));
      const complete=jobs.filter(job=>job?.status==="completed").length;
      const active=jobs.find(job=>["queued","submitting","rendering","downloading"].includes(job?.status));
      const failed=batch.items.filter(item=>["failed","interrupted"].includes(item.status)).length;
      const statusLabel={pending:"waiting",preparing:"preparing",queued:"queued",partial:"partly queued",failed:"failed",completed:"completed"}[batch.status] || batch.status;
      return <article className="production-batch" key={batch.id}><div><strong><Video size={15}/> {batch.request.topic || batch.request.sourceUrl || batch.request.productName || "Direct news article"}</strong><p>{complete}/{batch.request.count} completed · {batch.items.filter(item=>item.jobId).length} queued · {statusLabel}{active ? ` · ${active.status} ${Math.round(active.progress || 0)}%` : ""}</p>{batch.warnings?.map(warning=><small key={warning}>{warning}</small>)}{batch.error && <small className="danger-text">Batch: {batch.error}</small>}{batch.items.filter(item=>item.error).map(item=><small className="danger-text" key={item.index}>Video {item.index+1}: {item.error}</small>)}{batch.items.filter(item=>!item.error && ["preparing","queued"].includes(item.status)).map(item=><small key={item.index}>Video {item.index+1}: {item.status === "preparing" ? "đang chuẩn bị" : "đã đưa vào Queue"}</small>)}</div><div className="inline-actions">{failed>0 && <Button onClick={()=>retry(batch)}><RefreshCw size={14}/> Retry preparation</Button>}<Button onClick={()=>navigate?.(complete?"content":"queue")}>{complete?"Open Content":"Open Queue"}<ArrowRight size={14}/></Button></div></article>;
    })}</div>}
  </section>;
}
