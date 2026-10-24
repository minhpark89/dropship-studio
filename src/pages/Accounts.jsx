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
  const [busy, setBusy] = useState("");
  const [filter, setFilter] = useState("all");
  const accounts = data.accounts.filter(
    (account) => filter === "all" || account.provider === filter,
  );
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
  };
  const action = async (id, type, body = {}) => {
    setBusy(`${id}:${type}`);
    const result = await run(() => api(`/accounts/${id}/${type}`, body));
    if (result?.message) notify(result.message);
    setBusy("");
    return result;
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
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ACCOUNT WORKSPACE</div>
          <h1>Tài khoản của bạn.</h1>
          <p>Kết nối Dola và Google Flow bằng phiên đăng nhập trên máy này.</p>
        </div>
        <Button
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
        </Button>
      </div>
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
                      ? "DreamFace"
                      : "Google Flow / Veo"}
                </span>
                {sharedProfile(account) && <span>Hồ sơ Google dùng chung</span>}
                <span>
                  {account.loginMethod === "apple"
                    ? "Apple · iCloud"
                    : account.loginMethod === "cookie"
                      ? "Cookie"
                    : account.loginMethod === "credentials"
                      ? "Email + máº­t kháº©u"
                      : "Google"}
                </span>
              </div>
              <p className="account-message">{account.message}</p>
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
                  Đăng nhập
                </button>
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
          Mật khẩu không được lưu trong dự án. Cookie được giữ trên máy.
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
                  {form.provider === "dreamface" && <option value="credentials">Email + má»­t kháº©u DreamFace</option>}
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
                  label="Mật khẩu (tùy chọn, chỉ dùng lần này)"
                  hint="Bạn có thể để trống và đăng nhập trực tiếp trong cửa sổ Google/Apple."
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
