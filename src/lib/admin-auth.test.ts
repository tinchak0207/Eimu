import test from "node:test";
import assert from "node:assert/strict";

import {
  createAdminSessionToken,
  hashAdminPassword,
  verifyAdminPassword,
  verifyAdminSessionToken,
} from "./admin-auth.ts";

test("admin passwords are verified from a salted scrypt hash", () => {
  const password = "test-only-password";
  const encoded = hashAdminPassword(password, "00112233445566778899aabbccddeeff");

  assert.match(encoded, /^scrypt\$/);
  assert.equal(encoded.includes(password), false);
  assert.equal(verifyAdminPassword(password, encoded), true);
  assert.equal(verifyAdminPassword("wrong-password", encoded), false);
});

test("admin session tokens reject tampering and expiry", () => {
  const secret = "test-session-secret-with-enough-entropy";
  const token = createAdminSessionToken("tinchak0207", secret, 1_000, 60);

  assert.deepEqual(verifyAdminSessionToken(token, secret, 1_030), { username: "tinchak0207" });
  assert.equal(verifyAdminSessionToken(`${token}x`, secret, 1_030), null);
  assert.equal(verifyAdminSessionToken(token, secret, 1_061), null);
});
