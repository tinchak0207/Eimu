import { useCallback, useEffect, useRef, useState } from "react";
import {
  ImageError,
  ImageResult,
  ProviderTiming,
  ReferenceImage,
  ReferenceImageRole,
} from "@/lib/image-types";
import { initializeProviderRecord, type ModelMode, ProviderKey } from "@/lib/provider-config";
import {
  generationModel,
  type AspectRatio,
  type OutputResolution,
} from "@/lib/generation-model-catalog";
import {
  fetchStoredHistory,
  getStoredToken,
  getStoredUser,
  type StoredHistoryEntry,
} from "@/lib/new-api-client";
import {
  mergePersistedHistory,
  type PersistedGenerationEntry,
  readGenerationCache,
  recordGenerationResult,
  selectPersistedHistoryForUser,
  writeGenerationCache,
} from "@/lib/generation-cache";
import {
  WORKFLOW_SCHEMA_VERSION,
  buildWorkflowPrompt,
  createGenerationWorkflow,
} from "@/lib/generation-workflow";
import { LOCAL_TEST_MODE } from "@/lib/local-test-mode";
import {
  mergeGenerationTaskProjections,
  type GenerationTaskProjection,
} from "@/lib/generation-task-types";

interface UseImageGenerationReturn {
  images: ImageResult[];
  errors: ImageError[];
  timings: Record<ProviderKey, ProviderTiming>;
  failedProviders: ProviderKey[];
  isLoading: boolean;
  recentWorkflows: PersistedGenerationEntry[];
  tasks: GenerationTaskProjection[];
  startGeneration: (
    prompt: string,
    providers: ProviderKey[],
    providerToModel: Record<ProviderKey, string>,
    options?: GenerationOptions,
  ) => Promise<ImageResult[]>;
  resetState: () => void;
  activePrompt: string;
}

type GenerationResponse = {
  image?: string | null;
  imageUrl?: string | null;
  videoUrl?: string | null;
  mediaType?: "image" | "video" | "audio";
  endpointLabel?: string;
  task_id?: string;
  taskId?: string;
  resultId?: string;
  status?: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "refunded" | "unknown";
  data?: Array<{ url?: string | null; endpointLabel?: string; mimeType?: string }>;
  error?: string;
};

export type ExternalImageGenerator = (request: {
  prompt: string;
  modelId: string;
  qualityMode?: ModelMode;
  aspectRatio?: AspectRatio;
  outputResolution?: OutputResolution;
  durationSeconds?: number;
  generateAudio?: boolean;
  loraModelVersionIds?: string[];
}) => Promise<GenerationResponse>;

interface GenerationOptions {
  referenceImages?: ReferenceImage[];
  qualityMode?: ModelMode;
  aspectRatio?: AspectRatio;
  outputResolution?: OutputResolution;
  durationSeconds?: number;
  generateAudio?: boolean;
  loraModelVersionIds?: string[];
  copies?: number;
  concurrency?: number;
  contextPrompt?: string;
  negativePrompt?: string;
  negativeHint?: string;
  workflowPreset?: string;
  workflowPresetLabel?: string;
  promptHint?: string;
  productionIntent?: string;
  imageSize?: string;
  imageSizes?: string[];
  styleTemplate?: string;
  qualityProfile?: string;
  seedHint?: string;
  regionalPrompts?: Array<{ text: string; weight?: number }>;
  estimatedCredits?: number;
  referenceImageRoles?: Record<string, ReferenceImageRole>;
  externalGenerator?: ExternalImageGenerator;
  retryOfTaskId?: string;
}

const MAX_RECENT_WORKFLOWS = 6;

function selectRecentWorkflowEntries(entries: PersistedGenerationEntry[]) {
  return entries.filter((entry) => entry.workflow).slice(0, MAX_RECENT_WORKFLOWS);
}

function getGenerationCacheUser() {
  const storedUser = getStoredUser();
  if (storedUser) return { id: storedUser.id, username: storedUser.username };
  if (LOCAL_TEST_MODE) return { id: 0, username: "local-test" };
  return null;
}

function selectLocalHistory(cache: ReturnType<typeof readGenerationCache>, userId?: number) {
  if (userId !== undefined) return selectPersistedHistoryForUser(cache, userId);
  if (!LOCAL_TEST_MODE) return [];
  return Object.values(cache.historyByUser).flat().sort((a, b) => b.generatedAt - a.generatedAt);
}

