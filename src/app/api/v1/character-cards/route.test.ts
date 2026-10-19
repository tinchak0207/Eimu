// `/v1/character-cards` 挂载点的断言 = 共用套件（与 `/api/biz/character-cards` 逐条相同）。
// 断言本体在 src/lib/biz-character-cards-route-suite.ts，本档只负责把它绑到本 route。
import { registerBizCharacterCardRouteSuite } from "../../../../lib/biz-character-cards-route-suite";
import { GET, POST } from "./route";

registerBizCharacterCardRouteSuite("/v1/character-cards", { GET, POST });
