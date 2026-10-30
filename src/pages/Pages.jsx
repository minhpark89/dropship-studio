import { useEffect, useState } from "react";
import { CalendarClock, Check, ClipboardList, Filter, FolderPlus, Info, KeyRound, Link2, Plus, RefreshCw, Search, Send, ShieldCheck, Trash2, UsersRound, WandSparkles } from "lucide-react";
import { PageManager, PostManager } from "./Management.jsx";
import { api } from "../api.js";
import { Badge, Button, Empty, Field, Modal, Notice } from "../components.jsx";

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

function TokenPoolHint({ tokenGroups }) {
  if (tokenGroups.length) return <Notice>Chọn Pool token ở trên để giới hạn token dùng cho nhóm Page. Pool đã tự chia Page sẽ hiển thị số Page/token ngay trong danh sách.</Notice>;
  return <Notice>Chưa có Pool token. Tạo Pool token ở mục Nhóm phân phối → Pool token trước, chọn các token cần dùng và bấm Tự chia Page; sau đó mở lại lịch nhóm để chọn pool.</Notice>;
}

function hasCompletePostContent(post) {
  const hasMedia = Array.isArray(post?.mediaIds) && post.mediaIds.length > 0;
  const hasCaption = Boolean(String(post?.caption || "").trim());
  const hasFirstComment = Boolean(String(post?.firstComment || "").trim());
  const hasArticle = post?.contentType !== "news" || Boolean(String(post?.articleBody || "").trim());
  return hasMedia && hasCaption && hasFirstComment && hasArticle;
}

function postState(post) {
  if (post?.isPublication) {
    return post.status === "published_comment_error" || post.firstCommentStatus === "error"
      ? { key: "error", label: "Meta đã đăng · lỗi first comment" }
      : { key: "published", label: "Đã đăng Meta" };
  }
  if (post?.automationStatus === "publishing") return { key: "publishing", label: "Đang đăng Meta" };
  if (post?.automationRetryBlocked) return { key: "error", label: "Đã dừng tự thử" };
  if (post?.automationStatus === "meta_error") return { key: "error", label: "Lỗi Meta" };
  if (post?.automationStatus === "website_error") return { key: "error", label: "Lỗi website" };
  if (post?.automationError) return { key: "error", label: "Lỗi tự động" };
  if (post?.status === "scheduled") return { key: "scheduled", label: "Đã hẹn giờ" };
  if (!hasCompletePostContent(post)) return { key: "needs_content", label: "Thiếu Content" };
  if (post?.status === "ready") return { key: "ready", label: "Sẵn sàng đăng" };
  return { key: "draft", label: "Bản nháp" };
}

function postDateLabel(value, timezone) {
  if (!value) return "Chưa có lịch";
  try {
    return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: timezone || undefined }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}



