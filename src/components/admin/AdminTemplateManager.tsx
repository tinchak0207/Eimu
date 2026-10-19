"use client";

// 场景模板管理（只读）：列出 VPS templates-cache.json 里的所有场景 + preset，
// 每个场景可展开查看 preset 的 key / name / prompt（prompt 可一键复制）。
// 读的是上游 `GET /v1/templates`，由 /api/admin/templates 代理，走 admin session
// cookie，不携带 BIZ_API_KEY。

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, Copy, Layers3, Loader2, RefreshCw } from "lucide-react";

interface TemplatePreset {
  key: string;
  name: string;
  prompt: string;
}

interface TemplateScene {
  sceneId: string;
  name: string;
  presets: TemplatePreset[];
  /** 可选的样例预览图 URL（若 VPS 回传该字段才显示缩略图）。 */
  sampleUrl?: string;
}

interface TemplatesResponse {
  success: boolean;
  scenes?: TemplateScene[];
  message?: string;
}

export function AdminTemplateManager() {
  const [scenes, setScenes] = useState<TemplateScene[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/templates", { cache: "no-store" });
      const json = (await res.json()) as TemplatesResponse;
      if (!json.success || !json.scenes) {
        setError(json.message ?? "读取场景模板失败。");
        return;
      }
      setScenes(json.scenes);
    } catch {
      setError("网络异常，读取场景模板失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleScene = (sceneId: string) => {
    setOpened((current) => ({ ...current, [sceneId]: !current[sceneId] }));
  };

  const copyPrompt = async (preset: TemplatePreset) => {
    try {
      await navigator.clipboard.writeText(preset.prompt);
      setCopiedKey(preset.key);
      setTimeout(() => setCopiedKey((current) => (current === preset.key ? null : current)), 2000);
    } catch {
      setError("复制失败，请手动选中复制。");
    }
  };

  const totalPresets = scenes.reduce((sum, scene) => sum + (scene.presets?.length ?? 0), 0);

  return (
    <>
      <section className="mb-6 grid border-y border-black/10 bg-white sm:grid-cols-3">
        <div className="border-b border-black/10 px-5 py-4 sm:border-b-0 sm:border-r">
          <p className="text-xs text-black/45">场景数</p>
          <strong className="mt-1 block text-2xl">{scenes.length}</strong>
        </div>
        <div className="border-b border-black/10 px-5 py-4 sm:border-b-0 sm:border-r">
          <p className="text-xs text-black/45">Preset 总数</p>
          <strong className="mt-1 block text-2xl">{totalPresets}</strong>
        </div>
        <div className="px-5 py-4">
          <p className="text-xs text-black/45">数据来源</p>
          <p className="mt-1 block text-sm font-medium text-[#242830]">
            VPS templates-cache
            <span className="ml-1 align-middle rounded bg-black/5 px-1 py-0.5 text-[11px] font-semibold text-black/40">
              TTL 1h
            </span>
          </p>
        </div>
      </section>

      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">场景模板</h2>
          <p className="mt-1 text-sm text-black/45">
            列出上游预置的设计场景与 Prompt preset。当前为只读视图：新增 / 编辑 / 删除需要 VPS admin 写入端点。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex shrink-0 items-center gap-2 rounded-md bg-[#2878d0] px-3.5 py-2 text-sm font-semibold text-white hover:bg-[#1d66b7]"
        >
          <RefreshCw className="h-4 w-4" />
          重新整理
        </button>
      </div>

      {error && (
        <p className="mb-4 flex items-start gap-2 rounded-md border border-[#efc3bf] bg-[#fff2f0] px-3 py-2.5 text-sm text-[#a82d24]">
          {error}
        </p>
      )}

      <section className="overflow-hidden rounded-md border border-black/10 bg-white">
        {loading ? (
          <div className="flex min-h-48 items-center justify-center text-sm text-black/45">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            读取场景模板
          </div>
        ) : scenes.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-5 text-center">
            <Layers3 className="mb-3 h-8 w-8 text-black/20" />
            <p className="text-sm font-semibold text-black/60">还没有任何场景模板</p>
            <p className="mt-1 text-sm text-black/40">上游 templates-cache 为空，或尚未下发模板。</p>
          </div>
        ) : (
          <div className="divide-y divide-black/[0.07]">
            {scenes.map((scene) => (
              <div key={scene.sceneId} className="px-5 py-3.5">
                <div className="flex items-center gap-3">
                  {/* 样例缩略图：有 sampleUrl 显示，否则显示占位图 */}
                  {scene.sampleUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={scene.sampleUrl}
                      alt={scene.name}
                      className="h-12 w-12 shrink-0 rounded-md border border-black/10 object-cover"
                    />
                  ) : (
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md border border-black/10 bg-black/[0.03] text-black/20">
                      <Layers3 className="h-5 w-5" />
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => toggleScene(scene.sceneId)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <strong className="truncate text-sm">{scene.name}</strong>
                      <p className="mt-0.5 truncate font-mono text-xs text-black/45">{scene.sceneId}</p>
                    </div>
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-black/40 transition-transform ${
                        opened[scene.sceneId] ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                </div>

                {opened[scene.sceneId] && (
                  <div className="mt-3 space-y-3 border-t border-black/[0.06] pt-3">
                    <p className="text-xs text-black/40">Presets · {scene.presets?.length ?? 0}</p>
                    {(scene.presets ?? []).length === 0 ? (
                      <p className="text-sm text-black/40">该场景暂无 preset。</p>
                    ) : (
                      scene.presets?.map((preset) => (
                        <div key={preset.key} className="rounded-md border border-black/10 bg-black/[0.02] px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <strong className="truncate text-sm">{preset.name}</strong>
                            <code className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 font-mono text-[11px] text-black/45">
                              {preset.key}
                            </code>
                          </div>
                          <div className="mt-1.5 flex items-start gap-2">
                            <code className="min-w-0 flex-1 whitespace-pre-wrap rounded bg-black/5 px-2 py-1.5 font-mono text-xs leading-relaxed text-black/60">
                              {preset.prompt}
                            </code>
                            <button
                              type="button"
                              onClick={() => void copyPrompt(preset)}
                              title="复制 prompt"
                              aria-label="复制 prompt"
                              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-[#20242c] px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-black"
                            >
                              {copiedKey === preset.key ? (
                                <>
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                  已复制
                                </>
                              ) : (
                                <>
                                  <Copy className="h-3.5 w-3.5" />
                                  复制
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/*
        TODO: 新增/编辑/删除场景 - 需要 VPS admin endpoint
        POST   /api/admin/templates            - 新增场景
        PUT    /api/admin/templates/:sceneId   - 更新
        DELETE /api/admin/templates/:sceneId   - 删除
        前端已留出展开结构，CRUD 后端打通后在此处追加表单与操作按钮。
      */}
    </>
  );
}