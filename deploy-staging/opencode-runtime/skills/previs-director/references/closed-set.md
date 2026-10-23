# 闭集词表（真源指针）

真源：`src/lib/director-engine/actionClipCatalog.ts`

- `CLOSED_ACTIONS` ← `MOTION_TEMPLATES.map(t => t.id)`（含打斗 kebab-case）
- `CLOSED_CAMERA_MOVES` ← `CAMERA_TEMPLATES`（24+ 枚举）
- `normalizeActionId` / `normalizeCameraMove`：别名表 → 闭集直返 → Levenshtein 最近邻

## 运镜闭集（DirectorCameraMove）

`static` `push` `pull` `truck-left` `truck-right` `crane-up` `crane-down` `pan-left` `pan-right` `tilt-up` `tilt-down` `orbit` `arc-left` `arc-right` `follow` `tracking` `steadicam` `handheld` `handheld-intense` `jib-up` `jib-down` `zoom-in` `zoom-out` `dolly-zoom` `whip-pan-left` `whip-pan-right` `roll-left` `roll-right`

## 打斗相关动作（S2 补齐，须在 CLOSED_ACTIONS 内）

`slash` `chop` `stab` `jump-attack` `dodge-forward` `hit-react` `idle-combat` `run-combat`  
`slash-spin` `slash-diagonal` `slash-combo` `jump` `flip-air` `land` `roll` `dash` `charge`  
`knockback` `slide-land` `cast-summon` `cast-circle` `cast-release`  
`raise-sword` `shout` `shockwave` `launch` `wipe-blood`

完整动作枚举见 `types.ts` 的 `DirectorActionId`。Kaykit 映射复用 `clipMap.ts`，勿平行第二份。

## 编程拼装

```ts
import { buildPlanFromClosedBeats, compileReferenceWuxiaPlan } from '@/lib/director-engine/planning-core'
import { normalizeActionId, normalizeCameraMove } from '@/lib/director-engine/actionClipCatalog'
```
