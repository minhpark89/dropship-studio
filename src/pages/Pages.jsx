import { useEffect, useState } from "react";
import { CalendarClock, Check, ClipboardList, Filter, FolderPlus, Info, KeyRound, Link2, Plus, RefreshCw, Send, ShieldCheck, Trash2, UsersRound, Video, WandSparkles } from "lucide-react";
import { api } from "../api.js";
import { Badge, Button, Empty, Field, Modal, Notice } from "../components.jsx";
import { isPublishableVideo, mediaOutputType } from "../../shared/output-media.js";

const blankPage = { name: "", externalId: "", url: "", timezone: "Asia/Bangkok", notes: "", archived: false };
const blankMetaTokenForm = () => ({ name: "", kind: "SYSTEM_USER", appId: "", appSecret: "", note: "" });

function splitTokens(value) {
  return [...new Set(String(value || "").split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean))].slice(0, 100);
}

function localDateTimeValue(value = Date.now() + 10 * 60_000) {
  const date = new Date(value);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function tokenLoadLabel(group) {
  const loads = Object.values(group?.assignmentLoads || {}).map(Number).filter((value) => Number.isFinite(value));
  if (!loads.length) return "chưa chia Page";
  const minimum = Math.min(...loads);
  const maximum = Math.max(...loads);
  return minimum === maximum ? `${minimum} Page/token` : `${minimum}–${maximum} Page/token`;
}

export function DistributionPanel({ data, notify, projectId = "" }) {
  const projectPosts = (data.socialPosts || []).filter((post) => !projectId || post.projectId === projectId);
  const [posts, setPosts] = useState(projectPosts);
  const [selectedIds, setSelectedIds] = useState([]);
  const [groupId, setGroupId] = useState("");
  const [tokenGroupId, setTokenGroupId] = useState("");
  const [startAt, setStartAt] = useState("");
  const [staggerMinutes, setStaggerMinutes] = useState(15);
  const [busy, setBusy] = useState("");
  const pages = (data.socialPages || []).filter((page) => !page.archived);
  const groups = data.settings?.meta?.pageGroups || [];
  const tokenGroups = data.settings?.meta?.tokenGroups || [];
  const media = (data.media || []).filter((item) => !projectId || item.projectId === projectId || !item.projectId);
  const mediaById = new Map(media.map((item) => [item.id, item]));
  const eligible = media.filter((item) => isPublishableVideo(item, data.jobs) && !posts.some((post) => post.mediaIds?.includes(item.id)));
  const contentTypeFor = (item) => mediaOutputType(item, data.jobs) === "news" ? "news" : "product";
  const warehouse = posts.filter((post) => post.mediaIds?.some((id) => isPublishableVideo(mediaById.get(id), data.jobs)));

  useEffect(() => setPosts((data.socialPosts || []).filter((post) => !projectId || post.projectId === projectId)), [data.socialPosts, projectId]);

  const refresh = async () => {
    const state = await api("/state");
    setPosts((state.socialPosts || []).filter((post) => !projectId || post.projectId === projectId));
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
  const syncWarehouse = async () => {
    if (!eligible.length) {
      notify("Chưa có video render đủ điều kiện mới trong thư viện.");
      return;
    }
    setBusy("warehouse");
    let added = 0;
    try {
      for (const item of eligible) {
        try {
          await api(`/content/from-media/${item.id}`, { pageId: "", source: "warehouse-sync", contentType: contentTypeFor(item) });
          added += 1;
        } catch {
          // Keep scanning; one missing link/LLM response must not block the rest of the warehouse.
        }
      }
      await refresh();
      notify(`Đã quét ${eligible.length} video; thêm ${added} video vào kho bài.`);
    } finally {
      setBusy("");
    }
  };
  const assignPage = async (post, pageId) => {
    if (!pageId || post.status === "published") return;
    const result = await action(`page:${post.id}`, () => api(`/social/posts/${post.id}`, { pageId, revision: post.revision }, "PATCH"), "Đã gắn Page cho bài.");
    if (result) setPosts((current) => current.map((item) => item.id === result.id ? result : item));
  };
  const publishNow = async (post) => {
    if (!post.pageId) {
      notify("Chọn Page trước khi đăng ngay.", "error");
      return;
    }
    const result = await action(`now:${post.id}`, () => api(`/social/posts/${post.id}/publish-now`, { pageId: post.pageId, revision: post.revision, tokenGroupId: tokenGroupId || undefined }, "POST"), "Đã đưa video vào hàng đăng ngay; Meta scheduler sẽ xử lý.");
    if (result) setPosts((current) => current.map((item) => item.id === result.id ? result : item));
  };
  const schedule = async () => {
    if (!groupId || !selectedIds.length) {
      notify("Chọn nhóm Page và ít nhất một video trong kho.", "error");
      return;
    }
    const result = await action("schedule", () => api(`/social/groups/${groupId}/schedule`, {
      postIds: selectedIds,
      ...(startAt ? { startAt: new Date(startAt).toISOString() } : {}),
      staggerMinutes: Number(staggerMinutes),
      tokenGroupId: tokenGroupId || undefined,
    }, "POST"), "Đã xếp lịch theo nhóm; scheduler sẽ tự publish khi đến giờ.");
    if (result) {
      setSelectedIds([]);
      await refresh();
    }
  };
  const toggle = (id) => setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const selectAll = () => setSelectedIds(selectedIds.length === warehouse.length ? [] : warehouse.map((post) => post.id));

  return <section className="pages-distribution-view">
    <div className="hub-panel pages-distribution-panel">
      <div className="hub-panel-heading"><div><span className="hub-kicker"><ClipboardList size={14} /> CONTENT WAREHOUSE</span><h2>Kho video &amp; quản lý bài đăng</h2><p className="pages-panel-copy">Video render xong sẽ tự tạo một bản Content trong kho. Gắn Page, chọn nhóm, rồi đặt một lịch chung cho cả lô.</p></div><div className="hub-heading-actions"><Button onClick={refresh} busy={busy === "refresh"}><RefreshCw size={14} /> Làm mới kho</Button><Button variant="primary" onClick={syncWarehouse} busy={busy === "warehouse"}><Video size={14} /> Quét video đủ điều kiện</Button></div></div>
      <div className="pages-distribution-metrics"><div><strong>{eligible.length}</strong><span>video mới đủ điều kiện</span></div><div><strong>{warehouse.length}</strong><span>bài trong kho</span></div><div><strong>{selectedIds.length}</strong><span>đang chọn để xếp lịch</span></div><div><strong>{groups.length}</strong><span>nhóm Page có lịch</span></div></div>
      <div className="pages-render-rules"><strong>Quy tắc render 0.5.14</strong><span>mỗi item giữ đúng tin và MC đã chọn</span><span>ảnh editorial được xoay thứ tự + chuyển động theo biến thể</span><span>mỗi video có một bản Content riêng, không ghi đè video khác</span><span>chỉ bài đã gắn Page và qua preflight mới được scheduler publish</span></div>
      <div className="pages-schedule-toolbar"><label><span>Nhóm Page</span><select value={groupId} onChange={(event) => setGroupId(event.target.value)}><option value="">Chọn nhóm để xếp lịch</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name} · {group.pageIds.length} Page · {group.scheduleConfig?.times?.length ? group.scheduleConfig.times.join(", ") : "giờ tùy chọn"}</option>)}</select></label><label><span>Token pool</span><select value={tokenGroupId} onChange={(event) => setTokenGroupId(event.target.value)}><option value="">Tự chọn token khỏe</option>{tokenGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label><label><span>Bắt đầu <small>(trống = khung giờ nhóm)</small></span><input type="datetime-local" value={startAt} min={localDateTimeValue()} onChange={(event) => setStartAt(event.target.value)} /></label><label><span>Cách nhau (phút)</span><input type="number" min="0" max="1440" value={staggerMinutes} onChange={(event) => setStaggerMinutes(event.target.value)} /></label><Button variant="primary" onClick={schedule} busy={busy === "schedule"} disabled={!selectedIds.length || !groupId}><CalendarClock size={14} /> Xếp lịch nhóm</Button></div>
      <div className="pages-warehouse-heading"><div><strong>Video trong kho</strong><small>Chọn video để phân phối sang các Page theo lịch nhóm.</small></div><Button onClick={selectAll}>{selectedIds.length === warehouse.length && warehouse.length ? "Bỏ chọn tất cả" : "Chọn tất cả"}</Button></div>
      {warehouse.length ? <div className="pages-warehouse-list">{warehouse.map((post) => { const attached = mediaById.get(post.mediaIds?.[0]); const page = pages.find((item) => item.id === post.pageId); return <article className={`pages-warehouse-row ${selectedIds.includes(post.id) ? "selected" : ""}`} key={post.id}><input type="checkbox" checked={selectedIds.includes(post.id)} onChange={() => toggle(post.id)} aria-label={`Chọn ${post.title}`} /><div className="pages-warehouse-thumb">{attached?.thumbnailUrl ? <img src={attached.thumbnailUrl} alt="" /> : <Video size={18} />}</div><div className="pages-warehouse-copy"><strong>{post.title}</strong><small>{attached?.name || "Video render"} · {post.contentType === "news" ? "News" : "Product"} · {post.status}</small>{post.automationError && <em>{post.automationError}</em>}</div><select aria-label={`Page cho ${post.title}`} value={post.pageId || ""} onChange={(event) => assignPage(post, event.target.value)} disabled={post.status === "published"}><option value="">Chưa gắn Page</option>{pages.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><span className={`pages-warehouse-state ${post.status}`}>{post.status === "scheduled" ? "Đã xếp lịch" : page?.name || "Chờ phân phối"}</span>{post.status !== "published" && <Button className="pages-warehouse-now" onClick={() => publishNow(post)} busy={busy === `now:${post.id}`} disabled={!post.pageId}><Send size={12} /> Đăng ngay</Button>}</article>; })}</div> : <Empty icon={Send} title="Kho bài đang trống">Khi video render hoàn tất, Studio sẽ đưa video vào đây để gắn Page và xếp lịch.</Empty>}
    </div>
  </section>;
}

export function PagesPage({ data, notify }) {
  const [pages, setPages] = useState(data.socialPages || []);
  const [meta, setMeta] = useState(null);
  const [pageForm, setPageForm] = useState(blankPage);
  const [modal, setModal] = useState(null);
  const [token, setToken] = useState("");
  const [bulkTokens, setBulkTokens] = useState("");
  const [tokenForm, setTokenForm] = useState(blankMetaTokenForm);
  const [groupName, setGroupName] = useState("");
  const [groupTimes, setGroupTimes] = useState("");
  const [groupStagger, setGroupStagger] = useState(15);
  const [groupDailyLimit, setGroupDailyLimit] = useState(0);
  const [groupAutomation, setGroupAutomation] = useState(false);
  const [groupTokenGroupId, setGroupTokenGroupId] = useState("");
  const [groupStrategy, setGroupStrategy] = useState("round_robin");
  const [groupMaxPagesPerToken, setGroupMaxPagesPerToken] = useState(0);
  const [selectedIds, setSelectedIds] = useState([]);
  const [busy, setBusy] = useState("");
  const [pageFilter, setPageFilter] = useState("all");
  const [view, setView] = useState("pages");
  const [avatarTargetMode, setAvatarTargetMode] = useState("all");
  const [avatarPageIds, setAvatarPageIds] = useState([]);
  const [bulkProgress, setBulkProgress] = useState(null);
  const [tokenSyncProgress, setTokenSyncProgress] = useState(null);

  useEffect(() => {
    setPages(data.socialPages || []);
    let cancelled = false;
    api("/meta")
      .then((next) => { if (!cancelled) setMeta(next); })
      .catch(() => { if (!cancelled) setMeta(data.settings?.meta || null); });
    return () => { cancelled = true; };
  }, [data.socialPages, data.settings?.meta?.activeTokenId, data.settings?.meta?.enabled, data.settings?.meta?.pages?.length, data.settings?.meta?.tokens?.length]);

  const closeModal = () => {
    setModal(null);
    setBulkProgress(null);
  };

  const refreshMeta = async ({ sync = false } = {}) => {
    const canSync = sync && (meta?.connected || meta?.activeToken?.id);
    const next = canSync
      ? await api("/meta/refresh-pages", { tokenId: meta?.activeToken?.id || undefined }, "POST")
      : await api("/meta");
    setMeta(next);
    return next;
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

  const savePage = async (event) => {
    event.preventDefault();
    const input = Object.fromEntries(new FormData(event.currentTarget));
    const value = { ...input, archived: input.archived === "on" };
    const editing = modal?.type === "page-edit";
    const result = await action("page", () => editing
      ? api(`/social/pages/${modal.page.id}`, { ...value, revision: modal.page.revision }, "PATCH")
      : api("/social/pages", value, "POST"), editing ? "Đã cập nhật Page." : "Đã thêm Page.");
    if (result) {
      setPages((current) => editing ? current.map((page) => page.id === result.id ? result : page) : [result, ...current]);
      closeModal();
    }
  };

  const syncLocalPages = async () => {
    const result = await action("sync-local-pages", () => api("/social/pages/sync-meta", { pageIds: (meta?.pages || []).map((item) => item.id) }, "POST"), "Đã tạo Page local từ danh sách Meta.");
    if (result?.pages?.length) setPages((current) => {
      const byExternalId = new Map(current.map((page) => [page.externalId, page]));
      for (const page of result.pages) byExternalId.set(page.externalId, page);
      return [...byExternalId.values()];
    });
  };

  const addToken = async (event) => {
    event.preventDefault();
    const result = await action("token", () => api("/meta/tokens", { accessToken: token, ...tokenForm }, "POST"), "Đã xác minh token và đồng bộ Page.");
    if (result) {
      setToken("");
      setTokenForm(blankMetaTokenForm());
      closeModal();
      await refreshMeta();
    }
  };

  const addBulkTokens = async (event) => {
    event.preventDefault();
    if (busy) return;
    const tokens = splitTokens(bulkTokens);
    if (!tokens.length) {
      notify("Hãy dán ít nhất một token.", "error");
      return;
    }
    setBusy("bulk-token");
    const progress = { current: 0, total: tokens.length, ok: 0, failed: 0, finished: false };
    setBulkProgress({ ...progress });
    for (const accessToken of tokens) {
      try {
        await api("/meta/tokens", {
          accessToken,
          name: tokenForm.name,
          kind: tokenForm.kind,
          appId: tokenForm.appId,
          appSecret: tokenForm.appSecret,
          note: tokenForm.note,
        }, "POST");
        progress.ok += 1;
      } catch {
        progress.failed += 1;
      }
      progress.current += 1;
      setBulkProgress({ ...progress });
    }
    progress.finished = true;
    setBulkProgress({ ...progress });
    setBusy("");
    setBulkTokens("");
    await refreshMeta();
    notify(`Đã kiểm tra ${progress.total} token: ${progress.ok} hợp lệ, ${progress.failed} lỗi.`);
  };

  const refreshAllTokens = async () => {
    if (busy) return;
    const tokens = Array.isArray(meta?.tokens) ? meta.tokens.filter((item) => item.id) : [];
    if (!tokens.length) {
      notify("Chưa có token để đồng bộ.", "error");
      return;
    }
    const progress = { current: 0, total: tokens.length, ok: 0, failed: 0, finished: false };
    setBusy("refresh-all");
    setTokenSyncProgress({ ...progress });
    let lastError = "";
    try {
      for (const token of tokens) {
        try {
          await api(`/meta/tokens/${token.id}/refresh-pages`, {}, "POST");
          progress.ok += 1;
        } catch (error) {
          progress.failed += 1;
          lastError = error.message || lastError;
        }
        progress.current += 1;
        setTokenSyncProgress({ ...progress });
        if (progress.current < progress.total) {
          const delay = progress.current % 10 === 0 ? 5000 : 800;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      progress.finished = true;
      setTokenSyncProgress({ ...progress });
      try {
        setMeta(await api("/meta"));
      } catch (error) {
        lastError = error.message || lastError;
      }
      if (progress.failed) notify(`Đã đồng bộ ${progress.ok}/${progress.total} token; ${progress.failed} token lỗi${lastError ? `: ${lastError}` : "."}`, "error");
      else notify(`Đã đồng bộ ${progress.ok} token và tải đủ danh sách Page.`);
    } finally {
      setBusy("");
    }
  };

  const bindPage = async (event) => {
    const pageId = event.target.value;
    if (!pageId) return;
    await action("bind", () => api("/meta/bind", { pageId }, "POST"), "Đã gắn Page Meta.");
    await refreshMeta();
  };

  const saveGroup = async (event) => {
    event.preventDefault();
    const kind = modal?.type === "token-group" ? "token" : "page";
    const body = {
      name: groupName,
      ...(kind === "token"
        ? { tokenIds: selectedIds, strategy: groupStrategy, maxPagesPerToken: Number(groupMaxPagesPerToken) || 0, autoAssign: true }
        : { id: modal?.group?.id, pageIds: selectedIds, scheduleConfig: { times: splitTokens(groupTimes).filter((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)), staggerMinutes: Number(groupStagger) || 15, dailyLimit: Number(groupDailyLimit) || 0, enabled: groupAutomation, autoPublish: groupAutomation, tokenGroupId: groupTokenGroupId || "" } }),
    };
    const result = await action("group", () => api(`/meta/${kind}-groups`, body, "POST"), "Đã tạo nhóm.");
    if (result) {
      setGroupName("");
      setGroupTimes("");
      setGroupStagger(15);
      setGroupDailyLimit(0);
      setGroupAutomation(false);
      setGroupTokenGroupId("");
      setGroupStrategy("round_robin");
      setGroupMaxPagesPerToken(0);
      setSelectedIds([]);
      closeModal();
      await refreshMeta();
    }
  };

  const connected = Boolean(meta?.connected);
  const verifiedPages = (meta?.pages || []).filter((page) => page.tokenIds?.length).length;
  const activePages = pages.filter((page) => !page.archived).length;
  const openGroup = (type, group = null) => {
    const config = group?.scheduleConfig || {};
    setGroupName(group?.name || "");
    setGroupTimes(Array.isArray(config.times) ? config.times.join(", ") : "");
    setGroupStagger(config.staggerMinutes || 15);
    setGroupDailyLimit(config.dailyLimit || 0);
    setGroupAutomation(config.enabled === true || config.autoPublish === true);
    setGroupTokenGroupId(config.tokenGroupId || "");
    setGroupStrategy(group?.strategy || "round_robin");
    setGroupMaxPagesPerToken(group?.maxPagesPerToken || 0);
    setSelectedIds(group ? [...(group.pageIds || [])] : []);
    setModal({ type, group });
  };
  const groupItems = modal?.type === "token-group" ? (meta?.tokens || []) : (meta?.pages || []);
  const pageHealth = (page) => page.health || (page.tokenIds?.length ? "HEALTHY" : "UNVERIFIED");
  const allMetaPages = meta?.pages || [];
  const visibleMetaPages = allMetaPages.filter((page) => pageFilter === "all" || pageHealth(page) === pageFilter);

  const openAvatarModal = () => {
    setAvatarTargetMode("all");
    setAvatarPageIds(visibleMetaPages.map((page) => page.id));
    setModal({ type: "avatar-bulk" });
  };
  const toggleAvatarPage = (pageId) => {
    setAvatarPageIds((current) => current.includes(pageId) ? current.filter((id) => id !== pageId) : [...current, pageId]);
  };
  const pruneGroup = async (group) => {
    const result = await action(`prune:${group.id}`, () => api(`/meta/page-groups/${group.id}/prune`, {}, "POST"), "Đã lọc Page lỗi khỏi nhóm.");
    if (result) await refreshMeta();
  };
  const autoAssignTokenGroup = async (group) => {
    const result = await action(`assign-token-group:${group.id}`, () => api(`/meta/token-groups/${group.id}/auto-assign`, { strategy: group.strategy || "round_robin", maxPagesPerToken: group.maxPagesPerToken || 0 }, "POST"), "Đã tự chia Page theo token khỏe trong pool.");
    if (result) await refreshMeta();
  };
  const generateAvatars = async (event) => {
    event.preventDefault();
    const input = Object.fromEntries(new FormData(event.currentTarget));
    const targetMode = String(input.targetMode || "all");
    const groupId = targetMode.startsWith("group:") ? targetMode.slice("group:".length) : "";
    const ids = targetMode === "selected"
      ? avatarPageIds
      : groupId
        ? (meta?.pageGroups || []).find((group) => group.id === groupId)?.pageIds || []
        : visibleMetaPages.map((page) => page.id);
    if (!ids.length) {
      notify("Chọn ít nhất một Page để đổi avatar.", "error");
      return;
    }
    const result = await action("avatar-bulk", () => api("/meta/page-avatars/generate", { groupId: groupId || undefined, pageIds: ids, prompt: input.prompt, useLlm: input.useLlm === "on", apply: input.apply === "on" }, "POST"), "Đã xử lý avatar AI cho các Page.");
    if (result) { closeModal(); await refreshMeta(); }
  };

  useEffect(() => {
    if (!meta?.connected || !meta?.activeToken?.id || !meta.pages?.length || meta.pages.every((page) => page.avatar)) return;
    let cancelled = false;
    api("/meta/refresh-pages", { tokenId: meta.activeToken.id }, "POST")
      .then((next) => { if (!cancelled) setMeta(next); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [meta?.connected, meta?.activeToken?.id, meta?.pages?.length]);

  return (
    <div className={`page workspace-hub pages-hub pages-view-${view}`}>
      <div className="page-heading hub-heading">
        <div><div className="eyebrow">PAGES WORKSPACE</div><h1>Điều khiển Page gọn trong một màn hình.</h1><p>Chọn đúng khu vực cần làm, xem danh sách trong panel riêng và chuyển sang Content khi đã sẵn sàng.</p></div>
        <div className="hub-heading-actions"><Button onClick={() => refreshMeta({ sync: true })} busy={busy === "refresh"} disabled={Boolean(busy)}><RefreshCw size={15} /> Làm mới Meta</Button><Button onClick={refreshAllTokens} busy={busy === "refresh-all"} disabled={Boolean(busy)}><RefreshCw size={15} /> Đồng bộ tất cả token</Button><Button variant="primary" onClick={() => { setPageForm(blankPage); setModal({ type: "page-add" }); }} disabled={Boolean(busy)}><Plus size={16} /> Thêm Page</Button></div>
      </div>
      <div className="hub-metrics"><div><span>Page đang hoạt động</span><strong>{activePages}</strong><small>kênh nội dung local</small></div><div><span>Page đã xác minh</span><strong>{verifiedPages}</strong><small>có token binding</small></div><div><span>Token khỏe</span><strong>{(meta?.tokens || []).filter((item) => item.status === "ACTIVE").length}</strong><small>được chọn khi publish</small></div><div><span>Nhóm phân phối</span><strong>{(meta?.pageGroups || []).length + (meta?.tokenGroups || []).length}</strong><small>Page + token groups</small></div></div>
      {tokenSyncProgress ? <div className="bulk-token-progress"><div><strong>{tokenSyncProgress.finished ? "Đã hoàn tất đồng bộ Page" : `Đang đồng bộ token ${tokenSyncProgress.current}/${tokenSyncProgress.total}`}</strong><span>{tokenSyncProgress.ok} thành công · {tokenSyncProgress.failed} lỗi</span></div><progress max={tokenSyncProgress.total} value={tokenSyncProgress.current} /><small className="muted">Chạy tuần tự · nghỉ 0,8 giây giữa token và 5 giây sau mỗi 10 token.</small></div> : null}
      <div className="pages-tabs" role="tablist" aria-label="Khu vực Page">
        {[["pages", "Page & avatar", UsersRound], ["tokens", "Token", KeyRound], ["groups", "Nhóm phân phối", FolderPlus], ["distribution", "Kho bài & lịch", ClipboardList]].map(([id, label, Icon]) => <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? "active" : ""} onClick={() => setView(id)}><Icon size={15} /><span>{label}</span></button>)}
      </div>
      <div className="pages-content">
      <section className="hub-hero"><div><span className="hub-kicker"><ShieldCheck size={14} /> WORKFLOW</span><h2>{connected ? "Meta đã sẵn sàng cho Content." : "Kết nối Meta để bắt đầu phân phối."}</h2><p>{connected ? "Chọn Page ở đây, sau đó sang Content để soạn caption, first comment và link bài viết." : "Token được kiểm tra qua /me và /me/accounts; public state chỉ trả metadata và token mask."}</p></div>{connected ? <select aria-label="Page Meta đang gắn" value={meta?.boundPage?.id || ""} onChange={bindPage}><option value="">Chọn Page để gắn</option>{(meta.pages || []).map((page) => <option key={page.id} value={page.id}>{page.name} · {page.id}</option>)}</select> : <Button variant="primary" onClick={() => setModal({ type: "token" })}><KeyRound size={15} /> Thêm token Meta</Button>}</section>
      <section className="hub-panel pages-management-panel pages-panel">
        <div className="hub-panel-heading"><div><span className="hub-kicker"><Filter size={14} /> PAGE HEALTH</span><h2>Page đồng bộ từ Meta</h2></div><div className="hub-heading-actions"><select value={pageFilter} onChange={(event) => setPageFilter(event.target.value)}><option value="all">Tất cả Page</option><option value="HEALTHY">Token khỏe</option><option value="ERROR">Có lỗi</option><option value="UNVERIFIED">Chưa xác minh</option></select><Button onClick={openAvatarModal}><WandSparkles size={14} /> Đổi avatar AI hàng loạt</Button></div></div>
        {visibleMetaPages.length ? <div className="hub-list">{visibleMetaPages.map((page) => <article className="hub-list-row" key={page.id}>{page.avatar ? <img className="hub-avatar-image" src={page.avatar} alt={`Avatar ${page.name}`} /> : <span className="hub-avatar">f</span>}<div><strong>{page.name}</strong><small>{page.id} · {page.bindingCount || page.tokenIds?.length || 0} token binding{page.avatarStatus && page.avatarStatus !== "ready" ? ` · avatar ${page.avatarStatus}` : ""}{page.avatarError ? ` · ${page.avatarError}` : ""}{page.errorMessage ? ` · ${page.errorMessage}` : ""}</small></div><Badge status={pageHealth(page) === "HEALTHY" ? "ready" : pageHealth(page) === "ERROR" ? "error" : "offline"} /></article>)}</div> : <Empty icon={UsersRound} title="Không có Page phù hợp">Đổi bộ lọc hoặc đồng bộ lại token.</Empty>}
      </section>
      <div className="hub-columns pages-columns pages-pages-row">
        <section className="hub-panel pages-local-panel"><div className="hub-panel-heading"><div><span className="hub-kicker">CHANNELS</span><h2>Page local</h2></div><div className="inline-actions"><Button onClick={syncLocalPages} busy={busy === "sync-local-pages"} disabled={!allMetaPages.length}><RefreshCw size={14} /> Tạo từ Meta ({allMetaPages.length})</Button><Button onClick={() => { setPageForm(blankPage); setModal({ type: "page-add" }); }}><Plus size={14} /> Page mới</Button></div></div>{pages.length ? <div className="hub-list">{pages.map((page) => { const metaPage = allMetaPages.find((item) => item.id === page.externalId); const avatar = page.avatar || metaPage?.avatar || ""; return <article className="hub-list-row" key={page.id}>{avatar ? <img className="hub-avatar-image" src={avatar} alt={`Avatar ${page.name}`} /> : <span className="hub-avatar">f</span>}<div><strong>{page.name}</strong><small>{page.externalId || "Chưa gắn Page ID"} · {page.timezone}</small></div><Badge status={page.archived ? "offline" : "ready"} /><Button className="icon-button" aria-label={`Sửa ${page.name}`} onClick={() => { setPageForm(page); setModal({ type: "page-edit", page }); }}><Link2 size={14} /></Button></article>; })}</div> : <Empty icon={UsersRound} title="Chưa có Page local">Bấm “Tạo từ Meta” để đưa Page đã xác minh vào nơi gắn Content và lịch đăng.</Empty>}</section>
        <section className="hub-panel pages-token-panel"><div className="hub-panel-heading"><div><span className="hub-kicker">TOKEN VAULT</span><h2>Credential pool</h2></div><Button onClick={() => setModal({ type: "token" })}><Plus size={14} /> Token</Button></div>{meta?.tokens?.length ? <div className="hub-list">{meta.tokens.map((item) => <article className="hub-list-row" key={item.id}><span className="hub-token-icon"><KeyRound size={14} /></span><div><strong>{item.name}</strong><small>{item.tokenMasked || "***"} · {item.pagesCount || 0} Page · {item.kind === "VIA_TOKEN" ? `Via Token · App ${item.appId || "?"}` : "System User"}</small></div><Badge status={item.status === "ACTIVE" ? "ready" : item.status === "ERROR" ? "error" : "offline"} /><div className="inline-actions"><Button className="icon-button" title="Đồng bộ lại Page" onClick={() => action(`refresh-token:${item.id}`, () => api(`/meta/tokens/${item.id}/refresh-pages`, {}, "POST"), "Đã đồng bộ lại Page từ token.").then(refreshMeta)} busy={busy === `refresh-token:${item.id}`}><RefreshCw size={13} /></Button><Button className="icon-button danger-text" title="Xóa token" onClick={async () => { if (!confirm(`Xóa token ${item.name}?`)) return; const result = await action(`delete-token:${item.id}`, () => api(`/meta/tokens/${item.id}`, {}, "DELETE"), "Đã xóa token."); if (result) await refreshMeta(); }} busy={busy === `delete-token:${item.id}`}><Trash2 size={13} /></Button></div></article>)}</div> : <Empty icon={KeyRound} title="Vault đang trống">Thêm token do bạn sở hữu để xác minh quyền Page.</Empty>}</section>
      </div>
  <div className="hub-columns pages-columns pages-groups-row"><section className="hub-panel pages-page-groups-panel"><div className="hub-panel-heading"><div><span className="hub-kicker">PAGE GROUPS</span><h2>Nhóm Page</h2></div><Button onClick={() => openGroup("page-group")}><FolderPlus size={14} /> Tạo nhóm</Button></div>{(meta?.pageGroups || []).length ? meta.pageGroups.map((group) => <div className="hub-group-row" key={group.id}><strong>{group.name}</strong><span>{group.pageIds.length} Page</span><div className="hub-group-rule"><small>{group.scheduleConfig?.times?.length ? `Mỗi ngày: ${group.scheduleConfig.times.join(", ")}` : "Chưa đặt khung giờ"} · {group.scheduleConfig?.enabled ? `Tự động ${group.scheduleConfig?.dailyLimit || group.scheduleConfig.times?.length || 1} video/ngày` : "Tự động đang tắt"}{group.scheduleConfig?.tokenGroupId ? ` · Pool: ${(meta?.tokenGroups || []).find((item) => item.id === group.scheduleConfig.tokenGroupId)?.name || "đã chọn"}` : ""}</small><Button onClick={() => openGroup("page-group", group)}><CalendarClock size={13} /> Sửa lịch</Button></div><Button onClick={() => pruneGroup(group)} busy={busy === `prune:${group.id}`}><Filter size={13} /> Lọc Page lỗi</Button></div>) : <p className="hub-empty">Tạo nhóm theo kênh, thị trường hoặc lịch đăng.</p>}</section><section className="hub-panel pages-token-groups-panel"><div className="hub-panel-heading"><div><span className="hub-kicker">TOKEN GROUPS</span><h2>Pool token</h2></div><Button onClick={() => openGroup("token-group")}><FolderPlus size={14} /> Tạo pool</Button></div>{(meta?.tokenGroups || []).length ? meta.tokenGroups.map((group) => <div className="hub-group-row" key={group.id}><strong>{group.name}</strong><span>{group.tokenIds.length} token · {group.assignedPageCount || 0}/{group.pageIds?.length || 0} Page đã chia / {tokenLoadLabel(group)}</span><div className="hub-group-rule"><small>{group.strategy === "round_robin" ? "Luân phiên đều" : group.strategy === "random" ? "Ngẫu nhiên" : "Token ít dùng nhất"}{group.maxPagesPerToken ? ` · tối đa ${group.maxPagesPerToken} Page/token` : " · tự cân bằng"}{group.assignmentBlockedCount ? ` · ${group.assignmentBlockedCount} Page cần Sync lại` : ""}</small><Button onClick={() => autoAssignTokenGroup(group)} busy={busy === `assign-token-group:${group.id}`}><RefreshCw size={13} /> Tự chia Page</Button><Button onClick={() => openGroup("token-group", group)}><FolderPlus size={13} /> Sửa pool</Button></div></div>) : <p className="hub-empty">Tạo pool theo team hoặc quota để Studio tự chia Page vào token khỏe.</p>}</section></div>
      </div>
      <DistributionPanel data={data} notify={notify} />
      {modal?.type === "avatar-bulk" ? <Modal wide title="Đổi avatar Page bằng AI" onClose={closeModal}><form onSubmit={generateAvatars}><Notice>Avatar generation is separate from Page publishing; requests are throttled per token.</Notice><Field label="Phạm vi đổi avatar"><select name="targetMode" value={avatarTargetMode} onChange={(event) => setAvatarTargetMode(event.target.value)}><option value="all">Tất cả Page đang hiển thị ({visibleMetaPages.length})</option><option value="selected">Chọn từng Page ({avatarPageIds.length})</option>{(meta?.pageGroups || []).map((group) => <option key={group.id} value={`group:${group.id}`}>Nhóm: {group.name} · {group.pageIds.length} Page</option>)}</select></Field>{avatarTargetMode === "selected" ? <><div className="avatar-picker-toolbar"><span>{avatarPageIds.length} Page được chọn</span><div><Button type="button" onClick={() => setAvatarPageIds(allMetaPages.map((page) => page.id))}>Chọn tất cả</Button><Button type="button" onClick={() => setAvatarPageIds([])}>Bỏ chọn</Button></div></div><div className="hub-picker avatar-page-picker">{allMetaPages.map((page) => <label key={page.id}><input type="checkbox" checked={avatarPageIds.includes(page.id)} onChange={() => toggleAvatarPage(page.id)} />{page.avatar ? <img className="avatar-page-picker-image" src={page.avatar} alt="" /> : <span className="hub-avatar">f</span>}<span><strong>{page.name}</strong><small>{page.id}</small></span></label>)}</div></> : null}<Field label="Mô tả avatar"><textarea name="prompt" rows="4" defaultValue="Professional editorial social media page avatar, clean bold composition, square portrait, consistent brand colors, no text, no logos, no watermark." /></Field><label className="check-field"><input name="useLlm" type="checkbox" defaultChecked={data.settings?.llm?.enabled === true} /><span /> Dùng LLM tối ưu prompt trước khi render</label><label className="check-field"><input name="apply" type="checkbox" /><span /> Áp dụng lên Page Meta sau khi tạo ảnh</label><p className="avatar-rate-note">Một ảnh được tạo và dùng cho các Page đã chọn. Apply chạy tuần tự theo token, nghỉ 1 giây giữa request và 5 giây sau mỗi 10 Page.</p><div className="modal-actions"><Button type="button" onClick={closeModal}>Hủy</Button><Button variant="primary" busy={busy === "avatar-bulk"}><WandSparkles size={15} /> Tạo avatar</Button></div></form></Modal> : null}
      {modal?.type === "page-add" || modal?.type === "page-edit" ? <Modal title={modal.type === "page-edit" ? "Sửa Page" : "Thêm Page local"} onClose={closeModal}><form onSubmit={savePage}><div className="form-grid"><Field label="Tên Page"><input name="name" required maxLength={120} value={pageForm.name} onChange={(event) => setPageForm({ ...pageForm, name: event.target.value })} /></Field><Field label="Page ID"><input name="externalId" inputMode="numeric" value={pageForm.externalId} onChange={(event) => setPageForm({ ...pageForm, externalId: event.target.value })} placeholder="ID Meta" /></Field><Field label="Facebook URL"><input name="url" type="url" value={pageForm.url} onChange={(event) => setPageForm({ ...pageForm, url: event.target.value })} /></Field><Field label="Múi giờ"><input name="timezone" value={pageForm.timezone} onChange={(event) => setPageForm({ ...pageForm, timezone: event.target.value })} /></Field></div><Field label="Ghi chú"><textarea name="notes" rows="3" value={pageForm.notes} onChange={(event) => setPageForm({ ...pageForm, notes: event.target.value })} /> </Field>{modal.type === "page-edit" && <label className="check-field"><input name="archived" type="checkbox" checked={pageForm.archived} onChange={(event) => setPageForm({ ...pageForm, archived: event.target.checked })} /><span /> Lưu trữ Page</label>}<div className="modal-actions"><Button type="button" onClick={closeModal}>Hủy</Button><Button variant="primary" busy={busy === "page"}><Check size={15} /> Lưu Page</Button></div></form></Modal> : null}
      {modal?.type === "token" ? <Modal wide title="Thêm credential Meta" onClose={closeModal}><form onSubmit={addToken}><Notice>Chọn System User hoặc Via Token. Via Token bắt buộc có App ID, App Secret và Via Token; App Secret chỉ lưu local.</Notice><Field label={tokenForm.kind === "VIA_TOKEN" ? "Via Token" : "System User access token"}><input type="password" required autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder={tokenForm.kind === "VIA_TOKEN" ? "Dán Via Token do bạn sở hữu" : "Dán System User token do bạn sở hữu"} /></Field><div className="form-grid"><Field label="Tên kết nối"><input value={tokenForm.name} onChange={(event) => setTokenForm({ ...tokenForm, name: event.target.value })} placeholder="Team Content 01" /></Field><Field label="Loại credential"><select value={tokenForm.kind} onChange={(event) => setTokenForm({ ...tokenForm, kind: event.target.value })}><option value="SYSTEM_USER">System User</option><option value="VIA_TOKEN">Via Token · App ID + App Secret</option></select></Field>{tokenForm.kind === "VIA_TOKEN" && <><Field label="App ID"><input required value={tokenForm.appId} maxLength={200} autoComplete="off" placeholder="Meta App ID" onChange={(event) => setTokenForm({ ...tokenForm, appId: event.target.value })} /></Field><Field label="App Secret"><input required type="password" value={tokenForm.appSecret} maxLength={5000} autoComplete="new-password" placeholder="Meta App Secret" onChange={(event) => setTokenForm({ ...tokenForm, appSecret: event.target.value })} /></Field></>}</div><div className="meta-token-type-help"><Info size={15} /><span>{tokenForm.kind === "VIA_TOKEN" ? "Via Token được kiểm tra qua /debug_token trước khi đồng bộ Page." : "System User token cần được cấp Page asset và quyền phù hợp trong Meta Business Settings."}</span></div><Field label="Ghi chú"><textarea rows="2" value={tokenForm.note} onChange={(event) => setTokenForm({ ...tokenForm, note: event.target.value })} /></Field><Button type="button" onClick={() => { setBulkProgress(null); setModal({ type: "bulk-token" }); }}><KeyRound size={14} /> Nhập nhanh danh sách token</Button><div className="modal-actions"><Button type="button" onClick={closeModal}>Hủy</Button><Button variant="primary" busy={busy === "token"}>Kiểm tra & lưu</Button></div></form></Modal> : null}
      {modal?.type === "bulk-token" ? <Modal wide title="Nhập danh sách token" onClose={closeModal}><form onSubmit={addBulkTokens}><Notice>Dán mỗi token trên một dòng hoặc phân tách bằng dấu phẩy. Studio kiểm tra tuần tự và cập nhật tiến trình sau từng token.</Notice><Field label="Danh sách token"><textarea required rows="8" value={bulkTokens} onChange={(event) => setBulkTokens(event.target.value)} placeholder="token-1\ntoken-2\ntoken-3" disabled={Boolean(bulkProgress && !bulkProgress.finished)} /></Field><div className="form-grid"><Field label="Tên kết nối"><input value={tokenForm.name} onChange={(event) => setTokenForm({ ...tokenForm, name: event.target.value })} placeholder="Team Content" disabled={Boolean(bulkProgress && !bulkProgress.finished)} /></Field><Field label="Loại credential"><select value={tokenForm.kind} onChange={(event) => setTokenForm({ ...tokenForm, kind: event.target.value })} disabled={Boolean(bulkProgress && !bulkProgress.finished)}><option value="SYSTEM_USER">System User</option><option value="VIA_TOKEN">Via Token</option></select></Field></div>{tokenForm.kind === "VIA_TOKEN" && <div className="form-grid"><Field label="App ID"><input required value={tokenForm.appId} onChange={(event) => setTokenForm({ ...tokenForm, appId: event.target.value })} disabled={Boolean(bulkProgress && !bulkProgress.finished)} /></Field><Field label="App Secret"><input required type="password" value={tokenForm.appSecret} onChange={(event) => setTokenForm({ ...tokenForm, appSecret: event.target.value })} disabled={Boolean(bulkProgress && !bulkProgress.finished)} /></Field></div>}<Field label="Ghi chú"><textarea rows="2" value={tokenForm.note} onChange={(event) => setTokenForm({ ...tokenForm, note: event.target.value })} disabled={Boolean(bulkProgress && !bulkProgress.finished)} /></Field>{bulkProgress ? <div className="bulk-token-progress"><div><strong>{bulkProgress.finished ? "Đã hoàn tất kiểm tra token" : `Đang kiểm tra token ${bulkProgress.current}/${bulkProgress.total}`}</strong><span>{bulkProgress.ok} hợp lệ · {bulkProgress.failed} lỗi</span></div><progress max={bulkProgress.total} value={bulkProgress.current} /></div> : null}<div className="modal-actions">{bulkProgress?.finished ? <Button type="button" variant="primary" onClick={closeModal}>Đóng</Button> : <><Button type="button" onClick={closeModal} disabled={Boolean(bulkProgress)}>Hủy</Button><Button variant="primary" busy={busy === "bulk-token"} disabled={Boolean(bulkProgress)}>Kiểm tra danh sách</Button></>}</div></form></Modal> : null}
      {modal?.type === "page-group" || modal?.type === "token-group" ? <Modal title={modal.type === "page-group" ? (modal.group ? "Sửa lịch nhóm Page" : "Tạo nhóm Page") : "Tạo pool token"} onClose={closeModal}><form onSubmit={saveGroup}><Field label="Tên nhóm"><input required autoFocus value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder={modal.type === "page-group" ? "Ví dụ: Page miền Bắc" : "Ví dụ: Team A"} /></Field>{modal.type === "page-group" ? <><div className="form-grid"><Field label="Khung giờ đăng" hint="HH:mm, cách nhau bằng dấu phẩy"><input value={groupTimes} onChange={(event) => setGroupTimes(event.target.value)} placeholder="09:00, 15:00, 20:00" /></Field><Field label="Cách nhau giữa Page (phút)"><input type="number" min="0" max="1440" value={groupStagger} onChange={(event) => setGroupStagger(event.target.value)} /></Field><Field label="Giới hạn video/ngày" hint="0 = theo số khung giờ"><input type="number" min="0" max="200" value={groupDailyLimit} onChange={(event) => setGroupDailyLimit(event.target.value)} /></Field><Field label="Pool token tự động"><select value={groupTokenGroupId} onChange={(event) => setGroupTokenGroupId(event.target.value)}><option value="">Tự chọn theo Page</option>{(meta?.tokenGroups || []).map((group) => <option key={group.id} value={group.id}>{group.name} · {group.tokenIds.length} token</option>)}</select></Field></div><label className="check-field"><input type="checkbox" checked={groupAutomation} onChange={(event) => setGroupAutomation(event.target.checked)} /><span /> AUTO POST ENABLED: eligible Content enters the Meta queue at the Page-group times.</label></> : <><div className="form-grid"><Field label="Cách chia Page"><select value={groupStrategy} onChange={(event) => setGroupStrategy(event.target.value)}><option value="least_recently_used">Token ít dùng nhất</option><option value="round_robin">Luân phiên đều</option><option value="random">Ngẫu nhiên</option></select></Field><Field label="Giới hạn Page / token" hint="0 = tự cân bằng"><input type="number" min="0" max="50" value={groupMaxPagesPerToken} onChange={(event) => setGroupMaxPagesPerToken(event.target.value)} /></Field></div><Notice>Token pool balances pages automatically. Round robin turns 100 pages and 30 tokens into 3-4 pages per token. Set a limit only when you want a hard cap.</Notice></>}<div className="hub-picker">{groupItems.map((item) => <label key={item.id}><input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => setSelectedIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} /><span>{item.name || item.id}</span></label>)}</div><div className="modal-actions"><Button type="button" onClick={closeModal}>Hủy</Button><Button variant="primary" busy={busy === "group"}><FolderPlus size={15} /> {modal.group ? "Lưu thay đổi" : "Tạo nhóm"}</Button></div></form></Modal> : null}
    </div>
  );
}
