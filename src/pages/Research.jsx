import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleHelp,
  AlertTriangle,
  Download,
  ExternalLink,
  Film,
  Image,
  ImageDown,
  KeyRound,
  Newspaper,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { api } from "../api.js";
import { buildResearchAssemblyTimeline } from "../../shared/research-assembly.js";
import { isPublishableVideo } from "../../shared/output-media.js";
import { Button, Empty, Field, Notice } from "../components.jsx";
import "./research.css";

const emptyResearch = {
  topic: "",
  niche: "General news",
  language: "en",
  feeds: "",
  maxArticles: 6,
  includeImages: true,
};

function dateLabel(value) {
  if (!value) return "Chưa có ngày";
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return value;
  }
}

function articleDateLabel(value) {
  if (!value) return "Ngày đăng chưa rõ";
  try {
    return new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium" }).format(new Date(value));
  } catch {
    return "Ngày đăng chưa rõ";
  }
}

function accountStatus(account) {
  return account.status === "ready" ? "Sẵn sàng" : account.status === "checking" ? "Đang kiểm tra" : account.status === "needs_login" ? "Cần đăng nhập" : account.status || "Chưa kiểm tra";
}

function isLlmFallback(result) {
  return result?.contentSource !== "llm" || result?.warnings?.some((warning) => /LLM/i.test(warning));
}

function ResearchImageTile({ image }) {
  const [failed, setFailed] = useState(false);
  return (
    <a className="research-image-tile" href={image.pageUrl || image.imageUrl} target="_blank" rel="noreferrer">
      <div className={`research-image-thumb${failed ? " is-failed" : ""}`}>
        {failed ? <span>Preview unavailable</span> : <img src={image.imageUrl} alt={image.title || image.query} loading="eager" decoding="async" onError={() => setFailed(true)} />}
      </div>
      <span>{image.title || image.query}</span>
      <small>{image.license || "Commons"}</small>
    </a>
  );
}

