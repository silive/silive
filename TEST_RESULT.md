# 非常智造上线前测试结果

测试时间：2026-05-02  
测试方式：本地自动接口测试 + 静态代码检查 + 必须真机/生产验证项人工步骤整理  
测试环境：`http://127.0.0.1:3000`  
测试原则：本轮只测试和记录，不修改业务代码。

## 一、自动测试摘要

| 项目 | 结果 | 说明 |
|---|---:|---|
| Node 服务监听 3000 | 通过 | 本地存在 Node 进程监听 `*:3000` |
| `node --check cms/server.js` | 通过 | 后端入口 JS 语法通过 |
| 项目 JS 语法批量检查 | 通过 | 排除 `node_modules`、`cms/uploads` 后全部 `.js` 通过 |
| JSON 配置解析 | 通过 | `app.json`、`project.config.json`、`project.private.config.json`、`sitemap.json` 可解析 |
| 小程序打包忽略敏感目录 | 通过 | `.env`、`.env.*`、`cms/data`、`cms/uploads`、`themes` 等已忽略 |
| `/api/health` | 通过 | 返回 `ok: true`，当前存储为 `json` |
| `/api/home` | 通过 | 返回首页数据 |
| `/api/products` | 通过 | 返回商品列表 |
| `/api/product/detail` | 通过 | 使用首个商品 ID 可获取详情 |
| 后台登录接口 | 通过 | 当前 `.env` 配置账号可登录 |
| 未登录访问 `/admin` | 通过 | 返回 302 到 `/login` |
| 登录后访问 `/admin` | 通过 | 返回后台 HTML |
| 后台商品/订单/设置/总览接口 | 通过 | 登录 cookie 下均可访问 |
| 公开上传 1 张真实 PNG | 通过 | 返回 `/uploads/temp-...png` |
| 公开上传 9 张真实 PNG | 通过 | 返回 9 个 URL |
| 公开上传 10 张 | 通过 | 返回 `400 每次最多上传9张图片` |
| 公开上传伪造 jpg | 通过 | 正确拒绝，HTTP 400 |
| 未登录上传 6MB 图片 | 通过 | 正确拒绝，HTTP 413 |
| 未登录访问 `/api/orders` | 通过 | 返回 401，请先完成微信登录 |
| 推荐事件非法类型 | 通过 | 返回 400，事件类型错误 |
| 推荐事件合法 click | 通过 | 返回 200 并记录事件 |
| 本地 mock 微信 openid | 通过 | 返回稳定 `mock-openid-local` 和 `mock-user-session-local` |
| 本地 mock 手机号授权 | 通过 | 返回稳定手机号 `13812345678`、openid、userSession、userToken |
| 本地 mock 下单 | 通过 | 创建订单 `DD2026050205195852B4` |
| 本地 mock 支付 | 通过 | 订单状态变为 `已支付 / 待发货` |
| 上传错误状态码复测 | 通过 | 1张/9张为 200，10张为 400，伪造 jpg 为 400，6MB 为 413 |

## 二、逐项测试结果

### 1. 微信手机号授权登录

状态：本地 mock 自动测试通过；真实微信授权仍需真机复测。  
自动测试结果：本地 `/api/wechat/openid` 和 `/api/wechat/phone` 已使用 mock 逻辑。

本地 mock 返回：

```json
{
  "openid": "mock-openid-local",
  "phoneNumber": "13812345678",
  "userSession": "mock-user-session-local",
  "userToken": "mock-user-session-local"
}
```

说明：

- 当前 `.env` 中 `WECHAT_APPID=your_miniprogram_appid`、`WECHAT_SECRET=your_miniprogram_secret` 是占位值。
- 后端已把这些占位值识别为“未配置”。
- 当 `PAY_MOCK=true` 且非生产环境时，使用 mock 微信登录。

人工测试步骤：

