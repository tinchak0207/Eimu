import test from "node:test";
import assert from "node:assert/strict";

import { publicImageUrl } from "./image-url.ts";

test("publicImageUrl drops local upstream image URLs", () => {
  assert.equal(publicImageUrl("http://127.0.0.1:18081/images/a.png"), null);
  assert.equal(publicImageUrl("http://localhost:18081/images/a.png"), null);
});

test("publicImageUrl keeps public upstream image URLs", () => {
  assert.equal(publicImageUrl("https://cdn.example.com/images/a.png"), "https://cdn.example.com/images/a.png");
});
