import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  licenseStatus,
  parseLicenseToken,
  removeLicenseToken,
  saveLicenseToken,
  verifyLicenseToken,
} from "../server/license.js";

function tokenFor(payload, privateKey) {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return `${bytes.toString("base64url")}.${crypto.sign(null, bytes, privateKey).toString("base64url")}`;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dropship-license-"));
  const keys = crypto.generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  return { root, keys, publicKey };
}

test("license status never treats a missing token or public key as active", () => {
  const { root } = fixture();
  assert.equal(licenseStatus(root).status, "not_activated");
  assert.equal(licenseStatus(root).configured, false);
});

test("official Dropship token verifies, persists, and can be removed without exposing token", () => {
  const { root, keys, publicKey } = fixture();
  const payload = {
    product: "dropship-studio",
    licenseId: "ds-test-001",
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    features: { ai: true, export: true },
  };
  const token = tokenFor(payload, keys.privateKey);
  assert.equal(parseLicenseToken(token).payload.licenseId, payload.licenseId);
  assert.equal(verifyLicenseToken(token, { publicKey }).status, "active");
  const saved = saveLicenseToken(root, token, { publicKey });
  assert.equal(saved.status, "active");
  assert.equal(saved.licenseId, payload.licenseId);
  assert.equal(JSON.stringify(saved).includes(token), false);
  assert.equal(fs.readFileSync(path.join(root, "license.token"), "utf8").trim(), token);
  assert.equal(removeLicenseToken(root).status, "not_activated");
  assert.equal(fs.existsSync(path.join(root, "license.token")), false);
});

test("expired and tampered tokens are rejected", () => {
  const { root, keys, publicKey } = fixture();
  const expired = tokenFor({
    product: "dropship-studio",
    licenseId: "expired",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  }, keys.privateKey);
  assert.equal(verifyLicenseToken(expired, { publicKey }).status, "expired");
  assert.throws(() => saveLicenseToken(root, expired, { publicKey }), /hết hạn/);
  const parts = expired.split(".");
  const tampered = `${Buffer.from(JSON.stringify({ product: "dropship-studio", licenseId: "tampered", expiresAt: new Date(Date.now() + 60_000).toISOString() })).toString("base64url")}.${parts[1]}`;
  assert.throws(() => verifyLicenseToken(tampered, { publicKey }), /không hợp lệ/);
});

