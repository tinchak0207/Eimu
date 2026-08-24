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
var container_image_exports = {};
__export(container_image_exports, {
  ContainerImage: () => ContainerImage
});
module.exports = __toCommonJS(container_image_exports);
class ContainerImage {
  constructor(params) {
    this.type = "ContainerImage";
    this.files = params.files;
    this.handler = params.handler;
    this.runtime = params.runtime;
    this.command = params.command;
    this.environment = params.environment ?? {};
    this.architecture = params.architecture;
    this.memory = params.memory;
    this.maxDuration = params.maxDuration;
    this.maxConcurrency = params.maxConcurrency;
    this.regions = params.regions;
    this.functionFailoverRegions = params.functionFailoverRegions;
    this.experimentalTriggers = params.experimentalTriggers;
    this.supportsCancellation = params.supportsCancellation;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ContainerImage
});
