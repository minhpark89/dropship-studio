import { StudioError } from "../store.js";

const ignoredHeaderNames = new Set([
  "path",
  "domain",
  "expires",
  "max-age",
  "secure",
  "httponly",
  "samesite",
  "priority",
  "partitioned",
]);
const allowed = {
  dola: ["dola.com", "ciciai.com"],
  flow: ["google.com"],
};

export function parseCookies(input, provider) {
  const source = input.trim();
  const defaultDomain = provider === "dola" ? ".dola.com" : ".google.com";
  if (!allowed[provider]) throw new StudioError("Dịch vụ không hợp lệ.");
  if (!source || source.length > 2 * 1024 * 1024)
    throw new StudioError("Dữ liệu cookie trống hoặc quá lớn.");
  let entries;
  if (source.startsWith("[") || source.startsWith("{")) {
    try {
      const parsed = JSON.parse(source);
      entries = Array.isArray(parsed) ? parsed : parsed.cookies;
      if (!Array.isArray(entries)) throw new Error("invalid cookies");
    } catch {
      throw new StudioError(
        "JSON cookie không hợp lệ. Chọn định dạng Cookie-Editor hoặc storageState.",
      );
    }
  } else if (
    source.split(/\r?\n/).some((line) => line.split("\t").length >= 7)
  ) {
    entries = source
      .split(/\r?\n/)
      .filter(
        (line) =>
          line.trim() &&
          (!line.startsWith("#") || line.startsWith("#HttpOnly_")),
      )
      .map((line) => {
        const httpOnly = line.startsWith("#HttpOnly_");
        const [domain, , cookiePath, secure, expiry, name, ...values] = line
          .replace(/^#HttpOnly_/, "")
          .split("\t");
        return {
          domain,
          path: cookiePath,
          secure: secure === "TRUE",
          expires: Number(expiry) || -1,
          name,
          value: values.join("\t"),
          httpOnly,
        };
      });
  } else {
    entries = source
      .replace(/^cookie\s*:\s*/i, "")
      .split(/[;\r\n]+/)
      .map((part) => {
        const separator = part.indexOf("=");
        if (separator < 1) return null;
        return {
          name: part.slice(0, separator).trim(),
          value: part.slice(separator + 1).trim(),
          domain: defaultDomain,
          secure: true,
        };
      })
      .filter(
        (entry) => entry && !ignoredHeaderNames.has(entry.name.toLowerCase()),
      );
  }
  const cookies = [];
  const seen = new Set();
  for (const item of entries) {
    if (
      typeof item.name !== "string" ||
      typeof item.value !== "string" ||
      !item.name ||
      /[\s;=]/.test(item.name)
    ) {
      throw new StudioError("Có một cookie không đúng định dạng tên/giá trị.");
    }
    const domain = item.domain || defaultDomain;
    const host = domain.replace(/^\./, "").toLowerCase();
    const legacyFlowDomain = provider === "flow" && host === "labs.google";
    if (
      !legacyFlowDomain &&
      !allowed[provider].some(
        (suffix) => host === suffix || host.endsWith("." + suffix),
      )
    ) {
      continue;
    }
    let expires = Number(item.expires ?? item.expirationDate ?? -1);
    if (item.session || !Number.isFinite(expires) || expires === 0)
      expires = -1;
    if (expires > 100000000000) expires /= 1000;
    if (expires !== -1 && expires <= Date.now() / 1000) continue;
    const sameSite =
      {
        lax: "Lax",
        strict: "Strict",
        none: "None",
        no_restriction: "None",
        unspecified: "Lax",
      }[String(item.sameSite || "Lax").toLowerCase()] || "Lax";
    const cookie = {
      name: item.name,
      value: item.value,
      domain,
      path: item.path || "/",
      expires,
      httpOnly: Boolean(item.httpOnly),
      secure: sameSite === "None" || Boolean(item.secure),
      sameSite,
    };
    const key = `${domain}|${cookie.path}|${cookie.name}`;
    if (!seen.has(key)) {
      cookies.push(cookie);
      seen.add(key);
    }
  }
  if (!cookies.length)
    throw new StudioError("Không có cookie còn hạn thuộc dịch vụ đã chọn.");
  return cookies;
}