1. 在真机或微信开发者工具中使用真实 AppID。
2. 配置真实 `WECHAT_APPID` 和 `WECHAT_SECRET`。
3. 点击商品详情页“立即定制”。
4. 授权手机号。
5. 验证是否写入 `userSession` 并跳转确认订单页。

预期结果：

- 授权成功。
- 后端返回手机号、openid、userSession。
- 订单页和我的页显示已登录。

对应文件：

- `utils/auth.js`
- `components/login-sheet/*`
- `pages/product/detail.js`
- `cms/server.js`

### 2. 首页商品展示

状态：自动测试通过。

测试步骤：

- 请求 `/api/home`。
- 请求 `/api/products`。

预期结果：

- 首页数据和商品列表正常返回。

实际结果：

- `/api/home` 返回 200。
- `/api/products` 返回 200。

对应文件：

- `pages/index/index.js`
- `pages/index/default-data.js`
- `cms/server.js`

### 3. 商品详情页

状态：自动测试通过。

测试步骤：

- 从 `/api/products` 获取第一个商品 ID。
- 请求 `/api/product/detail?id=<id>`。

预期结果：

- 返回商品详情。

实际结果：

- 返回商品详情 200。

对应文件：

- `pages/product/detail.js`
- `cms/server.js`

### 4. 图片上传

状态：部分通过。

已自动测试：

- 1 张真实 PNG：通过。
- 9 张真实 PNG：通过。
- 10 张：正确拒绝。
- 错误格式：正确拒绝，但状态码 500。
- 未登录 6MB：正确拒绝，但状态码 500。

预期结果：

- 错误格式和超大图片应返回 400 或 413 一类客户端错误。

实际问题：

- 错误格式和超大图片由全局 catch 返回 500。

对应文件：

- `pages/checkout/checkout.js`
- `utils/api.js`
- `cms/server.js`

### 5. 确认定制下单

状态：本地 mock 自动测试通过；真机正式登录下单仍需人工复测。

自动测试步骤：

1. 调用 `/api/wechat/phone` 获取 mock session。
2. 使用 `X-User-Session: mock-user-session-local` 请求 `/api/orders`。
3. 创建商品 `P_LEAF_001` 的订单。

自动测试结果：

- 创建订单成功：`DD2026050205195852B4`。
- 订单写入 `openid=mock-openid-local`。
- 订单写入 `userToken=mock-user-session-local`。
- 订单初始状态为 `待支付`。

仍需人工测试：

1. 真机授权手机号。
2. 上传图片。
3. 填写姓名、手机号、地址、定制要求。
4. 提交订单。
5. 后台订单管理确认订单出现。

对应文件：

- `pages/checkout/checkout.js`
- `utils/auth.js`
- `utils/api.js`
- `cms/server.js`

### 6. 模拟支付

状态：本地自动测试通过。

自动测试步骤：

1. 使用 mock session 创建订单。
2. 请求 `/api/pay/wechat`。
3. 返回 mock 支付参数。
4. 请求 `/api/pay/mock-success`。
5. 查询 `/api/orders?keyword=<orderId>`。

自动测试结果：

- `/api/pay/wechat` 返回：

```json
{
  "mock": true,
  "orderId": "DD2026050205195852B4"
}
```

- `/api/pay/mock-success` 返回 `ok: true`。
- 订单状态变为：`paymentStatus=已支付`，`status=待发货`。

对应文件：

- `pages/checkout/checkout.js`
- `cms/server.js`
- `.env`

### 7. 正式微信支付配置检查

状态：未通过当前本地配置，仅可作为生产人工项。

当前发现：

- `NODE_ENV` 未设置。
- `PAY_MOCK=true`。
- `PUBLIC_BASE_URL=http://127.0.0.1:3000`。
- 微信支付相关配置仍是示例占位值。

预期生产配置：

```env
NODE_ENV=production
PAY_MOCK=false
PUBLIC_BASE_URL=https://api.feichangjiandan.xyz
```

