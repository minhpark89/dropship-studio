import { useEffect, useMemo, useState } from "react";
import { Check, FolderPlus, Info, KeyRound, Link2, Plus, RefreshCw, ShieldCheck, Trash2, UsersRound } from "lucide-react";
import { api } from "../api.js";
import { Badge, Button, Empty, Field, Modal, Notice } from "../components.jsx";

const blankPage = { name: "", externalId: "", url: "", timezone: "Asia/Bangkok", notes: "", archived: false };
const blankMetaTokenForm = () => ({ name: "", kind: "SYSTEM_USER", appId: "", appSecret: "", note: "" });

export function PagesPage({ data, run, notify }) {
  const [pages, setPages] = useState(data.socialPages || []);
  const [meta, setMeta] = useState(data.settings?.meta || null);
  const [pageForm, setPageForm] = useState(blankPage);
  const [modal, setModal] = useState(null);
  const [token, setToken] = useState("");
  const [tokenForm, setTokenForm] = useState(blankMetaTokenForm);
  const [groupName, setGroupName] = useState("");
  const [selectedIds, setSelectedIds] = useState([]);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    setPages(data.socialPages || []);
    setMeta(data.settings?.meta || null);
  }, [data.socialPages, data.settings?.meta]);

  const refreshMeta = async () => {
    const next = await api("/meta");
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
      setModal(null);
    }
  };
  const addToken = async (event) => {
    event.preventDefault();
    const result = await action("token", () => api("/meta/tokens", { accessToken: token, ...tokenForm }, "POST"), "Đã xác minh token và đồng bộ Page.");
    if (result) {
      setToken("");
      setTokenForm(blankMetaTokenForm());
      setModal(null);
      await refreshMeta();
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
    const body = { name: groupName, ...(kind === "token" ? { tokenIds: selectedIds } : { pageIds: selectedIds }) };
    const result = await action("group", () => api(`/meta/${kind}-groups`, body, "POST"), "Đã tạo nhóm.");
    if (result) {
      setGroupName("");
      setSelectedIds([]);
      setModal(null);
      await refreshMeta();
    }
  };
  const connected = Boolean(meta?.connected);
  const verifiedPages = (meta?.pages || []).filter((page) => page.tokenIds?.length).length;
  const activePages = pages.filter((page) => !page.archived).length;
  const openGroup = (type) => { setGroupName(""); setSelectedIds([]); setModal({ type }); };
  const groupItems = modal?.type === "token-group" ? (meta?.tokens || []) : (meta?.pages || []);

  return (
    <div className="page workspace-hub pages-hub">
      <div className="page-heading hub-heading">
        <div><div className="eyebrow">PAGES WORKSPACE</div><h1>Page & token ở một nơi.</h1><p>Quản lý kênh, quyền truy cập và pool credential riêng trước khi chuyển sang Content.</p></div>
        <div className="hub-heading-actions"><Button onClick={() => refreshMeta()} busy={busy === "refresh"}><RefreshCw size={15} /> Làm mới Meta</Button><Button variant="primary" onClick={() => { setPageForm(blankPage); setModal({ type: "page-add" }); }}><Plus size={16} /> Thêm Page</Button></div>
      </div>
      <div className="hub-metrics"><div><span>Page đang hoạt động</span><strong>{activePages}</strong><small>kênh nội dung local</small></div><div><span>Page đã xác minh</span><strong>{verifiedPages}</strong><small>có token binding</small></div><div><span>Token khỏe</span><strong>{(meta?.tokens || []).filter((item) => item.status === "ACTIVE").length}</strong><small>được chọn khi publish</small></div><div><span>Nhóm phân phối</span><strong>{(meta?.pageGroups || []).length + (meta?.tokenGroups || []).length}</strong><small>Page + token groups</small></div></div>
      <section className="hub-hero"><div><span className="hub-kicker"><ShieldCheck size={14} /> WORKFLOW</span><h2>{connected ? "Meta đã sẵn sàng cho Content." : "Kết nối Meta để bắt đầu phân phối."}</h2><p>{connected ? "Chọn Page ở đây, sau đó sang Content để soạn caption, first comment và link store." : "Token được kiểm tra qua /me và /me/accounts; public state chỉ trả metadata và token mask."}</p></div>{connected ? <select aria-label="Page Meta đang gắn" value={meta?.boundPage?.id || ""} onChange={bindPage}><option value="">Chọn Page để gắn</option>{(meta.pages || []).map((page) => <option key={page.id} value={page.id}>{page.name} · {page.id}</option>)}</select> : <Button variant="primary" onClick={() => setModal({ type: "token" })}><KeyRound size={15} /> Thêm token Meta</Button>}</section>
      <div className="hub-columns">
        <section className="hub-panel"><div className="hub-panel-heading"><div><span className="hub-kicker">CHANNELS</span><h2>Page local</h2></div><Button onClick={() => { setPageForm(blankPage); setModal({ type: "page-add" }); }}><Plus size={14} /> Page mới</Button></div>{pages.length ? <div className="hub-list">{pages.map((page) => <article className="hub-list-row" key={page.id}><span className="hub-avatar">f</span><div><strong>{page.name}</strong><small>{page.externalId || "Chưa gắn Page ID"} · {page.timezone}</small></div><Badge status={page.archived ? "offline" : "ready"} /><Button className="icon-button" aria-label={`Sửa ${page.name}`} onClick={() => { setPageForm(page); setModal({ type: "page-edit", page }); }}><Link2 size={14} /></Button></article>)}</div> : <Empty icon={UsersRound} title="Chưa có Page">Tạo Page local hoặc đồng bộ từ Meta token.</Empty>}</section>
        <section className="hub-panel"><div className="hub-panel-heading"><div><span className="hub-kicker">TOKEN VAULT</span><h2>Credential pool</h2></div><Button onClick={() => setModal({ type: "token" })}><Plus size={14} /> Token</Button></div>{meta?.tokens?.length ? <div className="hub-list">{meta.tokens.map((item) => <article className="hub-list-row" key={item.id}><span className="hub-token-icon"><KeyRound size={14} /></span><div><strong>{item.name}</strong><small>{item.tokenMasked || "***"} · {item.pagesCount || 0} Page · {item.kind === "VIA_TOKEN" ? `Via Token · App ${item.appId || "?"}` : "System User"}</small></div><Badge status={item.status === "ACTIVE" ? "ready" : item.status === "ERROR" ? "error" : "offline"} /></article>)}</div> : <Empty icon={KeyRound} title="Vault đang trống">Thêm token do bạn sở hữu để xác minh quyền Page.</Empty>}</section>
      </div>
      <div className="hub-columns"><section className="hub-panel"><div className="hub-panel-heading"><div><span className="hub-kicker">PAGE GROUPS</span><h2>Nhóm Page</h2></div><Button onClick={() => openGroup("page-group")}><FolderPlus size={14} /> Tạo nhóm</Button></div>{(meta?.pageGroups || []).length ? meta.pageGroups.map((group) => <div className="hub-group-row" key={group.id}><strong>{group.name}</strong><span>{group.pageIds.length} Page</span></div>) : <p className="hub-empty">Tạo nhóm theo kênh, thị trường hoặc lịch đăng.</p>}</section><section className="hub-panel"><div className="hub-panel-heading"><div><span className="hub-kicker">TOKEN GROUPS</span><h2>Pool token</h2></div><Button onClick={() => openGroup("token-group")}><FolderPlus size={14} /> Tạo pool</Button></div>{(meta?.tokenGroups || []).length ? meta.tokenGroups.map((group) => <div className="hub-group-row" key={group.id}><strong>{group.name}</strong><span>{group.tokenIds.length} token</span></div>) : <p className="hub-empty">Tạo pool theo team hoặc quota để Content tự chọn token khỏe.</p>}</section></div>
      {modal?.type === "page-add" || modal?.type === "page-edit" ? <Modal title={modal.type === "page-edit" ? "Sửa Page" : "Thêm Page local"} onClose={() => setModal(null)}><form onSubmit={savePage}><div className="form-grid"><Field label="Tên Page"><input name="name" required maxLength={120} value={pageForm.name} onChange={(event) => setPageForm({ ...pageForm, name: event.target.value })} /></Field><Field label="Page ID"><input name="externalId" inputMode="numeric" value={pageForm.externalId} onChange={(event) => setPageForm({ ...pageForm, externalId: event.target.value })} placeholder="ID Meta" /></Field><Field label="Facebook URL"><input name="url" type="url" value={pageForm.url} onChange={(event) => setPageForm({ ...pageForm, url: event.target.value })} /></Field><Field label="Múi giờ"><input name="timezone" value={pageForm.timezone} onChange={(event) => setPageForm({ ...pageForm, timezone: event.target.value })} /></Field></div><Field label="Ghi chú"><textarea name="notes" rows="3" value={pageForm.notes} onChange={(event) => setPageForm({ ...pageForm, notes: event.target.value })} /></Field>{modal.type === "page-edit" && <label className="check-field"><input name="archived" type="checkbox" checked={pageForm.archived} onChange={(event) => setPageForm({ ...pageForm, archived: event.target.checked })} /><span /> Lưu trữ Page</label>}<div className="modal-actions"><Button type="button" onClick={() => setModal(null)}>Hủy</Button><Button variant="primary" busy={busy === "page"}><Check size={15} /> Lưu Page</Button></div></form></Modal> : null}
      {modal?.type === "token" ? <Modal wide title="Thêm credential Meta" onClose={() => setModal(null)}><form onSubmit={addToken}><Notice>Chọn System User hoặc Via Token. Via Token bắt buộc có App ID, App Secret và Via Token; App Secret chỉ lưu local.</Notice><Field label={tokenForm.kind === "VIA_TOKEN" ? "Via Token" : "System User access token"}><input type="password" required autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder={tokenForm.kind === "VIA_TOKEN" ? "Dán Via Token do bạn sở hữu" : "Dán System User token do bạn sở hữu"} /></Field><div className="form-grid"><Field label="Tên kết nối"><input value={tokenForm.name} onChange={(event) => setTokenForm({ ...tokenForm, name: event.target.value })} placeholder="Team Content 01" /></Field><Field label="Loại credential"><select value={tokenForm.kind} onChange={(event) => setTokenForm({ ...tokenForm, kind: event.target.value })}><option value="SYSTEM_USER">System User</option><option value="VIA_TOKEN">Via Token · App ID + App Secret</option></select></Field>{tokenForm.kind === "VIA_TOKEN" && <><Field label="App ID"><input required value={tokenForm.appId} maxLength={200} autoComplete="off" placeholder="Meta App ID" onChange={(event) => setTokenForm({ ...tokenForm, appId: event.target.value })} /></Field><Field label="App Secret"><input required type="password" value={tokenForm.appSecret} maxLength={5000} autoComplete="new-password" placeholder="Meta App Secret" onChange={(event) => setTokenForm({ ...tokenForm, appSecret: event.target.value })} /></Field></>}</div><div className="meta-token-type-help"><Info size={15} /><span>{tokenForm.kind === "VIA_TOKEN" ? "Via Token được kiểm tra qua /debug_token trước khi đồng bộ Page." : "System User token cần được cấp Page asset và quyền phù hợp trong Meta Business Settings."}</span></div><Field label="Ghi chú"><textarea rows="2" value={tokenForm.note} onChange={(event) => setTokenForm({ ...tokenForm, note: event.target.value })} /></Field><div className="modal-actions"><Button type="button" onClick={() => setModal(null)}>Hủy</Button><Button variant="primary" busy={busy === "token"}>Kiểm tra & lưu</Button></div></form></Modal> : null}
      {modal?.type === "page-group" || modal?.type === "token-group" ? <Modal title={modal.type === "page-group" ? "Tạo nhóm Page" : "Tạo pool token"} onClose={() => setModal(null)}><form onSubmit={saveGroup}><Field label="Tên nhóm"><input required autoFocus value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder={modal.type === "page-group" ? "Ví dụ: Page miền Bắc" : "Ví dụ: Team A"} /></Field><div className="hub-picker">{groupItems.map((item) => <label key={item.id}><input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => setSelectedIds((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} /><span>{item.name || item.id}</span></label>)}</div><div className="modal-actions"><Button type="button" onClick={() => setModal(null)}>Hủy</Button><Button variant="primary" busy={busy === "group"}><FolderPlus size={15} /> Tạo nhóm</Button></div></form></Modal> : null}
    </div>
  );
}
