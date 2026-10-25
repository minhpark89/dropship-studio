import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  Check,
  Copy,
  FileDown,
  Link2,
  MessageCircle,
  Newspaper,
  Pencil,
  Plus,
  Send,
  ShoppingBag,
  Sparkles,
  Trash2,
  Video,
} from "lucide-react";
import { api } from "../api.js";
import { Badge, Button, Empty, Field, Modal, Notice } from "../components.jsx";

const statusNames = {
  draft: "Bản nháp",
  ready: "Đã duyệt",
  scheduled: "Có lịch",
  published: "Đã đăng",
};

const emptyPost = (projectId, pageId = "", contentType = "product", defaults = {}) => {
  const linkUrl = contentType === "news" ? defaults.articleWebsiteUrl || "" : defaults.storeUrl || "";
  const commentTemplate = contentType === "news" ? defaults.newsFirstCommentTemplate || "" : defaults.productFirstCommentTemplate || "";
  return {
  projectId,
  pageId,
  pageGroupId: "",
  tokenGroupId: "",
  contentType,
  title: "",
  caption: "",
  firstComment: commentTemplate.replaceAll("{{link}}", linkUrl),
  linkUrl,
  linkLabel: contentType === "news" ? defaults.articleLinkLabel || "Read the full article" : defaults.storeLinkLabel || "Shop now",
  sourceUrl: "",
  articleBody: "",
  researchId: null,
  mediaIds: [],
  scheduledAt: null,
  status: "draft",
  notes: "",
  };
};

function localDateInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dateInputIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function PreviewMedia({ media }) {
  if (!media) return <div className="content-media-fallback"><Video size={18} /></div>;
  if (media.kind === "image") return <img src={media.thumbnailUrl || media.url} alt="" loading="lazy" />;
  return <video src={media.url} muted preload="metadata" />;
}

function TypeBadge({ type }) {
  return <span className={`content-type-badge ${type}`}><i />{type === "news" ? "NEWS" : "PRODUCT"}</span>;
}

