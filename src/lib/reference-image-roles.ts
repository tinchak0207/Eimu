import type { ReferenceImageRole } from "@/lib/image-types";

export const REFERENCE_IMAGE_ROLES: Array<{ id: ReferenceImageRole; label: string }> = [
  { id: "general", label: "通用" },
  { id: "style", label: "风格" },
  { id: "character", label: "角色" },
  { id: "composition", label: "构图" },
  { id: "product", label: "产品" },
  { id: "face", label: "脸部" },
];
