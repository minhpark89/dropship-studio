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
  PlayCircle,
  Plus,
  RefreshCw,
  Send,
  ShoppingBag,
  Sparkles,
  Trash2,
  Video,
} from "lucide-react";
import { api } from "../api.js";
import { Badge, Button, Empty, Field, Modal, Notice } from "../components.jsx";
import { isPublishableVideo } from "../../shared/output-media.js";

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
  coverImageUrl: "",
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

function PreviewMedia({ media, onOpen }) {
  if (!media) return <div className="content-media-fallback"><Video size={18} /></div>;
  const preview = media.kind === "image"
    ? <img src={media.thumbnailUrl || media.url} alt="" loading="lazy" />
    : <video src={media.url} muted preload="metadata" />;
  if (!onOpen) return preview;
  return <button type="button" className="content-media-button" aria-label={`Xem ${media.kind === "video" ? "video" : "ảnh"} ${media.name || ""}`} onClick={() => onOpen(media)}>
    {preview}
    <span><PlayCircle size={16} /> Xem {media.kind === "video" ? "video" : "ảnh"}</span>
  </button>;
}

function TypeBadge({ type }) {
  return <span className={`content-type-badge ${type}`}><i />{type === "news" ? "NEWS" : "PRODUCT"}</span>;
}

function mediaContentType(media) {
  const type = String(media?.production?.contentType || media?.contentType || media?.mediaType || "").toLowerCase();
  if (type === "news" || type === "news-video") return "news";
  return /^news(?:\s|[·-])/i.test(String(media?.name || "")) ? "news" : "product";
}

function contentWords(value) {
  return new Set(String(value || "").toLowerCase().replace(/[^a-z0-9À-ỹ]+/gi, " ").split(/\s+/).filter((word) => word.length > 2));
}

function inferResearchId(media, research) {
  if (media?.production?.researchId) return media.production.researchId;
  if (mediaContentType(media) !== "news") return "";
  const target = contentWords(media?.production?.title || media?.name);
  let best = { id: "", score: 0 };
  for (const item of research || []) {
    const source = [item.headline, item.topic, ...(item.articles || []).slice(0, 5).map((article) => article.title)].join(" ");
    const score = [...contentWords(source)].filter((word) => target.has(word)).length;
    if (score > best.score) best = { id: item.id, score };
  }
  return best.score >= 2 ? best.id : "";
}

function contentCoverageKey(value, research) {
  const type = mediaContentType(value);
  const researchId = value?.researchId || inferResearchId(value, research);
  if (researchId) return `${type}:research:${researchId}`;
  const title = String(value?.production?.title || value?.title || value?.name || "")
    .replace(/\.mp4$/i, "")
    .replace(/^News\s*[·-]\s*/i, "")
    .trim()
    .toLowerCase();
  return `${type}:title:${title}`;
}

function postWorkflowStage(post) {
  if (post.contentType === "news") {
    if (!post.articleBody?.trim()) return "needs-content";
    if (post.website?.status !== "published" || !post.website.url) return "needs-website";
    if (!post.firstComment?.includes(post.website.url)) return "needs-comment";
    return "ready";
  }
  return post.firstComment?.trim() ? "ready" : "needs-comment";
}

const workflowStageLabels = {
  "needs-content": "Chưa có Content",
  "needs-website": "Chưa đăng website",
  "needs-comment": "Thiếu first comment",
  ready: "Sẵn sàng lên lịch",
};

