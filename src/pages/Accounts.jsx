import { useState } from "react";
import {
  Plus,
  Users,
  ExternalLink,
  RefreshCw,
  Cookie,
  LogIn,
  Trash2,
  ShieldCheck,
  FileUp,
  KeyRound,
  Globe2,
  MailPlus,
  Search,
  ListFilter,
  MoreHorizontal,
  FilterX,
  X,
} from "lucide-react";
import { api } from "../api.js";
import { Button, Modal, Field, Badge, Empty, Notice } from "../components.jsx";

const STATUS_FILTERS = [
  { value: "attention", label: "Cần xử lý" },
  { value: "ready", label: "Sẵn sàng" },
  { value: "needs_login", label: "Cần đăng nhập" },
  { value: "verification", label: "Cần xác minh" },
  { value: "offline", label: "Chưa kiểm tra" },
  { value: "busy", label: "Đang chạy" },
];

const PROXY_FILTERS = [
  { value: "all", label: "Tất cả" },
  { value: "with", label: "Có proxy" },
  { value: "without", label: "Không proxy" },
  { value: "error", label: "Proxy lỗi" },
];

const providerLabel = (provider) =>
  provider === "dola"
    ? "Dola / Seedance"
    : provider === "dreamface"
      ? "DreamFace · xoay ngày"
      : "Google Flow / Veo";

const methodLabel = (account) =>
  account.loginMethod === "apple"
    ? "Apple · iCloud"
    : account.loginMethod === "cookie"
      ? "Cookie"
      : account.loginMethod === "credentials"
        ? "Email + mật khẩu"
        : "Google";

const gmailLabel = (status) =>
  ({
    ready: "Email sẵn sàng",
    created: "Email sẵn sàng",
    verification: "Email chờ xác minh",
    failed: "Email cần thử lại",
    needs_login: "Email chờ xác nhận",
    opening: "Email đang mở",
    pending: "Email đang xử lý",
  })[status] || "";

const matchesStatus = (account, value) => {
  if (value === "attention")
    return account.status !== "ready" ||
      account.gmailStatus === "verification" ||
      account.proxyStatus === "error";
  if (value === "verification")
    return account.status === "verification" || account.gmailStatus === "verification";
  if (value === "busy") return ["busy", "checking"].includes(account.status);
  return account.status === value;
};

const matchesProxy = (account, value) => {
  if (value === "with") return Boolean(account.proxy);
  if (value === "without") return !account.proxy;
  if (value === "error") return account.proxyStatus === "error";
  return true;
};

const statusRank = (account) => {
  if (account.status === "verification" || account.gmailStatus === "verification") return 0;
  if (account.status === "needs_login") return 1;
  if (account.status === "offline") return 2;
  if (["checking", "busy"].includes(account.status)) return 3;
  return 4;
};

