# 非常智造小程序源码包体优化（2026-08）

## 状态

**MANUAL_REQUIRED**：本地配置级估算已经远低于 2 MB，但微信开发者工具的“实际源码包”需要在已打开的 IDE 中人工读取确认。未执行上传、预览、提审、发布、部署或生产操作。

## 基线与根目录

- 当前 HEAD：`896b682a0f52fd7bfe2ee7a288251aaa934be855`
- 优化前开发者工具实际源码包：约 `2227 KB`（用户提供的工具错误信息）
- `miniprogramRoot`：`./`，即仓库根目录
- 19 个注册页面，3 个 tabBar 页面；未新增分包或独立分包
- 公共上传规则来源：`project.config.json.packOptions.ignore`
- 私有 IDE 配置：`project.private.config.json.packOptions.ignore`，已同步相同的忽略项

仓库是“小程序前端 + Node CMS 后端”混合结构。由于源码根目录为仓库根目录，必须依赖 `packOptions.ignore` 把 `cms/`、脚本、审计、备份和非运行资料从小程序上传包排除；本轮没有移动或删除任何目录。

## 根因

配置级扫描显示，运行时小程序文件本身很小，而仓库中存在 CMS 上传图、后端、测试和审计资料。此前已排除大部分后端目录，但仍有两个会导致开发者工具实际包体异常偏大的因素：

1. `project.config.json` 开启了 `uploadWithSourceMap: true`。源码映射不参与小程序运行，却会随上传产物增加体积。
2. 推广/门店分享使用 `assets/share-promotion.png`（1080 x 864，318,159 B）；本地大 Logo、根目录检查文档、`handoff/` 等非运行内容还缺少完整公共排除规则。

## 优化前清单

按本轮开始时的忽略规则重建的本地估算：`114` 个文件、`857,968 B`（约 `837.86 KiB`）。该数字不等同于开发者工具实际上传结果，且优化前实际值以 `2227 KB` 为准。

| 文件或目录 | 大小 | 是否运行必需 | 当时处理 | 本轮处理 |
|---|---:|---|---|---|
| `cms/`，含本地上传图 | 约 43 MB | 否 | 已忽略 | 保持忽略，不删除 |
| `node_modules/` | 约 23 MB | 否 | 已忽略 | 保持忽略 |
| `artifacts/` | 约 332 KiB | 否 | 已忽略 | 保持忽略，不删除 |
| `scripts/` | 约 224 KiB | 否 | 已忽略 | 保持忽略 |
| `docs/` | 约 72 KiB | 否 | 已忽略 | 保持忽略 |
| `handoff/` | 约 60 KiB | 否 | 未显式忽略 | 新增忽略 |
| `themes/` | 约 32 KiB | 否，未被小程序资源路径引用 | 已忽略 | 保持忽略 |
| 根目录检查/审计文档与配置备份 | 约 50 KiB | 否 | 部分未显式忽略 | 新增精确忽略 |
| `assets/share-promotion.png` | 318,159 B | 是（分享图） | 必须上传 | 用同尺寸 WebP 替代，原图保留且忽略 |
| `assets/logo.png`、`assets/logo-orange.png` | 约 1.20 MiB | 否，未发现小程序引用 | 已忽略 | 保持忽略 |

未发现本地音频、视频、字体或 source map 文件；没有删除未确定引用的页面、组件、WXS、二维码或商品资源。

## 具体修改

### 上传配置

- 在公共和私有 `packOptions.ignore` 同步排除：`.github/`、`handoff/`、`providers/`、根目录测试/上线清单、`.gitignore`、私有配置文件和 `project.config.json.backup-20260730`。
- 保持现有 `cms/`、`scripts/`、`docs/`、`artifacts/`、`node_modules/`、测试目录、上传目录和大 Logo 的排除。
- 将公共 `setting.uploadWithSourceMap` 从 `true` 改为 `false`，私有 IDE 设置同步为 `false`。这只影响上传产物调试信息，不影响运行时逻辑。

### 分享资源

| 文件 | 优化前 | 优化后 | 节省 | 引用页面 | 视觉风险 |
|---|---:|---:|---:|---|---|
| `assets/share-promotion.png` | PNG，318,159 B，1080 x 864 | 原图保留；新增 `share-promotion.webp`，34,280 B，1080 x 864 | 283,879 B（89.23%） | 我的推广、门店专属码 | 低；原 PNG 实际 alpha 全不透明，WebP 保持尺寸与内容 |

`pages/promotion/promotion.js` 和 `pages/store/code/code.js` 仅将默认本地分享图路径替换为 WebP；线上回退分享图 URL 保持不变。二维码、小程序码、商品海报和所有业务路径没有修改。

### 可复现估算

新增 `scripts/audit-miniprogram-package-size.js`：读取公共和私有项目配置、应用公共 `packOptions.ignore`、列出最大文件和被忽略项，并可输出 JSON。结果文件为 `docs/miniprogram-package-size-after.json`，该目录本身已排除上传。

优化后估算：`99` 个文件、`480,469 B`（约 `469.21 KiB`）。相较本轮开始时的重建估算，减少约 `368.65 KiB`；相较用户提供的 2227 KB 实测基线，关闭 source map 和资源优化应提供充足余量，但仍不能替代开发者工具的最终数值。

## 分包与运行兼容

未使用分包。现有主包在排除非运行目录与 source map 后已远低于 1800 KB 目标的本地估算，分包会增加路径/分享/扫码入口回归风险，当前不需要。

已静态验证：

- 19 个 `app.json.pages` 均有 `.js`、`.wxml`、`.wxss`、`.json` 文件；
- 3 个 tabBar 页面均在页面注册表中；
- 93 个前端源文件的本地 `assets/` 引用均存在；
- `app.json`、`sitemap.json`、项目配置和 `package.json` 均可解析；
- 生产 API 域名仍使用既有受控配置（报告中已脱敏）；
- 前端 AI 预览调用仍不存在，普通图片上传、支付、退款、库存、推广、门店和自提逻辑未改动。

## 回归结果

| 检查 | 结果 |
|---|---|
| `npm run test:ai-preview-access` | PASS |
| `npm run test:order-domain` | PASS |
| `npm run test:order-chain` | PASS |
| `npm run test:security-boundaries` | PASS |
| 本轮 JS `node --check` | PASS |
| 配置 JSON 解析 | PASS |
| `git diff --check` | PASS |
| 微信开发者工具 CLI 打开项目并清理编译缓存 | PASS |
| 微信开发者工具实际源码包/问题面板 | MANUAL_REQUIRED |

## 人工确认步骤

1. 在已打开的微信开发者工具中确认项目路径为当前工作区。
2. 点击“编译”，再打开“代码依赖分析”或上传前详情。
3. 记录“实际源码包”总大小、主包/分包大小和问题面板数量。
4. 目标：实际源码包低于 `2 MB`，建议低于 `1800 KB`；问题面板为 `0`。
5. 只完成编译和查看，不点击“上传”“预览”“提审”或“发布”。

如果实际值仍高于目标，优先确认开发者工具是否已经重新读取 `project.config.json`，特别是 `uploadWithSourceMap: false` 与 `packOptions.ignore`；不应通过删除业务页面或仓库文件来压缩包体。