export function DistributionPanel(props) { return <PostManager {...props}/>; }

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
  const [groupTimezone, setGroupTimezone] = useState("Asia/Bangkok");
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
        : { id: modal?.group?.id, pageIds: selectedIds, scheduleConfig: { times: splitTokens(groupTimes).filter((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)), timezone: groupTimezone, staggerMinutes: Number(groupStagger) || 15, dailyLimit: Number(groupDailyLimit) || 0, enabled: groupAutomation, autoPublish: groupAutomation, tokenGroupId: groupTokenGroupId || "" } }),
    };
    const result = await action("group", () => api(`/meta/${kind}-groups`, body, "POST"), "Đã tạo nhóm.");
    if (result) {
      setGroupName("");
      setGroupTimes("");
      setGroupTimezone("Asia/Bangkok");
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
    setGroupTimezone(config.timezone || "Asia/Bangkok");
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
  const pageHealth = (page) => page.publishingHealth?.blocked ? "ERROR" : page.health || (page.tokenIds?.length ? "HEALTHY" : "UNVERIFIED");
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
  const resumePagePublishing = async (page) => {
    const result = await action(`resume:${page.id}`, () => api(`/meta/pages/${page.id}/resume-publishing`, {}, "POST"), "Đã cho phép thử lại Page. Chỉ đăng lại sau khi đã xử lý hạn chế trên Facebook.");
    if (result) await refreshMeta();
  };
  const toggleGroupAutomation = async (group) => {
    const config = group.scheduleConfig || {};
    const enabled = !(config.enabled === true && config.autoPublish !== false);
    if (enabled && (!Array.isArray(config.times) || !config.times.length)) {
      notify("Hãy đặt ít nhất một khung giờ trong Sửa lịch trước khi bật Auto Post.", "error");
      openGroup("page-group", group);
      return;
    }
    const result = await action(`automation:${group.id}`, () => api(`/social/groups/${group.id}/automation`, { enabled, autoPublish: enabled }, "POST"), enabled ? "Đã bật Auto Post cho nhóm Page." : "Đã tắt Auto Post cho nhóm Page.");
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



  return (
    <div className={`page workspace-hub pages-hub managed-workspace pages-view-${view}`}>
      <div className="page-heading hub-heading">
        <div><div className="eyebrow">PAGES WORKSPACE</div><h1>Điều khiển Page gọn trong một màn hình.</h1><p>Chọn đúng khu vực cần làm, xem danh sách trong panel riêng và chuyển sang Content khi đã sẵn sàng.</p></div>
        <div className="hub-heading-actions"><Button onClick={() => refreshMeta({ sync: true })} busy={busy === "refresh"} disabled={Boolean(busy)}><RefreshCw size={15} /> Làm mới Meta</Button><Button onClick={refreshAllTokens} busy={busy === "refresh-all"} disabled={Boolean(busy)}><RefreshCw size={15} /> Đồng bộ tất cả token</Button></div>
      </div>
      <div className="hub-metrics"><div><span>Page đang hoạt động</span><strong>{activePages}</strong><small>kênh nội dung local</small></div><div><span>Page đã xác minh</span><strong>{verifiedPages}</strong><small>có token binding</small></div><div><span>Token khỏe</span><strong>{(meta?.tokens || []).filter((item) => item.status === "ACTIVE").length}</strong><small>được chọn khi publish</small></div><div><span>Nhóm phân phối</span><strong>{(meta?.pageGroups || []).length + (meta?.tokenGroups || []).length}</strong><small>Page + token groups</small></div></div>
      {tokenSyncProgress ? <div className="bulk-token-progress"><div><strong>{tokenSyncProgress.finished ? "Đã hoàn tất đồng bộ Page" : `Đang đồng bộ token ${tokenSyncProgress.current}/${tokenSyncProgress.total}`}</strong><span>{tokenSyncProgress.ok} thành công · {tokenSyncProgress.failed} lỗi</span></div><progress max={tokenSyncProgress.total} value={tokenSyncProgress.current} /><small className="muted">Chạy tuần tự · nghỉ 0,8 giây giữa token và 5 giây sau mỗi 10 token.</small></div> : null}
      <div className="pages-tabs" role="tablist" aria-label="Khu vực Page">
        {[["pages", "Page & avatar", UsersRound], ["tokens", "Token", KeyRound], ["groups", "Nhóm phân phối", FolderPlus], ["distribution", "Bài đăng & trạng thái", ClipboardList]].map(([id, label, Icon]) => <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? "active" : ""} onClick={() => setView(id)}><Icon size={15} /><span>{label}</span></button>)}
      </div>
      <div className="pages-content">
      {view === "pages" && <PageManager data={data} notify={notify} onAvatar={(ids) => { setAvatarPageIds(ids); setAvatarTargetMode("selected"); setModal({ type: "avatar-bulk" }); }}/>}
      <section className="hub-hero"><div><span className="hub-kicker"><ShieldCheck size={14} /> WORKFLOW</span><h2>{connected ? "Meta đã sẵn sàng cho Content." : "Kết nối Meta để bắt đầu phân phối."}</h2><p>{connected ? "Chọn Page ở đây, sau đó sang Content để soạn caption, first comment và link bài viết." : "Token được kiểm tra qua /me và /me/accounts; public state chỉ trả metadata và token mask."}</p></div>{connected ? <select aria-label="Page Meta đang gắn" value={meta?.boundPage?.id || ""} onChange={bindPage}><option value="">Chọn Page để gắn</option>{(meta.pages || []).map((page) => <option key={page.id} value={page.id}>{page.name} · {page.id}</option>)}</select> : <Button variant="primary" onClick={() => setModal({ type: "token" })}><KeyRound size={15} /> Thêm token Meta</Button>}</section>

      <div className="hub-columns pages-columns pages-pages-row">

        <section className="hub-panel pages-token-panel"><div className="hub-panel-heading"><div><span className="hub-kicker">TOKEN VAULT</span><h2>Credential pool</h2></div><Button onClick={() => setModal({ type: "token" })}><Plus size={14} /> Token</Button></div>{meta?.tokens?.length ? <div className="hub-list">{meta.tokens.map((item) => <article className="hub-list-row" key={item.id}><span className="hub-token-icon"><KeyRound size={14} /></span><div><strong>{item.name}</strong><small>{item.tokenMasked || "***"} · {item.pagesCount || 0} Page · {item.kind === "VIA_TOKEN" ? `Via Token · App ${item.appId || "?"}` : "System User"}</small></div><Badge status={item.status === "ACTIVE" ? "ready" : item.status === "ERROR" ? "error" : "offline"} /><div className="inline-actions"><Button className="icon-button" title="Đồng bộ lại Page" onClick={() => action(`refresh-token:${item.id}`, () => api(`/meta/tokens/${item.id}/refresh-pages`, {}, "POST"), "Đã đồng bộ lại Page từ token.").then(refreshMeta)} busy={busy === `refresh-token:${item.id}`}><RefreshCw size={13} /></Button><Button className="icon-button danger-text" title="Xóa token" onClick={async () => { if (!confirm(`Xóa token ${item.name}?`)) return; const result = await action(`delete-token:${item.id}`, () => api(`/meta/tokens/${item.id}`, {}, "DELETE"), "Đã xóa token."); if (result) await refreshMeta(); }} busy={busy === `delete-token:${item.id}`}><Trash2 size={13} /></Button></div></article>)}</div> : <Empty icon={KeyRound} title="Vault đang trống">Thêm token do bạn sở hữu để xác minh quyền Page.</Empty>}</section>
      </div>
  <div className="hub-columns pages-columns pages-groups-row"><section className="hub-panel pages-page-groups-panel"><div className="hub-panel-heading"><div><span className="hub-kicker">PAGE GROUPS</span><h2>Nhóm Page</h2></div><Button onClick={() => openGroup("page-group")}><FolderPlus size={14} /> Tạo nhóm</Button></div>{(meta?.pageGroups || []).length ? meta.pageGroups.map((group) => <div className="hub-group-row" key={group.id}><strong>{group.name}</strong><span>{group.pageIds.length} Page</span><span className={group.scheduleConfig?.enabled && group.scheduleConfig?.autoPublish !== false ? "page-group-auto-status on" : "page-group-auto-status"}>{group.scheduleConfig?.enabled && group.scheduleConfig?.autoPublish !== false ? "AUTO POST: ON" : "AUTO POST: OFF"}</span><div className="hub-group-rule"><small>{group.scheduleConfig?.times?.length ? `Mỗi ngày: ${group.scheduleConfig.times.join(", ")}` : "Chưa đặt khung giờ"} · {group.scheduleConfig?.enabled ? `Tự động ${group.scheduleConfig?.dailyLimit || group.scheduleConfig.times?.length || 1} video/ngày` : "Tự động đang tắt"}{group.scheduleConfig?.tokenGroupId ? ` · Pool: ${(meta?.tokenGroups || []).find((item) => item.id === group.scheduleConfig.tokenGroupId)?.name || "đã chọn"}` : ""}</small><Button onClick={() => toggleGroupAutomation(group)} busy={busy === `automation:${group.id}`} disabled={group.purpose === "review" || group.id.startsWith("pgrp_hold_") || Boolean(busy) && busy !== `automation:${group.id}`}>{group.scheduleConfig?.enabled && group.scheduleConfig?.autoPublish !== false ? "\u0054\u1EAFt Auto Post" : "B\u1EADt Auto Post"}</Button><Button onClick={() => openGroup("page-group", group)}><CalendarClock size={13} /> Sửa lịch</Button></div><Button onClick={() => pruneGroup(group)} busy={busy === `prune:${group.id}`}><Filter size={13} /> Lọc Page lỗi</Button></div>) : <p className="hub-empty">Tạo nhóm theo kênh, thị trường hoặc lịch đăng.</p>}</section><section className="hub-panel pages-token-groups-panel"><div className="hub-panel-heading"><div><span className="hub-kicker">TOKEN GROUPS</span><h2>Pool token</h2></div><Button onClick={() => openGroup("token-group")}><FolderPlus size={14} /> Tạo pool</Button></div>{(meta?.tokenGroups || []).length ? meta.tokenGroups.map((group) => <div className="hub-group-row" key={group.id}><strong>{group.name}</strong><span>{group.tokenIds.length} token · {group.assignedPageCount || 0}/{group.pageIds?.length || 0} Page đã chia / {tokenLoadLabel(group)}</span><div className="hub-group-rule"><small>{group.strategy === "round_robin" ? "Luân phiên đều" : group.strategy === "random" ? "Ngẫu nhiên" : "Token ít dùng nhất"}{group.maxPagesPerToken ? ` · tối đa ${group.maxPagesPerToken} Page/token` : " · tự cân bằng"}{group.assignmentBlockedCount ? ` · ${group.assignmentBlockedCount} Page cần Sync lại` : ""}</small><Button onClick={() => autoAssignTokenGroup(group)} busy={busy === `assign-token-group:${group.id}`}><RefreshCw size={13} /> Tự chia Page</Button><Button onClick={() => openGroup("token-group", group)}><FolderPlus size={13} /> Sửa pool</Button></div></div>) : <p className="hub-empty">Tạo pool theo team hoặc quota để Studio tự chia Page vào token khỏe.</p>}</section></div>
      </div>
      {view === "distribution" && <DistributionPanel data={data} notify={notify} />}
      {modal?.type === "avatar-bulk" ? <Modal wide title="Đổi avatar Page bằng AI" onClose={closeModal}><form onSubmit={generateAvatars}><Notice>Avatar generation is separate from Page publishing; requests are throttled per token.</Notice><Field label="Phạm vi đổi avatar"><select name="targetMode" value={avatarTargetMode} onChange={(event) => setAvatarTargetMode(event.target.value)}><option value="all">Tất cả Page đang hiển thị ({visibleMetaPages.length})</option><option value="selected">Chọn từng Page ({avatarPageIds.length})</option>{(meta?.pageGroups || []).map((group) => <option key={group.id} value={`group:${group.id}`}>Nhóm: {group.name} · {group.pageIds.length} Page</option>)}</select></Field>{avatarTargetMode === "selected" ? <><div className="avatar-picker-toolbar"><span>{avatarPageIds.length} Page được chọn</span><div><Button type="button" onClick={() => setAvatarPageIds(allMetaPages.map((page) => page.id))}>Chọn tất cả</Button><Button type="button" onClick={() => setAvatarPageIds([])}>Bỏ chọn</Button></div></div><div className="hub-picker avatar-page-picker">{allMetaPages.map((page) => <label key={page.id}><input type="checkbox" checked={avatarPageIds.includes(page.id)} onChange={() => toggleAvatarPage(page.id)} />{page.avatar ? <img className="avatar-page-picker-image" src={page.avatar} alt="" /> : <span className="hub-avatar">f</span>}<span><strong>{page.name}</strong><small>{page.id}</small></span></label>)}</div></> : null}<Field label="Mô tả avatar"><textarea name="prompt" rows="4" defaultValue="Professional editorial social media page avatar, clean bold composition, square portrait, consistent brand colors, no text, no logos, no watermark." /></Field><label className="check-field"><input name="useLlm" type="checkbox" defaultChecked={data.settings?.llm?.enabled === true} /><span /> Dùng LLM tối ưu prompt trước khi render</label><label className="check-field"><input name="apply" type="checkbox" /><span /> Áp dụng lên Page Meta sau khi tạo ảnh</label><p className="avatar-rate-note">Một ảnh được tạo và dùng cho các Page đã chọn. Apply chạy tuần tự theo token, nghỉ 1 giây giữa request và 5 giây sau mỗi 10 Page.</p><div className="modal-actions"><Button type="button" onClick={closeModal}>Hủy</Button><Button variant="primary" busy={busy === "avatar-bulk"}><WandSparkles size={15} /> Tạo avatar</Button></div></form></Modal> : null}
      {modal?.type === "page-add" || modal?.type === "page-edit" ? <Modal title={modal.type === "page-edit" ? "Sửa Page" : "Thêm Page local"} onClose={closeModal}><form onSubmit={savePage}><div className="form-grid"><Field label="Tên Page"><input name="name" required maxLength={120} value={pageForm.name} onChange={(event) => setPageForm({ ...pageForm, name: event.target.value })} /></Field><Field label="Page ID"><input name="externalId" inputMode="numeric" value={pageForm.externalId} onChange={(event) => setPageForm({ ...pageForm, externalId: event.target.value })} placeholder="ID Meta" /></Field><Field label="Facebook URL"><input name="url" type="url" value={pageForm.url} onChange={(event) => setPageForm({ ...pageForm, url: event.target.value })} /></Field><Field label="Múi giờ"><input name="timezone" value={pageForm.timezone} onChange={(event) => setPageForm({ ...pageForm, timezone: event.target.value })} /></Field></div><Field label="Ghi chú"><textarea name="notes" rows="3" value={pageForm.notes} onChange={(event) => setPageForm({ ...pageForm, notes: event.target.value })} /> </Field>{modal.type === "page-edit" && <label className="check-field"><input name="archived" type="checkbox" checked={pageForm.archived} onChange={(event) => setPageForm({ ...pageForm, archived: event.target.checked })} /><span /> Lưu trữ Page</label>}<div className="modal-actions"><Button type="button" onClick={closeModal}>Hủy</Button><Button variant="primary" busy={busy === "page"}><Check size={15} /> Lưu Page</Button></div></form></Modal> : null}
      {modal?.type === "token" ? <Modal wide title="Thêm credential Meta" onClose={closeModal}><form onSubmit={addToken}><Notice>Chọn System User hoặc Via Token. Via Token bắt buộc có App ID, App Secret và Via Token; App Secret chỉ lưu local.</Notice><Field label={tokenForm.kind === "VIA_TOKEN" ? "Via Token" : "System User access token"}><input type="password" required autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder={tokenForm.kind === "VIA_TOKEN" ? "Dán Via Token do bạn sở hữu" : "Dán System User token do bạn sở hữu"} /></Field><div className="form-grid"><Field label="Tên kết nối"><input value={tokenForm.name} onChange={(event) => setTokenForm({ ...tokenForm, name: event.target.value })} placeholder="Team Content 01" /></Field><Field label="Loại credential"><select value={tokenForm.kind} onChange={(event) => setTokenForm({ ...tokenForm, kind: event.target.value })}><option value="SYSTEM_USER">System User</option><option value="VIA_TOKEN">Via Token · App ID + App Secret</option></select></Field>{tokenForm.kind === "VIA_TOKEN" && <><Field label="App ID"><input required value={tokenForm.appId} maxLength={200} autoComplete="off" placeholder="Meta App ID" onChange={(event) => setTokenForm({ ...tokenForm, appId: event.target.value })} /></Field><Field label="App Secret"><input required type="password" value={tokenForm.appSecret} maxLength={5000} autoComplete="new-password" placeholder="Meta App Secret" onChange={(event) => setTokenForm({ ...tokenForm, appSecret: event.target.value })} /></Field></>}</div><div className="meta-token-type-help"><Info size={15} /><span>{tokenForm.kind === "VIA_TOKEN" ? "Via Token được kiểm tra qua /debug_token trước khi đồng bộ Page." : "System User token cần được cấp Page asset và quyền phù hợp trong Meta Business Settings."}</span></div><Field label="Ghi chú"><textarea rows="2" value={tokenForm.note} onChange={(event) => setTokenForm({ ...tokenForm, note: event.target.value })} /></Field><Button type="button" onClick={() => { setBulkProgress(null); setModal({ type: "bulk-token" }); }}><KeyRound size={14} /> Nhập nhanh danh sách token</Button><div className="modal-actions"><Button type="button" onClick={closeModal}>Hủy</Button><Button variant="primary" busy={busy === "token"}>Kiểm tra & lưu</Button></div></form></Modal> : null}
      {modal?.type === "bulk-token" ? <Modal wide title="Nhập danh sách token" onClose={closeModal}><form onSubmit={addBulkTokens}><Notice>Dán mỗi token trên một dòng hoặc phân tách bằng dấu phẩy. Studio kiểm tra tuần tự và cập nhật tiến trình sau từng token.</Notice><Field label="Danh sách token"><textarea required rows="8" value={bulkTokens} onChange={(event) => setBulkTokens(event.target.value)} placeholder="token-1\ntoken-2\ntoken-3" disabled={Boolean(bulkProgress && !bulkProgress.finished)} /></Field><div className="form-grid"><Field label="Tên kết nối"><input value={tokenForm.name} onChange={(event) => setTokenForm({ ...tokenForm, name: event.target.value })} placeholder="Team Content" disabled={Boolean(bulkProgress && !bulkProgress.finished)} /></Field><Field label="Loại credential"><select value={tokenForm.kind} onChange={(event) => setTokenForm({ ...tokenForm, kind: event.target.value })} disabled={Boolean(bulkProgress && !bulkProgress.finished)}><option value="SYSTEM_USER">System User</option><option value="VIA_TOKEN">Via Token</option></select></Field></div>{tokenForm.kind === "VIA_TOKEN" && <div className="form-grid"><Field label="App ID"><input required value={tokenForm.appId} onChange={(event) => setTokenForm({ ...tokenForm, appId: event.target.value })} disabled={Boolean(bulkProgress && !bulkProgress.finished)} /></Field><Field label="App Secret"><input required type="password" value={tokenForm.appSecret} onChange={(event) => setTokenForm({ ...tokenForm, appSecret: event.target.value })} disabled={Boolean(bulkProgress && !bulkProgress.finished)} /></Field></div>}<Field label="Ghi chú"><textarea rows="2" value={tokenForm.note} onChange={(event) => setTokenForm({ ...tokenForm, note: event.target.value })} disabled={Boolean(bulkProgress && !bulkProgress.finished)} /></Field>{bulkProgress ? <div className="bulk-token-progress"><div><strong>{bulkProgress.finished ? "Đã hoàn tất kiểm tra token" : `Đang kiểm tra token ${bulkProgress.current}/${bulkProgress.total}`}</strong><span>{bulkProgress.ok} hợp lệ · {bulkProgress.failed} lỗi</span></div><progress max={bulkProgress.total} value={bulkProgress.current} /></div> : null}<div className="modal-actions">{bulkProgress?.finished ? <Button type="button" variant="primary" onClick={closeModal}>Đóng</Button> : <><Button type="button" onClick={closeModal} disabled={Boolean(bulkProgress)}>Hủy</Button><Button variant="primary" busy={busy === "bulk-token"} disabled={Boolean(bulkProgress)}>Kiểm tra danh sách</Button></>}</div></form></Modal> : null}
      {modal?.type === "page-group" || modal?.type === "token-group" ? <Modal title={modal.type === "page-group" ? (modal.group ? "Sửa lịch nhóm Page" : "Tạo nhóm Page") : "Tạo pool token"} onClose={closeModal}><form onSubmit={saveGroup}><Field label="Tên nhóm"><input required autoFocus value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder={modal.type === "page-group" ? "Ví dụ: Page miền Bắc" : "Ví dụ: Team A"} /></Field>{modal.type === "page-group" ? <><div className="form-grid"><Field label="Khung giờ đăng" hint="HH:mm, cách nhau bằng dấu phẩy"><input value={groupTimes} onChange={(event) => setGroupTimes(event.target.value)} placeholder="09:00, 15:00, 20:00" /></Field><Field label="Cách nhau giữa Page (phút)"><input type="number" min="0" max="1440" value={groupStagger} onChange={(event) => setGroupStagger(event.target.value)} /></Field><Field label="Giới hạn video/ngày" hint="0 = theo số khung giờ"><input type="number" min="0" max="200" value={groupDailyLimit} onChange={(event) => setGroupDailyLimit(event.target.value)} /></Field><Field label="Pool token tự động"><select value={groupTokenGroupId} onChange={(event) => setGroupTokenGroupId(event.target.value)}><option value="">Tự chọn theo Page</option>{(meta?.tokenGroups || []).map((group) => <option key={group.id} value={group.id}>{group.name} · {group.tokenIds.length} token</option>)}</select></Field></div><TokenPoolHint tokenGroups={meta?.tokenGroups || []} /><label className="check-field"><input type="checkbox" checked={groupAutomation} onChange={(event) => setGroupAutomation(event.target.checked)} /><span /> AUTO POST ENABLED: eligible Content enters the Meta queue at the Page-group times.</label></> : <><div className="form-grid"><Field label="Cách chia Page"><select value={groupStrategy} onChange={(event) => setGroupStrategy(event.target.value)}><option value="least_recently_used">Token ít dùng nhất</option><option value="round_robin">Luân phiên đều</option><option value="random">Ngẫu nhiên</option></select></Field><Field label="Giới hạn Page / token" hint="0 = tự cân bằng"><input type="number" min="0" max="50" value={groupMaxPagesPerToken} onChange={(event) => setGroupMaxPagesPerToken(event.target.value)} /></Field></div><Notice>Token pool balances pages automatically. Round robin turns 100 pages and 30 tokens into 3-4 pages per token. Set a limit only when you want a hard cap.</Notice></>}<div className="hub-picker">{groupItems.map((item) => <label key={item.id}><input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => setSelectedIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} /><span>{item.name || item.id}</span></label>)}</div><div className="modal-actions"><Button type="button" onClick={closeModal}>Hủy</Button><Button variant="primary" busy={busy === "group"}><FolderPlus size={15} /> {modal.group ? "Lưu thay đổi" : "Tạo nhóm"}</Button></div></form></Modal> : null}
    </div>
  );
}