function ResearchForm({ project, onResult, notify }) {
  const [value, setValue] = useState(emptyResearch);
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    if (!value.topic.trim() || busy) return;
    setBusy(true);
    try {
      const payload = {
        projectId: project.id,
        topic: value.topic.trim(),
        niche: value.niche.trim() || "Tin tức tổng hợp",
        language: value.language,
        feeds: value.feeds.split(/\r?\n|,/).map((feed) => feed.trim()).filter(Boolean),
        maxArticles: Number(value.maxArticles),
        includeImages: value.includeImages,
      };
      const result = await api("/research", payload);
      onResult(result);
      notify("Đã hoàn tất research và lưu kết quả vào dự án.");
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const update = (key, next) => setValue((current) => ({ ...current, [key]: next }));
  return (
    <form className="research-form" onSubmit={submit}>
      <div className="research-form-grid">
        <Field label="Chủ đề cần nghiên cứu">
          <input value={value.topic} required maxLength={200} autoFocus placeholder="Ví dụ: Xu hướng video ngắn 2026" onChange={(event) => update("topic", event.target.value)} />
        </Field>
        <Field label="Ngách nội dung">
          <input value={value.niche} maxLength={120} onChange={(event) => update("niche", event.target.value)} />
        </Field>
        <Field label="Ngôn ngữ">
          <select value={value.language} onChange={(event) => update("language", event.target.value)}><option value="en">English (US)</option></select>
        </Field>
        <Field label="Số bài tối đa">
          <select value={value.maxArticles} onChange={(event) => update("maxArticles", event.target.value)}>{[3, 6, 9, 10, 12].map((count) => <option key={count} value={count}>{count} bài</option>)}</select>
        </Field>
      </div>
      <Field label="RSS/Atom feeds riêng (tùy chọn)" hint="Mỗi dòng một URL HTTPS. Nếu để trống, server dùng danh sách feed đã cấu hình.">
        <textarea rows="3" value={value.feeds} placeholder="https://example.com/feed.xml" onChange={(event) => update("feeds", event.target.value)} />
      </Field>
      <label className="research-check"><input type="checkbox" checked={value.includeImages} onChange={(event) => update("includeImages", event.target.checked)} /><span /> Gợi ý hình ảnh cho từng góc nội dung</label>
      <div className="research-form-actions"><span><ShieldCheck size={14} /> Kết quả được lưu theo dự án</span><Button type="submit" variant="primary" busy={busy}><Search size={15} /> {busy ? "Đang nghiên cứu…" : "Bắt đầu research"}</Button></div>
    </form>
  );
}

function ResultCard({ result, accounts, onImport, importing, onUse, onDreamFace, dreaming, onAssemble, onSearchImages, searchingImages, onImportSearchImages, importingSearchImages, onRerunLlm, rerunning, renderCount = 0, posted = false, selected = false, onToggleSelect }) {
  const [videoCount, setVideoCount] = useState(() => Math.max(1, Number(renderCount) || 1));
  const [accountId, setAccountId] = useState("auto");
  const [autoCreateContent, setAutoCreateContent] = useState(true);
  const feedFallback = isLlmFallback(result);
  return (
    <article className="research-result-card">
      <div className="research-result-select-row"><label><input type="checkbox" checked={selected} onChange={() => onToggleSelect?.(result.id)} /> Chọn tin</label><span className={posted ? "research-history-posted" : "research-history-pending"}>{posted ? "Đã đăng" : "Chưa đăng"}</span><span className={renderCount ? "research-history-rendered" : "research-history-pending"}>{renderCount ? `Đã render ${renderCount} lần` : "Chưa render"}</span></div>
      <div className="research-result-header"><div><span className="research-kicker">{result.niche} · {dateLabel(result.createdAt)}</span><h3>{result.headline || result.topic}</h3></div><div className="research-result-statuses"><span className={`research-result-source ${feedFallback ? "fallback" : "llm"}`}>{feedFallback ? <CircleHelp size={14} /> : <Sparkles size={14} />}{feedFallback ? "Fallback từ feed" : "LLM đã tổng hợp"}</span><span className="research-result-state"><CheckCircle2 size={14} /> Đã lưu</span></div></div>
      {feedFallback && <div className="research-llm-status"><span><AlertTriangle size={15} /><strong>Research đang dùng bản tóm lược từ feed.</strong><small>{result.llmError || "LLM chưa trả về nội dung cho bản ghi này."} Bật và Test LLM rồi chạy lại để tạo headline, angle, script và image query bằng LLM.</small></span><Button onClick={() => onRerunLlm(result)} busy={rerunning}><RefreshCw size={14} /> Chạy lại bằng LLM</Button></div>}
      {(result.angle || result.script) && <details className="research-detail-block"><summary>Góc kể chuyện &amp; script</summary><div className="research-detail-content">{result.angle && <p className="research-angle"><strong>Góc tiếp cận</strong>{result.angle}</p>}{result.script && <div className="research-script"><strong>Script nháp</strong><p>{result.script}</p></div>}</div></details>}
      {result.articles?.length > 0 && <details className="research-detail-block research-articles"><summary>Nguồn tham khảo · {result.articles.length} tin</summary><div className="research-detail-content"><ol className="research-article-list">{result.articles.map((article, index) => <li key={article.id}><a className="research-article-link" href={article.url} target="_blank" rel="noreferrer" title={`Mở nguồn: ${article.title}`} aria-label={`Mở nguồn: ${article.title}`}><span className="research-article-number">{index + 1}</span><span className="research-article-copy"><b>{article.title}</b><small>{article.source || "Nguồn RSS"} · {articleDateLabel(article.publishedAt)} · Match {Math.round((article.relevance || 0) * 100)}%</small>{article.summary && <em>{article.summary.slice(0, 220)}{article.summary.length > 220 ? "…" : ""}</em>}</span><span className="research-open-source">Mở nguồn <ExternalLink size={14} /></span></a></li>)}</ol></div></details>}
      {result.imageQueries?.length > 0 && <details className="research-detail-block research-tags"><summary>Image queries · {result.imageQueries.length}</summary><div className="research-detail-content"><div>{result.imageQueries.map((query) => <span key={query}>{query}</span>)}</div></div></details>}
      <div className="research-auto-video"><span><Sparkles size={15} /><strong>Render tin này</strong><small>Ảnh, hook và MC DreamFace sẽ được tạo theo tin.</small></span><div className="research-auto-video-controls"><label>Số video<input type="number" min="1" max="30" value={videoCount} onChange={(event) => setVideoCount(Math.max(1, Math.min(30, Number(event.target.value) || 1)))} /></label><label>MC / profile<select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="auto">Auto · xoay profile khỏe</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.status}</option>)}</select></label><label className="research-auto-content-check"><input type="checkbox" checked={autoCreateContent} onChange={(event) => setAutoCreateContent(event.target.checked)} /><span>Tự tạo Content</span></label></div><Button variant="primary" onClick={() => onDreamFace(result, videoCount, accountId, autoCreateContent)} busy={dreaming}><Sparkles size={14} /> Render {videoCount === 1 ? "1 video" : `${videoCount} videos`}</Button></div>
      {result.imageQueries?.length > 0 && <details className="research-detail-block research-image-search"><summary>Kho ảnh công khai · {result.imageSearchResults?.length || 0} ảnh đã tìm</summary><div className="research-detail-content"><div className="research-image-search-heading"><div><strong>Wikimedia Commons</strong><small>Có giấy phép và nguồn để kiểm tra</small></div><Button onClick={() => onSearchImages(result)} busy={searchingImages}><Image size={14} /> {result.imageSearchResults?.length ? "Tìm lại ảnh" : "Tìm ảnh theo query"}</Button></div>{result.imageSearchResults?.length > 0 && <><div className="research-image-grid">{result.imageSearchResults.slice(0, 6).map((image) => <ResearchImageTile key={image.id} image={image} />)}</div><div className="research-image-actions"><span>{result.imageSearchResults.length} ảnh đã tìm được · tối đa 12 ảnh sẽ nhập</span><Button onClick={() => onImportSearchImages(result)} busy={importingSearchImages}><Download size={14} /> Tải ảnh về thư viện</Button></div></>}</div></details>}
      {(result.articles?.some((article) => article.imageUrl) || result.imageMediaIds?.length > 0 || result.script) && <details className="research-detail-block research-assets"><summary>Media &amp; thao tác · {result.imageMediaIds?.length || 0} ảnh sẵn sàng</summary><div className="research-detail-content">{result.articles?.some((article) => article.imageUrl) && <div className="research-image-actions"><span>{result.imageMediaIds?.length || 0} ảnh đã nhập vào thư viện</span><Button onClick={() => onImport(result)} busy={importing}><ImageDown size={14} /> Tải ảnh bài viết</Button></div>}{result.imageMediaIds?.length > 0 && <div className="research-image-actions"><span>{result.imageMediaIds.length} ảnh sẵn sàng để dựng</span><Button onClick={() => onAssemble(result)}><Film size={14} /> Ráp ảnh + caption</Button></div>}{result.script && <div className="research-image-actions"><span>Script đã sẵn sàng cho trình dựng video</span><Button onClick={() => onUse(result)}><Film size={14} /> Dùng script tạo video</Button></div>}</div></details>}
      {result.warnings?.length > 0 && <div className="research-warning"><CircleHelp size={15} />{result.warnings.join(" · ")}</div>}
    </article>
  );
}

