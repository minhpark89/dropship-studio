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
} from "lucide-react";
import { api } from "../api.js";
import { Button, Modal, Field, Badge, Empty, Notice } from "../components.jsx";

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
  const [busy, setBusy] = useState("");
  const [filter, setFilter] = useState("all");
  const [slotCount, setSlotCount] = useState(5);
  const [slotPrefix, setSlotPrefix] = useState("DreamFace profile");
  const [slotProxies, setSlotProxies] = useState("");
  const [slotConcurrency, setSlotConcurrency] = useState(1);
  const [connectNewProfiles,setConnectNewProfiles]=useState(true);
  const [gmailPrefix, setGmailPrefix] = useState("DreamFace Gmail");
  const [gmailProxy, setGmailProxy] = useState("");
  const accounts = data.accounts.filter(
    (account) => filter === "all" || account.provider === filter,
  );
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
  const close = () => {
    setModal(null);
    setPassword("");
    setCookies("");
    setSourceAccountId("");
    setProxyValue("");
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
  const checkDreamfaceAll = async () => {
    if (!dreamfaceAccounts.length || busy) return;
    setBusy("dreamface-all");
    let checked = 0;
    for (const account of dreamfaceAccounts) {
      const result = await run(() => api(`/accounts/${account.id}/check`));
      if (result) checked += 1;
    }
    setBusy("");
    if (checked) notify(`Đã kiểm tra ${checked} profile DreamFace. Profile sẵn sàng sẽ tự được xoay vòng khi chọn Tự chọn.`);
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
          <Button disabled={!dreamfaceAccounts.length || Boolean(busy)} busy={busy === "dreamface-all"} onClick={checkDreamfaceAll}><RefreshCw size={14} /> Kiểm tra tất cả</Button>
          <Button disabled={!captchaConfigured || !dreamfaceVerification || Boolean(busy)} busy={busy === "captcha-all"} onClick={solveAllCaptcha}><ShieldCheck size={14} /> Giải CAPTCHA</Button>
          <Button onClick={() => { setGmailPrefix("DreamFace Gmail"); setGmailProxy(""); setModal({ type: "gmail-create" }); }}><MailPlus size={15} /> Tạo Gmail</Button>
          <Button variant="primary" onClick={() => { setSlotCount(5); setSlotPrefix("DreamFace profile"); setSlotProxies(""); setModal({ type: "bulk-slots" }); }}><Plus size={15} /> Tạo nhiều profile</Button>
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
      <div className="toolbar">
        <div className="segmented">
          {[
            ["all", "Tất cả"],
            ["dola", "Dola"],
            ["flow", "Google Flow"],
            ["dreamface", "DreamFace"],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? "selected" : ""}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="muted small">
          {data.accounts.filter((account) => account.status === "ready").length}{" "}
          sẵn sàng / {data.accounts.length} tài khoản
        </span>
      </div>
      {accounts.length ? (
        <div className="account-grid">
          {accounts.map((account) => (
            <section className="panel account-card" key={account.id}>
              {account.provider === "dreamface" && (() => {
                const avatarMedia = account.avatarMediaId
                  ? data.media.find((media) => media.id === account.avatarMediaId)
                  : null;
                return <div className="account-avatar-preview">
                  {avatarMedia?.thumbnailUrl ? <img src={avatarMedia.thumbnailUrl} alt="DreamFace MC still" /> : <span className="account-avatar-placeholder">MC</span>}
                  <div><span className="account-avatar-kicker">AI MC STILL</span><strong>{avatarMedia ? `${account.avatarName || "AI News Host"} - ready` : "Created on first news render"}</strong><small>{avatarMedia ? `${account.avatarSource === "dreamface-image" ? "DreamFace Image" : "Highlight image endpoint"} - Avatar 3.0 Fast - 720p` : "An original AI presenter is generated and saved automatically."}</small></div>
                </div>;
              })()}
              <div className="spread">
                <span className={`provider-logo ${account.provider}`}>
                  {account.provider === "dola" ? "d" : account.provider === "dreamface" ? "D" : "F"}
                </span>
                <Badge status={account.status} />
              </div>
              <h3>{account.name}</h3>
              <p className="account-email">
                {account.email ||
                  (account.loginMethod === "cookie"
                    ? "Đăng nhập bằng cookie"
                    : "Đăng nhập qua trình duyệt")}
              </p>
              <div className="account-tags">
                <span>
                  {account.provider === "dola"
                    ? "Dola / Seedance"
                    : account.provider === "dreamface"
                      ? "DreamFace · xoay ngày"
                      : "Google Flow / Veo"}
                </span>
                {sharedProfile(account) && <span>Hồ sơ Google dùng chung</span>}
                <span>
                  {account.loginMethod === "apple"
                    ? "Apple · iCloud"
                    : account.loginMethod === "cookie"
                      ? "Cookie"
                    : account.loginMethod === "credentials"
                      ? "Email + mật khẩu"
                      : "Google"}
                </span>
                {account.proxy && <span><Globe2 size={11} /> Proxy {account.proxy}{account.proxyAuth ? " · user/pass" : ""}</span>}
                {account.proxyStatus && <span className={account.proxyStatus === "ready" ? "account-proxy-ok" : "account-proxy-error"}><Globe2 size={11} /> {account.proxyStatus === "ready" ? `Proxy OK${account.proxyIp ? ` · ${account.proxyIp}` : ""}` : "Proxy lỗi"}</span>}
              </div>
              <p className="account-message">{account.message}</p>
              {account.provider === "dreamface" && account.gmailStatus && account.gmailStatus !== "idle" && (
                <p className="small muted">DreamFace email: {account.gmailStatus === "ready" || account.gmailStatus === "created" ? "đã sẵn sàng" : account.gmailStatus === "verification" ? "đang chờ CAPTCHA/xác minh" : account.gmailStatus === "failed" ? "cần thử lại" : account.gmailStatus === "needs_login" ? "đã tự điền, chờ xác nhận" : "đang xử lý"}</p>
              )}
              {account.provider === "dola" &&
                account.status === "needs_login" && (
                  <p className="small muted">
                    Chọn “Đăng nhập” để mở đúng cửa sổ của tài khoản này. Sau
                    khi trở về trang Dola, app tự kiểm tra trong vài giây.
                  </p>
                )}
              <div className="card-actions">
                <Button
                  disabled={Boolean(busy) || account.status === "busy"}
                  busy={busy === `${account.id}:check`}
                  onClick={() => action(account.id, "check")}
                >
                  <RefreshCw size={14} />
                  Kiểm tra phiên
                </Button>
                <Button
                  disabled={Boolean(busy)}
                  onClick={() => action(account.id, "open")}
                  title="Mở trình duyệt tài khoản"
                >
                  <ExternalLink size={15} />
                </Button>
                {account.provider === "dreamface" && <Button
                  disabled={Boolean(busy) || ["busy", "checking"].includes(account.status)}
                  onClick={() => { setProxyValue(account.proxy || ""); setModal({ type: "proxy", account }); }}
                >
                  <Globe2 size={14} />
                  {account.proxy ? "Sửa proxy" : "Thêm proxy"}
                </Button>}
                {account.provider === "dreamface" && account.proxy && <Button
                  disabled={Boolean(busy) || ["busy", "checking"].includes(account.status)}
                  busy={busy === `${account.id}:proxy-check`}
                  onClick={() => checkProxy(account)}
                >
                  <Globe2 size={14} /> Kiểm tra proxy
                </Button>}
              </div>
              {data.capabilities?.googleProfileReuse && account.loginMethod === "google" && googleSources(account).length > 0 && (
                <div className="card-actions">
                  <button
                    className="text-button"
                    disabled={Boolean(busy) || ["busy", "checking"].includes(account.status)}
                    onClick={() => {
                      setSourceAccountId("");
                      setModal({ type: "reuse-google", account });
                    }}
                  >
                    <KeyRound size={13} />
                    Dùng phiên Google có sẵn
                  </button>
                </div>
              )}
              <div className="account-footer">
                <button
                  className="text-button"
                  disabled={Boolean(busy) || account.status === "busy"}
                  onClick={() => action(account.id, "login")}
                >
                  <LogIn size={13} />
                  {account.provider === "dreamface" && account.hasCredentials ? "Connect saved profile" : "Đăng nhập"}
                </button>
                {account.provider === "dreamface" && <button
                  className="text-button"
                  disabled={Boolean(busy) || ["busy", "checking"].includes(account.status)}
                   onClick={() => action(account.id, "gmail-signup", { action: ["ready", "created", "verification", "pending", "opening"].includes(account.gmailStatus) ? "check" : "start" })}
                >
                  <MailPlus size={13} />
                   {account.gmailStatus === "ready" || account.gmailStatus === "created" ? "Mở DreamFace" : account.gmailStatus === "verification" || account.gmailStatus === "pending" || account.gmailStatus === "opening" ? "Kiểm tra DreamFace" : "Tạo Gmail & điền"}
                </button>}
                {account.provider === "dreamface" && (account.status === "verification" || account.gmailStatus === "verification") && <button
                  className="text-button"
                  disabled={Boolean(busy) || ["busy", "checking"].includes(account.status)}
                  onClick={() => solveCaptcha(account)}
                >
                  <ShieldCheck size={13} />
                  Giải CAPTCHA tự động
                </button>}
                <button
                  className="text-button"
                  disabled={account.status === "busy"}
                  onClick={() => setModal({ type: "cookies", account })}
                >
                  <Cookie size={13} />
                  Nhập cookie
                </button>
                <button
                  className="icon-button danger-text"
                  disabled={account.status === "busy"}
                  aria-label={`Xóa ${account.name}`}
                  onClick={async () => {
                    if (
                      !confirm(
                        sharedProfile(account)
                          ? `Xóa tài khoản ${account.name}? Hồ sơ Google vẫn được giữ cho tài khoản khác đang dùng chung.`
                          : `Xóa tài khoản ${account.name} và hồ sơ trình duyệt đang dùng?`,
                      )
                    )
                      return;
                    const result = await run(() => api(`/accounts/${account.id}`, {}, "DELETE"));
                    if (result) notify(result.profileRetained
                      ? "Đã xóa tài khoản. Hồ sơ Google dùng chung được giữ lại."
                      : "Đã xóa tài khoản và hồ sơ trình duyệt đang dùng.");
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Empty icon={Users} title="Thêm tài khoản đầu tiên">
          Dola hỗ trợ Google và Apple. Google Flow dùng tài khoản Google.
          <br />
          Bạn cũng có thể nhập cookie của chính tài khoản đang dùng.
        </Empty>
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
            <div className="modal-actions"><Button type="button" onClick={close}>Hủy</Button><Button variant="primary" busy={Boolean(busy)}><Globe2 size={15} /> Lưu proxy</Button></div>
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
