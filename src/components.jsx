import {
  X,
  LoaderCircle,
  Film,
  Music2,
  Image,
  UploadCloud,
  Check,
  AlertCircle,
} from "lucide-react";
import { statusLabels } from "../shared/contracts.js";
import { useState, useId, cloneElement, isValidElement } from "react";
import { uploadFiles } from "./api.js";

export function Button({
  children,
  busy,
  variant = "",
  className = "",
  ...props
}) {
  return (
    <button
      {...props}
      disabled={busy || props.disabled}
      className={`button ${variant} ${className}`}
    >
      {busy && <LoaderCircle size={16} className="busy-icon" />}
      {children}
    </button>
  );
}

export function Field({ label, children, hint }) {
  const generated = useId();
  const id = children?.props?.id || generated;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id,
        "aria-labelledby": `${generated}-label`,
        "aria-describedby": hint ? `${generated}-hint` : undefined,
      })
    : children;
  return (
    <div className="field">
      <label id={`${generated}-label`} htmlFor={id}>
        {label}
      </label>
      {control}
      {hint && <small id={`${generated}-hint`}>{hint}</small>}
    </div>
  );
}

export function Badge({ status }) {
  return (
    <span className={`badge ${status}`}>
      <i />
      {statusLabels[status] || status}
    </span>
  );
}

export function Modal({ title, onClose, children, wide = false }) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Đóng">
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function Empty({ icon: Icon = Film, title, children, action }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={32} strokeWidth={1.4} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function MediaThumb({ media }) {
  if (media.thumbnailUrl)
    return <img src={media.thumbnailUrl} alt="" loading="lazy" />;
  return (
    <div className="media-placeholder">
      {media.kind === "audio" ? (
        <Music2 />
      ) : media.kind === "image" ? (
        <Image />
      ) : (
        <Film />
      )}
    </div>
  );
}

export function Uploader({ projectId, notify, onDone, compact = false }) {
  const [busy, setBusy] = useState(false);
  const upload = async (files) => {
    if (!files?.length || busy) return;
    setBusy(true);
    try {
      const result = await uploadFiles(files, projectId);
      notify(`Đã nhập ${result.length} tệp vào thư viện.`);
      onDone?.(result);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <label
      className={`upload-zone ${compact ? "compact" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        upload(event.dataTransfer.files);
      }}
    >
      {busy ? <LoaderCircle size={22} /> : <UploadCloud size={22} />}
      <strong>
        {busy
          ? "Đang đọc và nhập tệp…"
          : compact
            ? "Nhập media"
            : "Kéo tệp vào đây hoặc bấm để chọn"}
      </strong>
      {!compact && <small>Video, ảnh và âm thanh · Tối đa 2 GB/tệp</small>}
      <input
        type="file"
        multiple
        accept="video/*,image/*,audio/*,.mkv"
        disabled={busy}
        onChange={(event) => {
          upload(event.target.files);
          event.target.value = "";
        }}
      />
    </label>
  );
}

export function Notice({ children, error = false }) {
  return (
    <div className={`notice ${error ? "error" : ""}`}>
      <AlertCircle size={17} />
      <div>{children}</div>
    </div>
  );
}

export function CheckField({ children, checked, onChange }) {
  return (
    <label className="check-field">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="checkbox">{checked && <Check size={12} />}</span>
      {children}
    </label>
  );
}