对应文件：

- `.env`
- `cms/server.js`
- `DEPLOY.md`

### 8. 支付回调

状态：未测试，需要生产/微信支付沙箱或真实小额支付。

人工测试步骤：

1. 配置真实商户号、证书、公钥、APIv3 Key。
2. 发起真实微信支付。
3. 等待 `/api/pay/notify`。
4. 检查订单状态、金额校验、回调验签日志。

对应文件：

- `cms/server.js`
- `.env`
- Nginx 配置

### 9. 订单列表只显示当前用户订单

状态：部分通过。

已自动测试：

- 无 `userSession` 请求 `/api/orders` 返回 401。
- 代码已确认订单接口只使用服务端 `userSession/userToken` 解析身份。

未完成：

- 两个真实微信用户之间订单隔离需要真机测试。

对应文件：

- `pages/orders/orders.js`
- `utils/api.js`
- `utils/auth.js`
- `cms/server.js`

### 10. 后台订单管理

状态：自动接口测试通过，页面交互需人工测试。

已自动测试：

- 未登录访问 `/admin` 返回 302。
- 登录后访问 `/admin` 返回 HTML。
- 登录后 `/api/admin/orders` 返回订单数据。

人工测试步骤：

1. 登录后台。
2. 打开订单管理。
3. 搜索订单。
4. 填写快递公司和单号。
5. 标记发货。
6. 小程序订单页查看物流。

对应文件：

- `cms/admin.html`
- `cms/server.js`
- `pages/orders/orders.js`

### 11. 后台商品新增、修改、删除

状态：未执行破坏性自动测试。

原因：

- 新增/修改/删除会改变当前商品数据。
- 本轮按要求只输出测试结果，未改业务代码，也避免改业务数据。

人工测试步骤：

1. 后台新增一个测试商品。
2. 上传主图。
3. 保存。
4. 小程序首页/分类页查看。
5. 修改价格、分类、状态。
6. 删除测试商品。

已自动检查：

- 登录后 `/api/admin/products` 可访问。

对应文件：

- `cms/admin.html`
- `cms/server.js`
- `pages/index/index.js`
- `pages/category/list.js`

### 12. 后台 Banner 上传

状态：未执行破坏性自动测试。

原因：

- Banner 上传和保存会改变当前首页装修数据。

人工测试步骤：

1. 后台页面装修上传 Banner。
2. 保存标题、副标题、跳转目标。
3. 小程序首页刷新。
4. 点击 Banner 验证跳转。

对应文件：

- `cms/admin.html`
- `cms/server.js`
- `pages/index/index.js`
- `pages/profile/profile.js`
- `pages/help/help.js`

### 13. 小程序端图片是否同步显示

状态：部分通过。

已自动测试：

- 上传接口能返回可访问 URL。
- `/api/home` 和 `/api/products` 返回图片 URL。

需要人工/真机测试：

- 微信小程序 image 组件实际加载。
- 正式合法域名下是否显示。

风险观察：

- 当前 seed 商品/部分 Banner 使用 `.svg` 图片地址；微信小程序图片组件对 SVG 的兼容性和合法域名配置需真机确认。

对应文件：

- `pages/index/index.js`
- `pages/category/list.js`
- `pages/product/detail.js`
- `cms/server.js`

### 14. 退款申请流程

状态：未完成自动端到端测试。

原因：

- 需要登录用户 session 和可操作订单。
- 当前本地微信登录失败。

人工测试步骤：

1. 使用真实用户下单。
2. 在订单页申请退款。
3. 后台审核通过/部分退款/拒绝。
4. 用户端查看状态同步。

对应文件：

- `pages/orders/orders.js`
- `cms/admin.html`
- `cms/server.js`

### 15. 两个不同微信用户之间订单隔离测试

状态：未完成，需要真机双账号测试。

