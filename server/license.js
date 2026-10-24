import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TOKEN_FILE = "license.token";

function decodeSegment(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error("Token license không hợp lệ.");
  return Buffer.from(segment, "base64url");
}

function encodeSegment(value) {
  return Buffer.from(value).toString("base64url");
}

function resolvePublicKey(options = {}) {
  if (options.publicKey) return options.publicKey;
  if (process.env.DROPSHIP_LICENSE_PUBLIC_KEY) return process.env.DROPSHIP_LICENSE_PUBLIC_KEY;
  const configuredPath = process.env.DROPSHIP_LICENSE_PUBLIC_KEY_PATH;
  if (configuredPath && fs.existsSync(configuredPath)) return fs.readFileSync(configuredPath, "utf8");
  return "";
}

function safeFeatures(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => /^[A-Za-z0-9_.-]{1,80}$/.test(key) && (typeof item === "boolean" || typeof item === "string"))
      .slice(0, 100),
  );
}

function dateValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function publicClaims(payload) {
  return {
    licenseId: typeof payload.licenseId === "string" ? payload.licenseId.slice(0, 200) : null,
    product: payload.product === "dropship-studio" ? payload.product : null,
    issuedAt: dateValue(payload.issuedAt),
    expiresAt: dateValue(payload.expiresAt),
    features: safeFeatures(payload.features),
  };
}

function validateClaims(payload, now = Date.now()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Payload license không hợp lệ.");
  const claims = publicClaims(payload);
  if (!claims.product) throw new Error("License không thuộc Dropship Studio.");
  if (!claims.licenseId) throw new Error("License thiếu mã license.");
  if (claims.expiresAt === null) throw new Error("License thiếu hạn sử dụng.");
  if (claims.issuedAt !== null && claims.issuedAt > now + 5 * 60 * 1000) throw new Error("License có thời điểm cấp không hợp lệ.");
  if (payload.revoked === true || payload.status === "revoked") throw new Error("License đã bị thu hồi.");
  return claims;
}

export function parseLicenseToken(token) {
  const value = String(token || "").trim();
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Token license phải có payload và chữ ký.");
  const payloadBytes = decodeSegment(parts[0]);
  const signature = decodeSegment(parts[1]);
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new Error("Payload license không phải JSON.");
  }
  return { token: value, payloadBytes, payload, signature };
}

export function verifyLicenseToken(token, options = {}) {
  const parsed = parseLicenseToken(token);
  const publicKey = resolvePublicKey(options);
  if (!publicKey) {
    const error = new Error("Chưa cấu hình public key của Dropship Studio.");
    error.code = "LICENSE_PUBLIC_KEY_MISSING";
    throw error;
  }
  let valid = false;
  try {
    valid = crypto.verify(null, parsed.payloadBytes, crypto.createPublicKey(publicKey), parsed.signature);
  } catch {
    valid = false;
  }
  if (!valid) {
    const error = new Error("Chữ ký license không hợp lệ.");
    error.code = "LICENSE_SIGNATURE_INVALID";
    throw error;
  }
  const claims = validateClaims(parsed.payload, options.now || Date.now());
  return { ...claims, status: claims.expiresAt > (options.now || Date.now()) ? "active" : "expired" };
}

function tokenPath(root) {
  return path.join(root, TOKEN_FILE);
}

export function licenseStatus(root, options = {}) {
  const publicKeyConfigured = Boolean(resolvePublicKey(options));
  const file = tokenPath(root);
  if (!fs.existsSync(file)) {
    return {
      status: "not_activated",
      configured: publicKeyConfigured,
      message: publicKeyConfigured ? "Chưa nhập license Dropship Studio." : "Chưa cấu hình public key của Dropship Studio.",
      features: {},
    };
  }
  let token;
  try {
    token = fs.readFileSync(file, "utf8");
  } catch {
    return { status: "invalid", configured: publicKeyConfigured, message: "Không đọc được license trên máy.", features: {} };
  }
  try {
    const result = verifyLicenseToken(token, options);
    return { ...result, configured: publicKeyConfigured, message: result.status === "active" ? "License đang hoạt động." : "License đã hết hạn." };
  } catch (error) {
    return { status: "invalid", configured: publicKeyConfigured, message: error.code === "LICENSE_PUBLIC_KEY_MISSING" ? error.message : "License không hợp lệ.", features: {} };
  }
}

export function saveLicenseToken(root, token, options = {}) {
  const result = verifyLicenseToken(token, options);
  if (result.status !== "active") {
    const error = new Error("License đã hết hạn.");
    error.code = "LICENSE_EXPIRED";
    throw error;
  }
  fs.mkdirSync(root, { recursive: true });
  const destination = tokenPath(root);
  const temporary = `${destination}.tmp`;
  fs.writeFileSync(temporary, `${String(token).trim()}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, destination);
  try { fs.chmodSync(destination, 0o600); } catch {}
  return licenseStatus(root, options);
}

export function removeLicenseToken(root) {
  fs.rmSync(tokenPath(root), { force: true });
  return { status: "not_activated", configured: Boolean(resolvePublicKey()), message: "Đã xóa license trên máy.", features: {} };
}