function DreamFacePanel({ data, notify }) {
  const accounts = (data.accounts || []).filter((account) => account.provider === "dreamface");
  const [selectedId, setSelectedId] = useState(accounts[0]?.id || "");
  const [loginAccount, setLoginAccount] = useState(null);
  const [method, setMethod] = useState("credentials");
  const [login, setLogin] = useState({ email: "", password: "", cookies: "" });
  const [busy, setBusy] = useState("");
  useEffect(() => {
    if (!accounts.some((account) => account.id === selectedId)) setSelectedId(accounts[0]?.id || "");
  }, [accounts, selectedId]);
  const selected = accounts.find((account) => account.id === selectedId);
  const action = async (key, operation, message) => {
    if (busy) return;
    setBusy(key);
    try {
      await operation();
      notify(message);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setBusy("");
    }
  };
  const submitLogin = async (event) => {
    event.preventDefault();
    const account = loginAccount;
    const payload = method === "cookie" ? { cookies: login.cookies } : { email: login.email, password: login.password };
    await action(`login:${account.id}`, () => method === "cookie" ? api(`/accounts/${account.id}/cookies`, payload) : api(`/accounts/${account.id}/login`, payload), "Đã gửi thông tin đăng nhập DreamFace. Hãy hoàn tất MFA/xác minh trong cửa sổ nếu được yêu cầu.");
    setLogin({ email: "", password: "", cookies: "" });
    setLoginAccount(null);
  };
  return (
    <section className="research-card dreamface-card">
      <div className="research-card-heading"><div><span className="research-kicker">PROVIDER PROFILE</span><h2><Sparkles size={19} /> DreamFace</h2><p>Profile trình duyệt riêng cho tài khoản DreamFace. Automation chạy ẩn; đăng nhập luôn mở cửa sổ hiển thị.</p></div><span className="research-safe-pill"><ShieldCheck size={14} /> User-owned account</span></div>
      <div className="dreamface-notice"><ShieldCheck size={16} /><span>Studio không tự đăng ký tài khoản, tạo account ngẫu nhiên hoặc vượt CAPTCHA. Chỉ dùng email/mật khẩu hoặc cookie do bạn cung cấp.</span></div>
      {selected ? <div className="dreamface-account"><div className="dreamface-avatar"><UserRound size={18} /></div><div className="dreamface-account-copy"><strong>{selected.name}</strong><span>{selected.email || "Cookie session"} · {accountStatus(selected)}</span></div><div className="dreamface-account-actions"><Button disabled={busy === `check:${selected.id}`} onClick={() => action(`check:${selected.id}`, () => api(`/accounts/${selected.id}/check`), "Đã kiểm tra phiên DreamFace.")}><RefreshCw size={14} /> Kiểm tra</Button><Button onClick={() => setLoginAccount(selected)}><KeyRound size={14} /> Đăng nhập</Button><Button onClick={() => action(`open:${selected.id}`, () => api(`/accounts/${selected.id}/open`), "Đã mở profile DreamFace.")}><ExternalLink size={14} /></Button></div></div> : <Empty icon={UserRound} title="Chưa có profile DreamFace">Thêm account DreamFace ở mục Tài khoản, sau đó quay lại đây để đăng nhập.</Empty>}
      {accounts.length > 1 && <label className="dreamface-switcher"><span>Profile đang chọn</span><select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>}
      {loginAccount && <div className="dreamface-login"><div className="dreamface-login-top"><div><strong>Đăng nhập {loginAccount.name}</strong><small>Cửa sổ hiển thị sẽ được mở cho bước xác minh của bạn.</small></div><button className="icon-button" type="button" onClick={() => setLoginAccount(null)} aria-label="Đóng"><X size={17} /></button></div><div className="research-tabs"><button type="button" className={method === "credentials" ? "active" : ""} onClick={() => setMethod("credentials")}>Email + mật khẩu</button><button type="button" className={method === "cookie" ? "active" : ""} onClick={() => setMethod("cookie")}>Cookie session</button></div><form onSubmit={submitLogin}>{method === "credentials" ? <div className="research-form-grid"><Field label="Email"><input type="email" required value={login.email} onChange={(event) => setLogin((current) => ({ ...current, email: event.target.value }))} /></Field><Field label="Mật khẩu"><input type="password" required autoComplete="off" value={login.password} onChange={(event) => setLogin((current) => ({ ...current, password: event.target.value }))} /></Field></div> : <Field label="Cookie JSON / Cookie-Editor / header" hint="Cookie chỉ được gửi vào profile DreamFace và không hiển thị trong public snapshot."><textarea rows="4" required value={login.cookies} onChange={(event) => setLogin((current) => ({ ...current, cookies: event.target.value }))} /></Field>}<div className="research-form-actions"><span>Không lưu thông tin nhạy cảm vào trình duyệt UI.</span><Button type="submit" variant="primary" busy={busy === `login:${loginAccount.id}`}><KeyRound size={14} /> Gửi đăng nhập</Button></div></form></div>}
    </section>
  );
}

