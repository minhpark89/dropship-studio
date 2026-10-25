import { useState } from "react";
import {
  Search,
  Film,
  Download,
  Scissors,
  Trash2,
  Play,
  Image,
  Music2,
  Newspaper,
} from "lucide-react";
import { api, bytes, timecode, clipFrom } from "../api.js";
import { Button, Empty, MediaThumb, Modal, Uploader } from "../components.jsx";

export function LibraryPage({ data, project, run, notify, navigate }) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState([]);
  const media = data.media
    .filter(
      (item) =>
        (item.projectId === project.id || !item.projectId) &&
        (filter === "all" ||
          (filter === "exports" ? item.generated : item.kind === filter)) &&
        item.name.toLowerCase().includes(search.toLowerCase()),
    )
    .slice()
    .reverse();
  const append = async (items) => {
    const timeline = structuredClone(project.timeline);
    for (const item of items) {
      if (item.kind === "audio") {
        timeline.music = {
          mediaId: item.id,
          volume: 0.35,
          startSec: 0,
          offsetSec: 0,
          speed: 1,
          loop: true,
          fadeIn: 0.5,
          fadeOut: 1,
        };
      } else timeline.clips.push(clipFrom(item));
    }
    if (
      await run(() => api(`/projects/${project.id}`, { timeline }, "PATCH"))
    ) {
      notify(`Đã thêm ${items.length} tệp vào trình dựng.`);
      navigate("editor");
    }
  };
  const handoffToContent = (item) => {
    sessionStorage.setItem(
      "studio-content-media",
      JSON.stringify({ mediaId: item.id, projectId: project.id }),
    );
    navigate("content");
  };
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">MEDIA LIBRARY</div>
          <h1>Mọi chất liệu, một nơi.</h1>
          <p>Video AI, ảnh sản phẩm, nhạc và các bản xuất của dự án.</p>
        </div>
        <Uploader compact projectId={project.id} notify={notify} />
      </div>
      <div className="toolbar">
        <div className="segmented">
          {[
            ["all", "Tất cả"],
            ["video", "Video"],
            ["image", "Ảnh"],
            ["audio", "Âm thanh"],
            ["exports", "Đã tạo / xuất"],
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
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="Tìm media"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Tìm trong thư viện…"
          />
        </div>
      </div>
      {selected.length > 0 && (
        <div className="selection-toolbar">
          <span>Đã chọn {selected.length} tệp</span>
          <button className="text-button" onClick={() => setSelected([])}>
            Bỏ chọn
          </button>
          <Button
            variant="primary"
            onClick={() =>
              append(
                selected
                  .map((id) => data.media.find((item) => item.id === id))
                  .filter(Boolean),
              )
            }
          >
            <Scissors size={15} />
            Thêm vào timeline
          </Button>
        </div>
      )}
      {media.length ? (
        <div className="media-grid">
          {media.map((item) => (
            <article
              key={item.id}
              className={`media-card ${selected.includes(item.id) ? "selected" : ""}`}
            >
              <div className="media-cover">
                <button
                  className="media-preview"
                  onClick={() => setPreview(item)}
                  aria-label={`Xem ${item.name}`}
                >
                  <MediaThumb media={item} />
                  <span className="play-overlay">
                    {item.kind === "image" ? (
                      <Image size={23} />
                    ) : item.kind === "audio" ? (
                      <Music2 size={23} />
                    ) : (
                      <Play size={23} />
                    )}
                  </span>
                </button>
                <input
                  className="media-check"
                  aria-label={`Chọn ${item.name}`}
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, item.id]
                        : selected.filter((id) => id !== item.id),
                    )
                  }
                />
                <span className="media-time">
                  {item.kind === "image"
                    ? `${item.width}×${item.height}`
                    : timecode(item.duration)}
                </span>
                {item.generated && (
                  <span className="generated-tag">
                    {data.jobs.find((job) => job.id === item.jobId)?.type ===
                    "render"
                      ? "BẢN XUẤT"
                      : "AI"}
                  </span>
                )}
              </div>
              <div className="media-info">
                <h3 title={item.name}>{item.name}</h3>
                <p>
                  {item.kind === "audio"
                    ? "AUDIO"
                    : `${item.width}×${item.height}`}
                  <span>·</span>
                  {bytes(item.bytes)}
                </p>
                <div className="spread">
                  <button
                    className="text-button"
                    onClick={() => append([item])}
                  >
                    <Scissors size={14} />
                    Dựng video
                  </button>
                  {item.kind !== "audio" && (
                    <button
                      className="text-button"
                      onClick={() => handoffToContent(item)}
                    >
                      <Newspaper size={14} />
                      Soạn Content
                    </button>
                  )}
                  <div className="inline-actions">
                    <a
                      className="icon-button"
                      href={`${item.url}?download=1`}
                      title="Tải về"
                    >
                      <Download size={15} />
                    </a>
                    <button
                      className="icon-button danger-text"
                      aria-label={`Xóa tệp ${item.name}`}
                      onClick={async () => {
                        if (!confirm(`Xóa tệp ${item.name} khỏi thư viện?`))
                          return;
                        const result = await run(
                          () => api(`/media/${item.id}`, {}, "DELETE"),
                          "Đã xóa tệp.",
                        );
                        if (result)
                          setSelected(selected.filter((id) => id !== item.id));
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          icon={Film}
          title="Thư viện đang chờ nội dung"
          action={
            <Button onClick={() => navigate("create")}>Tạo video AI</Button>
          }
        >
          Nhập video, ảnh và âm thanh từ máy hoặc tạo nội dung mới bằng AI.
        </Empty>
      )}
      <div className="library-drop">
        <Uploader projectId={project.id} notify={notify} />
      </div>
      {preview && (
        <Modal title={preview.name} wide onClose={() => setPreview(null)}>
          <div className="preview-modal">
            {preview.kind === "video" ? (
              <video src={preview.url} controls autoPlay />
            ) : preview.kind === "audio" ? (
              <audio src={preview.url} controls autoPlay />
            ) : (
              <img src={preview.url} alt={preview.name} />
            )}
          </div>
          <div className="modal-actions">
            <a href={`${preview.url}?download=1`} className="button">
              <Download size={16} />
              Tải về
            </a>
            <Button variant="primary" onClick={() => append([preview])}>
              <Scissors size={16} />
              Thêm vào trình dựng
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
