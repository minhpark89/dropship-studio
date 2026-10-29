import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  CalendarClock,
  Check,
  ClipboardList,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  FileDown,
  Info,
  Link2,
  Newspaper,
  Pencil,
  Plus,
  Send,
  Trash2,
  UserRound,
  X,
  KeyRound,
  Layers3,
  RefreshCw,
  ShieldCheck,
  FolderPlus,
} from "lucide-react";
import { api } from "../api.js";
import { Badge, Button, Empty, Field, Modal, Notice } from "../components.jsx";
import { DistributionPanel } from "./Pages.jsx";
import "./social.css";

const statusLabels = {
  draft: "Bản nháp",
  ready: "Đã duyệt",
  scheduled: "Có lịch dự kiến",
  published: "Đã ghi nhận đăng",
};

const blankMetaTokenForm = () => ({
  name: "",
  kind: "SYSTEM_USER",
  appId: "",
  appSecret: "",
  note: "",
});

const emptyPost = (projectId, pageId, mediaId = "") => ({
  projectId,
  pageId,
  pageGroupId: "",
  tokenGroupId: "",
  title: "",
  caption: "",
  mediaIds: mediaId ? [mediaId] : [],
  scheduledAt: null,
  status: "draft",
  notes: "",
});

function mediaFor(post, media) {
  return post?.mediaIds?.[0]
    ? media.find((item) => item.id === post.mediaIds[0])
    : null;
}

