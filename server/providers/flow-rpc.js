// Passive decoding only. This module never sends or retries provider requests.
const symbolicErrors = new Set([
  "UNAUTHENTICATED",
  "AUTHENTICATION_REQUIRED",
  "SESSION_EXPIRED",
  "UNUSUAL_ACTIVITY",
  "RECAPTCHA_FAILED",
  "CAPTCHA_REQUIRED",
  "HUMAN_VERIFICATION_REQUIRED",
  "INSUFFICIENT_CREDITS",
  "NOT_ENOUGH_CREDITS",
  "RESOURCE_EXHAUSTED",
  "QUOTA_EXCEEDED",
  "RATE_LIMIT_EXCEEDED",
  "TOO_MANY_REQUESTS",
  "PERMISSION_DENIED",
  "ACCESS_DENIED",
  "CONTENT_POLICY_VIOLATION",
  "SAFETY_FILTERED",
  "REGION_NOT_SUPPORTED",
  "AGE_RESTRICTED",
]);

function payload(value) {
  // Unwrap JSON-in-JSON at the RPC boundary without rewriting user strings
  // inside the decoded object (a prompt may itself contain valid JSON).
  for (let depth = 0; depth < 8 && typeof value === "string"; depth += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  return value;
}

function documents(text) {
  if (typeof text !== "string") return [];
  const source = text.replace(/^\uFEFF?\s*\)\]\}'[^\r\n]*(?:\r?\n|$)/, "").trim();
  if (!source) return [];
  try {
    return [JSON.parse(source)];
  } catch {
    const result = [];
    // Byte-count lines are framing, not JSON payloads. Parsing complete JSON
    // lines also avoids confusing UTF-8 byte lengths with JS string lengths.
    for (const line of source.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate.startsWith("[") && !candidate.startsWith("{")) continue;
      try {
        result.push(JSON.parse(candidate));
      } catch {
        // A truncated final chunk must not discard earlier complete frames.
      }
    }
    return result;
  }
}

function numericCode(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d{1,3}$/.test(value)) return Number(value);
  return null;
}

/** Decode transport records; telemetry rows and payload-internal rows are ignored. */
export function decodeFlowRpc(text) {
  const result = [];
  const visit = (value, depth = 0) => {
    if (!Array.isArray(value) || depth > 16) return;
    if (value[0] === "wrb.fr" || value[0] === "er") {
      const field = Array.isArray(value[5]) ? value[5][0] : value[5];
      const errorCode = numericCode(field);
      result.push({
        rpcId: typeof value[1] === "string" ? value[1] : null,
        data: value[2] == null ? null : payload(value[2]),
        errorCode: errorCode === 0 ? null : errorCode,
      });
      return;
    }
    // Known transport metadata has arbitrary numeric/string fields. Do not
    // treat these fields as status codes or search inside their payloads.
    if (typeof value[0] === "string") return;
    for (const item of value) visit(item, depth + 1);
  };
  for (const document of documents(text)) visit(document);
  return result;
}

