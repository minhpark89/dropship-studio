export const MAX_AUTOMATIC_POST_ATTEMPTS = 3;

const numeric = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;

export function metaResponseDetails(response, body) {
  const error = body?.error || {};
  const retryAfter = response.headers?.get?.("retry-after");
  const seconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter.trim())
    ? Number(retryAfter)
    : retryAfter ? Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1000) : null;
  return {
    code: numeric(error.code),
    subcode: numeric(error.error_subcode),
    isTransient: typeof error.is_transient === "boolean" ? error.is_transient : null,
    httpStatus: numeric(response.status),
    retryAfterSeconds: Number.isFinite(seconds) && seconds >= 0 ? seconds : null,
  };
}

// Keep only diagnostic fields; raw Graph responses can contain credentials.
export function classifyMetaFailure(error) {
  const raw = error?.metaError || {};
  const details = {
    code: numeric(raw.code),
    subcode: numeric(raw.subcode),
    isTransient: typeof raw.isTransient === "boolean" ? raw.isTransient : null,
    httpStatus: numeric(raw.httpStatus),
    retryAfterSeconds: numeric(raw.retryAfterSeconds),
    appCode: /^META_[A-Z_]+$/.test(String(error?.code || raw.appCode || "")) ? String(error?.code || raw.appCode) : null,
  };
  const message = String(error?.message || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  let kind = "temporary";
  let retryable = true;
  if (details.appCode === "META_VIDEO_PROCESSING" && (details.code === null || details.code === 100 && details.subcode === 33)) {
    kind = "video_processing";
  } else if ([368, 459].includes(details.code) || /gioi han quyen truy cap|vi ly do bao mat|temporarily blocked|security (?:restriction|check)|account (?:is |has been )?restricted|checkpoint/.test(message)) {
    kind = "security_restriction";
    retryable = false;
  } else if ([102, 190].includes(details.code) || details.httpStatus === 401 || /access token.*(?:invalid|expired)|invalid.*access token|token.*(?:het han|khong hop le)/.test(message)) {
    kind = "authentication";
    retryable = false;
  } else if (details.code === 10 || details.code >= 200 && details.code <= 299 || details.httpStatus === 403 || /permission (?:denied|required)|insufficient permission|khong (?:co|du) quyen/.test(message)) {
    kind = "permission";
    retryable = false;
  } else if ([4, 17, 32, 341, 613, 80004].includes(details.code) || details.httpStatus === 429 || /rate.?limit|too many requests|request limit|throttl/.test(message)) {
    kind = "rate_limit";
  } else if (details.code === 100 || details.appCode && !["META_GRAPH_ERROR", "META_VIDEO_PROCESSING"].includes(details.appCode) || details.httpStatus >= 400 && details.httpStatus < 500 && details.isTransient !== true || details.isTransient === false) {
    kind = "request_rejected";
    retryable = false;
  }
  return { ...details, kind, retryable };
}

export function automaticPostRetry(error, attempts, now) {
  const details = classifyMetaFailure(error);
  const blocked = !details.retryable || attempts >= MAX_AUTOMATIC_POST_ATTEMPTS;
  const defaultDelay = details.kind === "rate_limit" ? 15 * 60_000 : Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
  const delay = Math.max(defaultDelay, Math.max(0, details.retryAfterSeconds || 0) * 1000);
  return {
    details,
    blocked,
    reason: blocked ? (!details.retryable ? details.kind : "retry_exhausted") : null,
    nextAttemptAt: blocked ? null : new Date(now + delay).toISOString(),
  };
}
