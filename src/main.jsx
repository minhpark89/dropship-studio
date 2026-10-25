import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Sparkles,
  Clapperboard,
  Users,
  Library,
  Scissors,
  ListVideo,
  Settings2,
  Newspaper,
  Search,
  Plus,
  ChevronDown,
  ArrowUpRight,
  X,
  CircleCheck,
  CircleAlert,
  PanelLeftClose,
} from "lucide-react";
import { api } from "./api.js";
import { Button, Modal, Field, Notice } from "./components.jsx";
import { CreatePage, StoryboardPage } from "./pages/Create.jsx";
import { AccountsPage } from "./pages/Accounts.jsx";
import { LibraryPage } from "./pages/Library.jsx";
import { EditorPage } from "./pages/Editor.jsx";
import { QueuePage, SettingsPage } from "./pages/Manage.jsx";
import { SocialPage } from "./pages/Social.jsx";
import { ResearchPage } from "./pages/Research.jsx";
import "./style.css";

const APP_VERSION = "0.1.2";

const tabs = [
  ["research", "Research & LLM", Search],
  ["create", "Tạo bằng AI", Sparkles],
  ["storyboard", "Kịch bản", Clapperboard],
  ["accounts", "Tài khoản", Users],
  ["library", "Thư viện", Library],
  ["editor", "Dựng video", Scissors],
  ["queue", "Hàng đợi", ListVideo],
  ["settings", "Cài đặt", Settings2],
  ["social", "Page & bài đăng", Newspaper],
];
const pages = {
  research: ResearchPage,
  create: CreatePage,
  storyboard: StoryboardPage,
  accounts: AccountsPage,
  library: LibraryPage,
  editor: EditorPage,
  queue: QueuePage,
  settings: SettingsPage,
  social: SocialPage,
};

function App() {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(
    localStorage.getItem("studio-project") || "",
  );
  const [tab, setTab] = useState("create");
  const [toast, setToast] = useState(null);
  const [connection, setConnection] = useState(true);
  const [projectModal, setProjectModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [sidebar, setSidebar] = useState(true);
  const notify = useCallback(
    (message, type = "success") => setToast({ message, type, id: Date.now() }),
    [],
  );
  const run = useCallback(
    async (operation, success) => {
      try {
        const value = await operation();
        if (success) notify(success);
        return value;
      } catch (error) {
        notify(error.message, "error");
        return null;
      }
    },
    [notify],
  );
  useEffect(() => {
    api("/state")
      .then(setData)
      .catch((error) => notify(error.message, "error"));
    const events = new EventSource("/api/events");
    events.onmessage = (event) => {
      setData((previous) => ({ ...previous, ...JSON.parse(event.data) }));
      setConnection(true);
    };
    events.onerror = () => setConnection(false);
    return () => events.close();
  }, [notify]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(
      () => setToast(null),
      toast.type === "error" ? 12000 : 5000,
    );
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    localStorage.setItem("studio-project", selected);
  }, [selected]);
  const project =
    data?.projects.find((item) => item.id === selected) || data?.projects[0];
  const pending =
    data?.jobs.filter((job) =>
      [
        "queued",
        "scheduled",
        "preparing",
        "submitting",
        "rendering",
        "downloading",
      ].includes(job.status),
    ).length || 0;
  const Page = pages[tab];
  const navigate = async (destination) => {
    const state = await run(() => api("/state"));
    if (state) setData(state);
    setTab(destination);
  };
  return (
    <div className={`app ${sidebar ? "" : "collapsed"}`}>
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            navigate("create");
          }}
        >
          <span className="brand-mark"><img src="/icon.png" alt="" /></span>
          <div>
            Dropship<span>STUDIO</span>
          </div>
        </a>
        <div className="sidebar-label">KHÔNG GIAN SÁNG TẠO</div>
        <nav>
          {tabs.map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => navigate(id)}
              className={tab === id ? "active" : ""}
              title={label}
            >
              <Icon size={19} />
              <span>{label}</span>
              {id === "queue" && pending > 0 && <b>{pending}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-indicator">
            <i />
            Lưu trên máy của bạn
          </div>
          <p>Dola · Google Flow · DreamFace · FFmpeg</p>
          <small>
            Dropship Studio <span>v{APP_VERSION}</span>
          </small>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button"
              aria-label="Thu gọn menu"
              onClick={() => setSidebar(!sidebar)}
            >
              <PanelLeftClose size={18} />
            </button>
            <span className="breadcrumb">
              Workspace <span>/</span>
            </span>
            <div className="project-select">
              <select
                aria-label="Dự án hiện tại"
                value={project?.id || ""}
                onChange={(event) => setSelected(event.target.value)}
              >
                {data?.projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </div>
            <button
              className="icon-button"
              aria-label="Tạo dự án"
              onClick={() => setProjectModal(true)}
            >
              <Plus size={17} />
            </button>
          </div>
          <div className="topbar-right">
            <span className="local-pill">
              <i />
              {connection ? "Local workspace" : "Mất kết nối"}
            </span>
            <button
              className="avatar"
              onClick={() => navigate("accounts")}
              aria-label="Quản lý tài khoản"
            >
              DS
            </button>
          </div>
        </header>
        <main>
          {!connection && (
            <Notice error>
              Đã mất kết nối với ứng dụng. Đang thử kết nối lại; thay đổi chưa
              gửi sẽ chưa được lưu.
            </Notice>
          )}
          {data && project ? (
            <Page
              key={`${project.id}:${tab}`}
              data={data}
              project={project}
              notify={notify}
              run={run}
              navigate={navigate}
            />
          ) : (
            <div className="loading-screen">
              <span className="brand-mark"><img src="/icon.png" alt="" /></span>
              <p>Đang mở không gian làm việc…</p>
            </div>
          )}
        </main>
      </div>
      {toast && (
        <div className={`toast ${toast.type}`} role="status">
          {toast.type === "error" ? (
            <CircleAlert size={20} />
          ) : (
            <CircleCheck size={20} />
          )}
          <span>{toast.message}</span>
          <button
            className="icon-button"
            aria-label="Đóng thông báo"
            onClick={() => setToast(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {projectModal && (
        <Modal title="Tạo dự án mới" onClose={() => setProjectModal(false)}>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const result = await run(() =>
                api("/projects", { name: newName }),
              );
              if (result) {
                setData((previous) => ({
                  ...previous,
                  projects: previous.projects.some(
                    (item) => item.id === result.id,
                  )
                    ? previous.projects
                    : [...previous.projects, result],
                }));
                setSelected(result.id);
                setProjectModal(false);
                setNewName("");
                notify("Đã tạo dự án mới.");
              }
            }}
          >
            <Field label="Tên dự án">
              <input
                autoFocus
                required
                value={newName}
                maxLength={120}
                placeholder="Ví dụ: Bộ sưu tập mùa hè"
                onChange={(event) => setNewName(event.target.value)}
              />
            </Field>
            <div className="modal-actions">
              <Button type="button" onClick={() => setProjectModal(false)}>
                Hủy
              </Button>
              <Button variant="primary">
                Tạo dự án <ArrowUpRight size={16} />
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
