import { useMemo, useState } from "react";
import { ArrowRight, RefreshCw, Sparkles, Video } from "lucide-react";
import { api } from "../api.js";
import { Badge, Button, Field, Notice } from "../components.jsx";

const statusLabels = {
  pending: "đang chuẩn bị",
  preparing: "đang chuẩn bị nguồn và hình",
  queued: "đã vào Queue",
  partial: "một phần đã vào Queue",
  failed: "có lỗi",
  interrupted: "bị gián đoạn",
  completed: "đã hoàn tất",
};

function batchTitle(batch, research) {
  const request = batch.request || {};
  return research?.headline || batch.sources?.[0]?.title || request.topic || request.sourceUrl || request.productName || "Video trực tiếp";
}

export function ProductionPanel({ data, project, mode, notify, navigate, focusBatchIds = [], focusResearchId = "" }) {
  const [topic, setTopic] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [productName, setProductName] = useState("");
  const [productBrief, setProductBrief] = useState("");
  const [productUrl, setProductUrl] = useState("");
  const [autoResearch, setAutoResearch] = useState(true);
  const [count, setCount] = useState(1);
  const [engine, setEngine] = useState("dreamface");
  const [accountId, setAccountId] = useState("auto");
  const [references, setReferences] = useState([]);
  const [feeds, setFeeds] = useState("");
  const [fontStyle, setFontStyle] = useState("news");
  const [autoCreateContent, setAutoCreateContent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const accounts = (data.accounts || []).filter((account) => account.provider === "dreamface");
  const researchById = useMemo(() => new Map((data.researchResults || []).map((result) => [result.id, result])), [data.researchResults]);
  const newsMediaIds = new Set((data.researchResults || []).filter((result) => result.projectId === project.id).flatMap((result) => result.imageMediaIds || []));
  const newsMcIds = new Set((data.accounts || []).filter((account) => account.provider === "dreamface" && account.avatarMediaId).map((account) => account.avatarMediaId));
  const images = (data.media || []).filter((media) => media.kind === "image" && media.projectId === project.id).filter((media) => {
    const type = String(media.mediaType || "").toLowerCase();
    const name = String(media.name || "");
    const editorial = Boolean(media.sourceUrl || media.attribution || media.license);
    return !newsMediaIds.has(media.id) && !newsMcIds.has(media.id) && !["news-editorial", "news-mc", "news-video"].includes(type) && media.production?.contentType !== "news" && !(media.generated && /news|broadcast|mc host/i.test(name)) && !(editorial && type !== "product");
  });
  const allBatches = (data.productionBatches || []).filter((batch) => batch.projectId === project.id && batch.request?.contentType === mode).slice().reverse();
  const focusedSet = new Set((focusBatchIds || []).filter(Boolean));
  const focusedBatch = allBatches.find((batch) => focusedSet.has(batch.id) || (focusResearchId && batch.request?.researchId === focusResearchId));
  if (focusedBatch) focusedSet.add(focusedBatch.id);
  const batches = [...allBatches.filter((batch) => focusedSet.has(batch.id)), ...allBatches.filter((batch) => !focusedSet.has(batch.id))].slice(0, 6);
  const focusedResearch = focusedBatch?.request?.researchId ? researchById.get(focusedBatch.request.researchId) : focusResearchId ? researchById.get(focusResearchId) : null;

  const start = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const batch = await api("/production/batches", {
        requestId,
        projectId: project.id,
        contentType: mode,
        autoCreateContent,
        autoResearch: mode === "news" || autoResearch,
        topic,
        productName,
        productBrief,
        productUrl,
        sourceUrl: mode === "news" ? sourceUrl : "",
        count: Number(count),
        engine: mode === "product" ? "dreamface" : engine,
        accountId,
        references: mode === "product" ? references : [],
        feeds: feeds.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
        variationPolicy: "visual-unique",
        fontStyle: mode === "news" ? fontStyle : "news",
      });
      setRequestId(crypto.randomUUID());
      notify(`${batch.items?.length || count} video${Number(count) === 1 ? "" : "s"} đang được chuẩn bị. Nếu LLM hoặc ảnh lỗi, lỗi sẽ hiện ngay trong bản ghi để Retry.`);
      navigate?.("editor", { focusBatchId: batch.id, researchId: batch.request?.researchId || "" });
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const retry = async (batch) => {
    try {
      await api(`/production/batches/${batch.id}/retry`, {});
      notify("Đã chạy lại bước chuẩn bị video.");
    } catch (error) {
      notify(error.message, "error");
    }
  };

  return <section className="production-panel workspace-hub">
    <div className="hub-panel-heading">
      <div>
        <span className="hub-kicker">BATCH PRODUCTION · ENGLISH (US)</span>
        <h2>{mode === "news" ? "Turn a niche into news videos" : "Turn products into video variations"}</h2>
        <p className="muted small">{mode === "news" ? "Research today's reports → create videos → write complete articles in Content." : "Research a product niche or add your own product → create videos → write store-link comments in Content."}</p>
      </div>
    </div>

    {focusedBatch && <article className="production-focus-card" data-testid="render-record" data-production-batch-id={focusedBatch.id}>
      <div className="production-focus-heading">
        <div>
          <span className="hub-kicker">BẢN GHI RENDER ĐANG ĐƯỢC THEO DÕI</span>
          <h3>{batchTitle(focusedBatch, focusedResearch)}</h3>
        </div>
        <Badge status={focusedBatch.status} />
      </div>
      <p className="production-focus-copy">{focusedResearch ? `Đã khóa theo bản research “${focusedResearch.topic || focusedResearch.headline}”. Video sẽ dùng đúng nguồn trong bản ghi này, tự chọn ảnh editorial và tạo narration/MC. Content sẽ ${focusedBatch.request?.autoCreateContent ? "được tạo tự động sau khi render" : "chờ bạn bấm tạo trong Content"}.` : "Bản ghi này đã được tạo. Mở Queue để xem từng bước chuẩn bị, render DreamFace và kết quả cuối."}</p>
      <div className="production-focus-steps">
        <span><b>1</b> Research đã chọn</span>
        <span><b>2</b> Ảnh + narration</span>
        <span><b>3</b> MC DreamFace</span>
        <span><b>4</b> Content &amp; website</span>
      </div>
      <div className="production-focus-actions">
        <Button onClick={() => navigate?.("queue")}><Video size={14} /> Mở Queue để xem tiến độ</Button>
        {focusedBatch.status === "completed" && <Button variant="primary" onClick={() => navigate?.("content")}>Mở Content</Button>}
      </div>
    </article>}

    <form onSubmit={start}>
      {mode === "product" && <div className="content-filter-tabs production-source-tabs"><button type="button" className={autoResearch ? "active" : ""} onClick={() => setAutoResearch(true)}>Auto research</button><button type="button" className={!autoResearch ? "active" : ""} onClick={() => setAutoResearch(false)}>My product</button></div>}
      <div className="production-inputs">
        {mode === "news" || autoResearch ? <Field label={mode === "news" ? "News niche" : "Product niche"}><input required={mode !== "news" || !sourceUrl} minLength={mode === "news" && sourceUrl ? undefined : 2} maxLength={200} value={topic} onChange={(event) => setTopic(event.target.value)} placeholder={mode === "news" ? "US technology, space, business…" : "Kitchen gadgets, pet accessories…"} /></Field> : <Field label="Product name"><input required maxLength={200} value={productName} onChange={(event) => setProductName(event.target.value)} placeholder="Portable blender" /></Field>}
        <Field label="Number of videos"><input type="number" min="1" max="50" required value={count} onChange={(event) => setCount(event.target.value)} /></Field>
        {mode === "news" && <Field label="Font / style"><select value={fontStyle} onChange={(event) => setFontStyle(event.target.value)}><option value="news">News chuẩn · Barlow Condensed</option><option value="viral">Viral mạnh · Anton + Barlow</option><option value="minimal">Viral sạch · Be Vietnam Pro</option></select></Field>}
      </div>
      {mode === "news" && <Field label="Link bài news (tuỳ chọn)" hint="Dán link bài viết để dùng đúng bài đó; bỏ trống để tự research theo từ khóa."><input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://news.example.com/article" /></Field>}
      {mode === "product" && <><div className="form-grid"><Field label="Product facts / creative brief"><textarea value={productBrief} maxLength={4000} onChange={(event) => setProductBrief(event.target.value)} placeholder="Verified features and the style you want. No invented offers." rows={3} /></Field><Field label="Product or store link" hint="Leave blank to use the store link from Settings."><input type="url" value={productUrl} onChange={(event) => setProductUrl(event.target.value)} placeholder={data.settings?.content?.storeUrl || "https://your-store.com/products/…"} /></Field></div>{images.length > 0 && <Field label="Product reference images" hint="Choose up to 10 images from this project's Library. News/editorial images are hidden."><div className="production-images">{images.map((media) => <label key={media.id}><input type="checkbox" checked={references.includes(media.id)} disabled={!references.includes(media.id) && references.length >= 10} onChange={() => setReferences((current) => current.includes(media.id) ? current.filter((id) => id !== media.id) : [...current, media.id])} /><img src={media.thumbnailUrl || media.url} alt="" /><span>{media.name}</span></label>)}</div></Field>}</>}
      <details className="production-options"><summary>Sources, profile &amp; render rules</summary><div className="form-grid"><Field label="RSS sources (optional)"><textarea rows={2} value={feeds} onChange={(event) => setFeeds(event.target.value)} placeholder="One RSS URL per line. Blank: search current US English news." /></Field><Field label="DreamFace profile"><select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="auto">Auto · daily rotation</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.status}</option>)}</select></Field></div><div className="production-render-rules"><strong>0.6.3 render rules</strong><span>One selected profile keeps the same MC across the batch.</span><span>Auto rotates healthy profiles when no MC is pinned.</span><span>Each item gets a different image order, camera motion and visual opening while facts stay the same.</span><span>Content is optional: enable the checkbox below to ask LLM to create it after each completed video.</span></div></details>
      <label className="toggle-field production-auto-content"><input type="checkbox" checked={autoCreateContent} onChange={(event) => setAutoCreateContent(event.target.checked)} /><span><strong>Tự tạo Content sau khi render</strong><small>{autoCreateContent ? "Sau khi có video, LLM sẽ tạo Content và báo lỗi ngay trong Queue/Content nếu không tạo được." : "Chỉ tạo video. Vào Content để chọn video và tạo bài sau."}</small></span></label>
      {!data.settings?.llm?.enabled && <Notice>Configure and enable your LLM in Settings to start automatic production.</Notice>}
      {(mode === "product" || engine === "dreamface") && !accounts.some((account) => account.status === "ready") && <p className="small muted">DreamFace MC videos wait in Queue until a verified profile is ready. <button type="button" className="inline-link" onClick={() => navigate?.("accounts")}>Open accounts</button></p>}
      <div className="production-actions"><span className="small muted">Output được gắn riêng là {mode === "news" ? "News" : "Product"}; Content {autoCreateContent ? "sẽ tạo sau render" : "để tạo sau"}.</span><Button type="submit" variant="primary" busy={busy} disabled={!data.settings?.llm?.enabled}><Sparkles size={16} /> Create {count || 1} video{Number(count) === 1 ? "" : "s"}</Button></div>
    </form>

    {batches.length > 0 && <div className="production-batches">
      <div className="production-batches-heading"><div><span className="hub-kicker">RENDER RECORDS</span><strong>Recent video records</strong></div><small>Each record keeps its source, progress, retry and Content handoff.</small></div>
      {batches.map((batch) => {
        const request = batch.request || {};
        const research = request.researchId ? researchById.get(request.researchId) : null;
        const jobs = (batch.items || []).map((item) => (data.jobs || []).findLast((job) => job.production?.batchId === batch.id && job.production?.itemIndex === item.index) || (data.jobs || []).find((job) => job.id === item.jobId));
        const complete = jobs.filter((job) => job?.status === "completed").length;
        const active = jobs.find((job) => ["queued", "submitting", "rendering", "downloading"].includes(job?.status));
        const failed = (batch.items || []).filter((item) => ["failed", "interrupted"].includes(item.status)).length;
        const title = batchTitle(batch, research);
        return <article className={`production-batch${focusedSet.has(batch.id) ? " is-focused" : ""}`} data-production-batch-id={batch.id} key={batch.id}>
          <div>
            <strong><Video size={15} /> {title}</strong>
            <p>{complete}/{request.count || batch.items?.length || 0} completed · {(batch.items || []).filter((item) => item.jobId).length} queued · {statusLabels[batch.status] || batch.status}{active ? ` · ${active.status} ${Math.round(active.progress || 0)}%` : ""}</p>
            {research && <small className="production-batch-source">Research đã chọn · {research.articles?.length || 0} nguồn · {research.topic || research.headline}</small>}
            <small className={request.autoCreateContent ? "production-content-mode enabled" : "production-content-mode"}>{request.autoCreateContent ? "Content: tự tạo sau render" : "Content: tạo sau trong Content Studio"}</small>
            {!research && request.sourceUrl && <small className="production-batch-source">Nguồn trực tiếp · {request.sourceUrl}</small>}
            {batch.warnings?.map((warning) => <small key={warning}>{warning}</small>)}
            {batch.error && <small className="danger-text">Batch: {batch.error}</small>}
            {(batch.items || []).filter((item) => item.error).map((item) => <small className="danger-text" key={item.index}>Video {item.index + 1}: {item.error}</small>)}
            {(batch.items || []).filter((item) => !item.error && ["preparing", "queued"].includes(item.status)).map((item) => <small key={item.index}>Video {item.index + 1}: {item.status === "preparing" ? "đang chuẩn bị" : "đã đưa vào Queue"}</small>)}
          </div>
          <div className="inline-actions">{failed > 0 && <Button onClick={() => retry(batch)}><RefreshCw size={14} /> Retry preparation</Button>}<Button onClick={() => navigate?.(complete ? "content" : "queue")}>{complete ? "Open Content" : "Open Queue"}<ArrowRight size={14} /></Button></div>
        </article>;
      })}
    </div>}
  </section>;
}