已自动检查：

- 无 session 请求订单返回 401。
- 后端不信任前端直接传 openid/userId/userToken。
- 支付归属校验已在代码中存在。

人工测试步骤：

1. 微信账号 A 登录并下单。
2. 微信账号 B 登录并下单。
3. A/B 分别查看订单页。
4. 尝试 B 支付 A 的订单。

预期结果：

- B 看不到 A 的订单。
- B 支付 A 订单返回 403。

对应文件：

- `utils/api.js`
- `utils/auth.js`
- `pages/orders/orders.js`
- `cms/server.js`

### 16. 生产环境 .env 安全检查

状态：当前本地配置不符合生产要求。

当前本地配置：

- `NODE_ENV` 未设置。
- `PAY_MOCK=true`。
- `PUBLIC_BASE_URL=http://127.0.0.1:3000`。
- 微信配置为占位值。

说明：

- 这对本地开发可以接受。
- 如果直接部署生产则不合格。

对应文件：

- `.env`
- `.env.example`
- `cms/server.js`
- `project.config.json`
- `project.private.config.json`
- `DEPLOY.md`

### 17. Nginx、HTTPS、微信合法域名检查

状态：未测试。

原因：

- 当前环境是本地 `127.0.0.1`。
- 无法从本地确认生产服务器 Nginx、HTTPS、备案与微信公众平台合法域名状态。

人工测试步骤：

```bash
nginx -t
systemctl status nginx
curl -I https://api.feichangjiandan.xyz/api/health
curl -I https://www.feichangjiandan.xyz
```

微信公众平台需检查：

- request 合法域名
- uploadFile 合法域名
- downloadFile 合法域名

对应文件/配置：

- `utils/api.js`
- `.env`
- Nginx 配置
- 微信公众平台

## 三、问题清单

### P1. 本地微信登录因 AppID/Secret 占位值失败

严重等级：已修复

原现象：

- `/api/wechat/openid` 使用 fake code 返回 `invalid appid`。
- 当前 `.env` 中 `WECHAT_APPID` 和 `WECHAT_SECRET` 是示例占位值但非空。
- 后端 mock openid 分支只在 `PAY_MOCK=true` 且 AppID/Secret 为空时生效。

修复结果：

- `cms/server.js` 已把 `your_miniprogram_appid`、`your_miniprogram_secret`、`placeholder`、`demo`、`test`、空值视为未配置。
- `PAY_MOCK=true` 且非生产环境时，`/api/wechat/openid` 和 `/api/wechat/phone` 使用 mock 逻辑。
- mock openid、手机号、userSession、userToken 稳定返回。
- 本地下单和模拟支付链路已跑通。

剩余建议：

- 真实微信登录仍需配置真实 AppID/Secret 并用真机测试。
- 生产环境 `NODE_ENV=production` 时禁止 mock 微信登录。

对应文件：

- `.env`
- `.env.example`
- `cms/server.js`
- `utils/auth.js`

### P2. 上传校验错误返回 HTTP 500

严重等级：已修复

原现象：

- 伪造 `.jpg` 文件上传被正确拒绝，但 HTTP 状态为 500。
- 未登录上传 6MB 图片被正确拒绝，但 HTTP 状态为 500。

修复结果：

- 图片格式错误现在返回 HTTP 400。
- 超过大小限制现在返回 HTTP 413。
- 每次超过 9 张图片仍返回 HTTP 400。
- JSON 格式统一为 `{ "ok": false, "message": "具体错误原因" }`。

复测结果：

- 1 张真实 PNG：HTTP 200。
- 9 张真实 PNG：HTTP 200。
- 10 张图片：HTTP 400，`每次最多上传9张图片`。
- 伪造 jpg：HTTP 400，`图片内容校验失败，请选择真实的jpg/png/webp/heic图片`。
- 未登录 6MB 图片：HTTP 413，`临时上传图片超过5MB，请登录后上传或压缩图片`。

