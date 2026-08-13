export type WorkstationLicenseMode = "adaptable" | "product-reference";

export interface WorkstationSource {
  name: string;
  repo: string;
  license: "Apache-2.0" | "MIT" | "GPL-3.0" | "AGPL-3.0";
  mode: WorkstationLicenseMode;
  capabilities: string[];
}

export const WORKSTATION_SOURCES: WorkstationSource[] = [
  {
    name: "InvokeAI",
    repo: "https://github.com/invoke-ai/InvokeAI",
    license: "Apache-2.0",
    mode: "adaptable",
    capabilities: [
      "Unified Canvas",
      "Control Layers",
      "Board & Gallery Management",
      "Queue",
      "Prompt Library",
      "Workflow management",
    ],
  },
  {
    name: "StableStudio",
    repo: "https://github.com/Stability-AI/StableStudio",
    license: "MIT",
    mode: "adaptable",
    capabilities: [
      "Web studio shell",
      "Plugin backend abstraction",
      "Generate and edit flow",
    ],
  },
  {
    name: "ComfyUI Frontend",
    repo: "https://github.com/Comfy-Org/ComfyUI_frontend",
    license: "GPL-3.0",
    mode: "product-reference",
    capabilities: [
      "Node library sidebar",
      "Queue and history sidebar",
      "Graph keybindings",
      "Canvas workflow UX",
    ],
  },
  {
    name: "ComfyUI",
    repo: "https://github.com/comfyanonymous/ComfyUI",
    license: "GPL-3.0",
    mode: "product-reference",
    capabilities: [
      "Node graph",
      "Async Queue",
      "Workflow JSON",
      "Partial re-execution",
      "PNG workflow recall",
    ],
  },
  {
    name: "Fooocus",
    repo: "https://github.com/lllyasviel/Fooocus",
    license: "GPL-3.0",
    mode: "product-reference",
    capabilities: [
      "Image Prompt",
      "Prompt-first UX",
      "Style presets",
      "Variation and upscale mental model",
    ],
  },
  {
    name: "AUTOMATIC1111 Stable Diffusion WebUI",
    repo: "https://github.com/AUTOMATIC1111/stable-diffusion-webui",
    license: "AGPL-3.0",
    mode: "product-reference",
    capabilities: [
      "txt2img and img2img tabs",
      "Inpaint and extras",
      "Custom scripts",
      "Batch processing",
      "PNG Info parameter restore",
    ],
  },
];

