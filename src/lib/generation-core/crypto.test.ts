import assert from "node:assert/strict";
import test from "node:test";
import { decryptGenerationPrompt, encryptGenerationPrompt, generationRequestHash } from "./crypto.ts";

const env = { GENERATION_PROMPT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") } as NodeJS.ProcessEnv;

test("generation prompt encryption round-trips without retaining plaintext in the ciphertext", () => {
  const prompt = "product image with a cobalt bottle";
  const ciphertext = encryptGenerationPrompt(prompt, env);
  assert.ok(ciphertext.startsWith("v1."));
  assert.equal(ciphertext.includes(prompt), false);
  assert.equal(decryptGenerationPrompt(ciphertext, env), prompt);
});

test("generation request hash is stable for object-key order and changes for material request changes", () => {
  const first = generationRequestHash({ model: "gpt-image-2", prompt: "a", workflow: { ratio: "1:1", style: "clean" } });
  const same = generationRequestHash({ workflow: { style: "clean", ratio: "1:1" }, prompt: "a", model: "gpt-image-2" });
  const changed = generationRequestHash({ model: "gpt-image-2", prompt: "b", workflow: { ratio: "1:1", style: "clean" } });
  assert.equal(first, same);
  assert.notEqual(first, changed);
});