export function ContentPage({ data, project, notify, navigate }) {
  const [pages, setPages] = useState(data.socialPages || []);
  const [posts, setPosts] = useState(data.socialPosts || []);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedPostIds, setSelectedPostIds] = useState([]);
  const [bulkConcurrency, setBulkConcurrency] = useState(2);
  const [bulkProgress, setBulkProgress] = useState(null);
  const [modal, setModal] = useState(null);
  const [previewMedia, setPreviewMedia] = useState(null);
  const [busy, setBusy] = useState("");
  const formRef = useRef(null);
  const contentDefaults = data.settings?.content || {};

  useEffect(() => {
    setPages(data.socialPages || []);
    setPosts(data.socialPosts || []);
  }, [data.socialPages, data.socialPosts]);

  useEffect(() => {
    setSelectedPostIds([]);
    setBulkProgress(null);
  }, [project.id, filter, search]);

  const media = useMemo(() => (data.media || [])
    .filter((item) => (item.projectId === project.id || !item.projectId) && ["image", "video"].includes(item.kind))
    .slice()
    .sort((left, right) => Number(right.generated) - Number(left.generated) || new Date(right.createdAt || 0) - new Date(left.createdAt || 0)), [data.media, project.id]);
  const renderedVideos = media.filter((item) => isPublishableVideo(item, data.jobs));
  const projectResearch = (data.researchResults || []).filter(result => result.projectId === project.id);
  const unassignedVideos = useMemo(() => {
    const coverage = new Map();
    for (const post of posts.filter((item) => item.projectId === project.id)) {
      const key = contentCoverageKey({ contentType: post.contentType, researchId: post.researchId, title: post.title }, projectResearch);
      coverage.set(key, (coverage.get(key) || 0) + 1);
    }
    return renderedVideos.filter((video) => {
      if (posts.some((post) => post.mediaIds?.includes(video.id))) return false;
      const key = contentCoverageKey(video, projectResearch);
      const available = coverage.get(key) || 0;
      if (available > 0) {
        coverage.set(key, available - 1);
        return false;
      }
      return true;
    });
  }, [posts, project.id, projectResearch, renderedVideos]);
  const unassignedVideoGroups = useMemo(() => {
    const groups = new Map();
    for (const video of unassignedVideos) {
      const type = mediaContentType(video);
      const title = String(video.production?.title || video.name || "").replace(/\.mp4$/i, "").replace(/^News\s*[·-]\s*/i, "").trim().toLowerCase();
      const key = `${type}:${title}`;
      const group = groups.get(key) || { video, type, count: 0 };
      group.count += 1;
      groups.set(key, group);
    }
    return [...groups.values()].slice(0, 20);
  }, [unassignedVideos]);
  const activePages = pages.filter((page) => !page.archived);
  const projectPosts = posts
    .filter((post) => post.projectId === project.id)
    .filter((post) => filter === "all" || post.contentType === filter || (filter === "ready" ? postWorkflowStage(post) === "ready" : postWorkflowStage(post) === filter))
    .filter((post) => !search.trim() || `${post.title} ${post.caption} ${post.firstComment}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((left, right) => new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0));
  const projectPostItems = posts.filter((post) => post.projectId === project.id);
  const counts = {
    all: projectPostItems.length,
    news: projectPostItems.filter((post) => post.contentType === "news").length,
    product: projectPostItems.filter((post) => post.contentType === "product").length,
    ready: projectPostItems.filter((post) => postWorkflowStage(post) === "ready").length,
    "needs-content": projectPostItems.filter((post) => postWorkflowStage(post) === "needs-content").length,
    "needs-website": projectPostItems.filter((post) => postWorkflowStage(post) === "needs-website").length,
    "needs-comment": projectPostItems.filter((post) => postWorkflowStage(post) === "needs-comment").length,
  };
  const selectedPosts = projectPosts.filter((post) => selectedPostIds.includes(post.id));
  const bulkPosts = selectedPosts.length ? selectedPosts : projectPosts.filter((post) => post.contentType === "news");
  const allVisibleSelected = projectPosts.length > 0 && projectPosts.every((post) => selectedPostIds.includes(post.id));

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
      coverImageUrl: String(form.get("coverImageUrl") || "").trim(),
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
    const contentType = mediaContentType(video);
    const result = await action(`write:${video.id}`, () => api(`/content/from-media/${video.id}`, {
      pageId: activePages[0]?.id || "",
      contentType,
      researchId: video.production?.researchId || undefined,
    }), contentType === "news" ? "Đã tạo bài News từ video." : "Đã tạo Content và first comment.");
    if (!result) return;
    let next = result;
    if (contentType === "news" && result.articleBody) {
      const published = await action(`website:${result.id}`, () => api(`/content/posts/${result.id}/website`, { revision: result.revision }), "Đã đăng bài News lên website và gắn URL vào first comment.");
      if (published) next = published;
    }
    setPosts((current) => [next, ...current.filter((post) => post.id !== next.id)]);
  };
  const publishWebsite = async (post, forceRevision = false) => {
    const result = await action(`website:${post.id}`,()=>api(`/content/posts/${post.id}/website`,{revision:post.revision, forceRevision}),forceRevision ? "Updated website article published with a new verified URL." : "Website article published. The first comment now contains its exact URL.");
    if(result)setPosts(current=>current.map(item=>item.id===result.id?result:item));
  };
  const repairImages = async (post) => {
    const result = await action(`repair-images:${post.id}`, () => api(`/content/posts/${post.id}/repair-images`, { revision: post.revision }), "Đã bổ sung ảnh inline cho bài viết. Hãy publish bản cập nhật website.");
    if (result) setPosts(current => current.map(item => item.id === result.id ? result : item));
  };
  const syncFirstComment = async (post) => {
    const result = await action(`sync-comment:${post.id}`, () => api(`/content/posts/${post.id}/sync-first-comment`, { revision: post.revision }), "Đã gắn URL website chính xác vào first comment.");
    if (result) setPosts((current) => current.map((item) => item.id === result.id ? result : item));
  };
  const regeneratePost = async (post) => {
    const result = await action(`regenerate:${post.id}`, () => api(`/content/posts/${post.id}/regenerate`, {}));
    if (result) {
      setPosts(current => current.map(item => item.id === result.id ? result : item));
      notify(result.automationError ? "LLM chưa tạo được bản mới. Content cũ vẫn được giữ nguyên; hãy kiểm tra LLM trong Settings rồi thử lại." : "LLM đã tạo lại Content News. Hãy kiểm tra bài và publish website.", result.automationError ? "error" : undefined);
    }
  };
  const togglePostSelection = (postId) => {
    setSelectedPostIds((current) => current.includes(postId) ? current.filter((id) => id !== postId) : [...current, postId]);
  };
  const toggleAllVisible = () => {
    setSelectedPostIds(allVisibleSelected ? [] : projectPosts.map((post) => post.id));
  };
  const bulkRegenerate = async () => {
    const targets = bulkPosts.filter((post) => post.contentType === "news");
    if (!targets.length || busy) return;
    const concurrency = Math.max(1, Math.min(8, Number(bulkConcurrency) || 2));
    setBusy("bulk-regenerate");
    setBulkProgress({ total: targets.length, completed: 0, succeeded: 0, failed: 0, active: 0, concurrency });
    let succeeded = 0;
    let failed = 0;
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= targets.length) return;
        const post = targets[index];
        setBulkProgress((current) => current ? { ...current, active: current.active + 1 } : current);
        try {
          const result = await api(`/content/posts/${post.id}/regenerate`, {});
          setPosts((current) => current.map((item) => item.id === result.id ? result : item));
          if (result.automationError) {
            failed += 1;
            notify(`${post.title}: ${result.automationError}`, "error");
          } else succeeded += 1;
        } catch (error) {
          failed += 1;
          notify(`${post.title}: ${error.message}`, "error");
        } finally {
          setBulkProgress((current) => current ? {
            ...current,
            completed: current.completed + 1,
            succeeded,
            failed,
            active: Math.max(0, current.active - 1),
          } : current);
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
    } finally {
      setBusy("");
      setSelectedPostIds([]);
    }
    setBulkProgress({ total: targets.length, completed: targets.length, succeeded, failed, active: 0, concurrency });
    notify(`Đã xử lý ${targets.length} bài bằng LLM: ${succeeded} thành công${failed ? `, ${failed} lỗi (content cũ được giữ)` : ""}.`, failed ? "error" : undefined);
  };
  const bulkPublishWebsite = async () => {
    const targets = bulkPosts.filter((post) => post.contentType === "news" && post.articleBody?.trim() && postWorkflowStage(post) === "needs-website" && !post.automationError);
    if (!targets.length || busy) return;
    setBusy("bulk-website");
    let published = 0;
    let failed = 0;
    try {
      for (const post of targets) {
        try {
          const result = await api(`/content/posts/${post.id}/website`, { revision: post.revision });
          setPosts((current) => current.map((item) => item.id === result.id ? result : item));
          published += 1;
        } catch (error) {
          failed += 1;
          notify(`${post.title}: ${error.message}`, "error");
        }
      }
    } finally {
      setBusy("");
      setSelectedPostIds([]);
    }
    notify(`Đã đăng ${published}/${targets.length} bài lên website${failed ? `, ${failed} lỗi` : ""}.`, failed ? "error" : undefined);
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
    <div className="page-heading hub-heading"><div><div className="eyebrow">CONTENT WORKSPACE</div><h1>Content tách riêng, quản lý nhẹ hơn.</h1><p>Soạn caption, first comment và link bài viết rồi gắn đúng Page trước khi duyệt.</p></div><div className="hub-heading-actions"><Button onClick={() => openCreate("news")}><Newspaper size={15} /> Content News</Button><Button variant="primary" onClick={() => openCreate("product")}><Plus size={16} /> Content Product</Button></div></div><div className="hub-metrics"><div><span>Tổng Content</span><strong>{counts.all}</strong><small>trong project hiện tại</small></div><div><span>News</span><strong>{counts.news}</strong><small>research → video → website</small></div><div><span>Product</span><strong>{counts.product}</strong><small>video sản phẩm</small></div><div><span>Đủ điều kiện</span><strong>{counts.ready}</strong><small>website + first comment</small></div></div>
    {!activePages.length && <Notice>You can write and save drafts now. Assign a Page before approval. <button className="inline-link" onClick={() => navigate?.("pages")}>Open Channels</button></Notice>}
        {unassignedVideoGroups.length > 0 && <section className="content-video-inbox"><div className="hub-panel-heading"><div><span className="hub-kicker">READY FROM RENDER</span><h2>{unassignedVideoGroups.length} video group(s) cần tạo Content</h2><p>News sẽ tạo bài, đăng website và gắn URL chính xác vào first comment.</p></div></div>{unassignedVideoGroups.map(({ video, type, count }) => <article key={video.id}><Video size={24}/><div><strong>{video.production?.title || video.name}</strong><p>{type === "news" ? `News · bài viết website + first comment${count > 1 ? ` · ${count} bản render` : ""}` : `Product · first comment${count > 1 ? ` · ${count} bản render` : ""}`}</p></div><Button variant="primary" busy={busy===`write:${video.id}` || busy===`website:${video.id}`} disabled={Boolean(busy)} onClick={()=>writeForVideo(video)}><Sparkles size={15}/>{type === "news" ? "Tạo bài + đăng website" : "Tạo first comment"}</Button></article>)}</section>}
    <div className="content-toolbar"><div className="content-filter-tabs">{[["all", "Tất cả"], ["news", "News"], ["product", "Product"], ["needs-content", "Cần viết"], ["needs-website", "Cần đăng web"], ["needs-comment", "Thiếu first comment"], ["ready", "Đủ điều kiện"]].map(([value, label]) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}<b>{counts[value]}</b></button>)}</div><input aria-label="Tìm Content" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm tiêu đề, caption hoặc first comment…" /></div>
    {filter === "needs-website" && projectPosts.length > 0 && <div className="content-bulk-controls"><label htmlFor="content-llm-concurrency">LLM threads<select id="content-llm-concurrency" value={bulkConcurrency} onChange={(event) => setBulkConcurrency(Number(event.target.value))} disabled={Boolean(busy)}>{[1, 2, 3, 4, 5, 6, 7, 8].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>{bulkProgress && <div className="content-bulk-progress"><strong>LLM {bulkProgress.completed}/{bulkProgress.total}</strong><span>{bulkProgress.active} running | {bulkProgress.succeeded} ok | {bulkProgress.failed} failed | {bulkProgress.concurrency} threads</span><progress max={bulkProgress.total} value={bulkProgress.completed} /></div>}</div>}
    {filter === "needs-website" && projectPosts.length > 0 && <div className="content-bulk-toolbar"><label className="content-select-toggle"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} /> <span>Select all {projectPosts.length} items</span></label><span className="content-bulk-hint">{selectedPosts.length ? `Selected ${selectedPosts.length} items` : "No selection = process all filtered News items"}</span><div className="content-bulk-actions"><Button busy={busy === "bulk-regenerate"} disabled={Boolean(busy)} onClick={bulkRegenerate}><Sparkles size={14} /> Regenerate LLM {selectedPosts.length ? `(${selectedPosts.length})` : "all"}</Button><Button variant="primary" busy={busy === "bulk-website"} disabled={Boolean(busy)} onClick={bulkPublishWebsite}><Send size={14} /> Publish website {selectedPosts.length ? `(${selectedPosts.length})` : "all"}</Button></div></div>}
    {projectPosts.length ? <div className="content-list">{projectPosts.map((post) => {
      const page = pages.find((item) => item.id === post.pageId);
      const attached = media.find((item) => item.id === post.mediaIds?.[0]);
      const articleImageCount = (post.articleBody?.match(/!\[[^\]]*\]\(https?:\/\//g) || []).length;
      return <article className={`content-card${filter === "needs-website" && selectedPostIds.includes(post.id) ? " selected" : ""}`} key={post.id}>
        <div className="content-card-media"><PreviewMedia media={attached} onOpen={setPreviewMedia} /><span className="content-card-type"><TypeBadge type={post.contentType || "product"} /></span>{attached?.kind === "video" && attached.generated && <span className="content-render-badge">VIDEO RENDER</span>}</div>
        <div className="content-card-body"><div className="content-card-top"><div>{filter === "needs-website" && <label className="content-card-select"><input type="checkbox" checked={selectedPostIds.includes(post.id)} onChange={() => togglePostSelection(post.id)} /> <span>Select</span></label>}<div className="content-card-kicker">{page?.name || "Chưa gán Page"} · {post.updatedAt ? new Date(post.updatedAt).toLocaleDateString("vi-VN") : "mới"}</div><h3>{post.title}</h3></div><div className="content-card-statuses"><Badge status={post.status} /><span className={`content-workflow-status ${postWorkflowStage(post)}`}>{workflowStageLabels[postWorkflowStage(post)]}</span></div></div>
          {post.caption && <p className="content-caption">{post.caption}</p>}
          <div className="content-meta-row"><span><MessageCircle size={13} /> {post.firstComment ? "Có first comment" : "Chưa có first comment"}</span>{post.linkUrl && <a href={post.linkUrl} target="_blank" rel="noreferrer"><Link2 size={13} /> {post.linkLabel || "Mở link"}</a>}{post.sourceUrl && <a href={post.sourceUrl} target="_blank" rel="noreferrer"><Newspaper size={13} /> Nguồn</a>}</div>
          {post.automationError && <div className="content-automation-error"><span><strong>News automation error</strong>{post.automationError}</span><Button onClick={() => regeneratePost(post)} busy={busy === `regenerate:${post.id}`} disabled={Boolean(busy)}><RefreshCw size={14} /> Regenerate with LLM</Button></div>}
          {post.firstComment && <div className="first-comment-preview"><MessageCircle size={14} /><span><strong>First comment</strong>{post.firstComment}</span></div>}
          {post.articleBody && <details className="content-article"><summary>Full article · {post.articleBody.split(/\s+/).length} words · {articleImageCount} image{articleImageCount === 1 ? "" : "s"}</summary><pre>{post.articleBody}</pre><Button onClick={()=>navigator.clipboard.writeText(post.articleBody).then(()=>notify("Article copied.")).catch(()=>notify("Could not copy the article.","error"))}><Copy size={14}/> Copy article</Button></details>}
          {post.articleBody && <div className="production-actions">{post.website?.status === "published" ? <><a className="inline-link" href={post.website.url} target="_blank" rel="noreferrer">Mở bài website</a>{post.website.contentChanged && <Button variant="primary" busy={busy === `website:${post.id}`} disabled={Boolean(busy)} onClick={() => publishWebsite(post, true)}><Send size={14} /> Đăng bản cập nhật</Button>}{articleImageCount < 3 && <Button busy={busy === `repair-images:${post.id}`} disabled={Boolean(busy)} onClick={() => repairImages(post)}><RefreshCw size={14} /> Bổ sung ảnh bài viết</Button>}{postWorkflowStage(post) === "needs-comment" && <Button busy={busy === `sync-comment:${post.id}`} disabled={Boolean(busy)} onClick={() => syncFirstComment(post)}><Link2 size={14} /> Gắn first comment</Button>}</> : <Button variant="primary" busy={busy === `website:${post.id}`} disabled={Boolean(busy)} onClick={() => publishWebsite(post)}><Send size={14} /> Đăng bài News lên website</Button>}</div>}
          <div className="content-card-actions">{postWorkflowStage(post) === "needs-content" && <Button variant="primary" busy={busy === `regenerate:${post.id}`} disabled={Boolean(busy)} onClick={() => regeneratePost(post)}><Sparkles size={14} /> Tạo lại bài News</Button>}<Button onClick={() => setModal({ mode: "edit", post })}><Pencil size={14} /> Sửa</Button>{post.status === "draft" && <Button variant="primary" onClick={() => updatePost(post, { status: "ready" }, "Đã duyệt Content.")}><Check size={14} /> Duyệt</Button>}{["ready", "scheduled"].includes(post.status) && <Button onClick={() => exportPost(post)}><FileDown size={14} /> Handoff</Button>}<Button onClick={() => duplicate(post)}><Copy size={14} /> Nhân bản</Button><Button className="danger-text" onClick={() => remove(post)}><Trash2 size={14} /></Button></div>
        </div>
      </article>;
    })}</div> : <Empty icon={Newspaper} title="Chưa có Content trong project này">Bắt đầu bằng một bản News từ research hoặc một bản Product từ Product Studio.</Empty>}
    {previewMedia && <Modal wide title={`Xem ${previewMedia.kind === "video" ? "video" : "ảnh"} · ${previewMedia.name || "media"}`} onClose={() => setPreviewMedia(null)}><div className="content-video-preview">{previewMedia.kind === "video" ? <video controls autoPlay playsInline poster={previewMedia.thumbnailUrl || undefined} src={previewMedia.url} /> : <img src={previewMedia.url || previewMedia.thumbnailUrl} alt={previewMedia.name || "Preview"} />}</div><div className="content-preview-meta"><strong>{previewMedia.name}</strong><span>{previewMedia.kind === "video" && previewMedia.duration ? `${Number(previewMedia.duration).toFixed(1)} giây · ${previewMedia.width || "?"}×${previewMedia.height || "?"}` : "Xem media local trước khi duyệt"}</span></div></Modal>}
    {modal && <Modal wide title={modal.mode === "edit" ? "Sửa Content" : "Soạn Content mới"} onClose={() => setModal(null)}><form ref={formRef} onSubmit={savePost} className="content-form">
      <div className="content-form-type" onChange={event=>{const type=event.target.value;setModal(current=>({...current,post:{...current.post,contentType:type}}));if(formRef.current){formRef.current.elements.linkUrl.value=type==="news"?contentDefaults.articleWebsiteUrl || "":contentDefaults.storeUrl || "";formRef.current.elements.linkLabel.value=type==="news"?contentDefaults.articleLinkLabel || "Read the full article":contentDefaults.storeLinkLabel || "Shop now";}}}><label><input type="radio" name="contentType" value="news" defaultChecked={modal.post.contentType === "news"} /> <Newspaper size={15} /> News</label><label><input type="radio" name="contentType" value="product" defaultChecked={modal.post.contentType !== "news"} /> <ShoppingBag size={15} /> Product</label></div>
      <div className="production-actions"><p className="small muted">{modal.post.contentType==="news"?"Write a complete article using this video's research sources.":"Write a short first comment with the store link from Settings. No article needed."}</p><Button type="button" variant="primary" busy={busy==="write:editor"} onClick={generateInEditor}><Sparkles size={15}/>{modal.post.contentType==="news"?"Generate full article":"Generate first comment"}</Button></div>
      <div hidden={modal.post.contentType!=="news"}><Field label="Research source" hint="Used for the news article and source citations."><select name="researchId" defaultValue={modal.post.researchId || ""}><option value="">Select research for this video</option>{projectResearch.map(result=><option key={result.id} value={result.id}>{result.headline}</option>)}</select></Field>
      <Field label="Full article (English)" hint="News articles are saved with the post and exported as article.md. Product content does not need an article."><textarea name="articleBody" rows={modal.post.contentType==="news"?12:2} maxLength={60000} defaultValue={modal.post.articleBody || ""} placeholder="Generate or paste the full website article…"/></Field></div>
      <div className="form-grid"><Field label="Tiêu đề"><input name="title" required maxLength={200} defaultValue={modal.post.title} autoFocus placeholder="Ví dụ: 3 thay đổi đáng chú ý hôm nay" /></Field><Field label="Page xuất bản"><select name="pageId" defaultValue={modal.post.pageId}><option value="">Assign a Page later</option>{pages.filter((page) => !page.archived || page.id === modal.post.pageId).map((page) => <option key={page.id} value={page.id}>{page.name}{page.archived ? " (đã lưu trữ)" : ""}</option>)}</select></Field><Field label="Nhóm Page"><select name="pageGroupId" defaultValue={modal.post.pageGroupId || ""}><option value="">Không chọn nhóm</option>{(data.settings?.meta?.pageGroups || []).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></Field><Field label="Pool token"><select name="tokenGroupId" defaultValue={modal.post.tokenGroupId || ""}><option value="">Tự chọn token khỏe</option>{(data.settings?.meta?.tokenGroups || []).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></Field></div>
      <div className="content-form-columns"><div><Field label="Caption"><textarea name="caption" rows="8" maxLength={20000} defaultValue={modal.post.caption} placeholder="Write the main caption…" /></Field><Field label="First comment" hint="Use this for a store, affiliate, or article link. It is preserved in the handoff package."><textarea name="firstComment" rows="5" maxLength={10000} defaultValue={modal.post.firstComment} placeholder="Read more here…" /></Field></div><div><Field label="Rendered video from Library" hint={renderedVideos.length ? `${renderedVideos.length} rendered video(s) available; newest first.` : "No rendered video yet; render from Video Studio or Research first."}><select name="mediaId" defaultValue={modal.post.mediaIds?.[0] || ""}><option value="">No media attached</option>{renderedVideos.length > 0 && <option disabled>— RENDERED VIDEOS —</option>}{renderedVideos.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.duration ? `${Number(item.duration).toFixed(1)}s` : "video"}</option>)}{media.some((item) => !renderedVideos.includes(item) && !(item.kind === "video" && !isPublishableVideo(item, data.jobs))) && <option disabled>— OTHER MEDIA —</option>}{media.filter((item) => !renderedVideos.includes(item) && !(item.kind === "video" && !isPublishableVideo(item, data.jobs))).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.kind}</option>)}</select></Field><div className="content-link-box"><div className="hub-kicker">LINK &amp; SOURCE</div><Field label="Store / article link"><input name="linkUrl" type="url" defaultValue={modal.post.linkUrl} placeholder={modal.post.contentType === "news" ? contentDefaults.articleWebsiteUrl || "https://article.example.com…" : contentDefaults.storeUrl || "https://store.example.com…"} /></Field><Field label="Link label"><input name="linkLabel" maxLength={160} defaultValue={modal.post.linkLabel} placeholder={modal.post.contentType === "news" ? contentDefaults.articleLinkLabel || "Read the full article" : contentDefaults.storeLinkLabel || "Shop now"} /></Field><Field label="Article cover image" hint="Optional public HTTPS image used by the website article and social preview."><input name="coverImageUrl" type="url" defaultValue={modal.post.coverImageUrl || ""} placeholder="https://images.example.com/news.jpg" /></Field><Field label="Article source" hint="Keep the source URL for news verification before publishing."><input name="sourceUrl" type="url" defaultValue={modal.post.sourceUrl} placeholder="https://news.example.com/article" /></Field></div></div></div>
      <div className="form-grid"><Field label="Trạng thái"><select name="status" defaultValue={modal.post.status}><option value="draft">Bản nháp</option><option value="ready">Đã duyệt</option><option value="scheduled">Có lịch</option></select></Field><Field label="Thời gian dự kiến"><input name="scheduledAt" type="datetime-local" defaultValue={localDateInput(modal.post.scheduledAt)} /></Field></div><Field label="Ghi chú nội bộ"><textarea name="notes" rows="2" maxLength={5000} defaultValue={modal.post.notes} placeholder="Ghi chú cho team…" /></Field><Notice>Content chỉ ghi nhận kế hoạch và tạo gói handoff. Việc publish Meta vẫn đi qua preflight và tài khoản/token do bạn sở hữu.</Notice><div className="modal-actions"><Button type="button" onClick={() => setModal(null)}>Hủy</Button><Button variant="primary" busy={busy === "post:new" || busy === `post:${modal.post.id}`}>{modal.mode === "edit" ? "Lưu Content" : "Tạo bản nháp"} <Send size={15} /></Button></div>
    </form></Modal>}
  </div>;
}