function mapStoredHistoryEntry(entry: StoredHistoryEntry): PersistedGenerationEntry {
  return {
    id: entry.id,
    prompt: entry.prompt,
    generatedAt: entry.generatedAt,
    results: entry.results.map((result) => ({
      provider: result.provider as ProviderKey,
      modelId: result.modelId,
      image: result.image ?? null,
        imageUrl: result.imageUrl ?? null,
        videoUrl: result.videoUrl ?? null,
        mediaType: result.mediaType,
        taskId: result.taskId,
        resultId: result.resultId,
    })),
    source: "server",
    workflow: entry.workflow,
    taskId: entry.taskId,
    primaryResultId: entry.primaryResultId,
  };
}

async function readGenerationResponse(response: Response): Promise<GenerationResponse> {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text) as GenerationResponse;
  } catch {
    if (!response.ok) {
      return { error: text.slice(0, 300) };
    }
    throw new Error("Server returned a non-JSON response.");
  }
}

async function waitForGenerationTask(
  taskId: string,
  headers: Record<string, string>,
  onProjection: (task: GenerationTaskProjection) => void,
): Promise<GenerationResponse> {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`/api/generation-jobs/${encodeURIComponent(taskId)}`, {
      headers,
      cache: "no-store",
    });
    const task = await response.json() as GenerationTaskProjection & { error?: string };
    if (!response.ok) throw new Error(task.error || `Task query failed: ${response.status}`);
    onProjection(task);
    if (task.status === "succeeded") {
      const first = task.results[0];
      return {
        imageUrl: task.kind === "video_generate" ? null : first?.url ?? null,
        videoUrl: task.kind === "video_generate" ? first?.url ?? null : null,
        mediaType: task.kind === "video_generate" || first?.mimeType?.startsWith("video/") ? "video" : "image",
        taskId: task.taskId,
        resultId: first?.resultId,
      };
    }
    if (task.status === "failed" || task.status === "cancelled" || task.status === "refunded" || task.status === "unknown") {
      throw new Error(task.error || `Generation task ended with status ${task.status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Generation task is still running; reopen the workspace to continue polling.");
}

interface UseImageGenerationOptions {
  /** 是否拉取服务端历史（recentWorkflows 仅专业模式使用，可按需关闭以减少首页请求）。默认 true 保持兼容。 */
  enableServerHistory?: boolean;
}

export function useImageGeneration(options?: UseImageGenerationOptions): UseImageGenerationReturn {
  const enableServerHistory = options?.enableServerHistory ?? true;
  const [images, setImages] = useState<ImageResult[]>([]);
  const [errors, setErrors] = useState<ImageError[]>([]);
  const [timings, setTimings] = useState<Record<ProviderKey, ProviderTiming>>(
    initializeProviderRecord<ProviderTiming>(),
  );
  const [failedProviders, setFailedProviders] = useState<ProviderKey[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activePrompt, setActivePrompt] = useState("");
  const [recentWorkflows, setRecentWorkflows] = useState<PersistedGenerationEntry[]>([]);
  const [tasks, setTasks] = useState<GenerationTaskProjection[]>([]);
  const serverHistorySyncedRef = useRef(false);
  const taskCanvasHydratedRef = useRef(false);

  const upsertTask = useCallback((task: GenerationTaskProjection) => {
    setTasks((current) => mergeGenerationTaskProjections(current, [task]));
  }, []);

  const syncServerTasks = useCallback(async () => {
    if (!enableServerHistory) return;
    const token = getStoredToken();
    const user = getStoredUser();
    if (!token || !user) return;
    const response = await fetch("/api/generation-jobs?limit=50", {
      headers: { Authorization: `Bearer ${token}`, "x-user-id": String(user.id) },
      cache: "no-store",
    });
    if (!response.ok) return;
    const payload = await response.json() as { success?: boolean; enabled?: boolean; data?: GenerationTaskProjection[] };
    if (!payload.success || !payload.enabled || !Array.isArray(payload.data)) return;
    setTasks((current) => mergeGenerationTaskProjections(current, payload.data ?? []));

    const taskEntries: PersistedGenerationEntry[] = payload.data.map((task) => ({
      id: task.taskId,
      prompt: task.prompt ?? "",
      generatedAt: Date.parse(task.createdAt),
      source: "server",
      workflow: task.submittedConfig.workflow,
      results: task.results.map((result) => ({
        provider: "image_tinchak",
        modelId: task.modelId,
        image: null,
        imageUrl: task.kind === "video_generate" ? null : result.url,
        videoUrl: task.kind === "video_generate" ? result.url : null,
        mediaType: task.kind === "video_generate" ? "video" : "image",
      })),
    }));
    setRecentWorkflows((current) => [...taskEntries, ...current]
      .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.id === entry.id) === index)
      .sort((a, b) => b.generatedAt - a.generatedAt)
      .slice(0, MAX_RECENT_WORKFLOWS));

    if (!taskCanvasHydratedRef.current) {
      const latest = payload.data.find((task) => task.status === "succeeded" && task.results.length > 0);
      if (latest) {
        taskCanvasHydratedRef.current = true;
        setActivePrompt(latest.prompt ?? "");
        setImages(latest.results.map((result) => ({
          provider: "image_tinchak",
          slotId: `${latest.taskId}:${result.resultId}`,
          image: null,
          imageUrl: latest.kind === "video_generate" ? null : result.url,
          videoUrl: latest.kind === "video_generate" ? result.url : null,
          mediaType: latest.kind === "video_generate" ? "video" : "image",
          modelId: latest.modelId,
          workflow: latest.submittedConfig.workflow,
          taskId: latest.taskId,
          resultId: result.resultId,
        })));
      }
    }
  }, [enableServerHistory]);

  useEffect(() => {
    const cache = readGenerationCache();
    const user = getGenerationCacheUser();
    setRecentWorkflows(selectRecentWorkflowEntries(selectLocalHistory(cache, user?.id)));
    if (!user) return;

    const current = cache.current;
    if (!current || current.userId !== user.id) return;

    setActivePrompt(current.prompt);
    setImages(
      current.results.map((result) => ({
        provider: result.provider,
        image: result.image,
        imageUrl: result.imageUrl,
        videoUrl: result.videoUrl,
        mediaType: result.mediaType,
        modelId: result.modelId,
        endpointLabel: result.endpointLabel,
        workflow: current.workflow,
      })),
    );
  }, []);

  useEffect(() => {
    if (!enableServerHistory || serverHistorySyncedRef.current) return;
    const user = getGenerationCacheUser();
    if (!user) return;
    const token = getStoredToken();
    if (!token) return;

    let cancelled = false;
    fetchStoredHistory(token)
      .then((storedHistory) => {
        if (cancelled || !Array.isArray(storedHistory.data)) return;
        serverHistorySyncedRef.current = true;
        setRecentWorkflows(selectRecentWorkflowEntries(
          mergePersistedHistory(readGenerationCache(), user.id, storedHistory.data.map(mapStoredHistoryEntry)),
        ));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [enableServerHistory]);

  useEffect(() => {
    if (!enableServerHistory) return;
    let cancelled = false;
    const sync = () => {
      if (!cancelled) void syncServerTasks();
    };
    sync();
    const interval = window.setInterval(sync, 3_000);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [enableServerHistory, syncServerTasks]);

  const resetState = () => {
    setImages([]);
    setErrors([]);
    setTimings(initializeProviderRecord<ProviderTiming>());
    setFailedProviders([]);
    setIsLoading(false);
  };

  const startGeneration = async (
    prompt: string,
    providers: ProviderKey[],
    providerToModel: Record<ProviderKey, string>,
    options: GenerationOptions = {},
  ) => {
    const referenceImages = options.referenceImages ?? [];
    const copies = Math.max(1, Math.min(8, options.copies ?? 1));
    const concurrency = Math.max(1, Math.min(4, options.concurrency ?? providers.length));
    const workflow = createGenerationWorkflow({
      ...options,
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      estimatedCredits: options.estimatedCredits ?? copies,
      copies,
      concurrency,
    }, referenceImages);
    const workflowPrompt = buildWorkflowPrompt(prompt, workflow);
    // 多尺寸投放：按槽位轮替分配尺寸，每个槽位携带自己的 workflow（含 imageSize）
    const sizeVariants = (options.imageSizes ?? []).filter((size, index, list) => list.indexOf(size) === index);
    const workflowForSlot = (copyIndex: number) =>
      workflow && sizeVariants.length > 0
        ? { ...workflow, imageSize: sizeVariants[copyIndex % sizeVariants.length] }
        : workflow;
    setActivePrompt(workflowPrompt);
    try {
      setIsLoading(true);
      const slots = providers.flatMap((provider) =>
        Array.from({ length: copies }, (_, copyIndex) => ({
          provider,
          copyIndex,
          slotId: `${provider}-${Date.now()}-${copyIndex}`,
        })),
      );
      // Initialize images array with null values
      setImages(
        slots.map(({ provider, slotId, copyIndex }) => ({
          provider,
          slotId,
          image: null,
          imageUrl: null,
          videoUrl: null,
          mediaType: generationModel(providerToModel[provider])?.kind ?? "image",
          modelId: providerToModel[provider],
          referenceImageNames: referenceImages.map((image) => image.name),
          workflow: workflowForSlot(copyIndex),
        })),
      );

      // Clear previous state
      setErrors([]);
      setFailedProviders([]);

      // Initialize timings with start times
      const now = Date.now();
      setTimings(
        Object.fromEntries(
          providers.map((provider) => [provider, { startTime: now }]),
        ) as Record<ProviderKey, ProviderTiming>,
      );

      // Helper to fetch a single provider
      const generateImage = async (
        provider: ProviderKey,
        modelId: string,
        slotId: string,
        slotWorkflow = workflow,
      ) => {
        const startTime = now;
        console.log(
          `Generate image request [provider=${provider}, modelId=${modelId}]`,
        );
        try {
          let data: GenerationResponse;
          if (options.externalGenerator) {
            data = await options.externalGenerator({
              prompt,
              modelId,
              qualityMode: options.qualityMode,
              aspectRatio: options.aspectRatio,
              outputResolution: options.outputResolution,
              durationSeconds: options.durationSeconds,
              generateAudio: options.generateAudio,
              loraModelVersionIds: options.loraModelVersionIds,
            });
          } else {
            const request = {
              prompt,
              provider,
              modelId,
              qualityMode: options.qualityMode,
              aspectRatio: options.aspectRatio,
              outputResolution: options.outputResolution,
              durationSeconds: options.durationSeconds,
              generateAudio: options.generateAudio,
              loraModelVersionIds: options.loraModelVersionIds,
              workflow: slotWorkflow,
              retryOfTaskId: options.retryOfTaskId,
            };
            const token = getStoredToken();
            const user = getStoredUser();
            const authHeaders: Record<string, string> = {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(user?.id ? { "x-user-id": String(user.id) } : {}),
            };
            let requestBody: BodyInit;
            let requestHeaders: Record<string, string>;

            if (referenceImages.length > 0) {
              const body = new FormData();
              body.append("prompt", prompt);
              body.append("provider", provider);
              body.append("modelId", modelId);
              body.append("qualityMode", options.qualityMode ?? "fast");
              if (options.aspectRatio) body.append("aspectRatio", options.aspectRatio);
              if (options.outputResolution) body.append("outputResolution", options.outputResolution);
              if (options.durationSeconds) body.append("durationSeconds", String(options.durationSeconds));
              if (typeof options.generateAudio === "boolean") body.append("generateAudio", String(options.generateAudio));
              if (options.loraModelVersionIds?.length) body.append("loraModelVersionIds", JSON.stringify(options.loraModelVersionIds));
              if (slotWorkflow) body.append("workflow", JSON.stringify(slotWorkflow));
              if (options.retryOfTaskId) body.append("retryOfTaskId", options.retryOfTaskId);
              body.append("referenceMetadata", JSON.stringify(referenceImages.map((image) => ({
                id: image.id,
                name: image.name,
                role: image.role ?? "general",
                sourceResultId: image.sourceResultId,
                sourceGenerationId: image.sourceGenerationId,
              }))));
              for (const image of referenceImages) body.append("referenceImages", image.file, image.name);
              requestBody = body;
              requestHeaders = authHeaders;
            } else {
              requestBody = JSON.stringify(request);
              requestHeaders = { ...authHeaders, "Content-Type": "application/json" };
            }

            const idempotencyKey = `web-${slotId}`;
            const durableResponse = await fetch("/api/generation-jobs", {
              method: "POST",
              headers: { ...requestHeaders, "Idempotency-Key": idempotencyKey },
              body: requestBody,
            });
            const durablePayload = await durableResponse.json().catch(() => ({})) as {
              data?: GenerationTaskProjection;
              error?: string;
              code?: string;
            };
            if (durableResponse.ok && durablePayload.data) {
              upsertTask(durablePayload.data);
              data = durablePayload.data.status === "succeeded"
                ? {
                    imageUrl: durablePayload.data.kind === "video_generate" ? null : durablePayload.data.results[0]?.url ?? null,
                    videoUrl: durablePayload.data.kind === "video_generate" ? durablePayload.data.results[0]?.url ?? null : null,
                    mediaType: durablePayload.data.kind === "video_generate" ? "video" : "image",
                    taskId: durablePayload.data.taskId,
                    resultId: durablePayload.data.results[0]?.resultId,
                  }
                : await waitForGenerationTask(durablePayload.data.taskId, authHeaders, upsertTask);
            } else if (durablePayload.code === "control_plane_disabled") {
              const isVideoModel = generationModel(modelId)?.kind === "video";
              const response = await fetch(isVideoModel ? "/api/generate-videos" : "/api/generate-images", {
                method: "POST",
                headers: requestHeaders,
                body: requestBody,
              });
              data = await readGenerationResponse(response);
              if (!response.ok) {
                throw new Error(
                  data.error ||
                    (response.status === 504 ? "生成超时，请稍后重试。" : `Server error: ${response.status}`),
                );
              }
              if (data.task_id) data = await waitForGenerationTask(data.task_id, authHeaders, upsertTask);
            } else {
              throw new Error(durablePayload.error || `Task submission failed: ${durableResponse.status}`);
            }
          }

          const completionTime = Date.now();
          const elapsed = completionTime - startTime;
          setTimings((prev) => ({
            ...prev,
            [provider]: {
              startTime,
              completionTime,
              elapsed,
            },
          }));

          console.log(
            `Successful image response [provider=${provider}, modelId=${modelId}, elapsed=${elapsed}ms]`,
          );

          // Update image in state
          const result = {
            provider,
            slotId,
            image: data.image ?? null,
            imageUrl: data.imageUrl ?? null,
            videoUrl: data.videoUrl ?? null,
            mediaType: data.mediaType ?? generationModel(modelId)?.kind ?? "image",
            modelId,
            endpointLabel: data.endpointLabel,
            referenceImageNames: referenceImages.map((image) => image.name),
            workflow: slotWorkflow,
            taskId: data.taskId ?? data.task_id,
            resultId: data.resultId,
          };
          setImages((prevImages) =>
            prevImages.map((item) =>
              item.slotId === slotId ? { ...item, ...result } : item,
            ),
          );
          return result;
        } catch (err) {
          console.error(
            `Error [provider=${provider}, modelId=${modelId}]:`,
            err,
          );
          setFailedProviders((prev) => [...prev, provider]);
          setErrors((prev) => [
            ...prev,
            {
              provider,
              message:
                err instanceof Error
                  ? err.message
                  : "An unexpected error occurred",
            },
          ]);

          const result = {
            provider,
            slotId,
            image: null,
            imageUrl: null,
            videoUrl: null,
            mediaType: generationModel(modelId)?.kind ?? "image",
            modelId,
            referenceImageNames: referenceImages.map((image) => image.name),
            workflow: slotWorkflow,
          };
          setImages((prevImages) =>
            prevImages.map((item) =>
              item.slotId === slotId ? { ...item, ...result } : item,
            ),
          );
          return result;
        }
      };

      const tasks = slots.map(({ provider, slotId, copyIndex }) => () =>
        generateImage(provider, providerToModel[provider], slotId, workflowForSlot(copyIndex)),
      );
      const completedResults: ImageResult[] = [];
      for (let index = 0; index < tasks.length; index += concurrency) {
        completedResults.push(...await Promise.all(tasks.slice(index, index + concurrency).map((task) => task())));
      }

      const user = getGenerationCacheUser();
      if (user) {
        const updatedCache = recordGenerationResult(readGenerationCache(), {
          userId: user.id,
          username: user.username,
          prompt: workflowPrompt,
          generatedAt: Date.now(),
          results: completedResults,
          workflow,
        });
        writeGenerationCache(updatedCache);
        setRecentWorkflows(selectRecentWorkflowEntries(selectPersistedHistoryForUser(updatedCache, user.id)));
      }
      return completedResults;
    } catch (error) {
      console.error("Error fetching images:", error);
      return [];
    } finally {
      setIsLoading(false);
    }
  };

  return {
    images,
    errors,
    timings,
    failedProviders,
    isLoading,
    recentWorkflows,
    tasks,
    startGeneration,
    resetState,
    activePrompt,
  };
}