export function ContentPage({ data, project, notify, navigate }) {
  const [pages, setPages] = useState(data.socialPages || []);
  const [posts, setPosts] = useState(data.socialPosts || []);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState("");
  const formRef = useRef(null);
  const contentDefaults = data.settings?.content || {};

  useEffect(() => {
    setPages(data.socialPages || []);
    setPosts(data.socialPosts || []);
  }, [data.socialPages, data.socialPosts]);

  const media = useMemo(() => (data.media || [])
    .filter((item) => (item.projectId === project.id || !item.projectId) && ["image", "video"].includes(item.kind))
    .slice()
    .sort((left, right) => Number(right.generated) - Number(left.generated) || new Date(right.createdAt || 0) - new Date(left.createdAt || 0)), [data.media, project.id]);
  const renderedVideos = media.filter((item) => item.kind === "video" && item.generated);
  const unassignedVideos = renderedVideos.filter(item => !posts.some(post => post.mediaIds?.includes(item.id)));
  const projectResearch = (data.researchResults || []).filter(result => result.projectId === project.id);
  const activePages = pages.filter((page) => !page.archived);
  const projectPosts = posts
    .filter((post) => post.projectId === project.id)
    .filter((post) => filter === "all" || post.contentType === filter || post.status === filter)
    .filter((post) => !search.trim() || `${post.title} ${post.caption} ${post.firstComment}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((left, right) => new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0));
  const counts = {
    all: posts.filter((post) => post.projectId === project.id).length,
    news: posts.filter((post) => post.projectId === project.id && post.contentType === "news").length,
    product: posts.filter((post) => post.projectId === project.id && post.contentType === "product").length,
    ready: posts.filter((post) => post.projectId === project.id && ["ready", "scheduled"].includes(post.status)).length,
  };

  const action = async (key, operation, message) => {
    if (busy) return null;
    setBusy(key);
    try {
      const result = await operation();
      if (message) notify(message);
      return result;
    } catch (error) {
      notify(error.message, "error");
      return null;
    } finally {
      setBusy("");
    }
  };

  const openCreate = (contentType = "product", mediaId = "") => {
    const selected = media.find(item => item.id === mediaId);
    const type = selected?.production?.contentType || contentType;
    setModal({ mode: "create", post: { ...emptyPost(project.id, activePages[0]?.id || "", type, contentDefaults), title: selected?.production?.title || "", researchId: selected?.production?.researchId || null, mediaIds: mediaId ? [mediaId] : [] } });
  };

  useEffect(() => {
    const handoff = sessionStorage.getItem("studio-content-media");
    if (!handoff) return;
    sessionStorage.removeItem("studio-content-media");
    let mediaId = handoff;
    try { mediaId = JSON.parse(handoff)?.mediaId || mediaId; } catch { /* plain id */ }
    if (media.some((item) => item.id === mediaId)) openCreate("product", mediaId);
  }, [media, contentDefaults]);

  const savePost = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const existing = modal.mode === "edit" ? modal.post : null;
    const mediaId = String(form.get("mediaId") || "");
    const value = {
      projectId: project.id,
      pageId: String(form.get("pageId") || ""),
      pageGroupId: String(form.get("pageGroupId") || ""),
      tokenGroupId: String(form.get("tokenGroupId") || ""),
      contentType: String(form.get("contentType") || "product"),
      title: String(form.get("title") || "").trim(),
      caption: String(form.get("caption") || "").trim(),
      firstComment: String(form.get("firstComment") || "").trim(),
      linkUrl: String(form.get("linkUrl") || "").trim(),
      linkLabel: String(form.get("linkLabel") || "").trim(),
      sourceUrl: String(form.get("sourceUrl") || "").trim(),
      articleBody: String(form.get("articleBody") || "").trim(),
      researchId: String(form.get("researchId") || "") || null,
      mediaIds: mediaId ? [mediaId] : [],
      scheduledAt: dateInputIso(String(form.get("scheduledAt") || "")),
      status: String(form.get("status") || "draft"),
      notes: String(form.get("notes") || "").trim(),
    };
    const result = await action(existing ? `post:${existing.id}` : "post:new", () => existing
      ? api(`/social/posts/${existing.id}`, { ...value, revision: existing.revision }, "PATCH")
      : api("/social/posts", value), existing ? "Đã cập nhật Content." : "Đã tạo bản nháp Content.");
    if (result) {
      setPosts((current) => existing ? current.map((post) => post.id === result.id ? result : post) : [result, ...current]);
      setModal(null);
    }
  };

  const updatePost = async (post, changes, message) => {
    const result = await action(`post:${post.id}`, () => api(`/social/posts/${post.id}`, { ...changes, revision: post.revision }, "PATCH"), message);
    if (result) setPosts((current) => current.map((item) => item.id === result.id ? result : item));
  };
  const duplicate = async (post) => {
    const result = await action(`post:${post.id}`, () => api(`/social/posts/${post.id}/duplicate`, { revision: post.revision }), "Đã nhân bản Content.");
    if (result) { setPosts((current) => [result, ...current]); setModal({ mode: "edit", post: result }); }
  };
  const remove = async (post) => {
    if (!confirm(`Xóa Content “${post.title}”?`)) return;
    const result = await action(`post:${post.id}`, () => api(`/social/posts/${post.id}`, { revision: post.revision }, "DELETE"), "Đã xóa Content.");
    if (result !== null) setPosts((current) => current.filter((item) => item.id !== post.id));
  };
  const exportPost = async (post) => {
    const result = await action(`export:${post.id}`, () => api(`/social/posts/${post.id}/export`, { revision: post.revision }), "Đã tạo gói handoff Content.");
    if (result) notify(`Đã chuẩn bị ${result.files?.length || 0} file để tải xuống.`);
  };

  const writeForVideo = async (video) => {
    const result = await action(`write:${video.id}`, () => api(`/content/from-media/${video.id}`, {pageId: activePages[0]?.id || ""}), "English Content draft created.");
    if (result) {
      setPosts(current => [result,...current.filter(post=>post.id!==result.id)]);
      setModal({mode:"edit",post:result});
    }
  };
  const publishWebsite = async (post) => {
    const result = await action(`website:${post.id}`,()=>api(`/content/posts/${post.id}/website`,{revision:post.revision}),"Website article published. The first comment now contains its exact URL.");
    if(result)setPosts(current=>current.map(item=>item.id===result.id?result:item));
  };
  const generateInEditor = async () => {
    const targetForm = formRef.current;
    const form = new FormData(targetForm);
    const result = await action("write:editor", () => api("/content/generate", {
      projectId: project.id,
      mediaId: String(form.get("mediaId") || "") || undefined,
      contentType: String(form.get("contentType")),
      researchId: String(form.get("researchId") || "") || null,
      title: String(form.get("title") || ""),
      linkUrl: String(form.get("linkUrl") || ""),
    }), "English copy is ready. Review and save the draft.");
    if (result && formRef.current === targetForm) {
      for (const [name,value] of Object.entries(result)) {
        const field = formRef.current.elements.namedItem(name);
        if (field && name !== "contentType") field.value = value ?? "";
      }
    }
  };

  return <div className="page workspace-hub content-hub">
    <div className="page-heading hub-heading">
      <div><div className="eyebrow">CONTENT WORKSPACE</div><h1>Content tách riêng, quản lý nhẹ hơn.</h1><p>Soạn caption, first comment, link store hoặc link bài viết rồi gán đúng Page trước khi duyệt.</p></div>
      <div className="hub-heading-actions"><Button onClick={() => openCreate("news")}><Newspaper size={15} /> Content News</Button><Button variant="primary" onClick={() => openCreate("product")}><Plus size={16} /> Content Product</Button></div>
    </div>
    <div className="hub-metrics"><div><span>Tổng Content</span><strong>{counts.all}</strong><small>trong project hiện tại</small></div><div><span>News</span><strong>{counts.news}</strong><small>research → DreamFace</small></div><div><span>Product</span><strong>{counts.product}</strong><small>video sản phẩm</small></div><div><span>Chờ duyệt / lịch</span><strong>{counts.ready}</strong><small>sẵn sàng handoff</small></div></div>
    {!activePages.length && <Notice>You can write and save drafts now. Assign a Page before approval. <button className="inline-link" onClick={() => navigate?.("pages")}>Open Channels</button></Notice>}
    {unassignedVideos.length > 0 && <section className="content-video-inbox"><div className="hub-panel-heading"><div><span className="hub-kicker">READY FROM RENDER</span><h2>{unassignedVideos.length} video(s) ready for Content</h2></div></div>{unassignedVideos.slice(0,20).map(video=><article key={video.id}><Video size={24}/><div><strong>{video.production?.title || video.name}</strong><p>{video.production?.contentType === "news" ? "News · full English article, caption and website link" : "Product · first comment with your store link"}</p></div><Button variant="primary" busy={busy===`write:${video.id}`} disabled={Boolean(busy)} onClick={()=>writeForVideo(video)}><Sparkles size={15}/>{video.production?.contentType === "news" ? "Write full article" : "Write store comment"}</Button><Button onClick={()=>openCreate(video.production?.contentType || "product",video.id)}>Edit manually</Button></article>)}</section>}
    <div className="content-toolbar"><div className="content-filter-tabs">{[["all", "Tất cả"], ["news", "News"], ["product", "Product"], ["ready", "Đã duyệt"]].map(([value, label]) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}<b>{counts[value]}</b></button>)}</div><input aria-label="Tìm Content" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm tiêu đề, caption hoặc first comment…" /></div>
    {projectPosts.length ? <div className="content-list">{projectPosts.map((post) => {
      const page = pages.find((item) => item.id === post.pageId);
      const attached = media.find((item) => item.id === post.mediaIds?.[0]);
      return <article className="content-card" key={post.id}>
        <div className="content-card-media"><PreviewMedia media={attached} /><span className="content-card-type"><TypeBadge type={post.contentType || "product"} /></span>{attached?.kind === "video" && attached.generated && <span className="content-render-badge">VIDEO RENDER</span>}</div>
        <div className="content-card-body"><div className="content-card-top"><div><div className="content-card-kicker">{page?.name || "Chưa gán Page"} · {post.updatedAt ? new Date(post.updatedAt).toLocaleDateString("vi-VN") : "mới"}</div><h3>{post.title}</h3></div><Badge status={post.status} /></div>
          {post.caption && <p className="content-caption">{post.caption}</p>}
          <div className="content-meta-row"><span><MessageCircle size={13} /> {post.firstComment ? "Có first comment" : "Chưa có first comment"}</span>{post.linkUrl && <a href={post.linkUrl} target="_blank" rel="noreferrer"><Link2 size={13} /> {post.linkLabel || "Mở link"}</a>}{post.sourceUrl && <a href={post.sourceUrl} target="_blank" rel="noreferrer"><Newspaper size={13} /> Nguồn</a>}</div>
          {post.firstComment && <div className="first-comment-preview"><MessageCircle size={14} /><span><strong>First comment</strong>{post.firstComment}</span></div>}
          {post.articleBody && <details className="content-article"><summary>Full article · {post.articleBody.split(/\s+/).length} words</summary><pre>{post.articleBody}</pre><Button onClick={()=>navigator.clipboard.writeText(post.articleBody).then(()=>notify("Article copied.")).catch(()=>notify("Could not copy the article.","error"))}><Copy size={14}/> Copy article</Button></details>}
          {post.articleBody && <div className="production-actions">{post.website?.status==="published"?<a className="inline-link" href={post.website.url} target="_blank" rel="noreferrer">Open published article</a>:<Button variant="primary" busy={busy===`website:${post.id}`} disabled={Boolean(busy)} onClick={()=>publishWebsite(post)}><Send size={14}/> Publish article to website</Button>}</div>}
          <div className="content-card-actions"><Button onClick={() => setModal({ mode: "edit", post })}><Pencil size={14} /> Sửa</Button>{post.status === "draft" && <Button variant="primary" onClick={() => updatePost(post, { status: "ready" }, "Đã duyệt Content.")}><Check size={14} /> Duyệt</Button>}{["ready", "scheduled"].includes(post.status) && <Button onClick={() => exportPost(post)}><FileDown size={14} /> Handoff</Button>}<Button onClick={() => duplicate(post)}><Copy size={14} /> Nhân bản</Button><Button className="danger-text" onClick={() => remove(post)}><Trash2 size={14} /></Button></div>
        </div>
      </article>;
    })}</div> : <Empty icon={Newspaper} title="Chưa có Content trong project này">Bắt đầu bằng một bản News từ research hoặc một bản Product từ Product Studio.</Empty>}
    {modal && <Modal wide title={modal.mode === "edit" ? "Sửa Content" : "Soạn Content mới"} onClose={() => setModal(null)}><form ref={formRef} onSubmit={savePost} className="content-form">
      <div className="content-form-type" onChange={event=>{const type=event.target.value;setModal(current=>({...current,post:{...current.post,contentType:type}}));if(formRef.current){formRef.current.elements.linkUrl.value=type==="news"?contentDefaults.articleWebsiteUrl || "":contentDefaults.storeUrl || "";formRef.current.elements.linkLabel.value=type==="news"?contentDefaults.articleLinkLabel || "Read the full article":contentDefaults.storeLinkLabel || "Shop now";}}}><label><input type="radio" name="contentType" value="news" defaultChecked={modal.post.contentType === "news"} /> <Newspaper size={15} /> News</label><label><input type="radio" name="contentType" value="product" defaultChecked={modal.post.contentType !== "news"} /> <ShoppingBag size={15} /> Product</label></div>
      <div className="production-actions"><p className="small muted">{modal.post.contentType==="news"?"Write a complete article using this video's research sources.":"Write a short first comment with the store link from Settings. No article needed."}</p><Button type="button" variant="primary" busy={busy==="write:editor"} onClick={generateInEditor}><Sparkles size={15}/>{modal.post.contentType==="news"?"Generate full article":"Generate first comment"}</Button></div>
      <div hidden={modal.post.contentType!=="news"}><Field label="Research source" hint="Used for the news article and source citations."><select name="researchId" defaultValue={modal.post.researchId || ""}><option value="">Select research for this video</option>{projectResearch.map(result=><option key={result.id} value={result.id}>{result.headline}</option>)}</select></Field>
      <Field label="Full article (English)" hint="News articles are saved with the post and exported as article.md. Product content does not need an article."><textarea name="articleBody" rows={modal.post.contentType==="news"?12:2} maxLength={60000} defaultValue={modal.post.articleBody || ""} placeholder="Generate or paste the full website article…"/></Field></div>
      <div className="form-grid"><Field label="Tiêu đề"><input name="title" required maxLength={200} defaultValue={modal.post.title} autoFocus placeholder="Ví dụ: 3 thay đổi đáng chú ý hôm nay" /></Field><Field label="Page xuất bản"><select name="pageId" defaultValue={modal.post.pageId}><option value="">Assign a Page later</option>{pages.filter((page) => !page.archived || page.id === modal.post.pageId).map((page) => <option key={page.id} value={page.id}>{page.name}{page.archived ? " (đã lưu trữ)" : ""}</option>)}</select></Field><Field label="Nhóm Page"><select name="pageGroupId" defaultValue={modal.post.pageGroupId || ""}><option value="">Không chọn nhóm</option>{(data.settings?.meta?.pageGroups || []).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></Field><Field label="Pool token"><select name="tokenGroupId" defaultValue={modal.post.tokenGroupId || ""}><option value="">Tự chọn token khỏe</option>{(data.settings?.meta?.tokenGroups || []).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></Field></div>
      <div className="content-form-columns"><div><Field label="Caption"><textarea name="caption" rows="8" maxLength={20000} defaultValue={modal.post.caption} placeholder="Write the main caption…" /></Field><Field label="First comment" hint="Use this for a store, affiliate, or article link. It is preserved in the handoff package."><textarea name="firstComment" rows="5" maxLength={10000} defaultValue={modal.post.firstComment} placeholder="Read more here…" /></Field></div><div><Field label="Rendered video from Library" hint={renderedVideos.length ? `${renderedVideos.length} rendered video(s) available; newest first.` : "No rendered video yet; render from Video Studio or Research first."}><select name="mediaId" defaultValue={modal.post.mediaIds?.[0] || ""}><option value="">No media attached</option>{renderedVideos.length > 0 && <option disabled>— RENDERED VIDEOS —</option>}{renderedVideos.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.duration ? `${Number(item.duration).toFixed(1)}s` : "video"}</option>)}{media.some((item) => !renderedVideos.includes(item)) && <option disabled>— OTHER MEDIA —</option>}{media.filter((item) => !renderedVideos.includes(item)).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.kind}</option>)}</select></Field><div className="content-link-box"><div className="hub-kicker">LINK &amp; SOURCE</div><Field label="Store / article link"><input name="linkUrl" type="url" defaultValue={modal.post.linkUrl} placeholder={modal.post.contentType === "news" ? contentDefaults.articleWebsiteUrl || "https://article.example.com…" : contentDefaults.storeUrl || "https://store.example.com…"} /></Field><Field label="Link label"><input name="linkLabel" maxLength={160} defaultValue={modal.post.linkLabel} placeholder={modal.post.contentType === "news" ? contentDefaults.articleLinkLabel || "Read the full article" : contentDefaults.storeLinkLabel || "Shop now"} /></Field><Field label="Article source" hint="Keep the source URL for news verification before publishing."><input name="sourceUrl" type="url" defaultValue={modal.post.sourceUrl} placeholder="https://news.example.com/article" /></Field></div></div></div>
      <div className="form-grid"><Field label="Trạng thái"><select name="status" defaultValue={modal.post.status}><option value="draft">Bản nháp</option><option value="ready">Đã duyệt</option><option value="scheduled">Có lịch</option></select></Field><Field label="Thời gian dự kiến"><input name="scheduledAt" type="datetime-local" defaultValue={localDateInput(modal.post.scheduledAt)} /></Field></div><Field label="Ghi chú nội bộ"><textarea name="notes" rows="2" maxLength={5000} defaultValue={modal.post.notes} placeholder="Ghi chú cho team…" /></Field><Notice>Content chỉ ghi nhận kế hoạch và tạo gói handoff. Việc publish Meta vẫn đi qua preflight và tài khoản/token do bạn sở hữu.</Notice><div className="modal-actions"><Button type="button" onClick={() => setModal(null)}>Hủy</Button><Button variant="primary" busy={busy === "post:new" || busy === `post:${modal.post.id}`}>{modal.mode === "edit" ? "Lưu Content" : "Tạo bản nháp"} <Send size={15} /></Button></div>
    </form></Modal>}
  </div>;
}

