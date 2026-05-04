# 非常智造上线前测试清单

更新时间：2026-05-02

说明：

- 本清单用于微信小程序 + Node.js 后台 CMS 上线前验收。
- 测试前请确认本地或测试环境 Node 服务已启动。
- 开发者工具测试本地接口时，需要勾选“不校验合法域名”。
- 生产/体验版必须使用 HTTPS 合法域名。

## 0. 测试环境准备

### 测试步骤

1. 启动后端：

```bash
npm start
```

2. 打开后台：

```text
http://127.0.0.1:3000/login
```

3. 微信开发者工具打开当前小程序项目。
4. 开发环境确认 API 为：

```text
http://127.0.0.1:3000
```

5. 检查接口：

```bash
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/home
curl http://127.0.0.1:3000/api/products
```

### 预期结果

- `/api/health` 返回 `ok: true`。
- 后台登录页可打开。
- 小程序首页能请求接口。

### 失败时可能原因

- Node 服务未启动。
- 3000 端口被占用。
- `.env` 配置错误。
- 微信开发者工具未勾选“不校验合法域名”。

### 对应代码文件

- `cms/server.js`
- `utils/api.js`
- `.env`
- `.env.example`

---

## 1. 微信手机号授权登录

### 测试步骤

1. 打开小程序。
2. 进入商品详情页，点击“立即定制”。
3. 未登录时应弹出底部授权面板。
4. 点击“授权手机号并登录”。
5. 在微信授权弹窗中允许授权。
6. 登录成功后继续进入确认定制页。
7. 再进入“我的”页面，确认手机号已脱敏展示。
8. 再进入订单页，确认已登录状态。

### 预期结果

- 授权成功后后端返回手机号、openid、userSession。
- 前端保存 `memberPhone`、`openid`、`userSession`、`userToken`。
- 登录弹窗关闭。
- 商品详情页可以继续进入下单页。
- 订单页和我的页刷新为已登录状态。

### 失败时可能原因

- 微信开发者工具不支持真实手机号授权，需要真机测试。
- `WECHAT_APPID` 或 `WECHAT_SECRET` 配置错误。
- `/api/wechat/phone` 请求失败。
- 未使用 `e.detail.code`。
- 前端没有保存 `userSession`。
- 合法域名未配置。

### 对应代码文件

- `components/login-sheet/login-sheet.*`
- `utils/auth.js`
- `utils/api.js`
- `pages/product/detail.js`
- `pages/orders/orders.js`
- `pages/profile/profile.js`
- `cms/server.js`

---

## 2. 首页商品展示

### 测试步骤

1. 打开小程序首页。
2. 检查 Banner 是否展示。
3. 检查四宫格入口是否展示。
4. 检查信任标签是否展示。
5. 检查热门推荐商品是否展示。
6. 点击商品卡片进入详情页。
7. 搜索商品名称，查看搜索结果。

### 预期结果

- 首页无白屏。
- 商品图片、名称、价格正常显示。
- 下架商品不应出现在前台。
- 点击商品可进入详情页。
- 搜索有结果时展示匹配商品，无结果时展示友好空状态。

### 失败时可能原因

- `/api/home` 或 `/api/products` 请求失败。
- `PUBLIC_BASE_URL` 资源地址错误。
- 商品图片 URL 指向本地不可访问地址。
- 后台商品状态为下架。
- 前端 fallback 数据异常。

### 对应代码文件

- `pages/index/index.js`
- `pages/index/index.wxml`
- `pages/index/index.wxss`
- `pages/index/default-data.js`
- `utils/api.js`
- `cms/server.js`
- `cms/data/home.json`

---

## 3. 商品详情页

### 测试步骤

1. 从首页点击任意商品。
2. 检查商品主图/轮播图。
3. 检查视频入口或视频播放器。
4. 检查商品名称、价格、分类标签。
5. 检查详情文字和详情图片。
6. 点击“推荐给朋友”。
7. 点击“立即定制”。