export function AccountsPage({ data, run, notify }) {
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({
    name: "",
    provider: "dola",
    loginMethod: "google",
    email: "",
    proxy: "",
  });
  const [password, setPassword] = useState("");
  const [cookies, setCookies] = useState("");
  const [sourceAccountId, setSourceAccountId] = useState("");
  const [proxyValue, setProxyValue] = useState("");
  const [bulkProxyValue, setBulkProxyValue] = useState("");
  const [busy, setBusy] = useState("");
  const [filters, setFilters] = useState({
    provider: "all",
    statuses: [],
    proxy: "all",
    query: "",
    sort: "attention",
  });
  const [selectedIds, setSelectedIds] = useState([]);
  const [slotCount, setSlotCount] = useState(5);
  const [slotPrefix, setSlotPrefix] = useState("DreamFace profile");
  const [slotProxies, setSlotProxies] = useState("");
  const [slotConcurrency, setSlotConcurrency] = useState(1);
  const [connectNewProfiles, setConnectNewProfiles] = useState(true);
  const [gmailPrefix, setGmailPrefix] = useState("DreamFace Gmail");
  const [gmailProxy, setGmailProxy] = useState("");
  const dreamfaceAccounts = data.accounts.filter((account) => account.provider === "dreamface");
  const dreamfaceReady = dreamfaceAccounts.filter((account) => account.status === "ready").length;
  const dreamfaceNeedsLogin = dreamfaceAccounts.filter((account) => account.status === "needs_login").length;
  const captchaConfigured = Boolean(data.settings?.captcha?.hasKey) && data.settings?.captcha?.enabled !== false;
  const dreamfaceVerification = dreamfaceAccounts.filter((account) =>
    account.status === "verification" || account.gmailStatus === "verification").length;
  const sameProfile = (left, right) =>
    (left.profileId || left.id) === (right.profileId || right.id);
  const sharedProfile = (account) =>
    data.accounts.some((other) => other.id !== account.id && sameProfile(account, other));
  const googleSources = (account) => data.accounts.filter((other) =>
    other.id !== account.id && other.loginMethod === "google" && !sameProfile(account, other));
  const scoped = data.accounts.filter((account) => {
    if (filters.provider !== "all" && account.provider !== filters.provider) return false;
    const query = filters.query.trim().toLowerCase();
    if (!query) return true;
    return `${account.name} ${account.email || ""} ${account.proxy || ""}`
      .toLowerCase()
      .includes(query);
  });
  const statusCounts = Object.fromEntries(
    STATUS_FILTERS.map(({ value }) => [value, scoped.filter((account) => matchesStatus(account, value)).length]),
  );
  const proxyCounts = Object.fromEntries(
    PROXY_FILTERS.map(({ value }) => [value, scoped.filter((account) => matchesProxy(account, value)).length]),
  );
  const visibleAccounts = scoped
    .filter((account) =>
      (!filters.statuses.length || filters.statuses.some((value) => matchesStatus(account, value))) &&
      matchesProxy(account, filters.proxy))
    .sort((left, right) => {
      if (filters.sort === "name") return left.name.localeCompare(right.name, "vi");
      if (filters.sort === "recent")
        return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
      return statusRank(left) - statusRank(right) || left.name.localeCompare(right.name, "vi");
    });
  const visibleIds = visibleAccounts.map((account) => account.id);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const selectedAccounts = data.accounts.filter((account) => selectedIds.includes(account.id));
  const selectedHasOtherProvider = selectedAccounts.some((account) => account.provider !== "dreamface");
  const filtersActive = Boolean(
    filters.query.trim() ||
    filters.provider !== "all" ||
    filters.statuses.length ||
    filters.proxy !== "all",
  );
  const close = () => {
    setModal(null);
    setPassword("");
    setCookies("");
    setSourceAccountId("");
    setProxyValue("");
    setBulkProxyValue("");
    setGmailPrefix("DreamFace Gmail");
    setGmailProxy("");
  };
  const action = async (id, type, body = {}) => {
    setBusy(`${id}:${type}`);
    const result = await run(() => api(`/accounts/${id}/${type}`, body));
    if (result?.message) notify(result.message);
    setBusy("");
    return result;
  };
  const checkProxy = async (account) => {
    const result = await run(() => api(`/accounts/${account.id}/proxy-check`, {}));
    if (result?.proxyMessage || result?.message) notify(result.proxyMessage || result.message, result?.proxyStatus === "error" ? "error" : "success");
    return result;
  };
  const checkAccounts = async (list) => {
    if (!list.length || busy) return;
    setBusy("bulk-check");
    let checked = 0;
    for (const account of list) {
      const result = await run(() => api(`/accounts/${account.id}/check`));
      if (result) checked += 1;
    }
    setBusy("");
    notify(`Đã kiểm tra ${checked}/${list.length} tài khoản.`);
  };
  const checkDreamfaceAll = async () => {
    if (!dreamfaceAccounts.length || busy) return;
    await checkAccounts(dreamfaceAccounts);
  };
  const solveCaptcha = async (account) => {
    const result = await action(account.id, "captcha");
    return result;
  };
  const solveAllCaptcha = async () => {
    const targets = dreamfaceAccounts.filter((account) =>
      account.status === "verification" || account.gmailStatus === "verification");
    if (!targets.length || busy) return;
    setBusy("captcha-all");
    for (const account of targets) {
      await run(() => api(`/accounts/${account.id}/captcha`, {}));
    }
    setBusy("");
    notify(`Đã gửi CAPTCHA của ${targets.length} profile DreamFace tới 2Captcha.`);
  };
  const solveSelectedCaptcha = async () => {
    const targets = selectedAccounts.filter((account) =>
      account.provider === "dreamface" &&
      (account.status === "verification" || account.gmailStatus === "verification"));
    if (!targets.length) {
      notify("Trong lựa chọn không có profile nào đang chờ CAPTCHA.", "error");
      return;
    }
    setBusy("bulk-captcha");
    for (const account of targets) {
      await run(() => api(`/accounts/${account.id}/captcha`, {}));
    }
    setBusy("");
    notify(`Đã gửi CAPTCHA của ${targets.length} profile tới 2Captcha.`);
  };
  const bulkLogin = async () => {
    const targets = selectedAccounts.filter((account) => account.provider === "dreamface");
    if (!targets.length) {
      notify("Chọn ít nhất một profile DreamFace để đăng nhập ẩn.", "error");
      return;
    }
    setBusy("bulk-login");
    const queued = await run(() => api("/accounts/bulk-login", {
      ids: targets.map((account) => account.id),
      concurrency: Number(data.settings?.dreamfaceConcurrency) || 1,
    }));
    setBusy("");
    if (queued)
      notify(`Đã xếp hàng ${queued.queued} profile đăng nhập ẩn. Không mở cửa sổ Chrome nào.`);
  };
  const openBulkProxy = (mode) => {
    const targets = selectedAccounts.filter((account) => account.provider === "dreamface");
    if (!targets.length) {
      notify("Chọn ít nhất một profile DreamFace để đổi proxy.", "error");
      return;
    }
    setBulkProxyValue("");
    setModal({ type: "proxy-bulk", mode, ids: targets.map((account) => account.id) });
  };
  const submitBulkProxy = async (event) => {
    event.preventDefault();
    const lines = bulkProxyValue.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (modal.mode === "set" && !lines.length) {
      notify("Nhập ít nhất một proxy.", "error");
      return;
    }
    if (modal.mode === "set" && lines.length > 1 && lines.length !== modal.ids.length) {
      notify(`Đang chọn ${modal.ids.length} profile nhưng có ${lines.length} dòng proxy. Dùng một dòng cho tất cả hoặc đúng ${modal.ids.length} dòng.`, "error");
      return;
    }
    setBusy("proxy-bulk");
    const result = await run(() => api("/accounts/proxy-bulk", {
      ids: modal.ids,
      mode: modal.mode,
      proxies: lines,
    }));
    setBusy("");
    if (!result) return;
    const skipped = result.skipped?.length || 0;
    notify(modal.mode === "clear"
      ? `Đã bỏ proxy khỏi ${result.updated} profile${skipped ? `, bỏ qua ${skipped} profile đang bận` : ""}.`
      : `Đã gán proxy cho ${result.updated} profile${skipped ? `, bỏ qua ${skipped} profile đang bận` : ""}.`);
    close();
  };
  const deleteAccount = async (account) => {
    if (
      !confirm(
        sharedProfile(account)
          ? `Xóa tài khoản ${account.name}? Hồ sơ Google vẫn được giữ cho tài khoản khác đang dùng chung.`
          : `Xóa tài khoản ${account.name} và hồ sơ trình duyệt đang dùng?`,
      )
    )
      return;
    const result = await run(() => api(`/accounts/${account.id}`, {}, "DELETE"));
    if (result) {
      setSelectedIds((current) => current.filter((id) => id !== account.id));
      notify(result.profileRetained
        ? "Đã xóa tài khoản. Hồ sơ Google dùng chung được giữ lại."
        : "Đã xóa tài khoản và hồ sơ trình duyệt đang dùng.");
    }
  };
  const clearProxy = async (account) => {
    const result = await run(() => api(`/accounts/${account.id}`, { proxy: "" }, "PATCH"));
    if (result) {
      notify("Đã bỏ proxy khỏi profile.");
      close();
    }
  };
  const toggleStatus = (value) => setFilters((current) => ({
    ...current,
    statuses: current.statuses.includes(value)
      ? current.statuses.filter((item) => item !== value)
      : [...current.statuses, value],
  }));
  const toggleSelect = (id) => setSelectedIds((current) =>
    current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const toggleSelectAll = () => setSelectedIds((current) =>
    allVisibleSelected
      ? current.filter((id) => !visibleIds.includes(id))
      : [...new Set([...current, ...visibleIds])]);
  const clearFilters = () => setFilters({
    provider: "all",
    statuses: [],
    proxy: "all",
    query: "",
    sort: "attention",
  });
  const createGmailAccount = async (event) => {
    event.preventDefault();
    setBusy("gmail-create");
    const proxy = gmailProxy.trim();
    const created = await run(() => api("/accounts/bulk-slots", {
      provider: "dreamface",
      count: 1,
      namePrefix: gmailPrefix.trim() || "DreamFace Gmail",
      proxies: proxy ? [proxy] : [],
    }));
    const account = created?.accounts?.[0];
    if (account) {
      const queued = await run(() => api("/accounts/bulk-login", { ids: [account.id] }));
      close();
      if (queued) notify(`Đã tạo email mẫu ${account.email}. App đăng nhập ẩn profile này trong nền; cửa sổ Chrome không mở ra.`);
    }
    setBusy("");
  };
  const submit = async (event) => {
    event.preventDefault();
    setBusy("save");
    const account = await run(() => api("/accounts", form));
    if (account) {
      if (form.loginMethod === "cookie" && cookies.trim()) {
        await action(account.id, "cookies", { cookies });
      } else if (form.loginMethod !== "cookie") {
        await action(account.id, "login", { email: form.email, password });
      }
      close();
    }
    setBusy("");
  };
  const createSlots = async (event) => {
    event.preventDefault();
    setBusy("bulk-slots");
    const proxies = slotProxies.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const result = await run(() => api("/accounts/bulk-slots", {
      provider: "dreamface",
      count: Number(slotCount),
      namePrefix: slotPrefix,
      proxies,
    }));
    if (result) {
      close();
      notify(`Đã tạo ${result.created} profile DreamFace${proxies.length ? " và gán proxy." : "."}`);
      if (connectNewProfiles) {
        const queued = await run(() => api("/accounts/bulk-login", {
          ids: result.accounts.map((account) => account.id),
          concurrency: Number(slotConcurrency) || 1,
        }));
        if (queued) {
          const hint = captchaConfigured
            ? `App đăng nhập ẩn ${queued.concurrency || slotConcurrency} profile cùng lúc và tự giải CAPTCHA bằng 2Captcha.`
            : "App đăng nhập ẩn trong nền; lưu API key 2Captcha để tự giải CAPTCHA.";
          notify(`Đã xếp hàng ${queued.queued || result.created} profile. ${hint} Không mở cửa sổ Chrome nào.`);
        }
      }
    }
    setBusy("");
  };
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ACCOUNT WORKSPACE</div>
          <h1>Tài khoản của bạn.</h1>
          <p>Quản lý các profile AI trên máy này, gồm DreamFace để render và xoay vòng theo ngày.</p>
        </div>
        <div className="account-heading-actions"><Button onClick={() => { setSlotCount(5); setSlotPrefix("DreamFace profile"); setSlotProxies(""); setSlotConcurrency(Number(data.settings?.dreamfaceConcurrency) || 1); setModal({ type: "bulk-slots" }); }}><Plus size={16} /> Tạo profile xoay vòng</Button><Button onClick={() => { setGmailPrefix("DreamFace Gmail"); setGmailProxy(""); setModal({ type: "gmail-create" }); }}><MailPlus size={16} /> Tạo Gmail & đăng nhập</Button><Button
          variant="primary"
          onClick={() => {
            setForm({
              name: "",
              provider: "dola",
              loginMethod: "google",
              email: "",
              proxy: "",
            });
            setModal({ type: "add" });
          }}
        >
          <Plus size={17} />
          Thêm tài khoản
        </Button></div>
      </div>
      <section className="dreamface-pool">
        <div className="dreamface-pool-copy">
          <div className="eyebrow">DREAMFACE POOL</div>
          <h3>{dreamfaceAccounts.length ? `${dreamfaceAccounts.length} profile đang quản lý` : "Tạo pool DreamFace"}</h3>
          <p>Chọn <strong>Tự chọn</strong> khi render. App ưu tiên profile chưa dùng trong ngày, sau đó xoay theo lượt ít dùng gần đây nhất.</p>
        </div>
        <div className="dreamface-pool-stats">
          <span><strong>{dreamfaceReady}</strong> sẵn sàng</span>
          <span><strong>{dreamfaceNeedsLogin}</strong> cần đăng nhập</span>
          {dreamfaceVerification > 0 && <span><strong>{dreamfaceVerification}</strong> chờ CAPTCHA</span>}
        </div>
        <div className="dreamface-pool-actions">
          <Button disabled={!dreamfaceAccounts.length || Boolean(busy)} busy={busy === "bulk-check"} onClick={checkDreamfaceAll}><RefreshCw size={14} /> Kiểm tra tất cả</Button>
          <Button disabled={!captchaConfigured || !dreamfaceVerification || Boolean(busy)} busy={busy === "captcha-all"} onClick={solveAllCaptcha}><ShieldCheck size={14} /> Giải CAPTCHA</Button>
        </div>
      </section>
      <div className="account-explainer">
        <span className="explainer-icon">
          <KeyRound size={22} />
        </span>
        <div>
          <h3>Dùng Gmail hoặc Apple để đăng nhập Dola.</h3>
          <p>
            Không cần tạo mật khẩu Dola riêng. Chọn Dola → Google / Gmail hoặc
            Apple / iCloud → hoàn tất đăng nhập và quay về Dola. App sẽ kiểm tra
            phiên Dola rồi báo “Sẵn sàng”.
          </p>
          <p>
            Chỉ đăng nhập Gmail ở cửa sổ khác chưa kết nối Dola với app này.
            Nhập cookie là cách dùng lại một phiên Dola đã đăng nhập; số lượt
            tạo video vẫn do Dola quyết định.
          </p>
        </div>
      </div>
      <section className="account-filters" aria-label="Bộ lọc tài khoản">
        <div className="account-filter-row">
          <label className="account-search">
            <Search size={14} />
            <input
              type="search"
              value={filters.query}
              placeholder="Tìm theo tên, email hoặc proxy…"
              aria-label="Tìm tài khoản"
              onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
            />
            {filters.query && (
              <button type="button" className="account-search-clear" aria-label="Xoá tìm kiếm" onClick={() => setFilters((current) => ({ ...current, query: "" }))}>
                <X size={13} />
              </button>
            )}
          </label>
          <div className="segmented provider-segmented" role="group" aria-label="Nhà cung cấp">
            {[
              ["all", "Tất cả"],
              ["dreamface", "DreamFace"],
              ["dola", "Dola"],
              ["flow", "Google Flow"],
            ].map(([value, label]) => (
              <button
                key={value}
                className={filters.provider === value ? "selected" : ""}
                aria-pressed={filters.provider === value}
                onClick={() => setFilters((current) => ({ ...current, provider: value }))}
              >
                {label}
              </button>
            ))}
          </div>
          <select
            className="account-sort"
            aria-label="Sắp xếp tài khoản"
            value={filters.sort}
            onChange={(event) => setFilters((current) => ({ ...current, sort: event.target.value }))}
          >
            <option value="attention">Cần xử lý trước</option>
            <option value="name">Tên A → Z</option>
            <option value="recent">Mới tạo trước</option>
          </select>
        </div>
        <div className="account-filter-chips">
          <span className="filter-label"><ListFilter size={13} /> Trạng thái</span>
          {STATUS_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`filter-chip ${filters.statuses.includes(value) ? "active" : ""}`}
              aria-pressed={filters.statuses.includes(value)}
              onClick={() => toggleStatus(value)}
            >
              {label}
              <b>{statusCounts[value] || 0}</b>
            </button>
          ))}
          <span className="filter-divider" />
          <span className="filter-label"><Globe2 size={13} /> Proxy</span>
          {PROXY_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`filter-chip ${filters.proxy === value ? "active" : ""}`}
              aria-pressed={filters.proxy === value}
              onClick={() => setFilters((current) => ({ ...current, proxy: value }))}
            >
              {label}
              <b>{proxyCounts[value] || 0}</b>
            </button>
          ))}
          {filtersActive && (
            <button type="button" className="account-filter-clear" onClick={clearFilters}>
              <FilterX size={13} /> Xoá lọc
            </button>
          )}
          <span className="account-filter-count">
            {visibleAccounts.length}/{data.accounts.length} tài khoản
          </span>
        </div>
      </section>
      {selectedAccounts.length > 0 && (
        <div className="account-bulkbar" role="region" aria-label="Thao tác hàng loạt">
          <strong>{selectedAccounts.length} đã chọn</strong>
          <Button disabled={Boolean(busy) || selectedHasOtherProvider} title={selectedHasOtherProvider ? "Chỉ áp dụng cho profile DreamFace" : ""} onClick={() => openBulkProxy("set")}><Globe2 size={14} /> Gán proxy</Button>
          <Button disabled={Boolean(busy) || selectedHasOtherProvider} title={selectedHasOtherProvider ? "Chỉ áp dụng cho profile DreamFace" : ""} onClick={() => openBulkProxy("clear")}><Globe2 size={14} /> Bỏ proxy</Button>
          <Button disabled={Boolean(busy) || selectedHasOtherProvider} title={selectedHasOtherProvider ? "Chỉ áp dụng cho profile DreamFace" : ""} busy={busy === "bulk-login"} onClick={bulkLogin}><LogIn size={14} /> Đăng nhập ẩn</Button>
          <Button disabled={Boolean(busy)} busy={busy === "bulk-check"} onClick={() => checkAccounts(selectedAccounts)}><RefreshCw size={14} /> Kiểm tra phiên</Button>
          <Button disabled={Boolean(busy)} busy={busy === "bulk-captcha"} onClick={solveSelectedCaptcha}><ShieldCheck size={14} /> Giải CAPTCHA</Button>
          <button type="button" className="account-bulk-clear" onClick={() => setSelectedIds([])}>Bỏ chọn</button>
        </div>
      )}
      {data.accounts.length === 0 ? (
        <Empty icon={Users} title="Thêm tài khoản đầu tiên">
          Dola hỗ trợ Google và Apple. Google Flow dùng tài khoản Google.
          <br />
          Bạn cũng có thể nhập cookie của chính tài khoản đang dùng.
        </Empty>
      ) : visibleAccounts.length === 0 ? (
        <Empty icon={FilterX} title="Không có profile khớp bộ lọc" action={<Button onClick={clearFilters}><FilterX size={15} /> Xoá bộ lọc</Button>}>
          Thử bỏ bớt trạng thái, proxy hoặc từ khoá tìm kiếm để xem lại toàn bộ profile.
        </Empty>
      ) : (
        <div className="account-list">
          <div className="account-list-head">
            <label className="row-check">
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} aria-label="Chọn tất cả profile đang hiển thị" />
            </label>
            <span>Hồ sơ</span>
            <span>Nhóm</span>
            <span>Proxy</span>
            <span>Trạng thái</span>
            <span aria-hidden="true" />
          </div>
          {visibleAccounts.map((account) => {
            const avatarMedia = account.avatarMediaId
              ? data.media.find((media) => media.id === account.avatarMediaId)
              : null;
            const selected = selectedIds.includes(account.id);
            const canOperate = !busy && !["busy", "checking"].includes(account.status);
            return (
              <section className={`account-row ${selected ? "selected" : ""}`} key={account.id}>
                <label className="row-check">
                  <input type="checkbox" checked={selected} onChange={() => toggleSelect(account.id)} aria-label={`Chọn ${account.name}`} />
                </label>
                <div className="account-identity">
                  {account.provider === "dreamface" ? (
                    <span
                      className="account-avatar-thumb"
                      title={avatarMedia ? `${account.avatarName || "AI News Host"} · Avatar 3.0 Fast · 720p` : "AI MC sẽ được tạo ở lần render tin tức đầu tiên"}
                    >
                      {avatarMedia?.thumbnailUrl ? <img src={avatarMedia.thumbnailUrl} alt="" /> : "MC"}
                    </span>
                  ) : (
                    <span className={`provider-logo ${account.provider}`}>
                      {account.provider === "dola" ? "d" : "F"}
                    </span>
                  )}
                  <div className="account-identity-copy">
                    <strong title={account.name}>{account.name}</strong>
                    <span title={account.email || ""}>
                      {account.email || (account.loginMethod === "cookie" ? "Đăng nhập bằng cookie" : "Đăng nhập qua trình duyệt")}
                    </span>
                  </div>
                </div>
                <div className="account-row-tags">
                  <span>{providerLabel(account.provider)}</span>
                  <span>{methodLabel(account)}</span>
                  {sharedProfile(account) && <span>Hồ sơ dùng chung</span>}
                  {account.provider === "dreamface" && gmailLabel(account.gmailStatus) && (
                    <span className={account.gmailStatus === "verification" ? "tag-warn" : ""}>{gmailLabel(account.gmailStatus)}</span>
                  )}
                </div>
                <div className="account-proxy">
                  {account.proxy ? (
                    <>
                      <span className="proxy-address" title={account.proxy}><Globe2 size={12} /> {account.proxy}</span>
                      <small className={account.proxyStatus === "ready" ? "proxy-ok" : account.proxyStatus === "error" ? "proxy-error" : "muted"}>
                        {account.proxyStatus === "ready"
                          ? `Proxy OK${account.proxyIp ? ` · ${account.proxyIp}` : ""}`
                          : account.proxyStatus === "error"
                            ? "Proxy lỗi"
                            : account.proxyAuth ? "Có user/pass · chưa kiểm tra" : "Chưa kiểm tra"}
                      </small>
                    </>
                  ) : (
                    <span className="muted">Kết nối trực tiếp</span>
                  )}
                </div>
                <div className="account-row-state">
                  <Badge status={account.status} />
                  {account.message && <small className="account-row-message" title={account.message}>{account.message}</small>}
                </div>
                <div className="account-row-actions">
                  <button
                    type="button"
                    className="icon-button"
                    title="Kiểm tra phiên"
                    aria-label={`Kiểm tra phiên ${account.name}`}
                    disabled={Boolean(busy) || account.status === "busy"}
                    onClick={() => action(account.id, "check")}
                  >
                    <RefreshCw size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    title="Mở trình duyệt tài khoản"
                    aria-label={`Mở trình duyệt ${account.name}`}
                    disabled={Boolean(busy)}
                    onClick={() => action(account.id, "open")}
                  >
                    <ExternalLink size={15} />
                  </button>
                  {account.provider === "dreamface" && (
                    <button
                      type="button"
                      className="icon-button"
                      title={account.proxy ? "Sửa proxy" : "Thêm proxy"}
                      aria-label={`${account.proxy ? "Sửa" : "Thêm"} proxy ${account.name}`}
                      disabled={!canOperate}
                      onClick={() => { setProxyValue(account.proxy || ""); setModal({ type: "proxy", account }); }}
                    >
                      <Globe2 size={15} />
                    </button>
                  )}
                  <details className="row-menu" name="account-row-menu">
                    <summary className="icon-button" title="Thao tác khác" aria-label={`Thao tác khác cho ${account.name}`}>
                      <MoreHorizontal size={16} />
                    </summary>
                    <div
                      className="row-menu-panel"
                      onClick={(event) => {
                        if (event.target.closest("button")) event.currentTarget.parentElement.open = false;
                      }}
                    >
                      <button type="button" disabled={Boolean(busy) || account.status === "busy"} onClick={() => action(account.id, "login")}>
                        <LogIn size={13} />
                        {account.provider === "dreamface" && account.hasCredentials ? "Kết nối profile đã lưu" : "Đăng nhập"}
                      </button>
                      {account.provider === "dreamface" && (
                        <button
                          type="button"
                          disabled={!canOperate}
                          onClick={() => action(account.id, "gmail-signup", { action: ["ready", "created", "verification", "pending", "opening"].includes(account.gmailStatus) ? "check" : "start" })}
                        >
                          <MailPlus size={13} />
                          {account.gmailStatus === "ready" || account.gmailStatus === "created" ? "Mở DreamFace" : account.gmailStatus === "verification" || account.gmailStatus === "pending" || account.gmailStatus === "opening" ? "Kiểm tra DreamFace" : "Tạo Gmail & điền"}
                        </button>
                      )}
                      {account.provider === "dreamface" && (account.status === "verification" || account.gmailStatus === "verification") && (
                        <button type="button" disabled={!canOperate} onClick={() => solveCaptcha(account)}>
                          <ShieldCheck size={13} /> Giải CAPTCHA tự động
                        </button>
                      )}
                      {account.provider === "dreamface" && account.proxy && (
                        <button type="button" disabled={!canOperate} onClick={() => checkProxy(account)}>
                          <Globe2 size={13} /> Kiểm tra proxy
                        </button>
                      )}
                      <button type="button" disabled={account.status === "busy"} onClick={() => setModal({ type: "cookies", account })}>
                        <Cookie size={13} /> Nhập cookie
                      </button>
                      {data.capabilities?.googleProfileReuse && account.loginMethod === "google" && googleSources(account).length > 0 && (
                        <button
                          type="button"
                          disabled={!canOperate}
                          onClick={() => { setSourceAccountId(""); setModal({ type: "reuse-google", account }); }}
                        >
                          <KeyRound size={13} /> Dùng phiên Google có sẵn
                        </button>
                      )}
                      <button type="button" className="danger-text" disabled={account.status === "busy"} onClick={() => deleteAccount(account)}>
                        <Trash2 size={13} /> Xoá tài khoản
                      </button>
                    </div>
                  </details>
                </div>
              </section>
            );
          })}
        </div>
      )}
      <div className="privacy-note">
        <ShieldCheck size={17} />
        <span>
          Tài khoản dùng hồ sơ Chrome riêng, hoặc hồ sơ Google bạn chọn dùng chung.
          DreamFace sign-in details are encrypted and saved on this PC. Cookies remain in each browser profile.
        </span>
      </div>
      {modal?.type === "reuse-google" && (
        <Modal title={`Dùng phiên Google · ${modal.account.name}`} onClose={close}>
          <form onSubmit={async (event) => {
            event.preventDefault();
            if (await action(modal.account.id, "reuse-google", { sourceAccountId })) close();
          }}>
            <Field label="Hồ sơ Google đã có trong app">
              <select required value={sourceAccountId} onChange={(event) => setSourceAccountId(event.target.value)}>
                <option value="">Chọn tài khoản đã đăng nhập Google</option>
                {googleSources(modal.account).map((source) => (
                  <option key={source.id} value={source.id} disabled={["busy", "checking"].includes(source.status)}>
                    {source.name} · {source.provider === "dola" ? "Dola" : "Flow"}
                  </option>
                ))}
              </select>
            </Field>
            <Notice>
              Hai tài khoản sẽ dùng chung phiên Google trong cùng hồ sơ Chrome,
              với trang Dola và Flow riêng. Các tác vụ trên hồ sơ này chạy lần lượt.
              Dịch vụ vẫn có thể yêu cầu xác nhận đăng nhập. Hồ sơ cũ được giữ trên máy.
            </Notice>
            <div className="modal-actions">
              <Button type="button" onClick={close}>Hủy</Button>
              <Button variant="primary" busy={Boolean(busy)} disabled={!sourceAccountId}>
                Dùng hồ sơ & kiểm tra
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {modal?.type === "proxy-bulk" && (
        <Modal title={modal.mode === "clear" ? `Bỏ proxy · ${modal.ids.length} profile` : `Gán proxy · ${modal.ids.length} profile`} onClose={close}>
          <form onSubmit={submitBulkProxy}>
            {modal.mode === "clear" ? (
              <Notice>
                App sẽ đóng phiên Chrome của từng profile, bỏ proxy và giữ nguyên dữ liệu đăng nhập.
                Profile chuyển về trạng thái cần kiểm tra lại. Profile đang được sử dụng sẽ được bỏ qua.
              </Notice>
            ) : (
              <>
                <Field
                  label="Danh sách proxy"
                  hint={`Một dòng dùng chung cho cả ${modal.ids.length} profile; hoặc đúng ${modal.ids.length} dòng để gán lần lượt. Hỗ trợ host:port, host:port:user:pass hoặc user:pass@host:port.`}
                >
                  <textarea
                    autoFocus
                    rows={Math.min(6, Math.max(3, modal.ids.length))}
                    value={bulkProxyValue}
                    onChange={(event) => setBulkProxyValue(event.target.value)}
                    placeholder={"127.0.0.1:8080\n127.0.0.1:8081:user:pass"}
                  />
                </Field>
                <Notice>
                  App đóng phiên Chrome hiện tại của từng profile rồi lưu proxy mới. Dữ liệu đăng nhập vẫn được giữ;
                  profile chuyển về trạng thái cần kiểm tra và có thể kiểm tra proxy ngay sau đó.
                </Notice>
              </>
            )}
            <div className="modal-actions">
              <Button type="button" onClick={close}>Hủy</Button>
              <Button variant="primary" busy={busy === "proxy-bulk"} disabled={modal.mode === "set" && !bulkProxyValue.trim()}>
                <Globe2 size={15} />
                {modal.mode === "clear" ? "Bỏ proxy" : "Gán proxy"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {modal?.type === "add" && (
        <Modal title="Thêm tài khoản" onClose={close}>
          <form onSubmit={submit}>
            <div className="form-grid">
              <Field label="Nhà cung cấp">
                <select
                  value={form.provider}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      provider: event.target.value,
                      loginMethod: event.target.value === "dreamface" ? "credentials" : "google",
                    })
                  }
                >
                  <option value="dola">Dola · Seedance</option>
                  <option value="flow">Google Flow · Veo</option>
                  <option value="dreamface">DreamFace</option>
                </select>
              </Field>
              <Field label="Cách đăng nhập">
                <select
                  value={form.loginMethod}
                  onChange={(event) =>
                    setForm({ ...form, loginMethod: event.target.value })
                  }
                >
                  <option value="google">Google / Gmail</option>
                  {form.provider === "dola" && (
                    <option value="apple">Apple / iCloud</option>
                  )}
                  {form.provider === "dreamface" && <option value="credentials">DreamFace email + password</option>}
                  <option value="cookie">Nhập cookie</option>
                </select>
              </Field>
            </div>
            <Field label="Tên dễ nhớ">
              <input
                autoFocus
                required
                value={form.name}
                maxLength={120}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                placeholder="Tài khoản làm việc"
              />
            </Field>
            <Field label="Email (không bắt buộc)">
              <input
                type="email"
                value={form.email}
                autoComplete="off"
                onChange={(event) =>
                  setForm({ ...form, email: event.target.value })
                }
                placeholder={
                  form.loginMethod === "apple"
                    ? "tenban@icloud.com"
                    : "tenban@gmail.com"
                }
              />
            </Field>
            {form.loginMethod === "cookie" ? (
              <CookieInput
                cookies={cookies}
                setCookies={setCookies}
                notify={notify}
              />
            ) : (
              <>
                <Field
                  label={form.provider === "dreamface" ? "DreamFace password (saved for reuse)" : "Mật khẩu (tùy chọn, chỉ dùng lần này)"}
                  hint={form.provider === "dreamface" ? "Saved on this PC for future connections." : "Bạn có thể để trống và đăng nhập trực tiếp trong cửa sổ Google/Apple."}
                >
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </Field>
                <Notice>
                  {form.provider === "dola"
                    ? "Dola sẽ mở cửa sổ Google/Apple. Đăng nhập, bấm Tiếp tục nếu được hỏi và chờ quay về Dola. Không cần đăng ký mật khẩu Dola riêng."
                    : "Đăng nhập Google rồi mở không gian làm việc của Flow. App sẽ kiểm tra phiên sau đó."}
                </Notice>
              </>
            )}
            <details className="advanced">
              <summary>
                <Globe2 size={14} />
                Proxy riêng (tùy chọn)
              </summary>
              <Field label="Địa chỉ proxy">
                <input
                  value={form.proxy}
                  onChange={(event) =>
                    setForm({ ...form, proxy: event.target.value })
                  }
                  placeholder="http://127.0.0.1:8080"
                />
              </Field>
            </details>
            <div className="modal-actions">
              <Button type="button" onClick={close}>
                Hủy
              </Button>
              <Button variant="primary" busy={Boolean(busy)}>
                <Plus size={16} />
                {form.loginMethod === "cookie"
                  ? "Thêm & nhập cookie"
                  : "Thêm & đăng nhập"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {modal?.type === "bulk-slots" && (
        <Modal title="Tạo nhiều profile DreamFace" onClose={close}>
          <form onSubmit={createSlots}>
            <Notice>
              Mỗi profile được tạo một email Gmail dạng mẫu riêng và mật khẩu ngẫu nhiên, lưu cục bộ trong kho mã hóa. Khi bật <strong>Đăng nhập ẩn ngay</strong>, app đăng nhập trong nền, tự giải reCAPTCHA bằng 2Captcha, chờ profile sẵn sàng rồi đóng và chuyển sang profile kế tiếp. Không mở cửa sổ Chrome nào, kể cả khi DreamFace cần xác minh. App không tạo hộp thư Google thật.
            </Notice>
            <div className="form-grid">
              <Field label="Số profile muốn tạo"><input type="number" min="1" max="100" value={slotCount} onChange={(event) => setSlotCount(event.target.value)} /></Field>
              <Field label="Tiền tố tên profile"><input maxLength="80" value={slotPrefix} onChange={(event) => setSlotPrefix(event.target.value)} /></Field>
            </div>
            <Field label="Proxy cho profile (tùy chọn)" hint="Một dòng dùng chung cho tất cả profile; nhiều dòng phải đúng bằng số profile. Hỗ trợ host:port, host:port:user:pass hoặc user:pass@host:port.">
              <textarea rows="3" value={slotProxies} onChange={(event) => setSlotProxies(event.target.value)} placeholder={"http://127.0.0.1:8080\nhttp://127.0.0.1:8081"} />
            </Field>
            <label className="check-field"><input type="checkbox" aria-label="Đăng nhập ẩn ngay, không mở cửa sổ" checked={connectNewProfiles} onChange={event=>setConnectNewProfiles(event.target.checked)}/> Đăng nhập ẩn ngay (không mở cửa sổ)</label>
            {connectNewProfiles && (
              <Field label="Số luồng Chrome chạy cùng lúc" hint="1 = lần lượt từng profile. Tăng lên để nhanh hơn nhưng tốn thêm RAM/CPU; Chrome vẫn chạy ẩn.">
                <input type="number" min="1" max="4" value={slotConcurrency} onChange={(event) => setSlotConcurrency(event.target.value)} />
              </Field>
            )}
            <Field label="Chọn profile khi render" hint="Tự chọn sẽ ưu tiên profile đã kết nối và chưa dùng trong ngày. Proxy được gắn cố định theo từng profile.">
              <input value="Xoay vòng theo ngày · profile sẵn sàng" readOnly />
            </Field>
            <div className="modal-actions"><Button type="button" onClick={close}>Hủy</Button><Button variant="primary" aria-label={`Tạo ${slotCount} profile`} busy={busy === "bulk-slots"}><Plus size={15} /> Tạo {slotCount} profile</Button></div>
          </form>
        </Modal>
      )}
      {modal?.type === "gmail-create" && (
        <Modal title="Tạo Gmail mẫu & đăng nhập DreamFace" onClose={close}>
          <form onSubmit={createGmailAccount}>
            <Notice>
              App sẽ tạo một email Gmail dạng mẫu không trùng các profile cũ, lưu mật khẩu ngẫu nhiên an toàn rồi mở DreamFace để tự điền và gửi đăng nhập/đăng ký. App không tạo Gmail thật. Nếu đã lưu API key 2Captcha, reCAPTCHA được giải tự động qua API; nếu không, cửa sổ Chrome sẽ giữ nguyên để bạn giải rồi bấm “Kiểm tra DreamFace”.
            </Notice>
            <Field label="Tên profile">
              <input autoFocus maxLength="80" value={gmailPrefix} onChange={(event) => setGmailPrefix(event.target.value)} placeholder="DreamFace Gmail" />
            </Field>
            <Field label="Proxy riêng (tùy chọn)" hint="Hỗ trợ host:port, host:port:user:pass hoặc user:pass@host:port. User/password được mã hóa trong máy và tự dùng khi mở Chrome.">
              <input value={gmailProxy} onChange={(event) => setGmailProxy(event.target.value)} placeholder="127.0.0.1:8080:user:pass" />
            </Field>
            <div className="modal-actions"><Button type="button" onClick={close}>Hủy</Button><Button variant="primary" busy={busy === "gmail-create"}><MailPlus size={15} /> Tạo email & mở DreamFace</Button></div>
          </form>
        </Modal>
      )}
      {modal?.type === "proxy" && (
        <Modal title={`Proxy · ${modal.account.name}`} onClose={close}>
          <form onSubmit={async (event) => {
            event.preventDefault();
            const result = await run(() => api(`/accounts/${modal.account.id}`, { proxy: proxyValue }, "PATCH"));
            if (result) {
              notify(proxyValue.trim() ? "Đã lưu proxy. Kiểm tra lại phiên trước khi render." : "Đã bỏ proxy khỏi profile.");
              close();
            }
          }}>
            <Field label="Địa chỉ proxy" hint="Hỗ trợ host:port, host:port:user:pass hoặc user:pass@host:port. User/password được mã hóa, không hiện lại trong giao diện.">
              <input autoFocus value={proxyValue} onChange={(event) => setProxyValue(event.target.value)} placeholder="127.0.0.1:8080:user:pass" />
            </Field>
            <Notice>Đổi proxy sẽ đóng phiên trình duyệt hiện tại của profile và chuyển trạng thái về cần kiểm tra; dữ liệu đăng nhập vẫn được giữ.</Notice>
            <div className="modal-actions">
              <Button type="button" onClick={close}>Hủy</Button>
              {modal.account.proxy && <Button type="button" onClick={() => clearProxy(modal.account)}>Bỏ proxy</Button>}
              <Button variant="primary" busy={Boolean(busy)}><Globe2 size={15} /> Lưu proxy</Button>
            </div>
          </form>
        </Modal>
      )}
      {modal?.type === "cookies" && (
        <Modal title={`Nhập cookie · ${modal.account.name}`} onClose={close}>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (await action(modal.account.id, "cookies", { cookies }))
                close();
            }}
          >
            <CookieInput
              cookies={cookies}
              setCookies={setCookies}
              notify={notify}
            />
            <Notice>
              Cookie cần thuộc{" "}
              {modal.account.provider === "dola" ? "dola.com" : "google.com"} và
              còn hạn. Cookie Google không thay thế cookie Dola sau đăng nhập.
            </Notice>
            <div className="modal-actions">
              <Button type="button" onClick={close}>
                Hủy
              </Button>
              <Button
                variant="primary"
                busy={Boolean(busy)}
                disabled={!cookies.trim()}
              >
                <Cookie size={16} />
                Nhập & kiểm tra
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function CookieInput({ cookies, setCookies, notify }) {
  return (
    <div>
      <Field
        label="Cookie"
        hint="Nhận JSON (Cookie-Editor), Netscape cookies.txt hoặc chuỗi name=value; name=value."
      >
        <textarea
          className="code-input"
          value={cookies}
          required
          rows="7"
          onChange={(event) => setCookies(event.target.value)}
          placeholder='[{"name":"sessionid","value":"…","domain":".dola.com"}]'
          spellCheck={false}
          autoComplete="off"
        />
      </Field>
      <label className="button file-label">
        <FileUp size={15} />
        Chọn tệp cookie
        <input
          type="file"
          accept=".json,.txt"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (file.size > 2000000)
              return notify("Tệp cookie tối đa 2 MB.", "error");
            setCookies(await file.text());
          }}
        />
      </label>
    </div>
  );
}
