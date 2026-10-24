import { useEffect, useRef, useState } from "react";
import {
  Plus,
  Film,
  Type,
  Image,
  Music2,
  Download,
  Undo2,
  Redo2,
  Copy,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Save,
  Scissors,
  ArrowUpRight,
  Volume2,
} from "lucide-react";
import { durationOf } from "../../shared/contracts.js";
import { api, uid, clipFrom, timecode } from "../api.js";
import {
  Button,
  Field,
  MediaThumb,
  Modal,
  Uploader,
  CheckField,
  Notice,
} from "../components.jsx";
import { Preview } from "./Preview.jsx";

const number = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

function Numeric({ label, value, onChange, min = 0, max, step = 0.1 }) {
  return (
    <Field label={label}>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number(Number(value).toFixed(3))}
        onChange={(event) => onChange(number(event.target.value))}
      />
    </Field>
  );
}

export function EditorPage({ data, project, run, notify, navigate }) {
  const [timeline, setTimeline] = useState(structuredClone(project.timeline));
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const [selected, setSelected] = useState({
    type: "clips",
    id: project.timeline.clips[0]?.id,
  });
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [history, setHistory] = useState({ past: [], future: [] });
  const [tab, setTab] = useState("media");
  const [modal, setModal] = useState(null);
  const [name, setName] = useState(`${project.name} - final`);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saved, setSaved] = useState(true);
  const duration = durationOf(timeline);
  const assets = data.media.filter(
    (media) => media.projectId === project.id || !media.projectId,
  );
  const selection = timeline[selected.type]?.find?.(
    (item) => item.id === selected.id,
  );
  const selectionMedia = data.media.find(
    (item) => item.id === selection?.mediaId,
  );
  const change = (update) => {
    const previous = timelineRef.current;
    let next =
      typeof update === "function" ? update(structuredClone(previous)) : update;
    if (next.clips !== previous.clips) {
      const total = durationOf(next);
      for (const type of ["texts", "images"])
        next[type] = next[type]
          .filter((item) => item.startSec < total)
          .map((item) => ({ ...item, endSec: Math.min(total, item.endSec) }));
    }
    setHistory((state) => ({
      past: [...state.past.slice(-49), structuredClone(previous)],
      future: [],
    }));
    timelineRef.current = next;
    setTimeline(next);
    setSaved(false);
  };
  const patch = (type, id, value) =>
    change((draft) => {
      draft[type] = draft[type].map((item) =>
        item.id === id ? { ...item, ...value } : item,
      );
      return draft;
    });
  const save = async () => {
    setSaving(true);
    const result = await run(() =>
      api(
        `/projects/${project.id}`,
        { timeline: timelineRef.current },
        "PATCH",
      ),
    );
    if (result) setSaved(true);
    setSaving(false);
    return result;
  };
  useEffect(() => {
    if (saved) return;
    const timer = setTimeout(save, 700);
    return () => clearTimeout(timer);
  }, [timeline, saved]);
  useEffect(() => {
    if (current > duration) setCurrent(duration);
  }, [duration, current]);
  useEffect(
    () => () => {
      api(
        `/projects/${project.id}`,
        { timeline: timelineRef.current },
        "PATCH",
      ).catch(() => {});
    },
    [project.id],
  );
  const addClip = (media) => {
    const clip = clipFrom(media);
    const start = duration;
    change((draft) => ({ ...draft, clips: [...draft.clips, clip] }));
    setSelected({ type: "clips", id: clip.id });
    setCurrent(start);
  };
  const addText = () => {
    const text = {
      id: uid(),
      text: "Câu chuyện của bạn",
      startSec: 0,
      endSec: duration,
      x: 0.5,
      y: 0.75,
      size: 42,
      color: "#ffffff",
      background: false,
    };
    change((draft) => ({ ...draft, texts: [...draft.texts, text] }));
    setSelected({ type: "texts", id: text.id });
    setCurrent(0);
    setPlaying(false);
  };
  const addLogo = (media) => {
    const image = {
      id: uid(),
      mediaId: media.id,
      startSec: 0,
      endSec: duration,
      x: 0.8,
      y: 0.15,
      scale: 0.2,
      opacity: 1,
    };
    change((draft) => ({ ...draft, images: [...draft.images, image] }));
    setSelected({ type: "images", id: image.id });
    setModal(null);
    setCurrent(0);
    setPlaying(false);
  };
  const setMusic = (mediaId) =>
    change((draft) => ({
      ...draft,
      music: mediaId
        ? {
            mediaId,
            volume: 0.35,
            startSec: 0,
            offsetSec: 0,
            speed: 1,
            loop: true,
            fadeIn: 0.5,
            fadeOut: 1,
          }
        : null,
    }));
  const remove = () => {
    change((draft) => ({
      ...draft,
      [selected.type]: draft[selected.type].filter(
        (item) => item.id !== selected.id,
      ),
    }));
    setSelected({ type: "clips", id: null });
  };
  const moveClip = (direction) =>
    change((draft) => {
      const index = draft.clips.findIndex((item) => item.id === selected.id);
      const target = index + direction;
      if (target < 0 || target >= draft.clips.length) return draft;
      [draft.clips[index], draft.clips[target]] = [
        draft.clips[target],
        draft.clips[index],
      ];
      return draft;
    });
  const split = () => {
    let offset = 0;
    const index = timeline.clips.findIndex((clip) => {
      const end = offset + (clip.outSec - clip.inSec) / clip.speed;
      if (current > offset + 0.05 && current < end - 0.05) return true;
      offset = end;
      return false;
    });
    if (index < 0)
      return notify("Đặt con trỏ ở bên trong clip để cắt.", "error");
    const clip = timeline.clips[index];
    const point = clip.inSec + (current - offset) * clip.speed;
    change((draft) => {
      draft.clips.splice(
        index,
        1,
        { ...clip, outSec: point },
        { ...clip, id: uid(), inSec: point },
      );
      return draft;
    });
  };
  const undo = (redo = false) => {
    const source = redo ? history.future : history.past;
    if (!source.length) return;
    const next = source.at(-1);
    setHistory(
      redo
        ? {
            past: [...history.past, timeline],
            future: history.future.slice(0, -1),
          }
        : {
            past: history.past.slice(0, -1),
            future: [...history.future, timeline],
          },
    );
    setTimeline(next);
    timelineRef.current = next;
    setSaved(false);
  };
  const setGlobal = (key, value) =>
    change((draft) => ({ ...draft, [key]: value }));
  return (
    <div className="editor-page">
      <div className="editor-heading">
        <div>
          <div className="eyebrow">VIDEO EDITOR</div>
          <h1>Dựng câu chuyện của bạn.</h1>
        </div>
        <div className="inline-actions">
          <span className="save-status">
            {saving ? "Đang lưu…" : saved ? "Đã lưu trên máy" : "Chưa lưu"}
          </span>
          <Button onClick={save} title="Lưu timeline">
            <Save size={16} />
          </Button>
          <Button
            variant="primary"
            disabled={!timeline.clips.length}
            onClick={() => {
              setPlaying(false);
              setModal("export");
            }}
          >
            <Download size={16} />
            Xuất video
          </Button>
        </div>
      </div>
      <div className="editor-workspace">
        <section className="editor-assets">
          <div className="editor-tabbar">
            <button
              className={tab === "media" ? "active" : ""}
              onClick={() => setTab("media")}
            >
              <Film size={16} />
              Media
            </button>
            <button
              className={tab === "audio" ? "active" : ""}
              onClick={() => setTab("audio")}
            >
              <Music2 size={16} />
              Nhạc
            </button>
          </div>
          <div className="asset-scroll">
            <Uploader compact projectId={project.id} notify={notify} />
            <div className="asset-grid">
              {assets
                .filter((item) =>
                  tab === "audio" ? item.hasAudio : item.kind !== "audio",
                )
                .map((media) => (
                  <button
                    key={media.id}
                    className="asset-item"
                    onClick={() =>
                      tab === "audio" ? setMusic(media.id) : addClip(media)
                    }
                    title={`Thêm ${media.name}`}
                  >
                    <MediaThumb media={media} />
                    <span className="asset-plus">
                      <Plus size={14} />
                    </span>
                    <strong>{media.name}</strong>
                    <small>{timecode(media.duration)}</small>
                  </button>
                ))}
            </div>
            {!assets.length && (
              <div className="quiet-empty">
                <Film size={25} />
                <p>Nhập media hoặc tạo video AI để bắt đầu.</p>
                <button
                  className="text-button"
                  onClick={() => navigate("create")}
                >
                  Tạo video AI <ArrowUpRight size={14} />
                </button>
              </div>
            )}
          </div>
        </section>
        <Preview
          timeline={timeline}
          media={data.media}
          current={current}
          setCurrent={setCurrent}
          playing={playing}
          setPlaying={setPlaying}
          onOverlay={patch}
        />
        <section className="inspector">
          <div className="panel-heading">
            <h3>
              {selection
                ? selected.type === "clips"
                  ? "Chỉnh sửa clip"
                  : selected.type === "texts"
                    ? "Chỉnh sửa chữ"
                    : "Chỉnh sửa logo"
                : "Khung hình & âm thanh"}
            </h3>
            {selection && (
              <button
                className="icon-button danger-text"
                onClick={remove}
                aria-label="Xóa phần tử đã chọn"
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
          <div className="inspector-scroll">
            {selection && selected.type === "clips" && (
              <>
                <p className="selection-name">{selectionMedia?.name}</p>
                <div className="form-grid">
                  <Numeric
                    label="Điểm đầu (s)"
                    value={selection.inSec}
                    max={selection.outSec - 0.05}
                    onChange={(value) =>
                      patch("clips", selection.id, {
                        inSec: Math.max(
                          0,
                          Math.min(value, selection.outSec - 0.05),
                        ),
                      })
                    }
                  />
                  <Numeric
                    label="Điểm cuối (s)"
                    value={selection.outSec}
                    min={selection.inSec + 0.05}
                    max={
                      selectionMedia?.kind === "image"
                        ? 600
                        : selectionMedia?.duration
                    }
                    onChange={(value) =>
                      patch("clips", selection.id, {
                        outSec: Math.max(
                          selection.inSec + 0.05,
                          Math.min(
                            value,
                            selectionMedia?.kind === "image"
                              ? 600
                              : selectionMedia?.duration,
                          ),
                        ),
                      })
                    }
                  />
                </div>
                <Field label="Tốc độ">
                  <select
                    value={selection.speed}
                    onChange={(event) =>
                      patch("clips", selection.id, {
                        speed: Number(event.target.value),
                      })
                    }
                  >
                    {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((value) => (
                      <option key={value} value={value}>
                        {value}×
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Cách đặt vào khung">
                  <select
                    value={selection.fit}
                    onChange={(event) =>
                      patch("clips", selection.id, { fit: event.target.value })
                    }
                  >
                    <option value="cover">Lấp đầy (cắt viền)</option>
                    <option value="contain">Vừa khung (giữ toàn ảnh)</option>
                  </select>
                </Field>
                <Field label={`Phóng to · ${selection.zoom.toFixed(2)}×`}>
                  <input
                    type="range"
                    min="1"
                    max="3"
                    step="0.01"
                    value={selection.zoom}
                    onChange={(event) =>
                      patch("clips", selection.id, {
                        zoom: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field
                  label={`Âm lượng clip · ${Math.round(selection.volume * 100)}%`}
                >
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.01"
                    value={selection.volume}
                    onChange={(event) =>
                      patch("clips", selection.id, {
                        volume: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <div className="inline-actions">
                  <Button
                    onClick={() => moveClip(-1)}
                    title="Đưa clip sang trái"
                  >
                    <ChevronLeft size={15} />
                  </Button>
                  <Button
                    onClick={() => moveClip(1)}
                    title="Đưa clip sang phải"
                  >
                    <ChevronRight size={15} />
                  </Button>
                  <Button
                    onClick={() =>
                      change((draft) => {
                        const index = draft.clips.findIndex(
                          (item) => item.id === selection.id,
                        );
                        draft.clips.splice(index + 1, 0, {
                          ...selection,
                          id: uid(),
                        });
                        return draft;
                      })
                    }
                  >
                    <Copy size={14} />
                    Nhân đôi
                  </Button>
                </div>
              </>
            )}
            {selection && ["texts", "images"].includes(selected.type) && (
              <>
                {selected.type === "texts" && (
                  <>
                    <Field label="Nội dung">
                      <textarea
                        rows="3"
                        value={selection.text}
                        onChange={(event) =>
                          patch("texts", selection.id, {
                            text: event.target.value,
                          })
                        }
                      />
                    </Field>
                    <div className="form-grid">
                      <Numeric
                        label="Cỡ chữ (px)"
                        min={12}
                        max={240}
                        step={1}
                        value={selection.size}
                        onChange={(size) =>
                          patch("texts", selection.id, { size })
                        }
                      />
                      <Field label="Màu chữ">
                        <input
                          type="color"
                          value={selection.color}
                          onChange={(event) =>
                            patch("texts", selection.id, {
                              color: event.target.value,
                            })
                          }
                        />
                      </Field>
                    </div>
                    <CheckField
                      checked={selection.background}
                      onChange={(background) =>
                        patch("texts", selection.id, { background })
                      }
                    >
                      Nền tối phía sau chữ
                    </CheckField>
                  </>
                )}
                {selected.type === "images" && (
                  <>
                    <Field
                      label={`Kích thước · ${Math.round(selection.scale * 100)}%`}
                    >
                      <input
                        type="range"
                        min="0.02"
                        max="1"
                        step="0.01"
                        value={selection.scale}
                        onChange={(event) =>
                          patch("images", selection.id, {
                            scale: Number(event.target.value),
                          })
                        }
                      />
                    </Field>
                    <Field
                      label={`Độ rõ · ${Math.round(selection.opacity * 100)}%`}
                    >
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={selection.opacity}
                        onChange={(event) =>
                          patch("images", selection.id, {
                            opacity: Number(event.target.value),
                          })
                        }
                      />
                    </Field>
                  </>
                )}
                <div className="form-grid">
                  <Numeric
                    label="Bắt đầu (s)"
                    value={selection.startSec}
                    max={selection.endSec - 0.05}
                    onChange={(startSec) =>
                      patch(selected.type, selection.id, {
                        startSec: Math.max(
                          0,
                          Math.min(startSec, selection.endSec - 0.05),
                        ),
                      })
                    }
                  />
                  <Numeric
                    label="Kết thúc (s)"
                    value={selection.endSec}
                    max={duration}
                    min={selection.startSec + 0.05}
                    onChange={(endSec) =>
                      patch(selected.type, selection.id, {
                        endSec: Math.min(
                          duration,
                          Math.max(selection.startSec + 0.05, endSec),
                        ),
                      })
                    }
                  />
                </div>
                <div className="form-grid">
                  <Numeric
                    label="Vị trí X (%)"
                    value={selection.x * 100}
                    max={100}
                    step={1}
                    onChange={(value) =>
                      patch(selected.type, selection.id, {
                        x: Math.max(0, Math.min(1, value / 100)),
                      })
                    }
                  />
                  <Numeric
                    label="Vị trí Y (%)"
                    value={selection.y * 100}
                    max={100}
                    step={1}
                    onChange={(value) =>
                      patch(selected.type, selection.id, {
                        y: Math.max(0, Math.min(1, value / 100)),
                      })
                    }
                  />
                </div>
                <p className="muted small">
                  Kéo trực tiếp chữ hoặc logo trong khung xem trước để đặt vị
                  trí.
                </p>
              </>
            )}
            <div className="inspector-divider" />
            <Field label="Tỷ lệ video">
              <select
                value={timeline.ratio}
                onChange={(event) => setGlobal("ratio", event.target.value)}
              >
                <option>9:16</option>
                <option>16:9</option>
                <option>1:1</option>
              </select>
            </Field>
            <Field label="Âm thanh gốc">
              <select
                value={timeline.originalAudio}
                onChange={(event) =>
                  setGlobal("originalAudio", event.target.value)
                }
              >
                <option value="keep">Giữ âm thanh</option>
                <option value="lower">Giảm còn 25%</option>
                <option value="boost">Tăng lên 150%</option>
                <option value="mute">Tắt âm thanh gốc</option>
              </select>
            </Field>
            <div className="inspector-divider" />
            <h4>
              <Music2 size={15} />
              Nhạc nền
            </h4>
            <Field label="Chọn nhạc">
              <select
                value={timeline.music?.mediaId || ""}
                onChange={(event) => setMusic(event.target.value)}
              >
                <option value="">Không có nhạc nền</option>
                {assets
                  .filter((item) => item.hasAudio)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </Field>
            {timeline.music && (
              <>
                <Field
                  label={`Âm lượng nhạc · ${Math.round(timeline.music.volume * 100)}%`}
                >
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.01"
                    value={timeline.music.volume}
                    onChange={(event) =>
                      change((draft) => ({
                        ...draft,
                        music: {
                          ...draft.music,
                          volume: Number(event.target.value),
                        },
                      }))
                    }
                  />
                </Field>
                <div className="form-grid">
                  {[
                    ["startSec", "Vào từ (s)", 0, duration],
                    [
                      "offsetSec",
                      "Cắt nhạc từ (s)",
                      0,
                      assets.find((item) => item.id === timeline.music.mediaId)
                        ?.duration,
                    ],
                    ["fadeIn", "Fade in (s)", 0, 30],
                    ["fadeOut", "Fade out (s)", 0, 30],
                    ["speed", "Tốc độ nhạc", 0.5, 2],
                  ].map(([key, label, min, max]) => (
                    <Numeric
                      key={key}
                      label={label}
                      value={timeline.music[key]}
                      min={min}
                      max={max}
                      onChange={(value) =>
                        change((draft) => ({
                          ...draft,
                          music: {
                            ...draft.music,
                            [key]: Math.max(min, Math.min(value, max)),
                          },
                        }))
                      }
                    />
                  ))}
                </div>
                <CheckField
                  checked={timeline.music.loop}
                  onChange={(loop) =>
                    change((draft) => ({
                      ...draft,
                      music: { ...draft.music, loop },
                    }))
                  }
                >
                  Lặp nhạc đến hết video
                </CheckField>
              </>
            )}
          </div>
        </section>
      </div>
      <section className="timeline-panel">
        <div className="timeline-toolbar">
          <div className="inline-actions">
            <button
              className="icon-button"
              aria-label="Hoàn tác"
              disabled={!history.past.length}
              onClick={() => undo()}
            >
              <Undo2 size={16} />
            </button>
            <button
              className="icon-button"
              aria-label="Làm lại"
              disabled={!history.future.length}
              onClick={() => undo(true)}
            >
              <Redo2 size={16} />
            </button>
            <span className="toolbar-separator" />
            <Button disabled={!duration} onClick={split}>
              <Scissors size={15} />
              Cắt tại con trỏ
            </Button>
            <Button disabled={!duration} onClick={addText}>
              <Type size={15} />
              Thêm chữ
            </Button>
            <Button disabled={!duration} onClick={() => setModal("logo")}>
              <Image size={15} />
              Thêm logo
            </Button>
          </div>
          <span className="muted small">
            {timeline.clips.length} clip · {timecode(duration)}
          </span>
        </div>
        <div className="timeline-scroll">
          <div className="timeline-ruler">
            <span>00:00</span>
            {Array.from({ length: 5 }, (_, index) => (
              <span key={index}>{timecode((duration * (index + 1)) / 5)}</span>
            ))}
          </div>
          <div className="timeline-body">
            <div
              className="timeline-playhead"
              style={{ left: `${duration ? (current / duration) * 100 : 0}%` }}
            />
            <div className="clip-track">
              {timeline.clips.map((clip, index) => {
                const media = data.media.find(
                  (item) => item.id === clip.mediaId,
                );
                const length = (clip.outSec - clip.inSec) / clip.speed;
                const start = timeline.clips
                  .slice(0, index)
                  .reduce(
                    (total, item) =>
                      total + (item.outSec - item.inSec) / item.speed,
                    0,
                  );
                return (
                  <button
                    key={clip.id}
                    className={`timeline-clip ${selected.id === clip.id ? "selected" : ""}`}
                    style={{
                      flexBasis: `${(length / (duration || 1)) * 100}%`,
                    }}
                    onClick={() => {
                      setSelected({ type: "clips", id: clip.id });
                      setCurrent(start);
                      setPlaying(false);
                    }}
                    draggable
                    onDragStart={(event) =>
                      event.dataTransfer.setData("text/plain", clip.id)
                    }
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const id = event.dataTransfer.getData("text/plain");
                      const sourceIndex = timeline.clips.findIndex(
                        (item) => item.id === id,
                      );
                      if (sourceIndex < 0 || sourceIndex === index) return;
                      change((draft) => {
                        const [moving] = draft.clips.splice(sourceIndex, 1);
                        draft.clips.splice(index, 0, moving);
                        return draft;
                      });
                    }}
                  >
                    {media && <MediaThumb media={media} />}
                    <span>{media?.name || "Tệp không còn tồn tại"}</span>
                    <small>
                      {length.toFixed(1)}s · {clip.speed}×
                    </small>
                  </button>
                );
              })}
              {!timeline.clips.length && (
                <div className="timeline-empty">
                  <Plus size={17} />
                  Chọn media bên trái để thêm vào timeline
                </div>
              )}
            </div>
            {["texts", "images"].map((type) => (
              <div className={`overlay-track ${type}`} key={type}>
                <span className="track-label">
                  {type === "texts" ? <Type size={13} /> : <Image size={13} />}
                </span>
                {timeline[type].map((overlay) => (
                  <button
                    key={overlay.id}
                    className={selected.id === overlay.id ? "selected" : ""}
                    style={{
                      left: `${(overlay.startSec / duration) * 100}%`,
                      width: `${((overlay.endSec - overlay.startSec) / duration) * 100}%`,
                    }}
                    onClick={() => {
                      setSelected({ type, id: overlay.id });
                      setCurrent(overlay.startSec);
                      setPlaying(false);
                    }}
                  >
                    {type === "texts" ? overlay.text : "Logo"}
                  </button>
                ))}
              </div>
            ))}
            <div className="overlay-track music">
              <span className="track-label">
                <Volume2 size={13} />
              </span>
              {timeline.music && (
                <button
                  style={{
                    left: `${(timeline.music.startSec / duration) * 100}%`,
                    width: `${((duration - timeline.music.startSec) / duration) * 100}%`,
                  }}
                  onClick={() => setSelected({ type: "clips", id: null })}
                >
                  <Music2 size={13} />
                  {
                    assets.find((item) => item.id === timeline.music.mediaId)
                      ?.name
                  }
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
      {modal === "logo" && (
        <Modal
          title="Chọn ảnh làm logo / lớp phủ"
          onClose={() => setModal(null)}
        >
          <Uploader compact projectId={project.id} notify={notify} />
          <div className="asset-grid">
            {assets
              .filter((item) => item.kind === "image")
              .map((media) => (
                <button
                  className="asset-item"
                  key={media.id}
                  onClick={() => addLogo(media)}
                >
                  <MediaThumb media={media} />
                  <strong>{media.name}</strong>
                </button>
              ))}
          </div>
        </Modal>
      )}
      {modal === "export" && (
        <Modal title="Xuất video" onClose={() => setModal(null)}>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setExporting(true);
              if (await save()) {
                const result = await run(() =>
                  api("/jobs/render", {
                    projectId: project.id,
                    name,
                    timeline,
                  }),
                );
                if (result) {
                  notify("Đã thêm tác vụ xuất video.");
                  setModal(null);
                  navigate("queue");
                }
              }
              setExporting(false);
            }}
          >
            <Field label="Tên file">
              <input
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <div className="form-grid">
              <Field label="Độ phân giải">
                <select
                  value={timeline.resolution}
                  onChange={(event) =>
                    setGlobal("resolution", Number(event.target.value))
                  }
                >
                  <option value="480">480p · Bản nháp</option>
                  <option value="720">720p · HD</option>
                  <option value="1080">1080p · Full HD</option>
                </select>
              </Field>
              <Field label="Khung hình / giây">
                <select
                  value={timeline.fps}
                  onChange={(event) =>
                    setGlobal("fps", Number(event.target.value))
                  }
                >
                  {[24, 25, 30, 60].map((value) => (
                    <option key={value} value={value}>
                      {value} fps
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Chất lượng">
              <select
                value={timeline.quality}
                onChange={(event) => setGlobal("quality", event.target.value)}
              >
                <option value="draft">Nháp · File nhỏ</option>
                <option value="standard">Tiêu chuẩn</option>
                <option value="high">Cao · File lớn hơn</option>
              </select>
            </Field>
            <Notice>
              {timeline.clips.length} clip · {timecode(duration)} ·{" "}
              {timeline.ratio}
              <br />
              MP4 (H.264 / AAC). Bản xuất được lưu vào thư viện sau khi kiểm
              tra.
            </Notice>
            <div className="modal-actions">
              <Button type="button" onClick={() => setModal(null)}>
                Hủy
              </Button>
              <Button variant="primary" busy={exporting}>
                <Download size={16} />
                Bắt đầu xuất
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
