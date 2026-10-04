// ts-register.mjs — 以 --import 载入，注册上面的 resolve hook。
import { register } from "node:module"
register("./ts-loader.mjs", import.meta.url)
