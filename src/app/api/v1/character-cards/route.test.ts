// `/v1/character-cards` 掛載點的斷言 = 共用套件（與 `/api/biz/character-cards` 逐條相同）。
// 斷言本體在 src/lib/biz-character-cards-route-suite.ts，本檔只負責把它綁到本 route。
import { registerBizCharacterCardRouteSuite } from "../../../../lib/biz-character-cards-route-suite";
import { GET, POST } from "./route";

registerBizCharacterCardRouteSuite("/v1/character-cards", { GET, POST });
