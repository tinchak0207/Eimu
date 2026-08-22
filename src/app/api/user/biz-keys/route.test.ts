import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BIZ_KEY_MAX_LABEL_LENGTH,
  normalizeUserBizKeyLabel,
  USER_API_KEY_DEFAULT_LABEL,
  USER_API_KEY_LIMIT,
} from "../../../../lib/biz-api-keys.ts";

const root = process.cwd();

function read(relPath: string) {
  return readFileSync(join(root, relPath), "utf8");
}

/** 去掉注释后再断言，避免注释里引用的反例把测试带跑。 */
function code(relPath: string) {
  return read(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const LIST = "src/app/api/user/biz-keys/route.ts";
const ITEM = "src/app/api/user/biz-keys/[id]/route.ts";

// ─────────────────────────────────────────── 鉴权

test("个人密钥端点全部要求校验过的身份，未登录一律 401", () => {
  for (const relPath of [LIST, ITEM]) {
    const source = code(relPath);
    const handlers = source.match(/export async function (GET|POST|DELETE)/g) ?? [];
    const guards = source.match(/requireVerifiedUser\(req\)/g) ?? [];
    assert.equal(guards.length, handlers.length, `${relPath} 每个 handler 都必须校验身份`);
    assert.match(source, /if \(!auth\.ok\) return fail\(auth\.status/, `${relPath} 校验失败必须透传上游状态`);
    assert.doesNotMatch(source, /getStoredUserFromHeaders/, `${relPath} 不得使用未校验的请求头身份`);
    assert.doesNotMatch(source, /x-user-id/, `${relPath} 不得信任客户端自报的身份`);
  }
});

test("用户 id 只来自校验结果，不得来自请求体或查询参数", () => {
  for (const relPath of [LIST, ITEM]) {
    const source = code(relPath);
    assert.doesNotMatch(source, /body\.userId|body\.user_id|params\.get\("userId"\)/, `${relPath} 不得从客户端取 userId`);
    assert.match(source, /auth\.user\.id/, `${relPath} 用户 id 只能来自校验结果`);
  }
});

// ─────────────────────────────────────────── 列表

test("列表只返回本人密钥，且不含哈希", () => {
  const source = code(LIST);
  assert.match(source, /key\.userId === auth\.user\.id/, "必须按 userId 过滤");
  assert.match(source, /toPublicBizApiKey/, "必须走公开视图");
  assert.doesNotMatch(source, /keyHash/, "列表不得含哈希");
});

test("列表响应同时给上限，前端才能如实展示剩余名额", () => {
  const source = code(LIST);
  assert.match(source, /limit: USER_API_KEY_LIMIT/);
});

// ─────────────────────────────────────────── 创建

test("创建绑定当前登录用户，达到上限拒绝签发", () => {
  const source = code(LIST);
  assert.match(source, /userId: auth\.user\.id/, "必须绑定当前用户计费");
  assert.match(source, /mine\.length/, "必须统计本人密钥数量");
  assert.match(source, />= USER_API_KEY_LIMIT/, "达到上限必须拒绝");
  assert.match(source, /key_limit_reached/, "拒绝要有明确错误码");
});

test("label 可选：空则用默认名，超长截断（与共享纯函数一致）", () => {
  const source = code(LIST);
  assert.match(source, /normalizeUserBizKeyLabel/, "必须复用共享的 label 规范化函数");
  assert.doesNotMatch(source, /请填写客户名称/, "个人面板 label 不是必填");
});

test("明文密钥只在签发响应里出现一次", () => {
  const list = code(LIST);
  const keyFields = list.match(/\bkey:/g) ?? [];
  assert.equal(keyFields.length, 1, "POST 只应有一处 key: 字段");
  assert.match(list, /key: issued\.key/);
  assert.doesNotMatch(code(ITEM), /\bkey:/, "吊销接口绝不返回密钥");
});

// ─────────────────────────────────────────── 吊销

test("吊销他人密钥不可能：归属不符按 404 处理，不泄露密钥存在性", () => {
  const source = code(ITEM);
  assert.match(source, /target\.userId !== auth\.user\.id/, "归属校验必须先于吊销");
  assert.match(source, /404/, "归属不符与不存在都返回 404");
  assert.match(source, /revokeBizApiKey/, "真正删除复用同一套存储层");
});

// ─────────────────────────────────────────── 存储层复用

test("个人密钥与 admin 共用同一套存储层，不发明新存储", () => {
  assert.match(code(LIST), /from "@\/lib\/biz-api-key-store"/, "列表/创建必须复用存储层");
  assert.match(code(LIST), /listBizApiKeys/, "列表必须复用 store 的 listBizApiKeys");
  assert.match(code(LIST), /issueBizApiKey/, "创建必须复用 store 的 issueBizApiKey");
  assert.match(code(ITEM), /from "@\/lib\/biz-api-key-store"/, "吊销必须复用存储层");
  assert.match(code(ITEM), /revokeBizApiKey/, "吊销必须复用 store 的 revokeBizApiKey");
});

// ─────────────────────────────────────────── 运行时纯函数

test("normalizeUserBizKeyLabel 空/非法输入回退默认名「DSH 插件」", () => {
  assert.equal(normalizeUserBizKeyLabel(undefined), USER_API_KEY_DEFAULT_LABEL);
  assert.equal(normalizeUserBizKeyLabel(""), USER_API_KEY_DEFAULT_LABEL);
  assert.equal(normalizeUserBizKeyLabel("   "), USER_API_KEY_DEFAULT_LABEL);
  assert.equal(normalizeUserBizKeyLabel(123), USER_API_KEY_DEFAULT_LABEL);
  assert.equal(normalizeUserBizKeyLabel(null), USER_API_KEY_DEFAULT_LABEL);
});

test("normalizeUserBizKeyLabel 保留合法名称并截断超长输入", () => {
  assert.equal(normalizeUserBizKeyLabel(" 我的插件 "), "我的插件");
  assert.equal(normalizeUserBizKeyLabel("长".repeat(120)).length, BIZ_KEY_MAX_LABEL_LENGTH);
  assert.equal(USER_API_KEY_LIMIT, 3);
});
