# MakerWorld 优秀模型目录同步

## 边界

同步器接收包含 MakerWorld 模型基础信息的 JSON 数据源，不包含绕过 Cloudflare 的逻辑。系统不下载、不托管 STL/3MF 文件。

所有成功取得基础信息的模型都创建或更新为下架的“待人工审核”。导入只要求：

- 来源是 `https://makerworld.com.cn/.../models/{id}`；
- 有模型标题。

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
