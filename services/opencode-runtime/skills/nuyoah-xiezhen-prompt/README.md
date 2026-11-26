# 南鸢写真提示词

南鸢写真与人像摄影提示词 Skill。支持完整中文提示词、系列母版、同系列变体、网页端抽卡关键词和参考图拆解；区分固定成像机制、单张现场光线与皮肤区域反射，避免直闪近景出现全脸油膜。

## 安装

```bash
npx skills add nuyoah-ai-works/nuyoah-xiezhen-prompt -g -y
```

## 使用示例

```text
使用 nuyoah-xiezhen-prompt，为这个主题写一组写真提示词。
```

```text
参考这张图片，为我设计一组同系列但不重复构图、动作和服装的夏日海岛写真提示词。
```

Skill 默认只交付提示词，不主动生图。把生成的提示词交给支持的图像模型后，才会得到写真成片。

## 更新

```bash
npx skills update nuyoah-xiezhen-prompt -g -y
```

安装后也可以直接告诉 Agent：

```text
更新南鸢写真提示词 Skill 到最新版。
```

当前任务不会热更新已经加载的 Skill；更新后请新建任务或重新加载 Agent。

产品说明与版本下载：[南鸢写真提示词](https://knowledge.nuyoahonline.com/skills/nuyoah-xiezhen-prompt)

完整规则见 [SKILL.md](SKILL.md)。

[MIT License](LICENSE)
