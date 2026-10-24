import { useState } from "react";
import {
  Sparkles,
  ArrowUpRight,
  Film,
  Image,
  Plus,
  Trash2,
  Layers,
  Clock3,
  WandSparkles,
  GripVertical,
  Save,
  ArrowDown,
  ArrowUp,
} from "lucide-react";
import { providers } from "../../shared/contracts.js";
import { api, uid } from "../api.js";
import {
  Button,
  Field,
  Badge,
  Empty,
  MediaThumb,
  Uploader,
  Notice,
  CheckField,
} from "../components.jsx";

export function CreatePage({ data, project, run, notify, navigate }) {
  const [provider, setProvider] = useState("dola");
  const [kind, setKind] = useState("video");
  const [mode, setMode] = useState("text");
  const [model, setModel] = useState(providers.dola.models[0]);
  const [duration, setDuration] = useState(10);
  const [ratio, setRatio] = useState("9:16");
  const [accountId, setAccountId] = useState("auto");
  const [prompt, setPrompt] = useState(() => {
    const handoffKey = `studio-research-prompt:${project.id}`;
    const handoff = sessionStorage.getItem(handoffKey);
    if (handoff) sessionStorage.removeItem(handoffKey);
    return handoff || localStorage.getItem(`draft:${project.id}`) || "";
  });
  const [references, setReferences] = useState([]);
  const [scheduledAt, setScheduledAt] = useState("");
  const [autoAssemble, setAutoAssemble] = useState(false);
  const [busy, setBusy] = useState(false);
  const config = providers[provider];
  const models = kind === "image" ? config.imageModels : config.models;
  const ratios = kind === "image" ? config.imageRatios || config.ratios : config.ratios;
  const changeKind = (value) => {
    if (value === "image" && !config.imageModels.length) return;
    setKind(value);
    setModel((value === "image" ? config.imageModels : config.models)[0]);
    setMode("text");
    setRatio("9:16");
    setReferences([]);
  };
  const prompts = prompt
    .trim()
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const ready = data.accounts.filter(
    (account) => account.provider === provider && account.status === "ready",
  );
  const media = data.media.filter(
    (item) =>
      item.projectId === project.id &&
      item.kind === (mode === "extend" ? "video" : "image"),
  );
  const referenceError =
    mode === "reference" && references.length === 0
      ? "Hãy chọn ít nhất một ảnh tham chiếu."
      : mode === "firstlast" && references.length !== 2
        ? "Chế độ khung đầu/cuối cần đúng 2 ảnh theo thứ tự."
        : mode === "extend" && references.length !== 1
          ? "Kéo dài video cần đúng một video tham chiếu."
          : "";
  const recent = data.jobs
    .filter((job) => job.projectId === project.id && job.type === "generate")
    .slice(-4)
    .reverse();
  const changePrompt = (value) => {
    setPrompt(value);
    localStorage.setItem(`draft:${project.id}`, value);
  };
  const submit = async (event) => {
    event.preventDefault();
    if (referenceError) {
      notify(referenceError);
      return;
    }
    setBusy(true);
    const result = await run(() =>
      api("/jobs/generate", {
        projectId: project.id,
        provider,
        kind,
        mode,
        model,
        duration,
        ratio,
        accountId,
        prompts,
        references: mode === "text" ? [] : references,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        autoAssemble,
      }),
    );
    setBusy(false);
    if (result) {
      notify(
        `Đã thêm ${result.length} yêu cầu vào hàng đợi${ready.length ? "." : ". Đăng nhập tài khoản để bắt đầu."}`,
      );
      navigate("queue");
    }
  };
  return (
    <div className="page create-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <span />
            TỪ Ý TƯỞNG ĐẾN KHUNG HÌNH
          </div>
          <h1>
            Bắt đầu bằng một ý tưởng<span className="accent">.</span>
          </h1>
          <p>
            Tạo nội dung với Dola, Google Flow hoặc DreamFace. Dựng thành video của riêng bạn.
          </p>
        </div>
        <span className="heading-symbol">
          <Sparkles size={30} strokeWidth={1.2} />
        </span>
      </div>
      <div className="creation-layout">
        <form className="creation-main" onSubmit={submit}>
          <div className="provider-cards">
            {Object.entries(providers)
              .filter(([, value]) => !value.hidden)
              .map(([id, value]) => (
              <button
                type="button"
                className={`provider-card ${provider === id ? "selected" : ""}`}
                key={id}
                onClick={() => {
                  setProvider(id);
                  if (kind === "image" && !value.imageModels.length) setKind("video");
                  setModel(
                    ((kind === "image" && value.imageModels.length) ? value.imageModels : value.models)[0],
                  );
                  setDuration(id === "flow" ? 8 : 10);
                  setRatio("9:16");
                  setAccountId("auto");
                }}
              >
                <span className={`provider-logo ${id}`}>
                  {id === "dola" ? "d" : id === "dreamface" ? "D" : "F"}
                </span>
                <span>
                  <strong>{id === "dola" ? "Dola" : id === "dreamface" ? "DreamFace" : "Google Flow"}</strong>
                  <small>
                    {id === "dola"
                      ? "Seedance · Google / Apple"
                      : id === "dreamface"
                        ? "Text-to-video · profile riêng"
                        : "Veo · Tài khoản Google"}
                  </small>
                </span>
                <i className="radio-dot" />
              </button>
              ))}
          </div>
          <section className="panel prompt-panel">
            <div className="panel-heading">
              <div className="segmented">
                {config.imageModels.length > 0 && <button
                  type="button"
                  className={kind === "video" ? "selected" : ""}
                  onClick={() => changeKind("video")}
                >
                  <Film size={16} />
                  Video AI
                </button>}
                <button
                  type="button"
                  className={kind === "image" ? "selected" : ""}
                  onClick={() => changeKind("image")}
                >
                  <Image size={16} />
                  Ảnh AI
                </button>
              </div>
              <span className="tiny-label">{prompts.length} prompt</span>
            </div>
            <label className="prompt-label" htmlFor="prompt">
              Bạn muốn tạo điều gì?
            </label>
            <textarea
              id="prompt"
              className="prompt-input"
              value={prompt}
              onChange={(event) => changePrompt(event.target.value)}
              required
              placeholder={
                "Một đôi giày thể thao trắng trên bệ đá, ánh sáng studio dịu, camera chậm rãi xoay quanh sản phẩm. Phong cách quảng cáo cao cấp…\n\nMỗi prompt cách nhau một dòng trống để tạo hàng loạt."
              }
            />
            <div className="prompt-footer">
              <span>
                <Layers size={14} />
                Một dòng trống = một tác vụ riêng
              </span>
              <button
                type="button"
                className="text-button"
                onClick={() => navigate("storyboard")}
              >
                <WandSparkles size={14} />
                Soạn kịch bản
              </button>
            </div>
          </section>
          <section className="panel options-panel">
            <div className="panel-heading">
              <h3>Cách tạo nội dung</h3>
              <span className="tiny-label">
                {kind === "video" ? "VIDEO" : "IMAGE"}
              </span>
            </div>
            <div className="mode-grid">
              {[
                ["text", "Văn bản"],
                ["reference", "Ảnh tham chiếu"],
                ["firstlast", "Khung đầu / cuối"],
                ["extend", "Kéo dài video"],
              ]
                .filter(
                  ([id]) =>
                    kind === "video"
                      ? provider === "dreamface" ? id === "text" : true
                      : ["text", "reference"].includes(id),
                )
                .map(([id, label]) => (
                  <button
                    type="button"
                    className={mode === id ? "selected" : ""}
                    key={id}
                    onClick={() => {
                      setMode(id);
                      setReferences([]);
                    }}
                  >
                    {label}
                  </button>
                ))}
            </div>
            {mode !== "text" && (
              <div className="reference-section">
                <div className="reference-grid">
                  {media.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className={`reference ${references.includes(item.id) ? "selected" : ""}`}
                      onClick={() =>
                        setReferences((list) =>
                          list.includes(item.id)
                            ? list.filter((id) => id !== item.id)
                            : [...list, item.id].slice(-10),
                        )
                      }
                    >
                      <MediaThumb media={item} />
                      <span>
                        {references.indexOf(item.id) >= 0
                          ? `${references.indexOf(item.id) + 1} · `
                          : ""}
                        {item.name}
                      </span>
                    </button>
                  ))}
                </div>
                <Uploader compact projectId={project.id} notify={notify} />
                <small>
                  {mode === "firstlast"
                    ? "Chọn đúng 2 ảnh theo thứ tự: đầu, cuối."
                    : mode === "extend"
                      ? "Chọn một video để tiếp nối."
                      : "Chọn ảnh từ thư viện làm tham chiếu."}
                </small>
                {referenceError && <Notice error>{referenceError}</Notice>}
              </div>
            )}
            <div className="form-grid three">
              <Field label="Mô hình">
                <select
                  value={model}
                  onChange={(event) => {
                    setModel(event.target.value);
                    if (
                      provider === "flow" &&
                      event.target.value.startsWith("Veo")
                    )
                      setDuration(8);
                  }}
                >
                  {models.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </Field>
              <Field label="Tỷ lệ khung hình">
                <select
                  value={ratio}
                  onChange={(event) => setRatio(event.target.value)}
                >
                  {ratios.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </Field>
              <Field label="Thời lượng">
                <select
                  value={duration}
                  disabled={
                    kind === "image" ||
                    (provider === "flow" && model.startsWith("Veo"))
                  }
                  onChange={(event) => setDuration(Number(event.target.value))}
                >
                  {config.durations.map((value) => (
                    <option key={value} value={value}>
                      {value} giây
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </section>
          {provider === "dola" && (
            <Notice>
              {kind === "image"
                ? "App chọn model và tỷ lệ ảnh trực tiếp trên Dola. Seedream 5.0 Pro được website ghi dùng gấp 4 credit so với 4.5."
                : "App chọn model, tỷ lệ và thời lượng trực tiếp trên Dola. Seedance 2.0 Fast và 1.0 hiện cho chọn 4–10 giây."}
              {" "}Quyền sử dụng phụ thuộc tài khoản; app kiểm tra thông số file thực tế sau khi tải.
            </Notice>
          )}
          {provider === "dreamface" && (
            <Notice>
              DreamFace chạy bằng profile tài khoản riêng và automation chạy ẩn sau khi đăng nhập. Hiện chỉ hỗ trợ prompt văn bản; hãy hoàn tất đăng nhập hoặc xác minh trong cửa sổ DreamFace trước khi gửi.
            </Notice>
          )}
          <div className="submit-row">
            <p>
              Nội dung được tạo bằng tài khoản của bạn.
              <br />
              <span>Hạn mức và phí theo dịch vụ đang dùng.</span>
            </p>
            <Button
              variant="primary"
              busy={busy}
              disabled={!prompts.length || Boolean(referenceError)}
            >
              <Sparkles size={17} />
              Tạo{" "}
              {prompts.length > 1
                ? `${prompts.length} nội dung`
                : kind === "video"
                  ? "video"
                  : "ảnh"}
              <ArrowUpRight size={17} />
            </Button>
          </div>
        </form>
        <aside className="creation-aside">
          <section className="panel">
            <div className="panel-heading">
              <h3>Tài khoản sử dụng</h3>
              <span className={`status-dot ${ready.length ? "green" : ""}`} />
            </div>
            <Field label="Chọn phiên đăng nhập">
              <select
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
              >
                <option value="auto">Tự chọn tài khoản sẵn sàng</option>
                {data.accounts
                  .filter((account) => account.provider === provider)
                  .map((account) => (
                    <option value={account.id} key={account.id}>
                      {account.name}
                    </option>
                  ))}
              </select>
            </Field>
            <div className="account-summary">
              <b>{ready.length.toString().padStart(2, "0")}</b>
              <span>
                tài khoản
                <br />
                sẵn sàng
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label="Mở tài khoản"
                onClick={() => navigate("accounts")}
              >
                <ArrowUpRight size={20} />
              </button>
            </div>
            {!ready.length && (
              <p className="muted small">
                Thêm Google/Apple hoặc nhập cookie. Tác vụ sẽ chờ đến khi có
                phiên hợp lệ.
              </p>
            )}
            <Button className="full" onClick={() => navigate("accounts")}>
              <Plus size={16} />
              Quản lý tài khoản
            </Button>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h3>Tự động hóa</h3>
              <Clock3 size={17} />
            </div>
            <Field label="Lên lịch (không bắt buộc)">
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(event) => setScheduledAt(event.target.value)}
              />
            </Field>
            <CheckField checked={autoAssemble} onChange={setAutoAssemble}>
              Ghép kết quả thành một video
            </CheckField>
            <p className="muted small">
              Giữ ứng dụng mở để chạy hàng đợi và lịch hẹn.
            </p>
          </section>
          <section className="panel recent-panel">
            <div className="panel-heading">
              <h3>Gần đây</h3>
              <button className="text-button" onClick={() => navigate("queue")}>
                Xem tất cả
              </button>
            </div>
            {recent.length ? (
              recent.map((job) => (
                <div className="recent-job" key={job.id}>
                  <span className="job-symbol">
                    <Film size={17} />
                  </span>
                  <div>
                    <p>{job.name}</p>
                    <Badge status={job.status} />
                  </div>
                </div>
              ))
            ) : (
              <div className="quiet-empty">
                <Film size={22} />
                <p>
                  Ý tưởng đầu tiên
                  <br />
                  đang chờ bạn.
                </p>
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

export function StoryboardPage({ project, run, notify, navigate }) {
  const [scenes, setScenes] = useState(project.storyboard);
  const [product, setProduct] = useState("");
  const [benefit, setBenefit] = useState("");
  const patch = (id, changes) =>
    setScenes((items) =>
      items.map((scene) =>
        scene.id === id ? { ...scene, ...changes } : scene,
      ),
    );
  const move = (index, direction) => {
    const next = [...scenes];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setScenes(next);
  };
  const save = () =>
    run(
      () => api(`/projects/${project.id}`, { storyboard: scenes }, "PATCH"),
      "Đã lưu kịch bản.",
    );
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">STORYBOARD</div>
          <h1>Từng cảnh, một câu chuyện.</h1>
          <p>
            Lên ý tưởng, sắp xếp cảnh và chuyển prompt sang hàng đợi tạo AI.
          </p>
        </div>
        <Button onClick={save}>
          <Save size={16} />
          Lưu kịch bản
        </Button>
      </div>
      <div className="panel story-starter">
        <div>
          <h3>Khung kịch bản quảng cáo sản phẩm</h3>
          <p className="muted small">
            Mẫu 4 cảnh để bạn chỉnh sửa: mở đầu, chi tiết, sử dụng và kết thúc.
          </p>
        </div>
        <div className="form-grid">
          <Field label="Sản phẩm">
            <input
              value={product}
              onChange={(event) => setProduct(event.target.value)}
              placeholder="Ví dụ: giày chạy bộ"
            />
          </Field>
          <Field label="Điểm nổi bật">
            <input
              value={benefit}
              onChange={(event) => setBenefit(event.target.value)}
              placeholder="Ví dụ: nhẹ, thoáng, êm chân"
            />
          </Field>
        </div>
        <Button
          disabled={!product.trim()}
          onClick={() => {
            const descriptions = [
              `Hero shot of ${product}, centered on a minimalist pedestal, soft studio lighting, slow camera orbit, premium product commercial.`,
              `Macro close-up showing the texture and details of ${product}. Emphasize: ${benefit || "product craftsmanship"}. Smooth cinematic dolly, natural light.`,
              `Lifestyle scene showing ${product} in use, natural realistic movement, consistent product appearance. Highlight: ${benefit || "everyday use"}.`,
              `Final beauty shot of ${product}, elegant clean background with negative space for a call to action. Slow camera pull back, cinematic commercial.`,
            ];
            setScenes([
              ...scenes,
              ...descriptions.map((prompt, index) => ({
                id: uid(),
                title: ["Mở đầu", "Chi tiết", "Trải nghiệm", "Kết thúc"][index],
                prompt,
                duration: 10,
                notes: "",
              })),
            ]);
          }}
        >
          <WandSparkles size={16} />
          Thêm 4 cảnh mẫu
        </Button>
      </div>
      <div className="story-list">
        {scenes.map((scene, index) => (
          <section className="panel story-scene" key={scene.id}>
            <div className="scene-number">
              {String(index + 1).padStart(2, "0")}
              <GripVertical size={18} />
            </div>
            <div className="scene-fields">
              <div className="form-grid">
                <Field label="Tên cảnh">
                  <input
                    value={scene.title}
                    onChange={(event) =>
                      patch(scene.id, { title: event.target.value })
                    }
                  />
                </Field>
                <Field label="Thời lượng dự kiến (giây)">
                  <input
                    type="number"
                    min="1"
                    max="60"
                    value={scene.duration}
                    onChange={(event) =>
                      patch(scene.id, { duration: Number(event.target.value) })
                    }
                  />
                </Field>
              </div>
              <Field label="Prompt tạo hình / video">
                <textarea
                  rows="3"
                  value={scene.prompt}
                  onChange={(event) =>
                    patch(scene.id, { prompt: event.target.value })
                  }
                />
              </Field>
              <Field label="Ghi chú dựng">
                <input
                  value={scene.notes}
                  onChange={(event) =>
                    patch(scene.id, { notes: event.target.value })
                  }
                  placeholder="Chữ, giọng đọc, điểm nhấn…"
                />
              </Field>
            </div>
            <div className="scene-actions">
              <button
                className="icon-button"
                aria-label="Đưa cảnh lên"
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={16} />
              </button>
              <button
                className="icon-button"
                aria-label="Đưa cảnh xuống"
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={16} />
              </button>
              <button
                className="icon-button danger-text"
                aria-label="Xóa cảnh"
                onClick={() =>
                  setScenes(scenes.filter((item) => item.id !== scene.id))
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          </section>
        ))}
      </div>
      {!scenes.length && (
        <Empty icon={Layers} title="Bắt đầu dựng câu chuyện">
          Thêm một cảnh hoặc dùng khung kịch bản phía trên.
        </Empty>
      )}
      <div className="spread">
        <Button
          onClick={() =>
            setScenes([
              ...scenes,
              {
                id: uid(),
                title: `Cảnh ${scenes.length + 1}`,
                prompt: "",
                duration: 10,
                notes: "",
              },
            ])
          }
        >
          <Plus size={16} />
          Thêm cảnh
        </Button>
        <Button
          variant="primary"
          disabled={!scenes.some((scene) => scene.prompt.trim())}
          onClick={async () => {
            if (!(await save())) return;
            localStorage.setItem(
              `draft:${project.id}`,
              scenes
                .map((scene) => scene.prompt.trim())
                .filter(Boolean)
                .join("\n\n"),
            );
            notify(
              "Đã chuyển prompt sang màn hình tạo AI. Chọn thời lượng dịch vụ trước khi gửi.",
            );
            navigate("create");
          }}
        >
          Chuyển sang tạo AI
          <ArrowUpRight size={16} />
        </Button>
      </div>
    </div>
  );
}