function localDate(value, timezone) {
  if (!value) return "Chưa đặt lịch";
  try {
    return new Intl.DateTimeFormat("vi-VN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone || undefined,
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}

function localDateInput(value) {
  if (!value) return "";
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dateInputIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function PreviewMedia({ media, className = "" }) {
  if (!media) return null;
  if (media.kind === "image") {
    return <img className={className} src={media.url} alt={media.name} />;
  }
  if (media.kind === "video") {
    return <video className={className} src={media.url} controls preload="metadata" />;
  }
  return null;
}

function MediaChoice({ media, selected, onChange }) {
  return (
    <div className="social-media-select">
      <div className="social-media-select-thumb">
        <PreviewMedia media={media} />
      </div>
      <select name="mediaId" value={selected || ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">Không đính kèm media</option>
        {media.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name} · {item.kind}
          </option>
        ))}
      </select>
    </div>
  );
}

export function SocialPage({ data, project, run, notify }) {
  const [pages, setPages] = useState(data.socialPages || []);
  const [posts, setPosts] = useState(data.socialPosts || []);
  const [selectedPageId, setSelectedPageId] = useState((data.socialPages || [])[0]?.id || "");
  const [postFilter, setPostFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [pageDialog, setPageDialog] = useState(null);
  const [postDialog, setPostDialog] = useState(null);
  const [previewPost, setPreviewPost] = useState(null);
  const [exportResult, setExportResult] = useState(null);
  const [publicationPost, setPublicationPost] = useState(null);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [meta, setMeta] = useState(data.settings?.meta || null);
  const [metaToken, setMetaToken] = useState("");
  const [metaBusy, setMetaBusy] = useState(false);
  const [tokenForm, setTokenForm] = useState(blankMetaTokenForm);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [groupDialog, setGroupDialog] = useState(null);
  const [metaPageSearch, setMetaPageSearch] = useState("");
  const [metaTokenSearch, setMetaTokenSearch] = useState("");

  useEffect(() => {
    setPages(data.socialPages || []);
    setPosts(data.socialPosts || []);
    setMeta(data.settings?.meta || null);
  }, [data.socialPages, data.socialPosts, data.settings?.meta]);

  useEffect(() => {
    if (selectedPageId && pages.some((page) => page.id === selectedPageId)) return;
    setSelectedPageId(pages[0]?.id || "");
  }, [pages, selectedPageId]);

  const projectMedia = useMemo(
    () =>
      (data.media || [])
        .filter(
          (item) =>
            (item.projectId === project.id || !item.projectId) &&
            ["image", "video"].includes(item.kind),
        )
        .slice()
        .reverse(),
    [data.media, project.id],
  );

  useEffect(() => {
    const handoff = sessionStorage.getItem("studio-social-media");
    if (!handoff) return;
    sessionStorage.removeItem("studio-social-media");
    let mediaId = handoff;
    try {
      const parsed = JSON.parse(handoff);
      mediaId = parsed?.mediaId || parsed?.id || handoff;
    } catch {
      // The root handoff may be a plain media UUID.
    }
    const media = projectMedia.find((item) => item.id === mediaId && (item.projectId === project.id || !item.projectId));
    if (media && pages.some((page) => !page.archived)) {
      const page = pages.find((item) => !item.archived);
      setSelectedPageId(page.id);
      setPostDialog({ mode: "create", post: emptyPost(project.id, page.id, media.id) });
    }
  }, [pages, project.id, projectMedia]);

  const selectedPage = pages.find((page) => page.id === selectedPageId) || null;
  const activePages = pages.filter((page) => !page.archived);
  const projectPagePosts = posts.filter((post) => post.projectId === project.id);
  const postSummary = {
    all: projectPagePosts.length,
    draft: projectPagePosts.filter((post) => post.status === "draft").length,
    ready: projectPagePosts.filter((post) => post.status === "ready").length,
    scheduled: projectPagePosts.filter((post) => post.status === "scheduled").length,
  };
  const projectPosts = posts
    .filter((post) => post.projectId === project.id)
    .filter((post) => !selectedPageId || post.pageId === selectedPageId)
    .filter((post) => postFilter === "all" || post.status === postFilter)
    .filter((post) => {
      const term = search.trim().toLowerCase();
      return !term || `${post.title} ${post.caption}`.toLowerCase().includes(term);
    })
    .slice()
    .sort((left, right) => new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0));
  const visibleMetaPages = (meta?.pages || []).filter((page) => !metaPageSearch.trim() || `${page.name} ${page.id}`.toLowerCase().includes(metaPageSearch.trim().toLowerCase()));
  const visibleMetaTokens = (meta?.tokens || []).filter((token) => !metaTokenSearch.trim() || `${token.name} ${token.id} ${token.tokenMasked}`.toLowerCase().includes(metaTokenSearch.trim().toLowerCase()));

  const action = async (key, operation, success) => {
    if (busyId) return null;
    setBusyId(key);
    setError("");
    try {
      const result = await operation();
      if (success) notify(success);
      return result;
    } catch (requestError) {
      const message = requestError.code === "STALE_REVISION"
        ? "Bản ghi đã thay đổi ở nơi khác. Hãy đóng biểu mẫu và mở lại để tải revision mới."
        : requestError.message;
      setError(message);
      notify(message, "error");
      return null;
    } finally {
      setBusyId("");
    }
  };

  const metaAction = async (operation, success) => {
    if (metaBusy) return null;
    setMetaBusy(true);
    setError("");
    try {
      const result = await operation();
      if (result && (Object.prototype.hasOwnProperty.call(result, "connected") || Array.isArray(result.pages))) setMeta(result);
      if (success) notify(success);
      return result;
    } catch (requestError) {
      setError(requestError.message);
      notify(requestError.message, "error");
      return null;
    } finally {
      setMetaBusy(false);
    }
  };

  const refreshMeta = async () => {
    const result = await api("/meta");
    setMeta(result);
    return result;
  };

  const connectMeta = async (event) => {
    event.preventDefault();
    const token = metaToken.trim();
    if (!token) return;
    const result = await metaAction(() => api("/meta/connect", { accessToken: token }, "POST"), "Meta đã kết nối.");
    if (result) setMetaToken("");
  };

  const bindMeta = (event) => metaAction(() => api("/meta/bind", { pageId: event.target.value }, "POST"), "Đã gắn Page Meta.");
  const disconnectMeta = () => metaAction(() => api("/meta", null, "DELETE"), "Đã ngắt kết nối Meta.");
  const addToken = async (event) => {
    event.preventDefault();
    const token = metaToken.trim();
    if (!token) return;
    const result = await metaAction(() => api("/meta/tokens", { accessToken: token, ...tokenForm }, "POST"), "Đã thêm token và đồng bộ Page.");
    if (result) {
      setMetaToken("");
      setTokenForm(blankMetaTokenForm());
      setTokenDialogOpen(false);
      await refreshMeta();
    }
  };
  const refreshToken = (token) => metaAction(async () => {
    await api(`/meta/tokens/${token.id}/refresh-pages`, null, "POST");
    return refreshMeta();
  }, `Đã kiểm tra lại ${token.name}.`);
  const removeToken = (token) => metaAction(async () => {
    await api(`/meta/tokens/${token.id}`, null, "DELETE");
    return refreshMeta();
  }, "Đã xóa token khỏi vault.");
  const saveMetaGroup = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const kind = groupDialog.kind;
    const name = String(form.get("name") || "").trim();
    if (!name) return;
    const body = { name };
    if (kind === "token") body.tokenIds = form.getAll("tokenIds").map(String);
    if (kind === "page") body.pageIds = form.getAll("pageIds").map(String);
    const result = await metaAction(async () => {
      await api(`/meta/${kind}-groups`, body, "POST");
      return refreshMeta();
    }, `Đã tạo nhóm ${kind === "token" ? "token" : "Page"}.`);
    if (result) setGroupDialog(null);
  };
  const publishMeta = async (post) => {
    const preflight = await metaAction(() => api("/meta/preflight", { postId: post.id }, "POST"));
    if (!preflight?.ready) {
      const message = (preflight?.checks || []).filter((check) => !check.ok).map((check) => check.message).join(" ") || "Preflight Meta chưa đạt; hãy kiểm tra lại bài đăng.";
      setError(message);
      notify(message, "error");
      return;
    }
    const result = await metaAction(() => api("/meta/publish/reel", { postId: post.id, idempotencyKey: `${post.id}:${post.revision}` }, "POST"));
    if (!result) return;
    if (result.firstCommentError) {
      const message = `Reel đã đăng nhưng first comment lỗi: ${result.firstCommentError}`;
      setPosts((current) => current.map((item) => item.id === post.id ? (result.post || item) : item));
      setError(message);
      notify(message, "error");
      return;
    }
    setPosts((current) => current.filter((item) => item.id !== post.id));
    notify("Đã đăng Reel và xóa bài khỏi kho chờ đăng.");
  };

  const savePage = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = {
      name: String(form.get("name") || "").trim(),
      platform: "facebook",
      externalId: String(form.get("externalId") || "").trim(),
      url: String(form.get("url") || "").trim(),
      timezone: String(form.get("timezone") || "Asia/Bangkok").trim(),
      notes: String(form.get("notes") || "").trim(),
      archived: form.get("archived") === "on",
    };
    const editing = pageDialog?.mode === "edit";
    const result = await action(
      editing ? `page:${pageDialog.page.id}` : "page:new",
      () => editing
        ? api(`/social/pages/${pageDialog.page.id}`, { ...value, revision: pageDialog.page.revision }, "PATCH")
        : api("/social/pages", value),
      editing ? "Đã cập nhật Page." : "Đã thêm Page.",
    );
    if (result) {
      setPages((current) => editing ? current.map((page) => page.id === result.id ? result : page) : [...current, result]);
      setSelectedPageId(result.id);
      setPageDialog(null);
    }
  };

  const deletePage = async (page) => {
    if (!confirm(`Xóa Page “${page.name}”? Page có bài đăng tham chiếu sẽ không thể xóa.`)) return;
    const result = await action(`page:${page.id}`, () => api(`/social/pages/${page.id}`, { revision: page.revision }, "DELETE"), "Đã xóa Page.");
    if (result !== null) {
      setPages((current) => current.filter((item) => item.id !== page.id));
      if (selectedPageId === page.id) setSelectedPageId("");
    }
  };

  const savePost = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const existing = postDialog?.mode === "edit" ? postDialog.post : null;
    const mediaId = String(form.get("mediaId") || "");
    const value = {
      projectId: project.id,
      pageId: String(form.get("pageId") || selectedPageId),
      title: String(form.get("title") || "").trim(),
      caption: String(form.get("caption") || "").trim(),
      mediaIds: mediaId ? [mediaId] : [],
      scheduledAt: dateInputIso(String(form.get("scheduledAt") || "")),
      status: String(form.get("status") || "draft"),
      notes: String(form.get("notes") || "").trim(),
    };
    const result = await action(
      existing ? `post:${existing.id}` : "post:new",
      () => existing
        ? api(`/social/posts/${existing.id}`, { ...value, revision: existing.revision }, "PATCH")
        : api("/social/posts", value),
      existing ? "Đã cập nhật bài đăng." : "Đã tạo bài đăng.",
    );
    if (result) {
      setPosts((current) => existing ? current.map((post) => post.id === result.id ? result : post) : [...current, result]);
      setPostDialog(null);
    }
  };

  const deletePost = async (post) => {
    if (!confirm(`Xóa bài “${post.title}”?`)) return;
    const result = await action(`post:${post.id}`, () => api(`/social/posts/${post.id}`, { revision: post.revision }, "DELETE"), "Đã xóa bài đăng.");
    if (result !== null) setPosts((current) => current.filter((item) => item.id !== post.id));
  };

  const duplicatePost = async (post) => {
    const result = await action(`post:${post.id}`, () => api(`/social/posts/${post.id}/duplicate`, { revision: post.revision }), "Đã tạo bản nháp từ bài đăng.");
    if (result) {
      setPosts((current) => [...current, result]);
      setPostDialog({ mode: "edit", post: result });
    }
  };

  const approvePost = async (post) => {
    const result = await action(`post:${post.id}`, () => api(`/social/posts/${post.id}`, { revision: post.revision, status: "ready" }, "PATCH"), "Đã duyệt nội dung.");
    if (result) setPosts((current) => current.map((item) => item.id === result.id ? result : item));
  };

  const schedulePost = async (post) => {
    const value = prompt("Nhập thời gian dự kiến theo ISO UTC, ví dụ 2026-12-01T10:00:00Z", post.scheduledAt || "");
    if (value === null) return;
    const result = await action(`post:${post.id}`, () => api(`/social/posts/${post.id}`, { revision: post.revision, scheduledAt: value, status: "scheduled" }, "PATCH"), "Đã lưu lịch. Scheduler sẽ tự publish khi đến giờ nếu preflight đạt.");
    if (result) setPosts((current) => current.map((item) => item.id === result.id ? result : item));
  };

  const exportPost = async (post) => {
    const result = await action(`export:${post.id}`, () => api(`/social/posts/${post.id}/export`, { revision: post.revision }), "Đã tạo gói đăng thủ công.");
    if (result) setExportResult({ post, ...result });
  };

  const recordPublication = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const post = publicationPost;
    const payload = {
      revision: post.revision,
      externalPostId: String(form.get("externalPostId") || "").trim(),
      permalink: String(form.get("permalink") || "").trim(),
      publishedAt: new Date(String(form.get("publishedAt") || "")).toISOString(),
    };
    const result = await action(`publish:${post.id}`, () => api(`/social/posts/${post.id}/publication`, payload), "Đã ghi nhận kết quả đăng thủ công.");
    if (result) {
      setPosts((current) => current.filter((item) => item.id !== result.id));
      setPublicationPost(null);
    }
  };

  return (
    <div className="page social-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">PAGE &amp; CONTENT</div>
          <h1>Hàng chờ &amp; trạng thái đăng.</h1>
          <p>Bài đủ Content sẽ vào hàng chờ; nhóm Page đã bật Auto Post tự lấy video theo khung giờ. Video và bìa chỉ quản lý trong Thư viện.</p>
        </div>
        <div className="social-heading-actions">
          <Button onClick={() => setPageDialog({ mode: "create", page: null })}><Plus size={15} /> Thêm Page</Button>
          <Button variant="primary" disabled={!selectedPage || selectedPage.archived} onClick={() => setPostDialog({ mode: "create", post: emptyPost(project.id, selectedPageId) })}><Pencil size={15} /> Tạo bài đăng</Button>
        </div>
      </div>
      <section className="social-overview" aria-label="Tổng quan Page">
        <div className="social-overview-card social-overview-card--accent"><span className="social-overview-label">PAGE ĐANG QUẢN LÝ</span><strong>{selectedPage?.name || "Chưa chọn Page"}</strong><small>{selectedPage ? `${selectedPage.platform === "facebook" ? "Facebook" : selectedPage.platform} · ${selectedPage.timezone || "Asia/Bangkok"}` : "Thêm hoặc chọn một Page để bắt đầu"}</small></div>
        <div className="social-overview-card"><span className="social-overview-label">PAGE ĐANG HOẠT ĐỘNG</span><strong>{activePages.length}</strong><small>{pages.length ? `${pages.length - activePages.length} Page đã lưu trữ` : "Chưa có Page kết nối"}</small></div>
        <div className="social-overview-card"><span className="social-overview-label">BÀI TRONG DỰ ÁN</span><strong>{postSummary.all}</strong><small>{postSummary.draft} bản nháp · {postSummary.ready} chờ duyệt</small></div>
        <div className="social-overview-card"><span className="social-overview-label">LỊCH ĐĂNG</span><strong>{postSummary.scheduled}</strong><small>{meta?.connected ? "Meta đã kết nối" : "Chưa kết nối Meta publisher"}</small></div>
      </section>
      {!meta?.connected && <div className="social-connection">
        <Info size={18} />
        <div><strong>Chưa kết nối Meta publisher</strong><p>Kho, nhóm và lịch vẫn được lưu local. Khi thêm token Meta và gắn Page, scheduler sẽ tự chạy các lịch đã đặt; nếu chưa kết nối, bài vẫn giữ trong kho để kiểm tra.</p></div>
      </div>}
      {error && <Notice error>{error}</Notice>}
      <section className="social-distribution-intro" aria-label="Quy trình kho video và lịch đăng">
        <div>
          <span className="social-kicker">HIGHLIGHT FLOW · 01 → 04</span>
          <h2>Video xong → Kho → Nhóm Page → Tự đăng</h2>
          <p>Render hoàn tất sẽ tạo một Content riêng trong kho. Chọn video, chọn nhóm đã có khung giờ, rồi xếp lịch; automation sẽ tự lấy video mới mỗi ngày theo thứ tự.</p>
        </div>
        <div className="social-workflow-steps"><span><b>01</b> Kho video</span><span><b>02</b> Chọn nhóm</span><span><b>03</b> Đặt giờ/ngày</span><span><b>04</b> Scheduler đăng</span></div>
      </section>
      <DistributionPanel data={data} notify={notify} projectId={project.id} />
      <section className="social-connection" aria-label="Meta connector">
        <UserRound size={18} />
        <div style={{ flex: 1 }}>
          <strong>Meta Page publisher</strong>
          <p>Nhập access token do bạn sở hữu để tải danh sách Page, gắn Page token và đăng Reel sau bước preflight. Token không được hiển thị lại.</p>
          {!meta?.connected ? <Button variant="primary" onClick={() => { setTokenForm(blankMetaTokenForm()); setMetaToken(""); setTokenDialogOpen(true); }}><KeyRound size={14} /> Thêm token Meta</Button> : <div className="social-form-inline"><select aria-label="Meta Page" value={meta.boundPage?.id || ""} onChange={bindMeta}><option value="">Chọn Page để đăng</option>{(meta.pages || []).map((page) => <option key={page.id} value={page.id}>{page.name} · {page.id}</option>)}</select><Button onClick={() => metaAction(() => api("/meta/refresh-pages"), "Đã cập nhật danh sách Page.")} busy={metaBusy}>Làm mới</Button><Button onClick={disconnectMeta} busy={metaBusy}>Ngắt kết nối</Button></div>}
          {meta?.connected && <small>{meta.boundPage ? `Đang gắn: ${meta.boundPage.name}` : "Chưa gắn Page."} · Graph {meta.graphVersion || "v26.0"}</small>}
        </div>
      </section>
      <section className="meta-management" aria-label="Quản lý token và nhóm Meta">
        <div className="meta-management-heading">
          <div>
            <div className="eyebrow">META WORKSPACE</div>
            <h2><KeyRound size={17} /> Vault token &amp; nhóm phân phối</h2>
            <p>Mỗi token được kiểm tra qua <code>/me</code> và <code>/me/accounts</code>. Token chỉ hiển thị dạng rút gọn; Page giữ binding đã xác minh để chọn đúng credential khi đăng.</p>
          </div>
          <div className="meta-management-actions">
            <Button onClick={() => setGroupDialog({ kind: "token" })}><FolderPlus size={14} /> Nhóm token</Button>
            <Button onClick={() => setGroupDialog({ kind: "page" })}><Layers3 size={14} /> Nhóm Page</Button>
            <Button variant="primary" onClick={() => setTokenDialogOpen(true)}><Plus size={14} /> Thêm token</Button>
          </div>
        </div>
        <div className="meta-metrics">
          <div><span>Token trong vault</span><strong>{(meta?.tokens || []).length}</strong><small>Không lộ token gốc</small></div>
          <div><span>Page đã xác minh</span><strong>{(meta?.pages || []).filter((page) => page.tokenIds?.length).length}</strong><small>Binding từ Meta</small></div>
          <div><span>Nhóm token</span><strong>{(meta?.tokenGroups || []).length}</strong><small>Chọn pool khi phân phối</small></div>
          <div><span>Nhóm Page</span><strong>{(meta?.pageGroups || []).length}</strong><small>Gắn content theo kênh</small></div>
        </div>
        <div className="meta-management-grid">
          <div className="meta-management-panel">
            <div className="social-panel-header"><h3>Token connections</h3><span>{(meta?.tokens || []).length} kết nối</span></div>
            <div className="meta-list-toolbar"><input aria-label="Tìm token" value={metaTokenSearch} onChange={(event) => setMetaTokenSearch(event.target.value)} placeholder="Tìm token…" /><span>{visibleMetaTokens.length}/{(meta?.tokens || []).length}</span></div>
            <div className="meta-token-list">
              {(meta?.tokens || []).length ? visibleMetaTokens.map((token) => (
                <div className="meta-token-row" key={token.id}>
                  <div className="meta-token-icon"><ShieldCheck size={16} /></div>
                  <div className="meta-token-main"><strong>{token.name}</strong><small>{token.tokenMasked || "***"} · {token.pagesCount || 0} Page · {token.kind === "VIA_TOKEN" ? `Via Token · App ${token.appId || "?"}` : "System User"}</small>{token.errorMessage && <small className="meta-token-error">{token.errorMessage}</small>}</div>
                  <span className={`meta-token-status ${token.status === "ACTIVE" ? "ok" : "warn"}`}>{token.status === "ACTIVE" ? "Đã xác minh" : token.status}</span>
                  <Button className="icon-button" aria-label={`Kiểm tra ${token.name}`} onClick={() => refreshToken(token)} busy={metaBusy}><RefreshCw size={14} /></Button>
                  <Button className="icon-button danger-text" aria-label={`Xóa ${token.name}`} onClick={() => removeToken(token)} busy={metaBusy}><Trash2 size={14} /></Button>
                </div>
              )) : <p className="meta-empty">Chưa có token. Thêm token Meta do bạn sở hữu để đồng bộ Page và quyền.</p>}
            </div>
          </div>
          <div className="meta-management-panel">
            <div className="social-panel-header"><h3>Page đã đồng bộ</h3><span>{(meta?.pages || []).length} Page</span></div>
            <div className="meta-list-toolbar"><input aria-label="Tìm Page Meta" value={metaPageSearch} onChange={(event) => setMetaPageSearch(event.target.value)} placeholder="Tìm Page…" /><span>{visibleMetaPages.length}/{(meta?.pages || []).length}</span></div>
            <div className="meta-page-mini-list">
              {(meta?.pages || []).length ? visibleMetaPages.map((page) => (
                <div className="meta-page-mini" key={page.id}>
                  {page.avatar ? <img src={page.avatar} alt="" /> : <span className="social-page-icon">f</span>}
                  <div><strong>{page.name}</strong><small>{page.id} · {page.tasks?.length ? page.tasks.join(", ") : "Chưa đọc quyền"}</small></div>
                  <span className={`meta-page-binding ${page.tokenIds?.length ? "ok" : "warn"}`}>{page.tokenIds?.length || 0} token</span>
                </div>
              )) : <p className="meta-empty">Chưa có Page được token xác minh.</p>}
            </div>
          </div>
        </div>
        <div className="meta-group-grid">
          <div className="meta-group-panel"><div className="social-panel-header"><h3>Nhóm token</h3><span>{(meta?.tokenGroups || []).length}</span></div>{(meta?.tokenGroups || []).length ? meta.tokenGroups.map((group) => <div className="meta-group-row" key={group.id}><div><strong>{group.name}</strong><small>{group.tokenIds.length} token · {group.strategy === "round_robin" ? "luân phiên đều" : group.strategy === "random" ? "ngẫu nhiên" : "token ít dùng nhất"}</small></div><span>{group.assignedPageCount || 0}/{group.pageIds.length} Page đã chia</span></div>) : <p className="meta-empty">Tạo nhóm token để Studio tự chia Page theo team hoặc quota.</p>}</div>
          <div className="meta-group-panel"><div className="social-panel-header"><h3>Nhóm Page</h3><span>{(meta?.pageGroups || []).length}</span></div>{(meta?.pageGroups || []).length ? meta.pageGroups.map((group) => <div className="meta-group-row" key={group.id}><div><strong>{group.name}</strong><small>{group.pageIds.length} Page · {group.scheduleConfig?.times?.length ? `mỗi ngày ${group.scheduleConfig.times.join(", ")}` : "chưa đặt giờ"} · {group.scheduleConfig?.enabled ? `tự động ${group.scheduleConfig?.dailyLimit || group.scheduleConfig.times?.length || 1} video/ngày` : "tự động tắt"}</small></div><span>{group.folderBinding || "Content local"}</span></div>) : <p className="meta-empty">Tạo nhóm Page để quản lý content theo kênh.</p>}</div>
        </div>
      </section>
      <div className="social-layout">
        <aside className="social-panel">
          <div className="social-panel-header"><h2>Facebook Pages</h2><span>{pages.length} Page</span></div>
          <div className="social-page-list">
            {pages.length ? pages.map((page) => (
              <button key={page.id} className={`social-page-item ${selectedPageId === page.id ? "selected" : ""} ${page.archived ? "archived" : ""}`} onClick={() => setSelectedPageId(page.id)}>
                <span className="social-page-icon">f</span><span><strong>{page.name}</strong><small>{page.archived ? "Đã lưu trữ" : page.timezone}</small></span><i className="social-page-state" />
              </button>
            )) : <p className="social-page-empty">Thêm Page đầu tiên để bắt đầu soạn bài.</p>}
          </div>
          {selectedPage && <div className="social-panel-footer"><Button onClick={() => setPageDialog({ mode: "edit", page: selectedPage })}><Edit3 size={14} /> Sửa Page</Button><button className="text-button danger-text" onClick={() => deletePage(selectedPage)}><Trash2 size={14} /> Xóa Page</button></div>}
        </aside>
        <section className="social-posts">
          <div className="social-post-toolbar">
            <select aria-label="Lọc trạng thái" value={postFilter} onChange={(event) => setPostFilter(event.target.value)}><option value="all">Tất cả trạng thái</option><option value="draft">Bản nháp</option><option value="ready">Đã duyệt</option><option value="scheduled">Có lịch dự kiến</option><option value="published">Đã ghi nhận đăng</option></select>
            <input aria-label="Tìm bài đăng" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm tiêu đề hoặc caption…" />
            <div className="social-post-meta"><span><ClipboardList size={14} /> {projectPosts.length} bài trong {project.name}</span>{selectedPage && <span>{selectedPage.name}</span>}</div>
          </div>
          {projectPosts.length ? <div className="social-post-list">{projectPosts.map((post) => {
            const page = pages.find((item) => item.id === post.pageId);
            const media = mediaFor(post, data.media || []);
            const immutable = post.status === "published";
            return <article className={`social-post-card ${immutable ? "is-published" : ""}`} key={post.id}>
              <div className="social-post-topline"><h3>{post.title}</h3><Badge status={post.status} /></div>
              <div className="social-post-meta"><span>{page?.name || "Page không còn tồn tại"}</span><span>{statusLabels[post.status] || post.status}</span>{post.scheduledAt && <span><CalendarClock size={13} /> {localDate(post.scheduledAt, page?.timezone)}</span>}</div>
              {post.caption && <p className="social-post-caption">{post.caption}</p>}
              {media && <div className="social-post-media"><div className="social-post-media-thumb"><PreviewMedia media={media} /></div><span className="social-post-media-name">{media.name}</span></div>}
              {post.publication && <div className={`social-export-box ${post.publication.source === "meta" && post.publication.firstCommentError ? "is-error" : ""}`}><strong>{post.publication.source === "meta" ? (post.publication.firstCommentError ? "Reel đã đăng · first comment lỗi" : "Reel đã đăng trên Meta") : "Đã ghi nhận đăng thủ công"}</strong><p>{post.publication.externalPostId} · {localDate(post.publication.publishedAt, page?.timezone)}</p>{post.publication.firstCommentError && <p className="social-post-publication-error">{post.publication.firstCommentError}</p>}<a href={post.publication.permalink} target="_blank" rel="noreferrer">Mở permalink <ExternalLink size={12} /></a></div>}
              <div className="social-post-actions"><Button onClick={() => setPreviewPost(post)}><Send size={14} /> Xem trước</Button>{!immutable && <><Button disabled={busyId === `post:${post.id}`} onClick={() => setPostDialog({ mode: "edit", post })}><Edit3 size={14} /> Sửa</Button>{post.status === "draft" && <Button disabled={busyId === `post:${post.id}`} variant="primary" onClick={() => approvePost(post)}><Check size={14} /> Duyệt</Button>}{(post.status === "ready" || post.status === "scheduled") && <Button disabled={busyId === `post:${post.id}`} onClick={() => schedulePost(post)}><CalendarClock size={14} /> Lên lịch</Button>}<Button disabled={busyId === `post:${post.id}`} onClick={() => deletePost(post)} className="danger-text"><Trash2 size={14} /></Button></>}{(immutable || post.status !== "draft") && <Button disabled={busyId === `post:${post.id}`} onClick={() => duplicatePost(post)}><Copy size={14} /> Nhân bản</Button>}{(post.status === "ready" || post.status === "scheduled") && <Button disabled={busyId === `export:${post.id}`} onClick={() => exportPost(post)}><FileDown size={14} /> Xuất gói</Button>}{(post.status === "ready" || post.status === "scheduled") && meta?.connected && meta?.boundPage?.id === page?.externalId && <Button variant="primary" disabled={metaBusy} onClick={() => publishMeta(post)}><Send size={14} /> Publish Reel</Button>}</div>
            </article>;
          })}</div> : <div className="social-empty"><Newspaper size={30} /><h3>{selectedPage ? "Chưa có bài đăng trong dự án này" : "Chưa có Page để quản lý"}</h3><p>{selectedPage ? "Tạo bản nháp, chọn media từ thư viện hiện tại rồi duyệt trước khi xuất handoff package." : "Tạo một Facebook Page local để bắt đầu chuẩn bị nội dung."}</p></div>}
        </section>
      </div>

      {pageDialog && <Modal title={pageDialog.mode === "edit" ? "Sửa Facebook Page" : "Thêm Facebook Page"} onClose={() => setPageDialog(null)}><form onSubmit={savePage}><div className="social-form-grid"><Field label="Tên Page"><input name="name" required maxLength={120} defaultValue={pageDialog.page?.name || ""} autoFocus placeholder="Ví dụ: Vira Home" /></Field><Field label="Page ID (tùy chọn)"><input name="externalId" inputMode="numeric" defaultValue={pageDialog.page?.externalId || ""} placeholder="ID chỉ gồm chữ số" /></Field><Field label="URL Facebook (tùy chọn)" hint="Chỉ dùng liên kết HTTPS facebook.com."><input name="url" type="url" defaultValue={pageDialog.page?.url || ""} placeholder="https://www.facebook.com/..." /></Field><Field label="Múi giờ"><input name="timezone" defaultValue={pageDialog.page?.timezone || "Asia/Bangkok"} placeholder="Asia/Bangkok" /></Field><Field label="Ghi chú" ><textarea name="notes" rows="3" defaultValue={pageDialog.page?.notes || ""} maxLength={5000} /></Field>{pageDialog.mode === "edit" && <label className="check-field"><input name="archived" type="checkbox" defaultChecked={pageDialog.page?.archived} /><span className="checkbox"><Archive size={12} /></span> Lưu trữ Page (ngăn tạo/duyệt/xuất bài mới)</label>}</div><div className="social-dialog-actions"><Button type="button" onClick={() => setPageDialog(null)}>Hủy</Button><Button variant="primary" busy={busyId.startsWith("page:")}>{pageDialog.mode === "edit" ? "Lưu thay đổi" : "Thêm Page"}</Button></div></form></Modal>}

      {postDialog && <Modal wide title={postDialog.mode === "edit" ? "Sửa bài đăng" : "Tạo bài đăng"} onClose={() => setPostDialog(null)}><form onSubmit={savePost}><div className="social-form-grid"><Field label="Tiêu đề"><input name="title" required maxLength={200} defaultValue={postDialog.post?.title || ""} autoFocus placeholder="Tiêu đề nội bộ" /></Field><Field label="Page"><select name="pageId" defaultValue={postDialog.post?.pageId || selectedPageId} disabled={postDialog.post?.status === "published"}>{pages.filter((page) => !page.archived || page.id === postDialog.post?.pageId).map((page) => <option key={page.id} value={page.id}>{page.name}{page.archived ? " (đã lưu trữ)" : ""}</option>)}</select></Field><Field label="Page group" hint="Preflight checks the selected Meta Page group."><select name="pageGroupId" defaultValue={postDialog.post?.pageGroupId || ""}><option value="">No group</option>{(meta?.pageGroups || []).map((group) => <option key={group.id} value={group.id}>{group.name} - {group.pageIds.length} pages</option>)}</select></Field><Field label="Token pool" hint="Publisher chooses a healthy token from this pool."><select name="tokenGroupId" defaultValue={postDialog.post?.tokenGroupId || ""}><option value="">Auto-select healthy token</option>{(meta?.tokenGroups || []).map((group) => <option key={group.id} value={group.id}>{group.name} - {group.tokenIds.length} tokens</option>)}</select></Field><Field label="Caption" hint="Có thể duyệt bài có caption hoặc media hợp lệ."><textarea name="caption" rows="6" maxLength={20000} defaultValue={postDialog.post?.caption || ""} placeholder="Viết nội dung bài đăng…" /></Field><Field label="Media từ thư viện"><MediaChoice media={projectMedia} selected={postDialog.post?.mediaIds?.[0] || ""} onChange={(value) => { setPostDialog((current) => ({ ...current, post: { ...current.post, mediaIds: value ? [value] : [] } })); }} /></Field><Field label="Trạng thái"><select name="status" defaultValue={postDialog.post?.status || "draft"}><option value="draft">Bản nháp</option><option value="ready">Duyệt nội dung</option><option value="scheduled">Lịch dự kiến</option></select></Field><Field label="Thời gian dự kiến" hint="Nhập theo giờ máy; hệ thống lưu timestamp UTC."><input name="scheduledAt" type="datetime-local" defaultValue={localDateInput(postDialog.post?.scheduledAt)} /></Field><Field label="Ghi chú" ><textarea name="notes" rows="2" maxLength={5000} defaultValue={postDialog.post?.notes || ""} /></Field></div><p className="social-form-hint">Lịch dự kiến chỉ là thông tin biên tập. Xuất gói không đánh dấu bài đã đăng và không gọi mạng xã hội.</p><div className="social-dialog-actions"><Button type="button" onClick={() => setPostDialog(null)}>Hủy</Button><Button variant="primary" busy={busyId.startsWith("post:")}>{postDialog.mode === "edit" ? "Lưu bài" : "Tạo bản nháp"}</Button></div></form></Modal>}

      {previewPost && <Modal wide title="Xem trước bài đăng" onClose={() => setPreviewPost(null)}><div className="social-preview">{mediaFor(previewPost, data.media || []) && <PreviewMedia media={mediaFor(previewPost, data.media || [])} className="social-preview-media" />}<div className="social-preview-copy"><strong>{previewPost.title}</strong><p>{previewPost.caption || "(Không có caption)"}</p></div></div><div className="social-dialog-actions"><Button onClick={() => setPreviewPost(null)}>Đóng</Button></div></Modal>}

      {exportResult && <Modal title="Gói đăng đã sẵn sàng" onClose={() => setExportResult(null)}><div className="social-export-box"><strong>Handoff package · revision {exportResult.revision}</strong><p>Gói chỉ chứa caption, manifest và media đã chọn. Hãy tải xuống rồi đăng bằng công cụ bên ngoài.</p><div className="social-export-files">{exportResult.files?.map((file) => <a key={file.name} href={file.url} download><Download size={13} /> {file.name}</a>)}</div></div><details><summary>Xem manifest</summary><pre className="code-block">{JSON.stringify(exportResult.manifest, null, 2)}</pre></details><div className="social-dialog-actions"><Button onClick={() => setExportResult(null)}>Đóng</Button><Button variant="primary" onClick={() => { setPublicationPost({ ...exportResult.post, revision: exportResult.revision }); setExportResult(null); }}><Link2 size={14} /> Ghi nhận sau khi đăng</Button></div></Modal>}

      {publicationPost && <Modal title="Ghi nhận đăng thủ công" onClose={() => setPublicationPost(null)}><p className="social-manual-label">Chỉ thực hiện sau khi bạn đã đăng bài bằng công cụ bên ngoài. Nhập đúng permalink và ID bài đăng; Studio không xác minh hay gửi nội dung.</p><form onSubmit={recordPublication}><Field label="External post ID"><input name="externalPostId" required pattern="[A-Za-z0-9_-]{1,200}" placeholder="ID từ công cụ đăng" /></Field><Field label="Permalink Facebook"><input name="permalink" type="url" required placeholder="https://www.facebook.com/..." /></Field><Field label="Thời điểm đã đăng"><input name="publishedAt" type="datetime-local" required defaultValue={localDateInput(new Date().toISOString())} /></Field><div className="social-dialog-actions"><Button type="button" onClick={() => setPublicationPost(null)}>Hủy</Button><Button variant="primary" busy={busyId.startsWith("publish:")}><Check size={14} /> Ghi nhận</Button></div></form></Modal>}

      {tokenDialogOpen && <Modal wide title="Thêm credential Meta vào vault" onClose={() => setTokenDialogOpen(false)}><form onSubmit={addToken}><p className="social-form-hint">Chọn một trong hai cách xác thực. System User dùng token đã cấp Page asset; Via Token cần App ID, App Secret và Via Token để kiểm tra qua <code>/debug_token</code>. Secret chỉ lưu local và không trả về giao diện.</p><Field label={tokenForm.kind === "VIA_TOKEN" ? "Via Token" : "System User access token"}><input type="password" required autoComplete="off" value={metaToken} onChange={(event) => setMetaToken(event.target.value)} placeholder={tokenForm.kind === "VIA_TOKEN" ? "Dán Via Token do bạn sở hữu" : "Dán System User token do bạn sở hữu"} /></Field><div className="social-form-grid"><Field label="Tên kết nối"><input value={tokenForm.name} maxLength={120} placeholder="Ví dụ: Team Content 01" onChange={(event) => setTokenForm((current) => ({ ...current, name: event.target.value }))} /></Field><Field label="Loại credential"><select value={tokenForm.kind} onChange={(event) => setTokenForm((current) => ({ ...current, kind: event.target.value }))}><option value="SYSTEM_USER">System User</option><option value="VIA_TOKEN">Via Token · App ID + App Secret</option></select></Field>{tokenForm.kind === "VIA_TOKEN" && <><Field label="App ID"><input required value={tokenForm.appId} maxLength={200} autoComplete="off" placeholder="Meta App ID" onChange={(event) => setTokenForm((current) => ({ ...current, appId: event.target.value }))} /></Field><Field label="App Secret"><input required type="password" value={tokenForm.appSecret} maxLength={5000} autoComplete="new-password" placeholder="Meta App Secret" onChange={(event) => setTokenForm((current) => ({ ...current, appSecret: event.target.value }))} /></Field></>}<Field label="Ghi chú"><textarea rows="3" maxLength={2000} value={tokenForm.note} onChange={(event) => setTokenForm((current) => ({ ...current, note: event.target.value }))} /></Field></div><div className="meta-token-type-help"><Info size={15} /><span>{tokenForm.kind === "VIA_TOKEN" ? "Via Token được kiểm tra bằng App ID + App Secret trước khi đồng bộ Page. Nếu App ID không khớp, Meta sẽ từ chối." : "System User token cần được cấp Page asset và quyền phù hợp trong Meta Business Settings."}</span></div><div className="social-dialog-actions"><Button type="button" onClick={() => setTokenDialogOpen(false)}>Hủy</Button><Button variant="primary" busy={metaBusy}><ShieldCheck size={14} /> Kiểm tra &amp; lưu</Button></div></form></Modal>}

      {groupDialog && <Modal wide title={`Tạo nhóm ${groupDialog.kind === "token" ? "token" : "Page"}`} onClose={() => setGroupDialog(null)}><form onSubmit={saveMetaGroup}><Field label="Tên nhóm"><input name="name" required maxLength={120} autoFocus placeholder={groupDialog.kind === "token" ? "Ví dụ: Team A · quota thấp" : "Ví dụ: Page bán hàng miền Bắc"} /></Field><div className="meta-group-picker"><strong>{groupDialog.kind === "token" ? "Chọn token trong nhóm" : "Chọn Page trong nhóm"}</strong>{(groupDialog.kind === "token" ? (meta?.tokens || []) : (meta?.pages || [])).map((item) => <label key={item.id}><input type="checkbox" name={groupDialog.kind === "token" ? "tokenIds" : "pageIds"} value={item.id} /><span>{item.name || item.id}</span><small>{item.id}</small></label>)}{!(groupDialog.kind === "token" ? meta?.tokens?.length : meta?.pages?.length) && <p className="meta-empty">Chưa có dữ liệu để thêm vào nhóm.</p>}</div><div className="social-dialog-actions"><Button type="button" onClick={() => setGroupDialog(null)}>Hủy</Button><Button variant="primary"><FolderPlus size={14} /> Tạo nhóm</Button></div></form></Modal>}
    </div>
  );
}