对应文件：

- `cms/server.js`
- `utils/api.js`

## 六、上传错误状态码修复后复测结果

测试时间：2026-05-02

| 场景 | HTTP 状态 | 结果 |
|---|---:|---|
| 1 张真实 PNG | 200 | 通过，返回上传 URL |
| 9 张真实 PNG | 200 | 通过，返回 9 个上传 URL |
| 10 张图片 | 400 | 通过，返回 `每次最多上传9张图片` |
| 伪造 jpg | 400 | 通过，返回 `图片内容校验失败，请选择真实的jpg/png/webp/heic图片` |
| 未登录 6MB 图片 | 413 | 通过，返回 `临时上传图片超过5MB，请登录后上传或压缩图片` |

### P3. 当前 `.env` 不符合生产上线配置

严重等级：高

现象：

- `NODE_ENV` 未设置。
- `PAY_MOCK=true`。
- `PUBLIC_BASE_URL=http://127.0.0.1:3000`。
- 微信与微信支付配置仍是示例占位值。

影响：

- 不能直接用于生产。
- 真实微信登录和支付无法工作。

修复建议：

- 生产 `.env` 设置：

```env
NODE_ENV=production
PAY_MOCK=false
PUBLIC_BASE_URL=https://api.feichangjiandan.xyz
```

- 配置真实微信 AppID/Secret、商户号、证书、公钥、APIv3 Key。
- 修改 `.env` 后重启 Node/PM2。

对应文件：

- `.env`
- `DEPLOY.md`
- `cms/server.js`

### P4. 商品/首页种子数据含 SVG 图片，需真机确认

严重等级：中

现象：

- `/api/products` 中存在 `product-leaf.svg` 等 SVG 图片地址。
- `/api/home` 中也存在部分 SVG Banner 地址。
- 当前上传接口已禁止公开上传 SVG，这是安全正确的；但历史 seed 数据仍引用 SVG。

影响：

- 微信小程序 image 组件和合法域名环境下可能显示异常。
- 如果生产域名未配置或 SVG 不兼容，会出现商品图不显示。

修复建议：

- 将正式商品图和 Banner 全部替换为 jpg/png/webp。
- 后台上传真实图片后确认小程序真机展示。

对应文件：

- `cms/data/home.json`
- `cms/data/settings.json`
- `cms/server.js`
- `pages/index/index.js`
- `pages/product/detail.js`

### P5. 商品新增/删除、Banner 保存、退款审核未自动执行

严重等级：低

现象：

- 为避免修改当前业务数据，本轮未自动执行破坏性操作。

影响：

- 这些功能仍需人工验收。

修复建议：

- 准备测试数据库或备份数据。
- 在测试环境执行新增、修改、删除、退款审核。
- 测试后恢复数据。

对应文件：

- `cms/admin.html`
- `cms/server.js`

## 四、需要人工测试的项目

以下项目不能仅靠本地自动测试完成：

1. 微信手机号授权登录真机测试。
2. 正式微信支付预下单。
3. 微信支付回调。
4. 两个真实微信用户订单隔离。
5. 小程序端图片真机展示。
6. 后台商品新增/修改/删除。
7. Banner 上传与跳转。
8. 退款申请与后台审核。
9. Nginx、HTTPS、微信合法域名。

## 五、总体结论

当前代码基础健康度较好：

- JS/JSON 基础检查通过。
- 本地 API 基础读取通过。
- 后台登录与主要后台查询接口通过。
- 上传限制、安全文件名、数量限制已生效。
- 订单未登录保护生效。
- 推荐事件接口校验生效。

上线前阻塞项：

1. 生产 `.env` 必须替换为正式安全配置。
2. 真实微信登录、真实微信支付与回调必须用真机/生产 HTTPS 环境验证。
3. 上传错误状态码建议修正，避免上线监控误报。
