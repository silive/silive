# MakerWorld 优秀模型目录同步

## 边界

同步器接收包含 MakerWorld 模型基础信息的 JSON 数据源，不包含绕过 Cloudflare 的逻辑。系统不下载、不托管 STL/3MF 文件。

所有成功取得基础信息的模型都创建或更新为下架的“待人工审核”。自动 JSON 同步要求：

- 来源是 `https://makerworld.com.cn/.../models/{id}`；
- 有模型标题。

后台批量链接导入只要求链接中能够识别 MakerWorld model ID。系统优先从拓竹区域元数据接口获取真实标题、主图、预览图、作者和许可证，再以模型页 HTML 作为后备。已存在但标记为“信息待补全”的记录会在重新导入时自动补全，不会重复创建商品。

如果模型已删除、区域不可用或元数据接口未返回该 ID，系统仍使用 `MakerWorld 模型 {model_id}` 作为临时标题并标记“信息待补全/图片待补全”。价格、模型克重和打印时间当前由审核人员填写，不在本次导入中自动计价。

许可证、版权、商用、图片复用、来源权利核验等字段都只作为参考资料保存，不参与导入、同步或保存判定。无论原始许可证文字是 `Standard Digital File License`、`Non-Commercial` 或未知，模型都会进入 `pending_review`。只有后台人工点击“审核通过”后才会上架。

## JSON 格式

数据源可以直接返回数组，也可放在 `items`、`models`、`results` 或 `data.items` 中：

```json
{
  "items": [
    {
      "id": "493632",
      "sourceUrl": "https://makerworld.com.cn/zh/models/493632-example",
      "title": "模型名称",
      "summary": "模型说明",
      "author": "作者名称",
      "license": "CC BY 4.0",
      "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
      "attribution": "模型名称 · 作者 · MakerWorld 原始链接 · CC BY 4.0",
      "imageUrl": "https://经授权的图片地址/example.jpg",
      "galleryImages": [],
      "metrics": {
        "downloads": 1000,
        "likes": 200,
        "boosts": 40,
        "makes": 80,
        "rating": 4.9
      },
      "rights": {
        "commercialUseAllowed": true,
        "listingMediaReuseAllowed": true,
        "sourceVerified": true
      }
    }
  ]
}
```

`license`、`licenseUrl`、`attribution` 和 `rights` 可原样传入作为人工审核参考；缺失这些字段不会导致导入失败。热度评分综合下载、点赞、助力、打印实例和评分，仅用于候选排序。

## 启用步骤

1. 配置 `.env` 中的 `MAKERWORLD_FEED_URL`、Token 和数据源域名白名单；这些配置只负责数据获取。
2. 在后台“商品管理 → MakerWorld 优秀模型同步”执行同步，或填写模型链接和标题手动导入。
3. 专业人员查看来源、作者、抓取时间及原始许可证文字，点击“审核通过”“审核拒绝”或“待审核”。
4. 只有“审核通过”会立即上架；同步任务本身永远不会自动上架。

## 批量链接导入

- 接口：`POST /api/admin/makerworld/import-batch`，请求体为 `{ "text": "..." }`。
- 支持每行、空格或整段文本粘贴，自动提取 MakerWorld URL；每批最多 100 条。
- 优先按 model ID 去重，其次按去除查询参数、片段、语言差异和末尾斜杠后的 canonical URL 去重。
- 单条页面请求默认 5 秒超时，并发最多 10 条；失败后降级创建待审核记录。
- 批次记录查询：`GET /api/admin/makerworld/import-batches?limit=10`。
- 页面可能返回 Cloudflare 403，此时会先使用 `api.bambulab.cn`/`api.bambulab.com` 的区域元数据接口。只有元数据接口和页面都无法取得模型时才标记待补全。

## 来源可用性巡检

- 后台默认每 360 分钟检查一批 MakerWorld 商品，首次启动后约 1 分钟执行。
- 只有官方元数据接口明确返回 HTTP 404 或 410 时，才把商品标记为“来源已失效”并自动下架。
- 网络超时、Cloudflare、HTTP 5xx 或返回内容异常只记录为状态不确定，不会误下架。
- 来源恢复后商品仍保持下架，必须由管理员重新审核上架。
- 手动检查接口：`POST /api/admin/makerworld/check-availability`；状态接口：`GET /api/admin/makerworld/availability-status`。
- 可通过 `MAKERWORLD_AVAILABILITY_CHECK_*` 环境变量调整启用状态、间隔、批量数、并发和超时。
