"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var strip_comments_and_literals_exports = {};
__export(strip_comments_and_literals_exports, {
  stripCommentsAndLiterals: () => stripCommentsAndLiterals
});
module.exports = __toCommonJS(strip_comments_and_literals_exports);
const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/;
const LINE_COMMENT = /\/\/[^\n]*/;
const DOUBLE_QUOTED = /"(?:\\[\s\S]|[^"\\])*"?/;
const SINGLE_QUOTED = /'(?:\\[\s\S]|[^'\\])*'?/;
const TEMPLATE_LITERAL = /`(?:\\[\s\S]|[^`\\])*`?/;
const COMMENT_OR_LITERAL = new RegExp(
  [BLOCK_COMMENT, LINE_COMMENT, DOUBLE_QUOTED, SINGLE_QUOTED, TEMPLATE_LITERAL].map((pattern) => pattern.source).join("|"),
  "g"
);
function stripCommentsAndLiterals(content) {
  return content.replace(COMMENT_OR_LITERAL, " ");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  stripCommentsAndLiterals
});
