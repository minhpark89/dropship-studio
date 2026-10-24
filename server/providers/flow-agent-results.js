import { StudioError } from "../store.js";

const hosts = new Set(["flow.google.com", "labs.google", "aisandbox-pa.googleapis.com"]);
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function endpoint(requestOrResponse) {
  try {
    const url = new URL(requestOrResponse.url());
    if (url.protocol !== "https:" || !hosts.has(url.hostname)) return null;
    if (/\/data\/batchexecute$/.test(url.pathname)) return "rpc";
    if (/\/FlowCreationAgentService\/StreamChat$/.test(url.pathname)) return "agent";
  } catch {}
  return null;
}

function urls(text) {
  const result = [];
  for (const value of text.match(/https:\/\/[^\s"'<>\\]+/g) || []) {
    try {
      const url = new URL(value.replace(/\\u003d/g, "="));
      if (url.hostname === "flow-content.google" || url.hostname.endsWith(".flow-content.google")) result.push(url.href);
    } catch {}
  }
  return [...new Set(result)];
}

function ids(text, projectId) {
  return [...new Set((text.match(uuid) || []).filter((value) => value !== projectId))];
}

/**
 * Correlates the current Flow creative-agent protocol. The agent uses a
 * positional batchexecute envelope rather than a named REST operation: the
 * exact prompt response establishes the conversation/creative IDs, and a
 * later content URL is accepted only when that response references one of
 * those IDs. DOM URLs and unrelated project media are ignored.
 */
export function createFlowAgentResultTracker({ prompt, projectId = "", onAccepted = () => {} }) {
  if (typeof prompt !== "string" || !prompt) throw new TypeError("A prompt is required.");
  const contextIds = new Set();
  const candidates = new Set();
  const observed = new WeakSet();
  let armed = false;
  let promptSeen = false;
  let approvalSeen = false;
  let accepted = false;
  let failure = null;
  let serial = Promise.resolve();

  const notify = async () => {
    if (accepted || !contextIds.size) return;
    accepted = true;
    await onAccepted({ providerMediaIds: [], providerOperationIds: [...contextIds] });
  };
  const tracker = {
    arm() {
      if (armed) throw new Error("Flow agent result tracker cannot be rearmed.");
      armed = true;
    },
    observeRequest(request) {
      if (!armed || !endpoint(request)) return;
      const body = request.postData() || "";
      if (body.includes(prompt)) promptSeen = true;
      if (/PERMISSION_ACTION_APPROVED|\[\s*["']Approve["']\s*\]/.test(body)) approvalSeen = true;
    },
    observeResponse(response) {
      serial = serial.then(async () => {
        if (!armed || failure || observed.has(response)) return;
        observed.add(response);
        const kind = endpoint(response);
        if (!kind) return;
        const text = await response.text();
        if (response.status() >= 400) {
          failure = new StudioError("Flow từ chối hoặc mất kết nối khi theo dõi kết quả.", "PROVIDER_REJECTED");
          return;
        }
        if (text.includes(prompt)) {
          promptSeen = true;
          for (const id of ids(text, projectId)) contextIds.add(id);
        }
        if (/PERMISSION_ACTION_APPROVED/.test(text)) approvalSeen = true;
        const related = contextIds.size && [...contextIds].some((id) => text.includes(id));
        if (approvalSeen && (related || text.includes(prompt))) {
          for (const url of urls(text)) candidates.add(url);
          if (candidates.size) await notify();
        }
        if (approvalSeen && /generation failed|unable to generate|quota exceeded/i.test(text)) {
          failure = new StudioError("Flow báo tạo video thất bại. Kiểm tra tác vụ trên website trước khi thử lại.", "PROVIDER_REJECTED");
        }
      }).catch(() => {
        failure = new StudioError("Không đọc được bằng chứng kết quả Flow; không tự gửi lại.", "PROVIDER_RESULT_UNRECOGNIZED");
      });
      return serial;
    },
    takeCandidates() {
      const result = [...candidates];
      candidates.clear();
      return result;
    },
    get error() {
      if (!promptSeen && approvalSeen) return new StudioError("Flow đã nhận bước tạo nhưng chưa nhận diện được prompt tương ứng; không tự gửi lại.", "PROVIDER_RESULT_UNRECOGNIZED");
      return failure;
    },
  };
  return tracker;
}