export function ResearchPage({ data, project, notify, navigate }) {
  const [results, setResults] = useState(data.researchResults || []);
  const [view, setView] = useState("research");
  const [importing, setImporting] = useState("");
  const [searchingImages, setSearchingImages] = useState("");
  const [importingSearchImages, setImportingSearchImages] = useState("");
  const [dreaming, setDreaming] = useState("");
  const [autoVideo, setAutoVideo] = useState("");
  const [rerunning, setRerunning] = useState("");
  const [researchFilter, setResearchFilter] = useState("all");
  const [llmBatch, setLlmBatch] = useState({ active: false, done: 0, total: 0 });
  const [batchAutoCreateContent, setBatchAutoCreateContent] = useState(true);
  const [renderOptions, setRenderOptions] = useState({
    concurrency: Number(data.settings?.concurrency) || 2,
    threads: Number(data.settings?.renderThreads) || 4,
  });
  const [savingRenderOptions, setSavingRenderOptions] = useState(false);
  const dreamfaceAccounts = useMemo(
    () => (data.accounts || []).filter((account) => account.provider === "dreamface"),
    [data.accounts],
  );
  useEffect(() => setResults(data.researchResults || []), [data.researchResults]);
  useEffect(() => setRenderOptions({
    concurrency: Number(data.settings?.concurrency) || 2,
    threads: Number(data.settings?.renderThreads) || 4,
  }), [data.settings?.concurrency, data.settings?.renderThreads]);
  const projectResults = useMemo(() => results.filter((result) => result.projectId === project.id).sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0)), [results, project.id]);
  const renderHistory = useMemo(() => {
    const history = new Map(projectResults.map((result) => [result.id, 0]));
    for (const media of data.media || []) {
      const researchId = media?.production?.researchId;
      if (researchId && history.has(researchId) && isPublishableVideo(media, data.jobs)) history.set(researchId, history.get(researchId) + 1);
    }
    return history;
  }, [data.media, data.jobs, projectResults]);
  const postedResearch = useMemo(() => {
    const mediaById = new Map((data.media || []).map((media) => [media.id, media]));
    const ids = new Set((data.socialPosts || []).filter((post) => post.projectId === project.id && ["published", "scheduled", "ready"].includes(post.status)).map((post) => post.researchId).filter(Boolean));
    for (const post of data.socialPosts || []) for (const mediaId of post.mediaIds || []) {
      const researchId = mediaById.get(mediaId)?.production?.researchId;
      if (researchId) ids.add(researchId);
    }
    return ids;
  }, [data.media, data.socialPosts, project.id]);
  const fallbackResults = useMemo(() => projectResults.filter(isLlmFallback), [projectResults]);
  const visibleResults = useMemo(() => {
    if (researchFilter === "needs-llm") return fallbackResults;
    if (researchFilter === "llm") return projectResults.filter((result) => !isLlmFallback(result));
    if (researchFilter === "rendered") return projectResults.filter((result) => (renderHistory.get(result.id) || 0) > 0);
    if (researchFilter === "not-rendered") return projectResults.filter((result) => !(renderHistory.get(result.id) || 0));
    if (researchFilter === "posted") return projectResults.filter((result) => postedResearch.has(result.id));
    return projectResults;
  }, [fallbackResults, projectResults, researchFilter, renderHistory, postedResearch]);
  const onResult = (result) => setResults((current) => [result, ...current.filter((item) => item.id !== result.id)]);
  const [selectedResearchIds, setSelectedResearchIds] = useState([]);
  const toggleResearch = (id) => setSelectedResearchIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const deleteSelectedResearch = async () => {
    const selected = selectedResearchIds.filter((id) => projectResults.some((result) => result.id === id));
    if (!selected.length || !confirm(`Xóa ${selected.length} tin đã chọn khỏi Research? Video và bài đã đăng vẫn được giữ trong kho.`)) return;
    let deleted = 0;
    for (const id of selected) {
      try {
        await api(`/research/${id}`, {}, "DELETE");
        deleted += 1;
      } catch (error) {
        notify(error.message, "error");
      }
    }
    if (deleted) {
      setResults((current) => current.filter((result) => !selected.includes(result.id)));
      setSelectedResearchIds([]);
      notify(`Đã xóa ${deleted} tin khỏi Research.`);
    }
  };
  const rerunLlm = async (result) => {
    if (rerunning || llmBatch.active) return;
    setRerunning(result.id);
    try {
      const updated = await api(`/research/${result.id}/llm`, {});
      onResult(updated);
      notify("LLM đã tổng hợp lại Research từ đúng các nguồn đã lưu.");
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setRerunning("");
    }
  };
  const rerunAllLlm = async ({ renderAfter = false } = {}) => {
    if (rerunning || llmBatch.active || autoVideo || dreaming || !fallbackResults.length) return;
    const selected = fallbackResults;
    const workerCount = Math.max(1, Math.min(4, Number(data.settings?.concurrency) || 2));
    let cursor = 0;
    let succeeded = 0;
    let failed = 0;
    setLlmBatch({ active: true, done: 0, total: selected.length });
    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= selected.length) return;
        try {
          const updated = await api(`/research/${selected[index].id}/llm`, {});
          onResult(updated);
          succeeded += 1;
        } catch {
          failed += 1;
        } finally {
          setLlmBatch((current) => ({ ...current, done: current.done + 1 }));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(workerCount, selected.length) }, worker));
    setLlmBatch({ active: false, done: selected.length, total: selected.length });
    if (failed) {
      notify(`LLM đã xử lý ${succeeded}/${selected.length} tin; ${failed} tin vẫn cần kiểm tra cấu hình hoặc thử lại.`, "error");
      return;
    }
    notify(`LLM đã xử lý xong ${succeeded} tin. Có thể đưa toàn bộ vào render.`);
    if (renderAfter) await renderAllResearch();
  };
  const importImages = async (result) => {
    if (importing) return;
    setImporting(result.id);
    try {
      const response = await api(`/research/${result.id}/import-images`, {
        articleIds: result.articles.filter((article) => article.imageUrl).map((article) => article.id),
      });
      onResult(response.result);
      notify(`Đã tải ${response.imported.length} ảnh vào thư viện.`);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setImporting("");
    }
  };
  const searchImages = async (result) => {
    if (searchingImages) return;
    setSearchingImages(result.id);
    try {
      const response = await api(`/research/${result.id}/search-images`, { queries: result.imageQueries || [] });
      onResult(response.result);
      notify(`Đã tìm ${response.images.length} ảnh công khai theo image query.`);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setSearchingImages("");
    }
  };
  const importSearchImages = async (result) => {
    if (importingSearchImages) return;
    setImportingSearchImages(result.id);
    try {
      const response = await api(`/research/${result.id}/import-search-images`, { imageIds: (result.imageSearchResults || []).map((image) => image.id) });
      onResult(response.result);
      notify(`Đã tải ${response.imported.length} ảnh vào thư viện.`);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setImportingSearchImages("");
    }
  };
  const useScript = (result) => {
    sessionStorage.setItem(`studio-research-prompt:${project.id}`, result.script || result.headline || "");
    notify("Đã chuyển script sang màn hình tạo video.");
    navigate?.("create");
  };
  const createDreamFaceVideo = async (result, requestedCount = 1, selectedAccountId = "auto", autoCreateContent = false) => {
    if (dreaming || autoVideo) return;
    const readyCount = dreamfaceAccounts.filter((account) => account.status === "ready").length;
    const count = Math.max(1, Math.min(30, Number(requestedCount) || 1));
    setDreaming(result.id);
    try {
      const batch = await api("/production/batches", {
        requestId: crypto.randomUUID(),
        projectId: project.id,
        contentType: "news",
        autoCreateContent,
        autoResearch: true,
        researchId: result.id,
        topic: (result.topic || result.headline || "US news").slice(0, 200),
        count,
        engine: "dreamface",
        accountId: selectedAccountId || "auto",
        references: [],
        feeds: [],
        variationPolicy: "visual-unique",
        fontStyle: "news",
      });
      notify(`Đã đưa ${batch.items?.length || count} news presenter video vào hàng đợi. MC ${selectedAccountId && selectedAccountId !== "auto" ? "được giữ cùng profile đã chọn" : "sẽ xoay theo profile khỏe"}; ảnh và chuyển động được tạo biến thể theo từng video${readyCount ? ` · ${readyCount} profile sẵn sàng.` : "; hãy đăng nhập một DreamFace slot để chạy."}`);
      // The News render workspace owns the preparation batch as well as the
      // provider jobs. Keep the user there so image/LLM failures are visible
      // and the failed item can be retried instead of disappearing in Queue.
      navigate?.("editor", { focusBatchId: batch.id, researchId: result.id });
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setDreaming("");
    }
  };
  const saveRenderOptions = async () => {
    setSavingRenderOptions(true);
    try {
      await api("/settings", {
        concurrency: renderOptions.concurrency,
        renderThreads: renderOptions.threads,
      }, "PATCH");
      notify(`Đã lưu: ${renderOptions.concurrency} job News song song · ${renderOptions.threads} FFmpeg threads/video.`);
      return true;
    } catch (error) {
      notify(error.message, "error");
      return false;
    } finally {
      setSavingRenderOptions(false);
    }
  };
  const renderAllResearch = async () => {
    if (autoVideo || dreaming || rerunning || !projectResults.length) return;
    if (!(await saveRenderOptions())) return;
    const selected = projectResults.slice(0, 30);
    setAutoVideo("all");
    const results = await Promise.allSettled(selected.map((result) => api("/production/batches", {
      requestId: crypto.randomUUID(),
      projectId: project.id,
      contentType: "news",
      autoCreateContent: batchAutoCreateContent,
      autoResearch: true,
      researchId: result.id,
      topic: (result.topic || result.headline || "US news").slice(0, 200),
      count: 1,
      engine: "dreamface",
      accountId: "auto",
      references: [],
      feeds: [],
      variationPolicy: "visual-unique",
      fontStyle: "news",
    })));
    const queued = results.filter((item) => item.status === "fulfilled").length;
    setAutoVideo("");
    if (queued) {
      notify(`Đã đưa ${queued}/${selected.length} tin vào News Queue. Các profile DreamFace sẵn sàng sẽ chạy song song.`);
      navigate?.("editor", { focusBatchIds: results.filter((item) => item.status === "fulfilled").map((item) => item.value.id) });
    } else {
      notify("Không tạo được batch News nào. Hãy kiểm tra LLM và DreamFace trong Cài đặt.", "error");
    }
  };
  const autoBuildVideo = async (result) => {
    if (autoVideo) return;
    setAutoVideo(result.id);
    try {
      const response = await api(`/research/${result.id}/auto-video`, {});
      onResult(response.result);
      notify(`Đã tìm ${response.imported.length} ảnh, ráp ${response.assembly.overlays} caption và đưa render tin tức vào hàng đợi.`);
      navigate?.("queue");
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setAutoVideo("");
    }
  };
  const assembleImages = async (result) => {
    try {
      const fresh = await api("/state");
      const freshProject = fresh.projects.find((item) => item.id === project.id);
      const assets = (result.imageMediaIds || [])
        .map((id) => fresh.media.find((item) => item.id === id))
        .filter((item) => item && item.kind === "image");
      const assembly = buildResearchAssemblyTimeline(freshProject.timeline, assets, result);
      if (!assembly.additions.length) {
        notify("Các ảnh này đã có trong timeline.");
        navigate?.("editor");
        return;
      }
      await api(`/projects/${project.id}`, { timeline: assembly.timeline }, "PATCH");
      notify(`Đã ráp ${assembly.additions.length} ảnh và ${assembly.overlays.length} caption vào timeline.`);
      navigate?.("editor");
    } catch (error) {
      notify(error.message, "error");
    }
  };
      return <div className="page research-page"><div className="page-heading research-heading"><div><div className="eyebrow">RESEARCH WORKSPACE</div><h1>Từ chủ đề đến góc kể chuyện.</h1><p>News Studio là luồng riêng: research → ảnh editorial → MC DreamFace → bài website → first comment.</p></div><div className="research-heading-actions"><Button variant="primary" onClick={() => projectResults[0] ? createDreamFaceVideo(projectResults[0], 1, "auto", batchAutoCreateContent) : navigate?.("editor")} busy={Boolean(dreaming)}><Newspaper size={15} /> Render 1 News video</Button><div className="research-heading-mark"><Newspaper size={20} /><span>{projectResults.length} kết quả</span></div></div></div><div className="research-tabs research-primary-tabs"><button className={view === "research" ? "active" : ""} onClick={() => setView("research")}><Search size={15} /> Research &amp; News</button><button className={view === "dreamface" ? "active" : ""} onClick={() => setView("dreamface")}><Sparkles size={15} /> DreamFace profiles</button></div>{view === "research" && <><section className="research-card research-run-card"><div className="research-card-heading"><div><span className="research-kicker">EDITORIAL INPUT</span><h2><Search size={19} /> Nghiên cứu chủ đề</h2><p>RSS/Atom được giới hạn và deduplicate trước khi tổng hợp.</p></div><span className="research-step"><span>01</span> INPUT</span></div><ResearchForm project={project} onResult={onResult} notify={notify} /></section><section className="research-results">
  <div className="research-section-heading">
    <div><span className="research-kicker">NEWS STUDIO · PROJECT RESULTS</span><h2>Kết quả gần đây</h2></div>
    {projectResults.length > 0 && <div className="research-batch-toolbar">
      <span className="research-batch-count">{projectResults.length} tin · tối đa {renderOptions.concurrency} News song song</span>
      <label>Trạng thái<select aria-label="Lọc Research" value={researchFilter} onChange={(event) => setResearchFilter(event.target.value)}><option value="all">Tất cả</option><option value="needs-llm">Thiếu LLM</option><option value="llm">Đã có LLM</option><option value="not-rendered">Chưa render</option><option value="rendered">Đã render</option><option value="posted">Đã đăng</option></select></label>
      <label>News song song<select value={renderOptions.concurrency} onChange={(event) => setRenderOptions((current) => ({ ...current, concurrency: Number(event.target.value) }))}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>FFmpeg threads<select value={renderOptions.threads} onChange={(event) => setRenderOptions((current) => ({ ...current, threads: Number(event.target.value) }))}>{[1, 2, 4, 8, 16, 32].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label className="research-batch-content"><input type="checkbox" checked={batchAutoCreateContent} onChange={(event) => setBatchAutoCreateContent(event.target.checked)} /> Tự tạo Content</label>
      {fallbackResults.length > 0 && <Button onClick={() => rerunAllLlm()} busy={llmBatch.active || Boolean(rerunning)}><RefreshCw size={14} /> {llmBatch.active ? `LLM ${llmBatch.done}/${llmBatch.total}` : `Chạy LLM cho ${fallbackResults.length} tin`}</Button>}
      {fallbackResults.length > 0 && <Button variant="primary" onClick={() => rerunAllLlm({ renderAfter: true })} busy={llmBatch.active || Boolean(rerunning)}><Sparkles size={14} /> LLM → Render {Math.min(projectResults.length, 30)} tin</Button>}
      <Button variant="primary" onClick={renderAllResearch} busy={autoVideo === "all" || savingRenderOptions}><Sparkles size={14} /> Render tất cả {Math.min(projectResults.length, 30)} tin</Button>
      {selectedResearchIds.length > 0 && <Button className="danger-text" onClick={deleteSelectedResearch}><Trash2 size={14} /> Xóa {selectedResearchIds.length} tin</Button>}
    </div>}
  </div>
  {visibleResults.length ? visibleResults.map((result) => <ResultCard key={result.id} result={result} accounts={dreamfaceAccounts} renderCount={renderHistory.get(result.id) || 0} posted={postedResearch.has(result.id)} selected={selectedResearchIds.includes(result.id)} onToggleSelect={toggleResearch} onImport={importImages} importing={importing === result.id} onUse={useScript} onDreamFace={createDreamFaceVideo} dreaming={dreaming === result.id} onAssemble={assembleImages} onSearchImages={searchImages} searchingImages={searchingImages === result.id} onImportSearchImages={importSearchImages} importingSearchImages={importingSearchImages === result.id} onRerunLlm={rerunLlm} rerunning={rerunning === result.id || llmBatch.active} />) : <Empty icon={Newspaper} title={researchFilter === "needs-llm" ? "Không còn tin lỗi LLM" : "Chưa có research nào"}>{researchFilter === "needs-llm" ? "Các tin đã được LLM xử lý hoặc chưa có lỗi cần chạy lại." : "Nhập một chủ đề để tạo bản ghi đầu tiên cho dự án này."}</Empty>}</section></>}{view === "dreamface" && <DreamFacePanel data={data} notify={notify} />}</div>;
}

export const Research = ResearchPage;
