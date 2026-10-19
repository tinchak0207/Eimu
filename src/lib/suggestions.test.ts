import test from "node:test";
import assert from "node:assert/strict";

import { getAllSuggestions, getInitialSuggestions } from "./suggestions.ts";

test("getInitialSuggestions preserves suggestion order for initial render", () => {
  const suggestions = getAllSuggestions();
  const initialSuggestions = getInitialSuggestions(suggestions);

  assert.deepEqual(initialSuggestions, suggestions);
  assert.notEqual(initialSuggestions, suggestions);
});
