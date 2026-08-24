import { compileShotPrompt, validateShotJson } from "/opt/agent-harness/gateway/video-prompt-schema"
const v = validateShotJson({ subject: "a red apple on a wooden table", action: "steam rises slowly as the apple rotates once", camera: { shot_type: "close-up", movement: "slow dolly in" }, environment: { lighting: "soft morning window light" }, style: { look: "cinematic" }, output: { duration_seconds: 5, aspect_ratio: "16:9" } })
if (!v.ok) { console.log("INVALID", v.error); process.exit(1) }
for (const m of ["veo-3.1", "kling-3.0", "runway-gen-4.5", "luma-ray-3", "seedance-2.0"]) {
  console.log("===", m, "===")
  console.log(compileShotPrompt(v.shot, m))
}