### 预期结果

- 商品详情页不应一直 loading。
- 商品图、详情图、价格显示正常。
- 分类标签正确。
- 分享文案自然，不出现强奖励导向文案。
- 点击立即定制未登录时进入授权流程，已登录时进入确认定制页。

### 失败时可能原因

- `/api/product/detail` 参数错误。
- 商品 ID 不存在。
- 图片 URL 失效。
- 商品详情字段为空但前端未做空状态。
- 登录弹窗组件路径错误。

### 对应代码文件

- `pages/product/detail.js`
- `pages/product/detail.wxml`
- `pages/product/detail.wxss`
- `components/login-sheet/*`
- `utils/auth.js`
- `cms/server.js`

---

## 4. 图片上传测试

### 4.1 上传 1 张图片

#### 测试步骤

1. 进入确认定制页。
2. 点击上传参考图片。
3. 选择 1 张 jpg/png/webp/heic 图片。
4. 等待上传完成。

#### 预期结果

- 上传成功。
- 页面显示缩略图。
- 点击缩略图可预览。
- 可删除该图片。
- 返回 URL 为 `/uploads/...`。

#### 失败时可能原因

- `/api/upload/public` 请求失败。
- 图片真实文件头不符合格式。
- uploadFile 合法域名未配置。
- 后端 `PUBLIC_BASE_URL` 错误。

#### 对应代码文件

- `pages/checkout/checkout.js`
- `pages/checkout/checkout.wxml`
- `utils/api.js`
- `cms/server.js`

### 4.2 上传 9 张图片

#### 测试步骤

1. 进入确认定制页。
2. 连续选择或上传 9 张图片。
3. 确认全部显示缩略图。

#### 预期结果

- 9 张均可上传。
- 页面布局不乱。
- 第 10 张应被阻止或提示最多 9 张。

#### 失败时可能原因

- 前端数量控制错误。
- 后端 multipart 数量限制触发。
- 上传队列中断。

#### 对应代码文件

- `pages/checkout/checkout.js`
- `cms/server.js`

### 4.3 上传超大图片

#### 测试步骤

1. 未登录状态上传大于 5MB 图片。
2. 已登录状态上传大于 10MB 图片。

#### 预期结果

- 未登录超过 5MB 提示：临时上传图片超过5MB。
- 已登录超过 10MB 提示：图片超过10MB。
- 不应写入上传目录。

#### 失败时可能原因

- 前端压缩导致实际文件变小。
- 后端 `readBody` 限制未触发。
- 上传错误提示未透传。

#### 对应代码文件

- `utils/api.js`
- `cms/server.js`

### 4.4 上传错误格式

#### 测试步骤

1. 将 `.txt` 或 `.js` 改名为 `.jpg`。
2. 尝试上传。

#### 预期结果

- 后端应拒绝。
- 提示图片内容校验失败或格式不一致。
- 不能生成可访问 URL。

#### 失败时可能原因

- 文件头检测未生效。
- 前端过滤导致无法选择，需要用接口工具测试。

#### 对应代码文件

- `cms/server.js`

---

## 5. 确认定制下单

### 测试步骤

1. 商品详情页点击立即定制。
2. 授权登录。
3. 进入确认定制页。
4. 填写姓名、手机号、地址、定制要求。
5. 上传图片。
6. 点击提交订单。

### 预期结果

- 手机号必须通过 `^1[3-9]\d{9}$`。
- 错误手机号不能提交。
- 订单提交成功。
- 后端订单包含用户身份、商品、金额、图片、定制要求。
- 后台订单管理能看到新订单。

### 失败时可能原因

- 未登录或 `userSession` 失效。
- 商品 ID 不存在。
- 手机号校验错误。
- 图片 URL 未保存。
- `/api/orders` 返回 401。

### 对应代码文件

- `pages/checkout/checkout.js`
- `utils/auth.js`
- `utils/api.js`
- `cms/server.js`

---

