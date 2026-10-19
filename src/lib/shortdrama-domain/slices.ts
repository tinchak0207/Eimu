import type { ShortDramaToolId } from "./index";

/** 主编排只读+派工；写库与生成下沉到集编写和执行器。不改画布入口。 */
export const SHORT_DRAMA_SLICES = {
  orchestrator: ["script_scene_parse", "storyboard_qc_17"],
  episode_writer: ["script_scene_parse", "cast_asset_lock", "storyboard_qc_17"],
  executor: [
    "keyframe_render",
    "audio_first_timeline",
    "last_frame_video_chain",
    "editing_manifest",
    "delivery_assets",
  ],
} as const satisfies Record<string, readonly ShortDramaToolId[]>;

export type ShortDramaActor = keyof typeof SHORT_DRAMA_SLICES;

export function sliceAllows(actor: ShortDramaActor, tool: ShortDramaToolId): boolean {
  return (SHORT_DRAMA_SLICES[actor] as readonly ShortDramaToolId[]).includes(tool);
}
