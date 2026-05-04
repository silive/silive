# API 文档

后端入口：`cms/server.js`

本地开发 Base URL：

```text
http://127.0.0.1:3000
```

生产 Base URL：

```text
https://api.feichangjiandan.xyz
```

## 1. 通用约定

### 响应格式

多数接口返回：

```json
{
  "ok": true,
  "data": {}
}
```

部分公开接口直接返回数组或对象，例如 `/api/products`、`/api/home`。

### 用户身份

用户端接口使用服务端签发的 `userSession/userToken`：

```http
X-User-Session: <userSession>
```

后端不会信任前端直接传来的 `openid/userId/userToken` 来判定订单归属。

### 管理员身份

后台登录成功后写入 cookie：

```http
Set-Cookie: vsc_sid=...; Path=/; HttpOnly; SameSite=Lax
```

生产环境追加：

```http
Secure
```

`/api/admin/*` 接口均需要管理员登录。

## 2. 健康检查

### GET `/api/health`

用途：检查服务与存储是否可用。

返回示例：

```json
{
  "ok": true,
  "service": "very-simple-admin",
  "storage": "mysql"
}
```

`storage` 可能为：

- `mysql`
- `json`

## 3. 管理员登录

### POST `/api/auth/login`

Body：

```json
{
  "username": "后台账号",
  "password": "后台密码"
}
```

成功：

```json
{ "ok": true }
```

失败：

```json
{ "ok": false, "message": "账号或密码错误" }
```

安全策略：

- 同一 IP 10 分钟内最多失败 5 次。
- 超过后锁定 10 分钟。
- 返回：`尝试次数过多，请稍后再试`。

### POST `/api/auth/logout`

清除后台 session。

## 4. 首页与商品

### GET `/api/home`

返回首页配置：

- Banner
- 首页入口
- 商品
- 联系方式
- `categoryCatalog`
- 活动
- 当前主题配置

### PUT `/api/home`

后台保存首页装修配置。需要管理员登录。

### GET `/api/products`

返回商品列表。

### GET `/api/product/detail?id=<productId>`

返回指定商品详情。

### GET `/api/products/<productId>`

同样返回商品详情。

## 5. 帮助中心

### GET `/api/help-center`

返回：

- 上架帮助文章
- 帮助中心 Banner
- 我的页 Banner
- 客服配置

帮助文章后台存储在系统设置 `helpArticles`。

## 6. 用户微信登录

### POST `/api/wechat/openid`

Body：

```json
{
  "code": "wx.login 返回的 code"
}
```

返回：

```json
{
  "ok": true,
  "openid": "脱敏：不应记录到文档",
  "userSession": "服务端签发 token"
}
```

### POST `/api/wechat/phone`

Body：

```json
{
  "code": "getPhoneNumber 返回的 e.detail.code",
  "loginCode": "wx.login 返回的 code"
}
```

返回：

```json
{
  "ok": true,
  "phoneNumber": "用户手机号",
  "openid": "用户 openid",
  "userSession": "服务端签发 token",
  "token": "同 userSession"
}
```

注意：

- `WECHAT_APPID` 和 `WECHAT_SECRET` 只能放在后端 `.env`。
- 前端禁止写入 AppSecret。

## 7. 上传

### POST `/api/upload`

后台上传接口，需要管理员登录。

支持：

- 图片最大 10MB。
- 视频 mp4 最大 50MB。

### POST `/api/upload/public`

小程序公开上传接口。

策略：

- 优先识别 `X-User-Session`。
- 已登录用户：单 userSession 或单 IP 每 10 分钟最多 100 次，单文件最大 10MB。
- 未登录临时上传：单 IP 每 10 分钟最多 20 次，单文件最大 5MB。
- 每次最多 9 张。
- 只允许真实文件头检测通过的 jpg/jpeg/png/webp/heic/heif。
- 随机文件名，不使用原始文件名。
- 未登录上传生成 `temp-` 前缀文件。
- `temp-` 图片超过 24 小时且未绑定订单会自动清理。

返回：

```json
{
  "ok": true,
  "url": "https://.../uploads/user-xxx.jpg",
  "urls": ["https://.../uploads/user-xxx.jpg"],
  "type": "image",
  "temporary": false
}
```

## 8. 订单

### POST `/api/orders`

创建订单。必须登录。

请求头：

```http
X-User-Session: <userSession>
```

Body 主要字段：