## 6. 模拟支付

### 测试步骤

1. 本地 `.env` 设置：

```env
NODE_ENV=development
PAY_MOCK=true
```

2. 重启 Node 服务。
3. 提交订单。
4. 点击支付。
5. 确认订单状态变为已支付/待发货。

### 预期结果

- 本地开发可使用 mock 支付。
- `/api/pay/mock-success` 仅本机或后台管理员登录可用。
- 生产环境不可用。

### 失败时可能原因

- `PAY_MOCK=false`。
- 请求不是本机也未登录后台。
- 订单归属校验失败。
- 订单缺少身份。

### 对应代码文件

- `pages/checkout/checkout.js`
- `cms/server.js`
- `.env`

---

## 7. 正式微信支付配置检查

### 测试步骤

1. 生产 `.env` 设置：

```env
NODE_ENV=production
PAY_MOCK=false
PUBLIC_BASE_URL=https://api.feichangjiandan.xyz
```

2. 检查微信支付配置：

```env
WECHAT_APPID=...
WECHAT_SECRET=...
WECHAT_MCH_ID=...
WECHAT_MCH_SERIAL_NO=...
WECHAT_PRIVATE_KEY_PATH=...
WECHAT_API_V3_KEY=...
WECHAT_PAY_NOTIFY_URL=https://api.feichangjiandan.xyz/api/pay/notify
WECHAT_PAY_PUBLIC_KEY_ID=...
WECHAT_PAY_PUBLIC_KEY_PATH=...
```

3. 重启服务。
4. 发起真实支付预下单。

### 预期结果

- 服务可以启动。
- 不允许 `PAY_MOCK=true`。
- 支付预下单返回微信支付参数。
- 不输出密钥到日志。

### 失败时可能原因

- 证书路径错误。
- APIv3 Key 错误。
- 商户号与 AppID 未绑定。
- 微信支付公钥不匹配。
- notify URL 不可公网访问。

### 对应代码文件

- `cms/server.js`
- `.env`
- `DEPLOY.md`

---

## 8. 支付回调

### 测试步骤

1. 使用真实微信支付完成一笔小额订单。
2. 等待微信支付回调 `/api/pay/notify`。
3. 查看后台订单状态。
4. 检查日志是否有验签或金额错误。

### 预期结果

- 回调验签通过。
- 解密资源成功。
- 二次查询微信支付订单成功。
- 金额与后端订单金额一致。
- 订单状态更新为已支付/待发货。
- 重复回调不会重复处理奖励。

### 失败时可能原因

- Nginx 未转发 raw body。
- 微信支付公钥配置错误。
- APIv3 Key 错误。
- 订单金额不匹配。
- notify URL 无法访问。

### 对应代码文件

- `cms/server.js`
- Nginx 配置
- `.env`

---

## 9. 订单列表只显示当前用户订单

### 测试步骤

1. 使用微信用户 A 登录。
2. A 下单。
3. 打开订单页，确认只看到 A 的订单。
4. 清缓存或换设备，使用微信用户 B 登录。
5. B 打开订单页。
6. 尝试在请求参数中伪造 A 的 openid/userToken。

### 预期结果

- B 不能看到 A 的订单。
- 后端只使用服务端签发的 `userSession/userToken`。
- 伪造前端参数无效。

### 失败时可能原因

- 前端未带 `X-User-Session`。
- 后端 session 丢失。
- 订单历史数据缺少身份字段。

### 对应代码文件

- `pages/orders/orders.js`
- `utils/api.js`
- `utils/auth.js`
- `cms/server.js`

---

## 10. 后台订单管理

### 测试步骤

1. 登录后台。
2. 进入订单管理。
3. 搜索订单号/客户名/手机号。
4. 查看订单详情。
5. 填写快递公司和快递单号。
6. 标记已发货。
7. 用户端订单页刷新。

### 预期结果

- 后台可查看全部订单。
- 未登录后台不能访问订单接口。
- 发货信息保存成功。
- 用户端同步显示物流信息。

