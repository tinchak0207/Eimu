/**
 * Change probes for media-endpoints.ts.
 *
 * These assert the two mappings that the production poller now routes through.
 * They are NOT the behavioural acceptance for the fix — that is done in
 * production against an already-succeeded video job (free, no regeneration).
 */
import { describe, expect, test } from "bun:test";
import { doneEventFor, pollPathFor } from "./media-endpoints";

describe("pollPathFor", () => {
  test("image tasks stay in the /v1/images namespace", () => {
    expect(pollPathFor("image", "abc")).toBe("/v1/images/abc");
    expect(pollPathFor("image", "abc").endsWith("/v1/images/abc")).toBe(true);
  });

  test("video tasks go to the /v1/videos namespace", () => {
    expect(pollPathFor("video", "abc")).toBe("/v1/videos/abc");
    expect(pollPathFor("video", "abc").endsWith("/v1/videos/abc")).toBe(true);
  });

  test("ids are URL-encoded (no raw slash/space leaks through)", () => {
    const path = pollPathFor("video", "a/b c");
    expect(path).toBe("/v1/videos/a%2Fb%20c");
    expect(path).not.toContain(" ");
    expect(path.slice("/v1/videos/".length)).toBe("a%2Fb%20c");
  });
});

describe("doneEventFor", () => {
  test("image → image.done", () => {
    expect(doneEventFor("image")).toBe("image.done");
  });

  test("video → video.done", () => {
    expect(doneEventFor("video")).toBe("video.done");
  });
});
