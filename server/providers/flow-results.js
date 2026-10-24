import { StudioError } from "../store.js";
import { decodeFlowRpc, flowResponseError } from "./flow-rpc.js";

// Passive, conservative correlation. Named JSON envelopes are supported; opaque
// positional RPC payloads require a separately verified schema before use.
const serviceHosts = new Set(["flow.google.com", "labs.google", "aisandbox-pa.googleapis.com"]);
const envelopes = new Set(["result", "results", "response", "data", "output", "outputs"]);
const mediaFields = new Set(["media", "generatedVideos", "generatedImages", "videos", "images"]);
const idFields = ["mediaId", "media_id", "outputId", "generationId"];

function json(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) &&
    !value.includes("://") ? value : null;
}

function https(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function transport(request) {
  try {
    const url = new URL(request.url());
    if (url.protocol !== "https:" || !serviceHosts.has(url.hostname)) return null;
    if (/\/data\/batchexecute$/.test(url.pathname) && ["flow.google.com", "labs.google"].includes(url.hostname)) {
      return { type: "rpc", url };
    }
    const method = url.pathname.split("/").at(-1);
    if (/^(?:(?:video|image|images|media):)?(?:batch)?(?:async)?(?:generate|create)(?:videos?|images?)(?:text|startimage|startandendimage|referenceimages?)?$/i.test(method)) {
      return { type: "submit", url };
    }
    if (/^(?:(?:video|image|media):)?(?:batch)?(?:check(?:async)?(?:video|image)?(?:generation)?status|getMedia|batchGet)$/i.test(method) || /\/operations\//.test(url.pathname)) {
      return { type: "poll", url };
    }
  } catch {}
  return null;
}

function rpcCalls(body) {
  const result = [];
  const encoded = new URLSearchParams(body || "").get("f.req");
  const document = json(encoded);
  const visit = (value, depth = 0) => {
    if (!Array.isArray(value) || depth > 8) return;
    if (typeof value[0] === "string" && typeof value[1] === "string") {
      const payload = json(value[1]);
      if (payload && typeof payload === "object") result.push({ rpcId: value[0], payload });
      return;
    }
    for (const item of value) visit(item, depth + 1);
  };
  visit(document);
  return result;
}

function promptMatches(value, prompt, depth = 0) {
  if (!value || typeof value !== "object" || depth > 16) return false;
  if (Array.isArray(value)) return value.some((item) => promptMatches(item, prompt, depth + 1));
  // Exact equality, never substring matching on encoded request bodies.
  if (value.prompt === prompt || value.textPrompt === prompt) return true;
  if (Array.isArray(value.parts) && value.parts.some((part) => part?.text === prompt)) return true;
  return ["requests", "generationRequests", "request", "textInput", "input", "contents"]
    .some((key) => promptMatches(value[key], prompt, depth + 1));
}

function rpcAction(payload, expected) {
  if (!payload || Array.isArray(payload)) return false;
  const action = payload.action || payload.method || payload.requestType;
  return typeof action === "string" && expected.test(action);
}

function referencesId(value, ids, depth = 0) {
  if (depth > 20 || value == null) return false;
  if (typeof value === "string") return ids.has(value);
  if (Array.isArray(value)) return value.some((item) => referencesId(item, ids, depth + 1));
  if (typeof value === "object") return Object.values(value).some((item) => referencesId(item, ids, depth + 1));
  return false;
}

function outputRecords(value, kind) {
  const records = [];
  const walk = (node, scope = {}, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 20) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, scope, depth + 1);
      return;
    }
    const ownOperation = identifier(node.operationId) || identifier(node.operation?.name) ||
      (scope.role === "operation" ? identifier(node.name) || identifier(node.id) : null) ||
      (typeof node.name === "string" && /^operations\//.test(node.name) ? identifier(node.name) : null);
    const operationId = ownOperation || scope.operationId || null;
    const ownMedia = idFields.map((key) => identifier(node[key])).find(Boolean) ||
      (scope.role === "media" ? identifier(node.id) || identifier(node.name) : null);
    const mediaId = ownMedia || scope.mediaId || null;
    const urls = [];
    if (scope.content === kind) {
      for (const field of ["url", "uri", "fifeUrl", "downloadUrl", "download_url"]) {
        const url = https(node[field]);
        if (url) urls.push(url);
      }
    }
    for (const field of kind === "video" ? ["videoUrl", "video_url"] : ["imageUrl", "image_url"]) {
      const url = https(node[field]);
      if (url) urls.push(url);
    }
    if (ownOperation || ownMedia || urls.length) records.push({ operationId, mediaId, urls });
    for (const key of ["mediaIds", "outputIds", "operationIds"]) {
      if (!Array.isArray(node[key])) continue;
      for (const item of node[key]) {
        const id = identifier(item);
        if (id) records.push({ operationId: key === "operationIds" ? id : operationId, mediaId: key === "operationIds" ? null : id, urls: [] });
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "operation" || key === "operations") {
        walk(child, { role: "operation" }, depth + 1);
      } else if (mediaFields.has(key)) {
        if ((/Videos|^videos$/.test(key) && kind !== "video") || (/Images|^images$/.test(key) && kind !== "image")) continue;
        walk(child, { role: "media", operationId }, depth + 1);
      } else if (envelopes.has(key)) {
        walk(child, { operationId, mediaId }, depth + 1);
      } else if (key === kind || key === (kind === "image" ? "generatedImage" : "generatedVideo")) {
        walk(child, { operationId, mediaId, content: kind }, depth + 1);
      }
    }
  };
  walk(value);
  return records;
}

