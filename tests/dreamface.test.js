import test from "node:test";
import assert from "node:assert/strict";
import { parseDreamFaceCookies } from "../server/providers/dreamface.js";

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