function errorSignals(value, result, context = false, depth = 0) {
  if (depth > 24 || value == null) return;
  if (typeof value === "string") {
    if (symbolicErrors.has(value)) result.push(value);
    else if (context) {
      // Only inspect free text within explicit error fields, never prompts,
      // generated text, signed URLs, or arbitrary raw response bodies.
      for (const word of value.match(/[A-Z][A-Z_]{2,}/g) || []) {
        if (symbolicErrors.has(word)) result.push(word);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    const tagged = ["error", "errors", "er"].includes(value[0]);
    for (const item of value) errorSignals(item, result, context || tagged, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const errorField = /^(error|errors|errorCode|error_code|reason|status)$/i.test(key);
    if ((context && /^(code|status)$/i.test(key)) || /^(errorCode|error_code)$/i.test(key)) {
      const code = numericCode(item);
      if (code !== null && code !== 0) result.push(code);
    }
    if (context || errorField) errorSignals(item, result, true, depth + 1);
    else if (item && typeof item === "object") errorSignals(item, result, false, depth + 1);
  }
}

function mappedError(signal) {
  if ([401, 16, "UNAUTHENTICATED", "AUTHENTICATION_REQUIRED", "SESSION_EXPIRED"].includes(signal)) {
    return {
      code: "NEEDS_LOGIN",
      message: "Phiên Google Flow đã hết hiệu lực. Đăng nhập lại trong cửa sổ tài khoản rồi kiểm tra phiên.",
    };
  }
  if (["UNUSUAL_ACTIVITY", "RECAPTCHA_FAILED", "CAPTCHA_REQUIRED", "HUMAN_VERIFICATION_REQUIRED"].includes(signal)) {
    return {
      code: "VERIFICATION",
      message: "Google Flow yêu cầu xác minh. Hoàn tất trong cửa sổ tài khoản và kiểm tra kết quả đã gửi trước khi tạo lại.",
    };
  }
  if ([429, 8, "RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED", "RATE_LIMIT_EXCEEDED", "TOO_MANY_REQUESTS"].includes(signal)) {
    return {
      code: "PROVIDER_REJECTED",
      message: "Google Flow đang giới hạn yêu cầu hoặc đã hết hạn mức. Kiểm tra trên website trước khi thử lại.",
    };
  }
  if (["INSUFFICIENT_CREDITS", "NOT_ENOUGH_CREDITS"].includes(signal)) {
    return {
      code: "PROVIDER_REJECTED",
      message: "Google Flow báo không đủ tín dụng cho yêu cầu này.",
    };
  }
  if ([403, 7, "PERMISSION_DENIED", "ACCESS_DENIED", "REGION_NOT_SUPPORTED", "AGE_RESTRICTED"].includes(signal)) {
    return {
      code: "PROVIDER_REJECTED",
      message: "Google Flow từ chối quyền truy cập. Kiểm tra quyền sử dụng dịch vụ trong cửa sổ tài khoản.",
    };
  }
  if (["CONTENT_POLICY_VIOLATION", "SAFETY_FILTERED"].includes(signal)) {
    return {
      code: "PROVIDER_REJECTED",
      message: "Google Flow từ chối nội dung theo quy định của dịch vụ. Xem thông báo trên website.",
    };
  }
  if (Number.isInteger(signal) && ((signal >= 400 && signal <= 599) || (signal > 0 && signal <= 16))) {
    return {
      code: "PROVIDER_REJECTED",
      message: "Google Flow báo lỗi xử lý yêu cầu. Kiểm tra kết quả trên website trước khi gửi lại.",
    };
  }
  return null;
}

/** Returns only fixed, safe messages; raw provider payloads are never echoed. */
export function flowResponseError(httpStatus, text) {
  if (httpStatus === 401) return mappedError(401);
  const signals = [];
  const records = decodeFlowRpc(text);
  for (const record of records) {
    if (record.errorCode !== null) signals.push(record.errorCode);
    errorSignals(record.data, signals);
  }
  if (!records.length) {
    for (const document of documents(text)) {
      // Ordinary JSON error objects are supported too; transport metadata
      // arrays are not a fallback source of errors.
      if (document && !Array.isArray(document) && typeof document === "object") {
        errorSignals(document, signals);
      }
    }
  }
  const errors = signals.map(mappedError).filter(Boolean);
  // A specific session/challenge failure is more actionable than a generic
  // HTTP 403 or the RPC's accompanying PERMISSION_DENIED status.
  for (const code of ["NEEDS_LOGIN", "VERIFICATION"]) {
    const error = errors.find((item) => item.code === code);
    if (error) return error;
  }
  if (httpStatus === 429) return mappedError(429);
  for (const signal of signals) {
    if (typeof signal !== "string") continue;
    const error = mappedError(signal);
    if (error) return error;
  }
  if (errors.length) return errors[0];
  return mappedError(httpStatus >= 400 ? httpStatus : null);
}
