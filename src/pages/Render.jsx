import { useState } from "react";
import { FileVideo, Newspaper, Package, Zap } from "lucide-react";
import { Button } from "../components.jsx";
import { EditorPage } from "./Editor.jsx";
import { ProductionPanel } from "./ProductionPanel.jsx";

const modes = [
  { id: "news", label: "Render video tin tức", hint: "Hook, nguồn và headline dọc", icon: Newspaper },
  { id: "product", label: "Render video sản phẩm", hint: "Demo, UGC và CTA bán hàng", icon: Package },
];

export function RenderPage(props) {
  const [mode, setMode] = useState("news");
  const selected = modes.find((item) => item.id === mode) || modes[0];
  return <div className="render-hub">
    <section className="render-switcher">
      <div><div className="eyebrow">RENDER WORKSPACE</div><h1>Render nhanh, đúng loại video.</h1><p>Chọn News hoặc Product trước khi dựng. Timeline và preset xuất được giữ nguyên trong project.</p></div>
      <div className="render-mode-tabs">{modes.map(({ id, label, hint, icon: Icon }) => <button key={id} className={mode === id ? "active" : ""} onClick={() => setMode(id)}><span><Icon size={18} /></span><strong>{label}</strong><small>{hint}</small></button>)}</div>
      <div className="render-fast-note"><Zap size={15} /><span><strong>Xuất nhanh</strong> dùng 480p, draft và preset FFmpeg tốc độ cao.</span></div>
    </section>
    <ProductionPanel key={`production:${props.project.id}:${mode}`} {...props} mode={mode} />
    <div className="render-selected-line"><span><FileVideo size={15} /> {selected.label}</span><Button onClick={() => props.navigate?.("content")}>Mở Content</Button></div>
    <EditorPage key={`editor:${props.project.id}:${mode}`} {...props} renderKind={mode} />
  </div>;
}
