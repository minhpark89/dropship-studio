import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Play,
  Pause,
  SkipBack,
  Volume2,
  VolumeX,
  Maximize2,
} from "lucide-react";
import { durationOf, dimensions } from "../../shared/contracts.js";
import { timecode } from "../api.js";

export function Preview({
  timeline,
  media,
  current,
  setCurrent,
  playing,
  setPlaying,
  onOverlay,
}) {
  const [muted, setMuted] = useState(true);
  const [width, setWidth] = useState(270);
  const viewport = useRef(null);
  const video = useRef(null);
  const music = useRef(null);
  const clock = useRef(current);
  const duration = durationOf(timeline);
  const canvas = dimensions(timeline);
  clock.current = current;
  let offset = 0;
  let selected = null;
  for (let index = 0; index < timeline.clips.length; index += 1) {
    const clip = timeline.clips[index];
    const length = (clip.outSec - clip.inSec) / clip.speed;
    if (current < offset + length || index === timeline.clips.length - 1) {
      selected = {
        clip,
        offset,
        media: media.find((item) => item.id === clip.mediaId),
      };
      break;
    }
    offset += length;
  }
  useLayoutEffect(() => {
    const element = viewport.current;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    if (element) observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!playing || duration <= 0) return;
    let last = performance.now();
    let frame;
    const tick = (now) => {
      const next = Math.min(
        duration,
        clock.current + Math.min((now - last) / 1000, 0.1),
      );
      last = now;
      clock.current = next;
      setCurrent(next);
      if (next >= duration) setPlaying(false);
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration, setCurrent, setPlaying]);
  const synchronize = () => {
    const element = video.current;
    if (!element || !selected) return;
    const target = Math.min(
      selected.clip.outSec - 0.03,
      selected.clip.inSec +
        Math.max(0, current - selected.offset) * selected.clip.speed,
    );
    if (
      Number.isFinite(target) &&
      Math.abs(element.currentTime - target) > (playing ? 0.18 : 0.015)
    )
      element.currentTime = Math.max(0, target);
    element.playbackRate = selected.clip.speed;
    element.muted = muted || timeline.originalAudio === "mute";
    element.volume = Math.min(
      1,
      selected.clip.volume *
        { keep: 1, lower: 0.25, boost: 1.5, mute: 0 }[timeline.originalAudio],
    );
    if (playing) element.play().catch(() => {});
    else element.pause();
  };
  useEffect(synchronize, [
    current,
    playing,
    muted,
    selected?.clip.id,
    timeline,
  ]);
  const musicMedia = media.find((item) => item.id === timeline.music?.mediaId);
  useEffect(() => {
    const element = music.current;
    const track = timeline.music;
    if (!element || !track || !musicMedia) return;
    const elapsed = Math.max(0, current - track.startSec);
    const available = musicMedia.duration - track.offsetSec;
    const logical = elapsed * track.speed;
    const position =
      track.offsetSec +
      (track.loop ? logical % available : Math.min(logical, available));
    if (Math.abs(element.currentTime - position) > 0.2)
      element.currentTime = position;
    const fadeIn = track.fadeIn > 0 ? Math.min(1, elapsed / track.fadeIn) : 1;
    const fadeOut =
      track.fadeOut > 0
        ? Math.min(1, Math.max(0, duration - current) / track.fadeOut)
        : 1;
    element.volume = Math.min(1, track.volume * fadeIn * fadeOut);
    element.playbackRate = track.speed;
    element.muted = muted;
    if (
      playing &&
      current >= track.startSec &&
      (track.loop || logical < available)
    )
      element.play().catch(() => {});
    else element.pause();
  }, [current, timeline.music, musicMedia, muted, playing, duration]);
  const beginDrag = (event, type, overlay) => {
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const rect = viewport.current.getBoundingClientRect();
    const move = (pointer) => {
      onOverlay(type, overlay.id, {
        x: Math.max(0, Math.min(1, (pointer.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (pointer.clientY - rect.top) / rect.height)),
      });
    };
    const finish = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", finish);
      element.removeEventListener("pointercancel", finish);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", finish);
    element.addEventListener("pointercancel", finish);
  };
  return (
    <div className="preview-section">
      <div className="preview-toolbar">
        <span>XEM TRƯỚC</span>
        <span>
          {canvas.width} × {canvas.height}
          <i>·</i>
          {timeline.fps} fps
        </span>
        <button
          className="icon-button"
          title="Toàn màn hình"
          onClick={() => viewport.current.requestFullscreen?.()}
        >
          <Maximize2 size={15} />
        </button>
      </div>
      <div className="preview-stage">
        <div
          className="preview-frame"
          ref={viewport}
          style={{
            aspectRatio: `${canvas.width} / ${canvas.height}`,
            "--aspect": canvas.width / canvas.height,
          }}
        >
          {selected?.media &&
            (selected.media.kind === "image" ? (
              <img
                className="preview-source"
                src={selected.media.url}
                alt=""
                style={{
                  objectFit: selected.clip.fit,
                  transform: `scale(${selected.clip.zoom})`,
                }}
              />
            ) : (
              <video
                ref={video}
                key={selected.clip.id}
                className="preview-source"
                src={selected.media.url}
                playsInline
                preload="auto"
                muted={muted}
                onLoadedMetadata={synchronize}
                style={{
                  objectFit: selected.clip.fit,
                  transform: `scale(${selected.clip.zoom})`,
                }}
              />
            ))}
          {!selected && (
            <div className="preview-empty">
              <Play size={30} strokeWidth={1} />
              <p>Thêm clip để bắt đầu</p>
              <small>{timeline.ratio}</small>
            </div>
          )}
          {timeline.images
            .filter((item) => current >= item.startSec && current < item.endSec)
            .map((item) => {
              const source = media.find((entry) => entry.id === item.mediaId);
              return (
                source && (
                  <img
                    key={item.id}
                    src={source.url}
                    alt="Logo"
                    className="preview-overlay image"
                    onPointerDown={(event) => beginDrag(event, "images", item)}
                    style={{
                      left: `${item.x * 100}%`,
                      top: `${item.y * 100}%`,
                      width: `${item.scale * 100}%`,
                      opacity: item.opacity,
                    }}
                  />
                )
              );
            })}
          {timeline.texts
            .filter((item) => current >= item.startSec && current < item.endSec)
            .map((item) => (
              <div
                key={item.id}
                className={`preview-overlay text ${item.background ? "with-bg" : ""}`}
                onPointerDown={(event) => beginDrag(event, "texts", item)}
                style={{
                  left: `${item.x * 100}%`,
                  top: `${item.y * 100}%`,
                  fontSize: (item.size * width) / canvas.width,
                  color: item.color,
                }}
              >
                {item.text}
              </div>
            ))}
        </div>
      </div>
      <div className="playback">
        <button
          className="icon-button"
          aria-label="Về đầu"
          onClick={() => setCurrent(0)}
        >
          <SkipBack size={16} />
        </button>
        <button
          className="play-button"
          aria-label={playing ? "Tạm dừng xem trước" : "Phát xem trước"}
          disabled={!duration}
          onClick={() => {
            if (current >= duration) setCurrent(0);
            setPlaying(!playing);
          }}
        >
          {playing ? <Pause size={17} /> : <Play size={17} />}
        </button>
        <span className="timecode" data-testid="playback-time">
          {timecode(current)} <i>/ {timecode(duration)}</i>
        </span>
        <input
          type="range"
          aria-label="Vị trí phát"
          min="0"
          max={duration || 1}
          step="0.01"
          value={Math.min(current, duration)}
          onChange={(event) => setCurrent(Number(event.target.value))}
        />
        <button
          className="icon-button"
          aria-label={
            muted ? "Bật âm thanh xem trước" : "Tắt âm thanh xem trước"
          }
          onClick={() => setMuted(!muted)}
        >
          {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </button>
      </div>
      {musicMedia && <audio ref={music} src={musicMedia.url} preload="auto" />}
    </div>
  );
}