```json
{
  "productId": "P1001",
  "customerName": "张三",
  "phone": "13812345678",
  "address": "上海市 ...",
  "customRequest": "定制要求",
  "originalImageUrl": "首张图",
  "originalImageUrls": ["图片1", "图片2"],
  "aiPreviewUrl": "AI预览图",
  "category": "军牌定制",
  "isCustomOrder": "true",
  "inviterCode": "邀请码"
}
```

安全点：

- 后端以商品表价格为准，不应使用前端传入金额作为最终金额。
- 后端使用 session 解析出的 `openid/userToken` 写订单身份。

### GET `/api/orders`

获取当前用户订单。必须登录。

查询：

- `status`
- `keyword`

返回当前 session 用户自己的订单，不返回其他用户订单。

### POST `/api/orders/refund`

申请退款。必须登录。

Body：

```json
{
  "orderId": "DD...",
  "refundType": "仅退款/退货退款",
  "refundReason": "原因",
  "refundAmount": "金额",
  "refundRemark": "备注",
  "refundImageUrl": "图片URL"
}
```

后端会校验订单归属。

## 9. 支付

### POST `/api/pay/wechat`

创建微信 JSAPI 支付参数。必须登录。

Body：

```json
{
  "orderId": "DD..."
}
```

安全策略：

- 只使用 session 解析出的 `openid`。
- 用户不能支付别人的订单。
- 历史空身份订单不能被用户端认领。
- 只有订单 `userToken` 已匹配且 `openid` 为空时，才允许安全补写 openid。

### POST `/api/pay/notify`

微信支付回调。

处理逻辑：

- 校验微信支付签名。
- 解密资源。
- 二次查询微信支付订单。
- 校验订单金额匹配。
- 幂等更新订单支付状态。

### POST `/api/pay/mock-success`

模拟支付接口。

仅在以下条件同时满足时可用：

- `NODE_ENV !== production`
- `PAY_MOCK=true`
- 请求来自 127.0.0.1 或后台管理员已登录

生产环境固定返回：

```json
{
  "ok": false,
  "message": "mock payment disabled in production"
}
```

## 10. 推广与新人福利

### GET `/api/promotion/summary?phone=<phone>`

返回推广摘要：

- 购物金
- 待发放奖励
- 邀请人数
- 邀请成交订单
- 邀请二维码 URL

### GET `/api/promotion/qr?code=<inviteCode>`

返回 SVG 邀请码图。

### POST `/api/promotion/bind`

绑定邀请关系。

### POST `/api/promotion/visit`

记录邀请访问。

### POST `/api/order-recommendation/event`

记录订单页推荐商品点击/转化事件。

安全策略：

- 单 IP 每分钟最多 60 次。
- `type/eventType` 只允许 `click` 或 `conversion`。
- 校验 `productId/orderId` 格式。
- `conversion` 事件如果传 `orderId`，必须能关联真实订单。

### GET `/api/newcomer/benefits`

返回新人福利资格与配置。

参数：

- `phone`
- `openid`

## 11. AI 预览

### POST `/api/ai/preview`

生成 AI 定制预览图。

当前为第一阶段实现：

- 优先实用。
- 可接入 OpenAI Images / Stable Diffusion / ComfyUI API。
- 如果未配置真实 AI 服务，返回模拟/占位预览。

## 12. 后台管理 API

以下接口均需要管理员登录。

### 商品导入

- `GET /api/admin/products/import-template`
- `POST /api/admin/products/import-preview`
- `POST /api/admin/products/import-confirm`

### 数据总览

- `GET /api/admin/overview`

### 商品

- `GET /api/admin/products`
- `PUT /api/admin/products`

### 订单

- `GET /api/admin/orders`
- `PUT /api/admin/orders`
- `POST /api/admin/orders/ship`
- `POST /api/admin/orders/refund-review`

### 客户与推广

- `GET /api/admin/customers`
- `GET /api/admin/promotion-relations`
- `PUT /api/admin/promotion-relations`
- `GET /api/admin/reward-rules`
- `PUT /api/admin/reward-rules`
- `GET /api/admin/reward-records`

### 系统设置

- `GET /api/admin/settings`
- `PUT /api/admin/settings`

系统设置中包含：

- 类目管理
- 活动管理
- 帮助中心
- 客服配置
- 新人福利
- Banner 扩展配置

### 主题

- `GET /api/admin/themes`
- `PUT /api/admin/themes`
- `PUT /api/admin/themes/:skinId`
- `POST /api/admin/themes/:skinId/activate`
- `DELETE /api/admin/themes/:skinId`

注意：后端皮肤管理保留，但小程序前端当前固定 skin01。