function safeFailure(message, code = "PROVIDER_RESULT_UNRECOGNIZED") {
  return new StudioError(message, code);
}

/** Attach request/response listeners before arm(); arm immediately before Send.
 * onAccepted receives IDs only and must persist them before candidates are used.
 * This observer does not send requests, inspect DOM URLs, or retry generation.
 */
export function createFlowResultTracker({ prompt, kind, onAccepted = () => {} }) {
  if (typeof prompt !== "string" || !prompt || !["image", "video"].includes(kind)) {
    throw new TypeError("A prompt and supported media kind are required.");
  }
  const observed = new WeakMap();
  const handled = new WeakSet();
  const mediaIds = new Set();
  const operationIds = new Set();
  const candidates = new Set();
  const emitted = new Set();
  let armed = false;
  let submission = null;
  let failure = null;
  let serial = Promise.resolve();

  const allIds = () => new Set([...mediaIds, ...operationIds]);
  const metadata = () => ({ providerMediaIds: [...mediaIds], providerOperationIds: [...operationIds] });
  const remember = async (records, initial) => {
    const matching = records.filter((record) => initial ||
      (record.operationId ? operationIds.has(record.operationId) : mediaIds.has(record.mediaId)));
    let changed = false;
    for (const record of matching) {
      for (const [id, set] of [[record.operationId, operationIds], [record.mediaId, mediaIds]]) {
        if (id && !set.has(id)) {
          set.add(id);
          changed = true;
        }
      }
    }
    if (changed) await onAccepted(metadata());
    for (const record of matching) {
      if (!record.operationId && !record.mediaId) continue;
      for (const url of record.urls) {
        if (!emitted.has(url)) candidates.add(url);
      }
    }
  };

  const tracker = {
    arm() {
      if (armed) throw new Error("Flow result tracker cannot be rearmed.");
      armed = true;
    },
    observeRequest(request) {
      if (!armed || failure) return;
      try {
        const endpoint = transport(request);
        if (!endpoint) return;
        const body = request.postData() || "";
        const payload = json(body);
        if (endpoint.type === "rpc") {
          if (request.method() !== "POST") return;
          const calls = rpcCalls(body);
          const submits = calls.filter((call) => rpcAction(call.payload, /^(?:batch)?(?:generate|create)(?:video|image|media)s?$/i) && promptMatches(call.payload, prompt));
          if (submits.length > 1) {
            failure = safeFailure("Flow gửi nhiều yêu cầu tạo trong cùng một lần. Kiểm tra kết quả trên website; app không tự gửi lại.");
            return;
          }
          if (submits.length === 1 && !submission) {
            submission = request;
            observed.set(request, { role: "submit", rpcId: submits[0].rpcId });
          } else {
            const polls = calls.filter((call) => rpcAction(call.payload, /^(?:batch)?(?:checkStatus|getMedia|getOperation)s?$/i) && referencesId(call.payload, allIds()));
            if (polls.length) observed.set(request, { role: "poll", rpcIds: polls.map((call) => call.rpcId), related: true });
          }
        } else if (endpoint.type === "submit") {
          if (request.method() !== "POST" || !promptMatches(payload, prompt) || submission) return;
          submission = request;
          observed.set(request, { role: "submit" });
        } else {
          const ids = allIds();
          const parts = decodeURIComponent(endpoint.url.pathname).split("/");
          const related = referencesId(payload, ids) || [...endpoint.url.searchParams.values()].some((value) => ids.has(value)) ||
            parts.some((value) => ids.has(value)) || [...ids].some((id) => endpoint.url.pathname.endsWith(`/${id}`));
          observed.set(request, { role: "poll", related });
        }
      } catch {
        // Malformed/unrecognized requests cannot establish output ownership.
      }
    },
    observeResponse(response) {
      serial = serial.then(async () => {
        if (!armed || failure) return;
        const request = response.request();
        const record = observed.get(request);
        if (!record || handled.has(request)) return;
        handled.add(request);
        const text = await response.text();
        let documents;
        let errorText = text;
        if (record.rpcId || record.rpcIds) {
          const wanted = new Set(record.rpcIds || [record.rpcId]);
          const decoded = decodeFlowRpc(text).filter((item) => wanted.has(item.rpcId) || item.rpcId === null && item.errorCode !== null);
          documents = decoded.map((item) => item.data);
          errorText = JSON.stringify(decoded.map((item) => ["wrb.fr", item.rpcId, JSON.stringify(item.data), null, null, item.errorCode]));
        } else {
          documents = [json(text)];
        }
        const providerError = flowResponseError(response.status(), errorText);
        if (providerError && (record.role === "submit" || record.related)) {
          failure = safeFailure(providerError.message, providerError.code);
          return;
        }
        if (response.status() >= 400) return;
        const outputs = documents.flatMap((document) => outputRecords(document, kind));
        if (record.role === "submit" && !outputs.some((item) => item.operationId || item.mediaId)) {
          failure = safeFailure("Flow đã phản hồi nhưng app chưa nhận diện được mã kết quả. Kiểm tra tác vụ trên website trước khi tạo lại; app không gửi lại tự động.");
          return;
        }
        await remember(outputs, record.role === "submit");
      }).catch(() => {
        failure = safeFailure("Không lưu hoặc đọc được bằng chứng kết quả Flow. Kiểm tra tác vụ đã gửi trên website; app không gửi lại tự động.");
      });
      return serial;
    },
    takeCandidates() {
      if (failure) return [];
      const result = [...candidates];
      candidates.clear();
      for (const url of result) emitted.add(url);
      return result;
    },
    get error() {
      return failure;
    },
  };
  return tracker;
}
