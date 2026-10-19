"use client";

import { STYLE_PRESETS, type StylePreset } from "@/lib/prompt-enhancer";
import { cn } from "@/lib/utils";

interface StylePresetsProps {
  value: StylePreset;
  onChange: (preset: StylePreset) => void;
  /** When true, renders chips only (no wrapper div) — for inline use */
  inline?: boolean;
  className?: string;
}

export function StylePresets({ value, onChange, inline, className }: StylePresetsProps) {
  // 纯文字胶囊：六个装饰图标在一行里只贡献噪点，标签本身已经说清楚了。
  const chips = STYLE_PRESETS.map((preset) => {
    const isActive = value === preset.key;
    return (
      <button
        key={preset.key}
        type="button"
        onClick={() => onChange(isActive ? "none" : preset.key)}
        className={cn("style-chip", isActive && "active")}
        aria-pressed={isActive}
      >
        {preset.label}
      </button>
    );
  });

  if (inline) {
    // Render chips as a fragment — parent controls layout
    return <>{chips}</>;
  }

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {chips}
    </div>
  );
}
