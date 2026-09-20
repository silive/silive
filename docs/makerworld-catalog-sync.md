# MakerWorld 优秀模型目录同步

## 边界

同步器只接收 MakerWorld 官方或已取得书面授权的 JSON 数据源，不包含网页爬虫，也不会绕过 Cloudflare。系统不下载、不托管、不再分发 STL/3MF 文件。

默认只创建下架草稿。开启 `MAKERWORLD_AUTO_PUBLISH=true` 后，仍需同时满足：

- 来源是 `https://makerworld.com.cn/.../models/{id}`；
- 许可证属于 `PUBLIC_DOMAIN`、`CC0`、`CC_BY_4_0`、`CC_BY_3_0` 之一；
- 数据源明确声明允许商用、允许复用商品展示图片并完成来源权利核验；
- 标题、作者、主图和署名信息完整。
- 主图域名位于 `MAKERWORLD_MEDIA_ALLOWED_HOSTS` 白名单，并已加入微信小程序下载域名。

`Standard Digital File License`、任何 `NC`（非商用）许可证以及权利状态不明确的模型都会保持下架。已同步商品若后续变为不合格，会自动下架。

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

热度评分综合下载、点赞、助力、打印实例和评分，仅用于候选排序，不代表授权状态。

## 启用步骤

1. 向 MakerWorld/Bambu Lab 获取接口或书面许可，并确认模型文件、成品销售、图片复用和署名规则。
2. 配置 `.env` 中的 `MAKERWORLD_FEED_URL`、Token 和域名白名单。
3. 保持 `MAKERWORLD_AUTO_PUBLISH=false`，先在后台“商品管理 → MakerWorld 优秀模型同步”手动同步并核对草稿。
4. 确认图片、定价、生产可行性和署名展示无误后，再按需开启自动上架。