### 失败时可能原因

- 后台 cookie 过期。
- `/api/admin/orders` 返回 401。
- 数据库写入失败。
- 前端订单页未刷新。

### 对应代码文件

- `cms/admin.html`
- `cms/server.js`
- `pages/orders/orders.js`

---

## 11. 后台商品新增、修改、删除

### 测试步骤

1. 登录后台。
2. 进入商品管理。
3. 新增商品，填写名称、价格、分类、主图。
4. 保存。
5. 修改商品价格/状态/分类。
6. 删除测试商品。
7. 小程序首页和分类页刷新。

### 预期结果

- 新增商品出现在后台列表。
- 上架商品前台可见。
- 下架商品前台不可见。
- 修改后前台同步。
- 删除后前台不再显示。

### 失败时可能原因

- 商品字段格式不对。
- 图片上传失败。
- `/api/admin/products` 未保存。
- 前端缓存或 fallback 数据未刷新。

### 对应代码文件

- `cms/admin.html`
- `cms/server.js`
- `pages/index/index.js`
- `pages/category/list.js`
- `pages/product/detail.js`

---

## 12. 后台 Banner 上传

### 测试步骤

1. 登录后台。
2. 进入页面装修/Banner 管理。
3. 上传 Banner 图片。
4. 填写标题、副标题、跳转类型和跳转目标。
5. 保存。
6. 刷新小程序首页/我的页/帮助中心。

### 预期结果

- 上传成功。
- Banner 图片后台预览正常。
- 小程序对应位置显示新 Banner。
- 点击 Banner 可跳转。

### 失败时可能原因

- 图片格式或大小不符合。
- 上传接口返回 URL 错误。
- 跳转目标未配置。
- 小程序页面读取 Banner 位错误。

### 对应代码文件

- `cms/admin.html`
- `cms/server.js`
- `pages/index/index.js`
- `pages/profile/profile.js`
- `pages/help/help.js`

---

## 13. 小程序端图片是否同步显示

### 测试步骤

1. 后台上传商品主图。
2. 保存商品。
3. 小程序首页查看商品图。
4. 分类页查看商品图。
5. 商品详情页查看轮播图和详情图。
6. 真机测试图片加载。

### 预期结果

- 图片 URL 为正式 API 域名或可访问路径。
- 不出现 `127.0.0.1`、`localhost`、`192.168.*` 在正式环境。
- 图片加载不报合法域名错误。

### 失败时可能原因

- `PUBLIC_BASE_URL` 配置错误。
- 图片仍是本地地址。
- uploadFile/downloadFile 合法域名未配置。
- Nginx 未代理 `/uploads/`。

### 对应代码文件

- `utils/api.js`
- `cms/server.js`
- `pages/index/index.js`
- `pages/category/list.js`
- `pages/product/detail.js`

---

## 14. 退款申请流程

### 测试步骤

1. 用户登录。
2. 找到自己的订单。
3. 点击申请退款或退货退款。
4. 填写退款原因、金额、备注。
5. 可选上传图片。
6. 提交。
7. 后台订单管理查看售后状态。
8. 后台审核通过/部分退款/拒绝。

### 预期结果

- 未登录不能申请。
- 用户只能申请自己的订单。
- 后台能看到退款详情。
- 审核结果同步到用户端。
- 退款成功后奖励/购物金按规则扣回。

### 失败时可能原因

- 订单归属校验失败。
- 退款金额超过订单金额。
- 图片上传失败。
- 后台审核接口权限问题。
- 真实原路退款 API 未完成或未配置。

### 对应代码文件

- `pages/orders/orders.js`
- `cms/admin.html`
- `cms/server.js`

---

## 15. 两个不同微信用户之间订单隔离测试

### 测试步骤

1. 准备两个微信账号 A 和 B。
2. A 登录并下单。
3. B 登录并下单。
4. A 查看订单页。
5. B 查看订单页。
6. 使用抓包或开发工具尝试把 B 请求参数改成 A 的 openid。
7. 尝试 B 支付 A 的订单号。

