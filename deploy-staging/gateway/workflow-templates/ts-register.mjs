// ts-register.mjs — 以 --import 載入，註冊上面的 resolve hook。
import { register } from "node:module"
register("./ts-loader.mjs", import.meta.url)
