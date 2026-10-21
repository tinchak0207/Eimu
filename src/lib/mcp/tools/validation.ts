import type { ToolInputSchema } from "./types";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 依 schema 验证工具参数。通过回 `null`，失败回**第一条**人话错误讯息（含路径）。
 * 纯函式、不抛错——抛与否由 `callTool` 决定，方便测试与路由各取所需。
 */
export function validateToolArguments(schema: ToolInputSchema, args: unknown): string | null {
  return validateValue(schema, args, "arguments");
}

function validateValue(schema: ToolInputSchema, value: unknown, path: string): string | null {
  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) {
    return `${path} 只能是 ${schema.enum.join(" / ")} 之一（收到 ${JSON.stringify(value)}）`;
  }

  switch (schema.type) {
    case "object": {
      if (!isPlainObject(value)) return `${path} 必须是物件`;
      for (const key of schema.required ?? []) {
        if (value[key] === undefined) return `${path}.${key} 是必填参数`;
      }
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        const property = schema.properties?.[key];
        if (!property) {
          if (schema.additionalProperties === false) return `${path}.${key} 不是本工具支援的参数`;
          continue;
        }
        const problem = validateValue(property, item, `${path}.${key}`);
        if (problem) return problem;
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) return `${path} 必须是阵列`;
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return `${path} 至少需要 ${schema.minItems} 个元素`;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `${path} 最多 ${schema.maxItems} 个元素（收到 ${value.length} 个）`;
      }
      if (schema.items) {
        for (let index = 0; index < value.length; index += 1) {
          const problem = validateValue(schema.items, value[index], `${path}[${index}]`);
          if (problem) return problem;
        }
      }
      return null;
    }
    case "string":
      if (typeof value !== "string") return `${path} 必须是字串`;
      return null;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return `${path} 必须是整数`;
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `${path} 必须是数字`;
      break;
    case "boolean":
      if (typeof value !== "boolean") return `${path} 必须是布林值`;
      return null;
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} 不得小于 ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} 不得大于 ${schema.maximum}`;
  }
  return null;
}