### 预期结果

- A 只看到 A 的订单。
- B 只看到 B 的订单。
- 伪造 openid/userId/userToken 无效。
- B 支付 A 订单返回 `403 无权支付该订单`。
- 历史空身份订单返回 `403 订单缺少用户身份，请联系商家处理`。

### 失败时可能原因

- 前端未传 `X-User-Session`。
- 后端用户 session 丢失。
- 历史订单身份字段为空。
- 支付归属校验被绕过。

### 对应代码文件

- `utils/api.js`
- `utils/auth.js`
- `pages/orders/orders.js`
- `cms/server.js`

---

## 16. 生产环境 .env 安全检查

### 测试步骤

1. 检查生产 `.env`。
2. 确认：

```env
NODE_ENV=production
PAY_MOCK=false
PUBLIC_BASE_URL=https://api.feichangjiandan.xyz
```

3. 检查 `ADMIN_USER` 不是 `admin`。
4. 检查 `ADMIN_PASSWORD` 至少 16 位。
5. 检查 `SESSION_SECRET` 至少 32 位且不是示例值。
6. 检查 `.env` 未提交仓库、未进入小程序上传包。

### 预期结果

- 生产环境配置安全。
- `PAY_MOCK=true` 时服务拒绝启动。
- `SESSION_SECRET` 示例值时服务拒绝启动。
- 小程序上传包不包含 `.env`。

### 失败时可能原因

- 忘记重启 Node 服务。
- PM2 使用旧环境变量。
- `.env` 路径错误。
- `project.config.json` 忽略规则被误删。

### 对应代码文件

- `.env`
- `.env.example`
- `cms/server.js`
- `project.config.json`
- `project.private.config.json`
- `DEPLOY.md`

---

## 17. Nginx、HTTPS、微信合法域名检查

### 测试步骤

1. 检查 Nginx：

```bash
nginx -t
systemctl status nginx
```

2. 检查 HTTPS：

```bash
curl -I https://api.feichangjiandan.xyz/api/health
curl -I https://www.feichangjiandan.xyz
```

3. 检查端口：

```bash
ss -lntp | grep 80
ss -lntp | grep 443
ss -lntp | grep 3000
```

4. 微信公众平台配置合法域名：

- request：`https://api.feichangjiandan.xyz`
- uploadFile：`https://api.feichangjiandan.xyz`
- downloadFile：如需要加载资源，也加入该域名

5. 真机打开体验版，测试首页、图片、上传、下单。

### 预期结果

- HTTPS 证书有效。
- API 域名可访问。
- 80 跳转 443。
- Nginx 正确代理到 Node 3000。
- 微信开发者工具和真机不报合法域名错误。
- `/uploads/` 可加载图片，但脚本类型不可执行。

### 失败时可能原因

- 域名未备案或解析错误。
- 证书未绑定正确站点。
- Nginx http2/TLS 配置与微信开发者工具兼容问题。
- 反向代理没转发到 3000。
- 微信后台合法域名未配置。
- `PUBLIC_BASE_URL` 仍是本地地址。

### 对应代码文件/配置

- `utils/api.js`
- `cms/server.js`
- `.env`
- Nginx 站点配置
- 微信公众平台合法域名设置

---

## 上线前最终通过标准

必须全部满足：

- 微信手机号授权登录真机通过。
- 首页、分类页、商品详情页加载正常。
- 图片上传 1 张、9 张、超大、错误格式均符合预期。
- 下单成功，订单写入后台。
- 模拟支付仅开发可用。
- 正式微信支付配置完整。
- 支付回调验签和订单更新正常。
- 用户订单隔离通过。
- 后台商品、订单、Banner 管理正常。
- 退款申请和后台审核流程可用。
- 生产 `.env` 安全。
- HTTPS、Nginx、微信合法域名配置完成。

