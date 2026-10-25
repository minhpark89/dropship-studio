import { useEffect, useState } from "react";
import {
  Pause,
  Play,
  RefreshCw,
  X,
  Download,
  ListVideo,
  ChevronDown,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Save,
  FolderOpen,
  Activity,
  Cpu,
  Globe2,
  Pencil,
  Trash2,
  KeyRound,
  BrainCircuit,
} from "lucide-react";
import { api } from "../api.js";
import { Button, Field, Badge, Empty, Notice } from "../components.jsx";

export function QueuePage({ data, project, run, navigate }) {
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState("");
  const jobs = data.jobs
    .filter(
      (job) =>
        job.projectId === project.id &&
        (filter === "all" ||
          (filter === "active"
            ? [
                "queued",
                "scheduled",
                "preparing",
                "submitting",
                "rendering",
                "downloading",
              ].includes(job.status)
            : job.status === filter)),
    )
    .slice()
    .reverse();
  const active = data.jobs.filter((job) =>
    ["preparing", "submitting", "rendering", "downloading"].includes(
      job.status,
    ),
  ).length;
  const queued = data.jobs.filter((job) =>
    ["queued", "scheduled"].includes(job.status),
  ).length;
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">PRODUCTION QUEUE</div>
          <h1>Ý tưởng đang thành hình.</h1>
          <p>
            Theo dõi tạo AI và xuất video. Mỗi kết quả hoàn tất được lưu vào thư
            viện.
          </p>
        </div>
        <Button
          variant={data.settings.queuePaused ? "primary" : ""}
          onClick={() =>
            run(() =>
              api(
                "/settings",
                { queuePaused: !data.settings.queuePaused },
                "PATCH",
              ),
            )
          }
        >
          {data.settings.queuePaused ? <Play size={16} /> : <Pause size={16} />}
          {data.settings.queuePaused
            ? "Tiếp tục hàng đợi"
            : "Tạm dừng nhận việc"}
        </Button>
      </div>
      <div className="queue-stats">
        <div>
          <Activity size={20} />
          <span>
            <b>{active}</b> đang chạy
          </span>
        </div>
        <div>
          <ListVideo size={20} />
          <span>
            <b>{queued}</b> đang chờ
          </span>
        </div>
        <div>
          <CheckCircle2 size={20} />
          <span>
            <b>
              {data.jobs.filter((job) => job.status === "completed").length}
            </b>{" "}
            hoàn tất
          </span>
        </div>
      </div>
      {data.settings.queuePaused && (
        <Notice>
          Hàng đợi đang tạm dừng nhận tác vụ mới. Tác vụ đang chạy vẫn tiếp tục.
        </Notice>
      )}
      <div className="toolbar">
        <div className="segmented">
          {[
            ["all", "Tất cả"],
            ["active", "Đang xử lý"],
            ["completed", "Hoàn tất"],
            ["failed", "Có lỗi"],
            ["cancelled", "Đã hủy"],
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
        <span className="muted small">{jobs.length} tác vụ trong dự án</span>
      </div>
      {jobs.length ? (
        <div className="job-list">
          {jobs.map((job) => {
            const account = data.accounts.find(
              (item) => item.id === (job.accountId || job.payload.accountId),
            );
            const output = data.media.find((item) => item.id === job.mediaId);
            const running = [
              "preparing",
              "submitting",
              "rendering",
              "downloading",
            ].includes(job.status);
            const waiting = ["queued", "scheduled"].includes(job.status);
            const available = data.accounts.some(
              (item) =>
                item.provider === job.payload.provider &&
                ["ready", "busy"].includes(item.status) &&
                (job.payload.accountId === "auto" ||
                  item.id === job.payload.accountId),
            );
            return (
              <article className="panel job-card" key={job.id}>
                <div className="job-row">
                  <span className={`job-type ${job.type}`}>
                    {job.type === "render" ? (
                      <Cpu size={22} />
                    ) : (
                      <span
                        className={`provider-logo small-logo ${job.payload.provider}`}
                      >
                        {job.payload.provider === "dola" ? "d" : job.payload.provider === "dreamface" ? "D" : "F"}
                      </span>
                    )}
                  </span>
                  <div className="job-details">
                    <h3>{job.name}</h3>
                    <p>
                      {job.type === "render"
                        ? "FFmpeg · Xuất video cục bộ"
                        : `${job.payload.model} · ${job.payload.ratio} · ${job.payload.duration}s`}
                      {account && ` · ${account.name}`}
                    </p>
                    {waiting && job.type === "generate" && !available && (
                      <button
                        className="text-button warning-text"
                        onClick={() => navigate("accounts")}
                      >
                        Chờ tài khoản đăng nhập →
                      </button>
                    )}
                    {job.status === "scheduled" && (
                      <small>
                        Hẹn giờ:{" "}
                        {new Date(job.payload.scheduledAt).toLocaleString(
                          "vi-VN",
                        )}
                      </small>
                    )}
                  </div>
                  <Badge status={job.status} />
                  <div className="inline-actions">
                    {output && (
                      <a
                        className="icon-button"
                        title="Tải kết quả"
                        href={`${output.url}?download=1`}
                      >
                        <Download size={17} />
                      </a>
                    )}
                    {(waiting || running) && (
                      <button
                        className="icon-button"
                        aria-label={`Hủy ${job.name}`}
                        onClick={() =>
                          run(
                            () => api(`/jobs/${job.id}/cancel`, {}),
                            "Đã gửi yêu cầu dừng.",
                          )
                        }
                      >
                        <X size={17} />
                      </button>
                    )}
                    {["failed", "cancelled", "interrupted"].includes(
                      job.status,
                    ) && (
                      <button
                        className="icon-button"
                        title="Thử lại"
                        onClick={() => {
                          if (
                            job.submittedAt &&
                            !confirm(
                              "Yêu cầu trước đã được gửi lên dịch vụ. Tạo lại có thể tốn thêm lượt. Bạn đã kiểm tra kết quả trong tài khoản và muốn tạo lại?",
                            )
                          )
                            return;
                          run(
                            () =>
                              api(`/jobs/${job.id}/retry`, {
                                confirmResubmit: Boolean(job.submittedAt),
                              }),
                            "Đã tạo tác vụ thử lại.",
                          );
                        }}
                      >
                        <RefreshCw size={16} />
                      </button>
                    )}
                    <button
                      className="icon-button"
                      aria-label="Chi tiết tác vụ"
                      onClick={() =>
                        setExpanded(expanded === job.id ? "" : job.id)
                      }
                    >
                      <ChevronDown size={17} />
                    </button>
                  </div>
                </div>
                {running && (
                  <div className="job-progress">
                    <div>
                      <span
                        style={{
                          width:
                            job.type === "generate"
                              ? "100%"
                              : `${job.progress}%`,
                          opacity: job.type === "generate" ? 0.35 : 1,
                        }}
                      />
                    </div>
                    <small>
                      {job.stage ||
                        (job.type === "generate"
                          ? "Chờ kết quả từ dịch vụ"
                          : "Đang xuất")}{" "}
                      ·{" "}
                      {job.type === "generate"
                        ? `${job.elapsedSeconds || 0} giây theo dõi`
                        : `${Math.round(job.progress)}%`}
                    </small>
                  </div>
                )}
                {job.error && (
                  <div className="job-error">
                    <AlertCircle size={14} />
                    <span>{job.error}</span>
                  </div>
                )}
                {job.warnings?.length > 0 && (
                  <Notice>{job.warnings.join(" ")}</Notice>
                )}
                {expanded === job.id && (
                  <div className="job-expanded">
                    {job.payload.prompt && (
                      <p className="job-prompt">{job.payload.prompt}</p>
                    )}
                    <p>
                      Tạo lúc {new Date(job.createdAt).toLocaleString("vi-VN")}
                      {job.submittedAt &&
                        ` · Đã gửi lúc ${new Date(job.submittedAt).toLocaleString("vi-VN")}`}
                    </p>
                    {job.accountId && (
                      <Button
                        onClick={() =>
                          run(() => api(`/accounts/${job.accountId}/open`, {}))
                        }
                      >
                        <ExternalLink size={14} />
                        Mở tài khoản để kiểm tra
                      </Button>
                    )}
                    <div className="job-logs">
                      {job.logs?.length ? (
                        job.logs.map((entry, index) => (
                          <div key={index}>
                            <time>
                              {new Date(entry.time).toLocaleTimeString("vi-VN")}
                            </time>
                            <span>{entry.message}</span>
                          </div>
                        ))
                      ) : (
                        <p>Chưa có nhật ký xử lý.</p>
                      )}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <Empty
          icon={ListVideo}
          title="Hàng đợi trống"
          action={
            <Button variant="primary" onClick={() => navigate("create")}>
              Tạo nội dung đầu tiên
            </Button>
          }
        >
          Tác vụ tạo AI và xuất video sẽ xuất hiện ở đây.
        </Empty>
      )}
    </div>
  );
}

export function SettingsPage({ data, project, run, notify }) {
  const [settings, setSettings] = useState(data.settings);
  const [health, setHealth] = useState(null);
  const [license, setLicense] = useState(null);
  const [licenseToken, setLicenseToken] = useState("");
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [modelOptions, setModelOptions] = useState([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [llmTest, setLlmTest] = useState(null);
  const [llmTestBusy, setLlmTestBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    const [nextHealth, nextLicense] = await Promise.all([
      run(() => api("/health")),
      run(() => api("/license")),
    ]);
    setHealth(nextHealth);
    setLicense(nextLicense);
    setBusy(false);
  };
  useEffect(() => {
    check();
  }, []);
  const loadModels = async (silent = false) => {
    const llm = settings.llm || {};
    if (!llm.endpoint) return;
    setModelsBusy(true);
    setModelsError("");
    try {
      const result = await api("/settings/llm/models", {
        endpoint: llm.endpoint,
        apiKey: llm.apiKey === "[đã lưu]" ? "" : llm.apiKey || "",
      });
      setModelOptions(result.models || []);
      if (!llm.model && result.models?.[0]) setSettings((current) => ({ ...current, llm: { ...(current.llm || {}), model: result.models[0] } }));
    } catch (error) {
      setModelsError(error.message);
      if (!silent) notify(error.message, "error");
    } finally {
      setModelsBusy(false);
    }
  };
  useEffect(() => {
    if (settings.llm?.enabled !== true) return undefined;
    const timer = setTimeout(() => loadModels(true), 350);
    return () => clearTimeout(timer);
  }, [settings.llm?.endpoint, settings.llm?.enabled]);
  const testLlm = async () => {
    setLlmTestBusy(true);
    const result = await run(() => api("/settings/llm/test"));
    if (result) setLlmTest(result);
    setLlmTestBusy(false);
  };
  const updateContentSetting = (key, value) => setSettings((current) => ({
    ...current,
    content: { ...(current.content || {}), [key]: value },
  }));
  const saveContentSettings = async (event) => {
    event.preventDefault();
    const result = await run(
      () => api("/settings", { content: settings.content || {} }, "PATCH"),
      "Đã lưu cấu hình Store, website và First Comment.",
    );
    if (result) setSettings((current) => ({ ...current, content: result.content || current.content }));
  };
  return (
    <div className="page settings-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">PREFERENCES</div>
          <h1>Không gian theo cách bạn làm.</h1>
          <p>Cấu hình trình duyệt, bộ xuất và tốc độ xử lý trên máy.</p>
        </div>
        <Button onClick={check} busy={busy}>
          <RefreshCw size={16} />
          Kiểm tra công cụ
        </Button>
      </div>
      <div className="settings-grid">
        <section className="panel">
          <div className="panel-heading">
            <h3>
              <Cpu size={18} />
              Công cụ cục bộ
            </h3>
          </div>
          {health ? (
            [...health.tools, { name: "Chrome / Edge", ...health.browser }].map(
              (tool) => (
                <div className="tool-row" key={tool.name}>
                  <span
                    className={tool.available ? "green-text" : "danger-text"}
                  >
                    {tool.available ? (
                      <CheckCircle2 size={18} />
                    ) : (
                      <AlertCircle size={18} />
                    )}
                  </span>
                  <div>
                    <strong>{tool.name}</strong>
                    <p>
                      {tool.version || tool.error || "Đã tìm thấy trình duyệt"}
                    </p>
                    <code>{tool.path}</code>
                  </div>
                </div>
              ),
            )
          ) : (
            <p className="muted">Đang kiểm tra…</p>
          )}
          <div className="data-directory">
            <small>Thư mục dữ liệu</small>
            <code>{health?.dataDir || "…"}</code>
            {(window.studioDesktop?.openDataFolder || data.capabilities?.desktop) && (
              <Button onClick={() => run(() => window.studioDesktop?.openDataFolder
                ? window.studioDesktop.openDataFolder()
                : api("/desktop/reveal", {}))}>
                <FolderOpen size={15} />
                Mở thư mục
              </Button>
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h3>
              <KeyRound size={18} />
              License Viral Studio
            </h3>
            {license && <Badge status={license.status === "active" ? "ready" : license.status} />}
          </div>
          <p className="muted small">
            License này chỉ xác nhận quyền dùng sản phẩm Viral Studio. Nó tách biệt với
            tài khoản Google/Dola/Flow và không thay thế cookie hay phiên trình duyệt.
          </p>
          {license?.message && (
            <Notice error={license.status === "invalid"}>{license.message}</Notice>
          )}
          {license?.licenseId && (
            <div className="data-directory">
              <small>Mã license</small>
              <code>{license.licenseId}</code>
              <small>Hết hạn</small>
              <code>{license.expiresAt ? new Date(license.expiresAt).toLocaleString("vi-VN") : "Không rõ"}</code>
            </div>
          )}
          {license?.features && Object.keys(license.features).length > 0 && (
            <p className="muted small">Tính năng: {Object.keys(license.features).join(", ")}</p>
          )}
          <form onSubmit={async (event) => {
            event.preventDefault();
            const result = await run(() => api("/license", { token: licenseToken }));
            if (result) {
              setLicense(result);
              setLicenseToken("");
              notify("Đã nhập license Viral Studio.");
            }
          }}>
            <Field label="Token license chính thức">
              <textarea
                className="code-input"
                rows="4"
                value={licenseToken}
                onChange={(event) => setLicenseToken(event.target.value)}
                placeholder="Dán token do nhà phát hành Dropship cấp"
                autoComplete="off"
              />
            </Field>
            <div className="modal-actions">
              <Button variant="primary" disabled={!licenseToken.trim()}>
                <KeyRound size={15} />
                Kiểm tra & lưu
              </Button>
              {license?.licenseId && (
                <Button type="button" onClick={async () => {
                  const result = await run(() => api("/license", undefined, "DELETE"));
                  if (result) {
                    setLicense(result);
                    notify("Đã xóa license trên máy.");
                  }
                }}>
                  Xóa license
                </Button>
              )}
            </div>
          </form>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h3>
              <Activity size={18} />
              Hàng đợi & theo dõi
            </h3>
          </div>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const { queuePaused, ...values } = settings;
              if (
                await run(
                  () => api("/settings", values, "PATCH"),
                  "Đã lưu cài đặt.",
                )
              )
                check();
            }}
          >
            <div className="form-grid">
              <Field label="Số tác vụ AI đồng thời">
                <input
                  type="number"
                  min="1"
                  max="5"
                  value={settings.concurrency}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      concurrency: Number(event.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Kiểm tra mỗi (giây)">
                <input
                  type="number"
                  min="3"
                  max="60"
                  value={settings.pollSeconds}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      pollSeconds: Number(event.target.value),
                    })
                  }
                />
              </Field>
            </div>
            <Field label="Chờ tạo AI tối đa (phút)">
              <input
                type="number"
                min="2"
                max="120"
                value={settings.maxWaitMinutes}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    maxWaitMinutes: Number(event.target.value),
                  })
                }
              />
            </Field>
            <p className="muted small">
              Mỗi tài khoản chỉ chạy một tác vụ. FFmpeg xuất tuần tự để giữ tài
              nguyên ổn định.
            </p>
            <label className="toggle-field">
              <input
                type="checkbox"
                checked={settings.browserVisible === true}
                onChange={(event) =>
                  setSettings({ ...settings, browserVisible: event.target.checked })
                }
              />
              <span>
                <strong>Hiện cửa sổ Chrome khi chạy tác vụ</strong>
                <small>Tắt để trình duyệt chạy ẩn như app mẫu; bật lại khi cần quan sát trực tiếp.</small>
              </span>
            </label>
            {[
              ["chromePath", "Đường dẫn Chrome / Edge"],
              ["ffmpegPath", "Đường dẫn FFmpeg"],
              ["ffprobePath", "Đường dẫn FFprobe"],
            ].map(([key, label]) => (
              <Field key={key} label={label}>
                <input
                  value={settings[key]}
                  placeholder="Để trống để tự tìm trên máy"
                  onChange={(event) =>
                    setSettings({ ...settings, [key]: event.target.value })
                  }
                />
              </Field>
            ))}
            <Button variant="primary">
              <Save size={16} />
              Lưu cài đặt
            </Button>
          </form>
        </section>
        <section className="panel settings-llm-panel">
          <div className="panel-heading">
            <h3>
              <BrainCircuit size={18} />
              LLM cho Research
            </h3>
            <Badge status={settings.llm?.enabled ? "ready" : "idle"} />
          </div>
          <p className="settings-llm-intro">
            Kết nối endpoint OpenAI-compatible để LLM viết angle, script và image query cho bài nghiên cứu. Có thể dùng Ollama hoặc LM Studio chạy trên máy.
          </p>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const llm = settings.llm || {};
              const payload = { ...llm };
              if (!llm.apiKey || llm.apiKey === "[\u0111ã lưu]") delete payload.apiKey;
              const result = await run(
                () => api("/settings/llm", payload, "PATCH"),
                "Đã lưu cài đặt LLM.",
              );
              if (result) {
                setSettings((current) => ({ ...current, llm: { ...result, apiKey: "" } }));
              }
            }}
          >
            <label className="toggle-field settings-llm-toggle">
              <input
                type="checkbox"
                checked={settings.llm?.enabled === true}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    llm: { ...(current.llm || {}), enabled: event.target.checked },
                  }))
                }
              />
              <span>
                <strong>Bật LLM cho Research</strong>
                <small>Tắt để dùng fallback nội bộ khi endpoint không sẵn sàng.</small>
              </span>
            </label>
            <div className="form-grid">
              <Field label="Endpoint OpenAI-compatible" hint="Ví dụ: http://127.0.0.1:11434/v1 hoặc https://api.openai.com/v1">
                <input
                  type="url"
                  required
                  value={settings.llm?.endpoint || ""}
                  placeholder="https://api.openai.com/v1"
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      llm: { ...(current.llm || {}), endpoint: event.target.value },
                    }))
                  }
                />
              </Field>
              <Field label="Model" hint={modelsError || (modelOptions.length ? `${modelOptions.length} model từ endpoint` : "Endpoint sẽ tự tải danh sách model") }>
                <div className="settings-model-picker">
                  <select
                    required
                    value={settings.llm?.model || ""}
                    onChange={(event) => setSettings((current) => ({ ...current, llm: { ...(current.llm || {}), model: event.target.value } }))}
                  >
                    {settings.llm?.model && !modelOptions.includes(settings.llm.model) && <option value={settings.llm.model}>{settings.llm.model} · hiện tại</option>}
                    {modelOptions.length ? modelOptions.map((model) => <option key={model} value={model}>{model}</option>) : <option value={settings.llm?.model || ""}>{settings.llm?.model || "Đang tải model…"}</option>}
                  </select>
                  <Button type="button" onClick={() => loadModels(false)} busy={modelsBusy}>Tải model</Button>
                </div>
              </Field>
            </div>
            <div className="form-grid">
              <Field label="API key" hint="Bỏ trống để giữ key đã lưu. Key chỉ lưu local.">
                <input
                  type="password"
                  autoComplete="off"
                  value={settings.llm?.apiKey === "[đã lưu]" ? "" : settings.llm?.apiKey || ""}
                  placeholder={settings.llm?.apiKey === "[\u0111ã lưu]" ? "•••••••• · đã lưu" : "sk-..."}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      llm: { ...(current.llm || {}), apiKey: event.target.value },
                    }))
                  }
                />
              </Field>
              <Field label="Timeout (giây)">
                <input
                  type="number"
                  min="10"
                  max="300"
                  value={settings.llm?.timeoutSeconds || 90}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      llm: { ...(current.llm || {}), timeoutSeconds: Number(event.target.value) },
                    }))
                  }
                />
              </Field>
            </div>
            <div className="settings-llm-footer">
              <div className="settings-llm-test-area">
                <Button type="button" className="settings-llm-test-button" onClick={testLlm} busy={llmTestBusy} disabled={!settings.llm?.endpoint || !settings.llm?.model}>
                  <CheckCircle2 size={15} />
                  Test LLM
                </Button>
                {llmTest && <span className="settings-llm-result"><CheckCircle2 size={14} /> Phản hồi {llmTest.model} · {llmTest.latencyMs}ms</span>}
              </div>
              <Button variant="primary" type="submit">
                <Save size={15} />
                Lưu endpoint LLM
              </Button>
            </div>
          </form>
        </section>
        <section className="panel settings-content-panel">
          <div className="panel-heading">
            <h3><Globe2 size={18} /> Content · Store &amp; website</h3>
          </div>
          <p className="muted small">Đặt link mặc định một lần. Khi tạo Content News/Product, app tự điền link, nhãn link và First Comment để bạn chỉ cần chọn video rồi duyệt.</p>
          <form onSubmit={saveContentSettings}>
            <div className="form-grid">
              <Field label="Tên Store"><input value={settings.content?.storeName || ""} maxLength={160} placeholder="Ví dụ: Viral Shop" onChange={(event) => updateContentSetting("storeName", event.target.value)} /></Field>
              <Field label="URL Store"><input type="url" value={settings.content?.storeUrl || ""} placeholder="https://store.example.com" onChange={(event) => updateContentSetting("storeUrl", event.target.value)} /></Field>
              <Field label="Nhãn link Store"><input value={settings.content?.storeLinkLabel || ""} maxLength={160} placeholder="Xem sản phẩm" onChange={(event) => updateContentSetting("storeLinkLabel", event.target.value)} /></Field>
              <Field label="Tên website bài viết"><input value={settings.content?.articleWebsiteName || ""} maxLength={160} placeholder="Ví dụ: Viral News" onChange={(event) => updateContentSetting("articleWebsiteName", event.target.value)} /></Field>
              <Field label="URL website bài viết"><input type="url" value={settings.content?.articleWebsiteUrl || ""} placeholder="https://news.example.com" onChange={(event) => updateContentSetting("articleWebsiteUrl", event.target.value)} /></Field>
              <Field label="Nhãn link bài viết"><input value={settings.content?.articleLinkLabel || ""} maxLength={160} placeholder="Đọc bài đầy đủ" onChange={(event) => updateContentSetting("articleLinkLabel", event.target.value)} /></Field>
            </div>
            <div className="form-grid">
              <Field label="First Comment Product mặc định" hint="Có thể dùng {{link}} để chèn link Store khi bạn tự soạn."><textarea rows="3" maxLength={10000} value={settings.content?.productFirstCommentTemplate || ""} placeholder="Xem sản phẩm tại: {{link}}" onChange={(event) => updateContentSetting("productFirstCommentTemplate", event.target.value)} /></Field>
              <Field label="First Comment News mặc định" hint="Có thể dùng {{link}} để chèn link bài viết khi bạn tự soạn."><textarea rows="3" maxLength={10000} value={settings.content?.newsFirstCommentTemplate || ""} placeholder="Đọc bài đầy đủ tại: {{link}}" onChange={(event) => updateContentSetting("newsFirstCommentTemplate", event.target.value)} /></Field>
            </div>
            <Button variant="primary"><Save size={15} /> Lưu Content defaults</Button>
          </form>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h3>Dự án hiện tại</h3>
          </div>
          <Field label="Tên dự án">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <div className="spread">
            <Button
              onClick={() =>
                run(
                  () => api(`/projects/${project.id}`, { name }, "PATCH"),
                  "Đã đổi tên dự án.",
                )
              }
            >
              <Pencil size={15} />
              Đổi tên
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (
                  confirm(
                    "Xóa dự án và timeline? Media được giữ lại trong thư viện chung.",
                  )
                )
                  run(
                    () => api(`/projects/${project.id}`, {}, "DELETE"),
                    "Đã xóa dự án.",
                  );
              }}
            >
              <Trash2 size={15} />
              Xóa dự án
            </Button>
          </div>
        </section>
        <section className="panel help-panel">
          <div className="panel-heading">
            <h3>
              <Globe2 size={18} />
              Cách kết nối AI
            </h3>
          </div>
          <p>
            Viral Studio mở website Dola hoặc Google Flow trong hồ sơ Chrome
            của từng tài khoản. Website tự xử lý phiên đăng nhập và gửi yêu cầu
            tạo nội dung.
          </p>
          <p>
            Đăng nhập Google/Apple hoặc nhập cookie, bấm{" "}
            <strong>Kiểm tra phiên</strong>, sau đó tạo nội dung. Nếu gặp xác
            minh hoặc yêu cầu nâng gói, hoàn tất trực tiếp trên website.
          </p>
          <Notice>
            Dola nhận yêu cầu tỷ lệ/thời lượng qua prompt; app ghi thông số file
            thực tế nếu kết quả khác yêu cầu. Với Flow, app chọn thông số trên
            giao diện và dừng trước khi gửi nếu không tìm được tùy chọn.
          </Notice>
          <p className="muted small">
            Đóng app khi dịch vụ đang tạo có thể làm gián đoạn theo dõi. Kiểm
            tra kết quả trên tài khoản trước khi gửi lại.
          </p>
        </section>
      </div>
    </div>
  );
}
