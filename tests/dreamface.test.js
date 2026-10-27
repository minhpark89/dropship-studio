import test from "node:test";
import assert from "node:assert/strict";
import { classifyDreamFaceSignupPage, classifyGoogleSignupPage, isDreamFaceGenerateLabel, parseDreamFaceCookies } from "../server/providers/dreamface.js";
import { createDreamFaceCredentials } from "../server/dreamface-accounts.js";

test("DreamFace cookie imports keep only valid service cookies", () => {
  const cookies = parseDreamFaceCookies(JSON.stringify([
    {
      name: "session_token",
      value: "fixture-session",
      domain: ".dreamfaceapp.com",
      expirationDate: Date.now() / 1000 + 600,
      httpOnly: true,
      secure: true,
    },
    { name: "unrelated", value: "drop", domain: ".evil-dreamfaceapp.com" },
    { name: "expired", value: "drop", domain: ".dreamfaceapp.com", expires: 10 },
  ]));
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].name, "session_token");
  assert.equal(cookies[0].httpOnly, true);
  assert.equal(cookies[0].sameSite, "Lax");

  const header = parseDreamFaceCookies("Cookie: SID=abc==; csrf=xyz");
  assert.deepEqual(header.map((cookie) => cookie.name), ["SID", "csrf"]);
  assert.throws(() => parseDreamFaceCookies("not-a-cookie"));
});

test("DreamFace accepts the quota-prefixed Generate button", () => {
  assert.equal(isDreamFaceGenerateLabel("Generate"), true);
  assert.equal(isDreamFaceGenerateLabel("2 Generate"), true);
  assert.equal(isDreamFaceGenerateLabel("Generate 2"), true);
  assert.equal(isDreamFaceGenerateLabel("Generate avatar videos with just one photo"), false);
  assert.equal(isDreamFaceGenerateLabel("2 Free Daily"), false);
});

test("Google signup keeps CAPTCHA and identity verification in the visible browser flow", () => {
  const captcha = classifyGoogleSignupPage({
    url: "https://accounts.google.com/signup",
    body: "Verify you are human",
  });
  assert.equal(captcha.status, "verification");
  assert.equal(captcha.authStep, "captcha");

  const phone = classifyGoogleSignupPage({
    url: "https://accounts.google.com/signup",
    body: "Enter the verification code sent to your phone",
  });
  assert.equal(phone.status, "verification");
  assert.equal(phone.authStep, "identity");

  const created = classifyGoogleSignupPage({
    url: "https://myaccount.google.com/",
    body: "Google Account",
  });
  assert.equal(created.status, "created");

  const signup = classifyGoogleSignupPage({
    url: "https://accounts.google.com/signup?continue=https%3A%2F%2Fmyaccount.google.com%2F",
    body: "Create your Google Account",
    formVisible: true,
  });
  assert.equal(signup.status, "pending");
});

test("DreamFace email action creates a unique Gmail-shaped credential and keeps CAPTCHA manual", () => {
  const first = createDreamFaceCredentials("", new Set(["viralstudio.old@gmail.com"]));
  const second = createDreamFaceCredentials("viralstudio.old@gmail.com", new Set([first.email, "viralstudio.old@gmail.com"]));
  assert.match(first.email, /^viralstudio\.[a-f0-9]+@gmail\.com$/);
  assert.match(second.email, /^viralstudio\.[a-f0-9]+@gmail\.com$/);
  assert.notEqual(first.email, second.email);
  assert.notEqual(first.password, second.password);

  const captcha = classifyDreamFaceSignupPage({ body: "Please verify you are human" });
  assert.equal(captcha.status, "verification");
  assert.equal(captcha.authStep, "captcha");
  const filled = classifyDreamFaceSignupPage({ formVisible: true });
  assert.equal(filled.status, "pending");
  assert.equal(filled.authStep, "credentials");
});
