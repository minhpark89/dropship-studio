import { useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  Clapperboard,
  Image,
  Lightbulb,
  MessageSquareText,
  Newspaper,
  PackageSearch,
  Play,
  ShoppingBag,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { api } from "../api.js";
import { Button, Field, Notice, Uploader } from "../components.jsx";

const templates = [
  { id: "demo", title: "Product demo", caption: "Show sản phẩm rõ ràng", icon: PackageSearch, hint: "Cận cảnh tính năng, chất liệu và khoảnh khắc sử dụng." },
  { id: "ugc", title: "UGC / review", caption: "Tự nhiên như creator", icon: MessageSquareText, hint: "Nhịp kể chân thật, có hook và cảm nhận người dùng." },
  { id: "offer", title: "Catalog / offer", caption: "Tập trung chuyển đổi", icon: ShoppingBag, hint: "Lợi ích, ưu đãi và CTA rõ để đưa sang Content." },
];

export function ProductPage({ data, project, notify, run, navigate }) {
  const [template, setTemplate] = useState("demo");
  const [productName, setProductName] = useState("");
  const [benefit, setBenefit] = useState("");
  const [cta, setCta] = useState("");
  const [prompt, setPrompt] = useState("");
  const [selected, setSelected] = useState([]);
  const [duration, setDuration] = useState(5);
  const [ratio, setRatio] = useState("9:16");
  const [accountId, setAccountId] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [videoCount, setVideoCount] = useState(1);
  const newsMediaIds = useMemo(() => new Set((data.researchResults || [])
    .filter((result) => result.projectId === project.id)
    .flatMap((result) => result.imageMediaIds || [])), [data.researchResults, project.id]);
  const newsMcIds = useMemo(() => new Set((data.accounts || [])
    .filter((account) => account.provider === "dreamface" && account.avatarMediaId)
    .map((account) => account.avatarMediaId)), [data.accounts]);
  const assets = useMemo(() => (data.media || [])
    .filter((item) => (item.projectId === project.id || !item.projectId) && item.kind === "image")
    .filter((item) => {
      const type = String(item.mediaType || "").toLowerCase();
      const name = String(item.name || "");
      const hasEditorialProvenance = Boolean(item.sourceUrl || item.attribution || item.license);
      const looksLikeNews = /\b(?:news|broadcast|trump|obama|starlink|ukraine|white house|minneapolis|midterm|rally|detroit news|bbc)\b/i.test(name);
      // News research assets and the generated presenter share the library,
      // but Product Studio should only offer product references.
      return !["news-editorial", "news-mc", "news-video"].includes(type)
        && !newsMediaIds.has(item.id)
        && !newsMcIds.has(item.id)
        && item.production?.contentType !== "news"
        && !(item.generated && /news|broadcast|mc host/i.test(name))
        && !(hasEditorialProvenance && type !== "product")
        && !(looksLikeNews && hasEditorialProvenance);
    })
    .slice().reverse(), [data.media, newsMediaIds, newsMcIds, project.id]);
  const dreamface = (data.accounts || []).filter((account) => account.provider === "dreamface");
  const ready = dreamface.filter((account) => account.status === "ready");
  const chosenTemplate = templates.find((item) => item.id === template) || templates[0];

  const toggleAsset = (id) => setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : current.length >= 10 ? current : [...current, id]);
  const buildPrompt = () => {
    const parts = [
      `${chosenTemplate.title} video in ${ratio} for ${productName || "this product"}.`,
      benefit && `Main benefit: ${benefit}.`,
      cta && `End with this call to action: ${cta}.`,
      "Modern style, clean lighting, smooth transitions, clear product details, no fake text or unrelated logos.",
    ].filter(Boolean);
    return parts.join(" ");
  };
  const submit = async (event) => {
    event.preventDefault();
    const finalPrompt = prompt.trim() || buildPrompt();
    if (!finalPrompt.trim()) { notify("Hãy nhập tên sản phẩm hoặc prompt.", "error"); return; }
    setBusy(true);
    const result = await run(() => api("/jobs/generate", {
      projectId: project.id,
      provider: "dreamface",
      accountId,
      kind: "video",
      mode: selected.length ? "reference" : "text",
      model: "DreamFace video",
      duration: Number(duration),
      ratio,
      prompts: Array.from({length:Number(videoCount)},(_,index)=>`${finalPrompt}\nCreate for the US market. All narration, captions, on-screen text, and calls to action must use American English.\nVariation ${index+1} of ${videoCount}: use a distinct opening shot, camera movement and pacing.`),
      references: selected,
      scheduledAt: null,
      // Finish a single product request through the local render queue.
      // Multi-video requests stay independent instead of becoming a montage.
      autoAssemble: Number(videoCount) === 1,
      contentContext: {contentType:"product",title:productName.slice(0,200),productBrief:[benefit,cta].filter(Boolean).join(". ").slice(0,4000)},
    }));
    setBusy(false);
    if (result) {
      notify(`Đã đưa ${result.length} video sản phẩm vào hàng đợi${ready.length ? "." : ". Hãy đăng nhập DreamFace để chạy."}`);
      navigate?.("queue");
    }
  };

  return <div className="page workspace-hub product-hub">
    <div className="workspace-split-note"><strong>PRODUCT VIDEO</strong><span>Sales demos and product references live here. News/editorial images are hidden from this picker. Research, MC, website articles and first comments are managed in Research &amp; News.</span><button type="button" onClick={() => navigate?.("research")}>Open News Studio →</button></div>
    <div className="page-heading hub-heading"><div><div className="eyebrow">PRODUCT WORKSPACE</div><h1>Product Studio cho video bán hàng.</h1><p>Chọn dạng video và bấm render. Queue sẽ tự chạy DreamFace; nếu tạo một video, FFmpeg cũng tự xuất bản hoàn chỉnh trước khi đưa vào Content.</p></div><div className="hub-heading-actions"><Button onClick={() => navigate?.("research")}><Newspaper size={15} /> Render News</Button><Button onClick={() => navigate?.("content")}><MessageSquareText size={15} /> Mở Content</Button><Button variant="primary" onClick={() => document.querySelector(".product-form")?.scrollIntoView({ behavior: "smooth" })}><Sparkles size={15} /> Tạo video</Button></div></div>
    <div className="product-status-strip"><div><span className="hub-kicker">DREAMFACE</span><strong>{ready.length} profile sẵn sàng</strong><small>{dreamface.length ? `${dreamface.length} account/slot đã thêm` : "Chưa có account"}</small></div><div><span className="hub-kicker">PROJECT</span><strong>{project.name}</strong><small>{assets.length} product media có thể chọn</small></div><div><span className="hub-kicker">OUTPUT</span><strong>9:16 · {duration}s</strong><small>Video social dọc</small></div></div>
    <div className="product-layout"><form className="hub-panel product-form" onSubmit={submit}><div className="hub-panel-heading"><div><span className="hub-kicker">01 · FORMAT</span><h2>Chọn kiểu video</h2></div><span className="step-dot">01</span></div><div className="product-template-grid">{templates.map(({ id, title, caption, icon: Icon, hint }) => <button key={id} type="button" className={`product-template ${template === id ? "selected" : ""}`} onClick={() => setTemplate(id)}><span className="template-icon"><Icon size={19} /></span><strong>{title}</strong><small>{caption}</small><em>{hint}</em>{template === id && <Check className="template-check" size={16} />}</button>)}</div>
      <div className="hub-panel-heading product-section-heading"><div><span className="hub-kicker">02 · BRIEF</span><h2>Thông tin sản phẩm</h2></div></div><div className="form-grid"><Field label="Tên sản phẩm"><input required value={productName} onChange={(event) => setProductName(event.target.value)} placeholder="Ví dụ: Bình giữ nhiệt 900ml" /></Field><Field label="Lợi ích chính"><input value={benefit} onChange={(event) => setBenefit(event.target.value)} placeholder="Nhẹ, giữ lạnh 24 giờ" /></Field></div><div className="form-grid"><Field label="CTA / ưu đãi"><input value={cta} onChange={(event) => setCta(event.target.value)} placeholder="Xem mẫu và đặt hàng hôm nay" /></Field><Field label="DreamFace profile"><select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="auto">Auto · profile khỏe tiếp theo</option>{dreamface.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.status}</option>)}</select></Field></div><Field label="Prompt chi tiết" hint="Để trống để Studio tự ghép từ brief. Bạn có thể sửa prompt theo từng sản phẩm."><textarea rows="6" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Mô tả bối cảnh, nhân vật, chuyển động, ánh sáng…" /></Field><div className="product-options"><Field label="Number of videos"><input type="number" min="1" max="50" required value={videoCount} onChange={(event)=>setVideoCount(event.target.value)} /></Field><Field label="Thời lượng"><select value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value={5}>5 giây</option><option value={10}>10 giây</option></select></Field><Field label="Tỷ lệ"><select value={ratio} onChange={(event) => setRatio(event.target.value)}><option value="9:16">9:16 · dọc</option><option value="16:9">16:9 · ngang</option></select></Field></div><div className="product-form-footer"><span><Lightbulb size={15} /> {selected.length ? `DreamFace sẽ dùng ${selected.length} ảnh tham chiếu.` : "Không chọn ảnh vẫn tạo được từ text."}</span><Button type="button" onClick={() => setPrompt(buildPrompt())}><Sparkles size={14} /> Gợi ý prompt</Button><Button type="submit" variant="primary" busy={busy}><Play size={15} /> Gửi DreamFace · render</Button></div></form><aside className="hub-panel product-assets"><div className="hub-panel-heading"><div><span className="hub-kicker">03 · REFERENCES</span><h2>Chọn sản phẩm</h2></div><span className="asset-count">{selected.length}/10</span></div><p className="panel-intro">Chọn ảnh trong thư viện để DreamFace giữ đúng hình dáng và màu sản phẩm.</p>{assets.length ? <div className="product-asset-grid">{assets.map((item) => <button type="button" key={item.id} className={`product-asset ${selected.includes(item.id) ? "selected" : ""}`} onClick={() => toggleAsset(item.id)}><div>{item.kind === "image" ? <img src={item.thumbnailUrl || item.url} alt={item.name} /> : <video src={item.url} muted preload="metadata" />}</div><span>{item.name}</span>{selected.includes(item.id) && <i><Check size={12} /></i>}</button>)}</div> : <div className="product-empty-assets"><Image size={26} /><strong>Chưa có media</strong><span>Nhập ảnh sản phẩm vào thư viện để chọn tại đây.</span></div>}<Uploader projectId={project.id} notify={notify} onDone={() => {}} compact /><div className="product-asset-note"><UploadCloud size={14} /> Chọn tối đa 10 ảnh · dùng file bạn sở hữu</div></aside></div><div className="product-next"><div><span className="hub-kicker">AFTER GENERATION</span><strong>Video xong → Render kiểm tra → Content → Page</strong><p>Hàng đợi sẽ giữ lại lịch sử provider, account và lỗi để bạn xoay vòng cho các ngày sau.</p></div><Button onClick={() => navigate?.("editor")}><Clapperboard size={15} /> Mở Render &amp; Preview <ArrowRight size={15} /></Button></div></div>;
}

