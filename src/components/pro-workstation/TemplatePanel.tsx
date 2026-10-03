"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Loader2, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { GENERATION_TRACE_ID_HEADER, newGenerationTraceId } from "@/lib/generation-request-headers";

/** 与 RATIO_SIZES 对应的比例 → 尺寸映射。 */
const RATIO_TO_SIZE: Record<string, string> = {
  "1:1": "1024x1024",
  "4:3": "1024x768",
  "3:4": "768x1024",
  "9:16": "768x1365",
};

const RATIO_OPTIONS = ["1:1", "4:3", "3:4", "9:16"] as const;
const PRESET_PRICE = 5;

interface ScenePreset {
  key: string;
  name: string;
  prompt: string;
}

interface SceneTemplate {
  sceneId: string;
  name: string;
  sampleUrl?: string;
  presets: ScenePreset[];
}

export interface TemplatePanelSubmitConfig {
  mediaId: string;
  sceneId: string;
  presetKey: string;
  subject: string;
  size: string;
  n: number;
}

interface TemplatePanelProps {
  token: string | null;
  onSubmit: (config: TemplatePanelSubmitConfig, resultUrl?: string) => void;
}

export default function TemplatePanel({ token, onSubmit }: TemplatePanelProps) {
  const { user } = useAuth();
  const [scenes, setScenes] = useState<SceneTemplate[]>([]);
  const [fetching, setFetching] = useState(true);
  const [fetchError, setFetchError] = useState("");
  const [selectedScene, setSelectedScene] = useState<SceneTemplate | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<ScenePreset | null>(null);
  const [expandedPrompt, setExpandedPrompt] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [ratio, setRatio] = useState<string>("1:1");
  const [n, setN] = useState(1);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadTemplates = async () => {
      setFetching(true);
      setFetchError("");
      if (!token) {
        setFetching(false);
        setFetchError("请先登录后再加载模板。");
        return;
      }
      try {
        const res = await fetch("/v1/templates", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { scenes?: SceneTemplate[] };
        if (cancelled) return;
        const list = data.scenes ?? [];
        setScenes(list);
        setSelectedScene(list[0] ?? null);
        setSelectedPreset(null);
      } catch {
        if (!cancelled) setFetchError("模板加载失败，请稍后重试。");
      } finally {
        if (!cancelled) setFetching(false);
      }
    };
    void loadTemplates();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const pickScene = useCallback((scene: SceneTemplate) => {
    setSelectedScene(scene);
    setSelectedPreset(null);
    setExpandedPrompt(null);
  }, []);

  const pickPreset = useCallback((preset: ScenePreset) => {
    setSelectedPreset(preset);
  }, []);

  const canSubmit = Boolean(token) && Boolean(selectedPreset) && !submitting;
  const totalPrice = n * PRESET_PRICE;

  const handleSubmit = useCallback(() => {
    if (!selectedPreset || !selectedScene || !token) return;
    const config: TemplatePanelSubmitConfig = {
      mediaId: "",
      sceneId: selectedScene.sceneId,
      presetKey: selectedPreset.key,
      subject: subject.trim(),
      size: RATIO_TO_SIZE[ratio] ?? "1024x1024",
      n,
    };
    const sizeValue = RATIO_TO_SIZE[ratio] ?? "1024x1024";
    setSubmitting(true);
    const run = async () => {
      try {
        // Phase 1：POST /v1/template-generations。mediaId（参考图）的上传与注入属于
        // 改图 API 接入 Phase 2，届时在提交前补齐 /v1/uploads 拿到的 mediaId。
        const res = await fetch("/api/pixai/template-generations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "X-User-Id": String(user?.id ?? 0),
            [GENERATION_TRACE_ID_HEADER]: newGenerationTraceId(),
          },
          body: JSON.stringify({
            image: config.mediaId,
            sceneId: config.sceneId,
            presetKey: config.presetKey,
            subject: config.subject,
            size: sizeValue,
            ratio,
            n: config.n,
          }),
        });
        if (!res.ok) {
          setFetchError("模板生成提交失败，请稍后重试。");
          return;
        }
        // The bridge returns synchronously: { data: [{ url }] }.
        let resultUrl: string | undefined;
        try {
          const payload = (await res.json()) as { data?: { url?: string }[] };
          resultUrl = payload.data?.[0]?.url;
        } catch {
          // non-JSON body: parent handles result display from history
        }
        onSubmit(config, resultUrl);
      } catch {
        setFetchError("模板生成请求失败，请检查网络后重试。");
      } finally {
        setSubmitting(false);
      }
    };
    void run();
  }, [selectedPreset, selectedScene, token, onSubmit, subject, ratio, n, user]);

  if (fetching) {
    return (
      <div className="pro-template-library">
        <div className="pro-template-loading">
          <Loader2 className="h-4 w-4" aria-hidden="true" />
          正在加载场景模板…
        </div>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="pro-template-library">
        <p className="pro-template-empty">{fetchError}</p>
      </div>
    );
  }

  return (
    <div className="pro-template-library">
      <div className="pro-template-control-label">选择场景</div>
      <div className="pro-template-grid">
        {scenes.map((scene) => (
          <button
            key={scene.sceneId}
            type="button"
            className={cn("pro-template-scene-card", selectedScene?.sceneId === scene.sceneId && "is-active")}
            onClick={() => pickScene(scene)}
          >
            {scene.sampleUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={scene.sampleUrl} alt={scene.name} />
            ) : (
              <span className="pro-template-scene-placeholder">无预览</span>
            )}
            <strong>{scene.name}</strong>
            <small>5币起</small>
          </button>
        ))}
        {!scenes.length && <p className="pro-template-empty">暂无可用场景模板。</p>}
      </div>

      {selectedScene && (
        <>
          <div className="pro-template-control-label">{selectedScene.name} · 选择配方</div>
          <div className="pro-template-preset-list">
            {selectedScene.presets.map((preset) => (
              <div
                key={preset.key}
                className={cn("pro-template-preset", selectedPreset?.key === preset.key && "is-active")}
              >
                <button
                  type="button"
                  className="pro-template-preset-head"
                  onClick={() => pickPreset(preset)}
                >
                  <span className="pro-template-preset-check">
                    {selectedPreset?.key === preset.key && <Check className="h-3 w-3" />}
                  </span>
                  <strong>{preset.name}</strong>
                </button>
                <button
                  type="button"
                  className="pro-template-prompt-toggle"
                  onClick={() => setExpandedPrompt((current) => (current === preset.key ? null : preset.key))}
                >
                  进階：查看完整提示词
                  <ChevronDown className={cn("h-3 w-3", expandedPrompt === preset.key && "is-open")} />
                </button>
                {expandedPrompt === preset.key && (
                  <pre className="pro-template-prompt-body">{preset.prompt}</pre>
                )}
              </div>
            ))}
            {!selectedScene.presets.length && (
              <p className="pro-template-empty">此场景暂无配方。</p>
            )}
          </div>

          {selectedPreset && (
            <div className="pro-template-config">
              <label className="pro-template-subject">
                <span>主体系述（可选）</span>
                <input
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  placeholder="描述主体（可选）"
                />
              </label>

              <div>
                <span className="pro-template-control-label">比例</span>
                <div className="pro-chip-row">
                  {RATIO_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      className={cn(ratio === opt && "is-active")}
                      onClick={() => setRatio(opt)}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>

              <div className="pro-template-control pro-template-count">
                <span>批量</span>
                <div className="pro-template-stepper">
                  <button type="button" onClick={() => setN((current) => Math.max(1, current - 1))} aria-label="减少数量">−</button>
                  <strong>{n}</strong>
                  <button type="button" onClick={() => setN((current) => Math.min(6, current + 1))} aria-label="增加数量">+</button>
                </div>
              </div>

              <div className="pro-template-total">
                总价 <strong>{totalPrice} 币</strong>
              </div>

              <button
                type="button"
                className="pro-template-submit"
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {submitting && <Loader2 className="h-4 w-4" />}
                {submitting ? "提交中…" : `生成 ${n} 张 · ${totalPrice} 币`}
                {!submitting && <Play className="h-4 w-4" />}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}