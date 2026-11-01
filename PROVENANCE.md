# 来源与许可（PROVENANCE）

本仓库是**独立插件项目 `dsh-balance-plain`**，代码按 MIT 发布（见 [`LICENSE`](LICENSE)）。

## 构成

| 部分 | 说明 |
|---|---|
| `assets/whale-widget.js` | 本项目原创前端：纯文本读数，真正嵌进侧栏 footer；无鲸鱼角色图、无按压/拖拽、无泡泡、无音效、无菜单、无任何鼠标触摸事件 |
| `tools/preview.html` | 本项目原创的离线预览台（桩掉 fetch，按真实侧栏结构渲染） |
| `icon.png`、`assets/icon-180.png`、`assets/screenshot-1.png` | 本项目自制图标与预览台截图 |
| `lib/index.js`、`lib/accounting.mjs` | 服务端基础实现（余额获取、账本记账、峰谷判定、`/dsh-whale/*` 路由）；沿用 MIT 许可代码，历史版权声明保留在 `LICENSE` 中 |
| `cordis.patch.yml` | bundle 挂载声明 |
| `README.md`、本文件 | 本项目文档 |

## 不含第三方美术素材

本仓库不包含任何第三方图片、动图或音效文件，只有前端 JS、自制图标和自制截图。

## 数据文件

读写 `~/.dsh/.dshw-usage.json`、`.dshw-size.json`、`.dshw-turn.json`，格式与既有实现一致。
⚠️ 与 `dsh-whale-widget` 不能同时安装：两者注册同一组 `/dsh-whale/*` 路由，也会同时注入前端脚本。

## 权利主张

如果你认为本仓库内容侵犯了你的权利，请开一条 issue 说明**文件名**与**依据**，核实后会立即替换或移除，不附加其它条件。
