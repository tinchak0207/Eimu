const fs = await import("node:fs");
const key = fs.readFileSync(".env.biz-key", "utf8").match(/sk-biz-[A-Za-z0-9]*/)[0];
const base = "https://image.tinchak0207.xyz";
// 1. 提交任务（emu_generate_image 同款请求）
const submit = await fetch(base + "/v1/images/generations", {
  method: "POST",
  headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "gpt-image-2", prompt: "夏日海盐汽水广告大片：一瓶冰爽青柠苏打水立在细沙上，气泡升腾，溅起的水花被阳光穿透，背景是渐变海天与柔和逆光，电影级商业摄影，浅景深，高清细节", size: "1024x1024", n: 1 }),
});
const task = await submit.json();
console.log("提交状态:", submit.status, "| task:", task.task_id, "| status:", task.status);
// 2. 轮询（emu-client 的 pollTask 同款逻辑）
for (let i = 0; i < 30; i++) {
  const r = await fetch(base + "/v1/images/" + task.task_id, { headers: { "Authorization": "Bearer " + key } });
  const j = await r.json();
  if (j.status === "succeeded") {
    console.log("轮询", i, "次后 succeeded");
    const url = j.data[0].url;
    const img = await (await fetch(url)).arrayBuffer();
    fs.writeFileSync("plugins/emu-demo-1.png", new Uint8Array(img));
    console.log("出图成功:", j.data[0].width + "x" + j.data[0].height, "sha256:", j.data[0].sha256.slice(0,12), "→ plugins/emu-demo-1.png");
    break;
  }
  if (j.status === "failed") { console.log("FAILED:", JSON.stringify(j).slice(0,200)); break; }
  await new Promise(res => setTimeout(res, 4000));
}
