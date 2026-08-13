import assert from "node:assert/strict";
import test from "node:test";

import { adobeHealthEndpoint } from "./adobe-health.ts";

test("Adobe health endpoint preserves the supplier base path when it ends in /api/v1", () => {
  assert.equal(
    adobeHealthEndpoint("https://supplier.example/api/v1", "health"),
    "https://supplier.example/api/v1/health",
  );
});

test("Adobe health endpoint preserves an nginx proxy prefix", () => {
  assert.equal(
    adobeHealthEndpoint("https://supplier.example/adobe2api/v1", "/health"),
    "https://supplier.example/adobe2api/v1/health",
  );
});

test("Adobe health endpoint accepts an explicit absolute probe URL", () => {
  assert.equal(
    adobeHealthEndpoint("https://supplier.example/api/v1", "https://health.example/probe"),
    "https://health.example/probe",
  );
});
