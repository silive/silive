# 项目文件结构说明

## 1. 根目录关键文件

```text
app.js
app.json
app.wxss
project.config.json
project.private.config.json
sitemap.json
package.json
DEPLOY.md
.env
.env.example
```

说明：

- `app.js`：小程序全局入口，初始化全局数据。
- `app.json`：页面注册、窗口、TabBar 配置。
- `app.wxss`：小程序全局样式。
- `project.config.json`：微信开发者工具项目配置，已配置打包忽略。
- `project.private.config.json`：本机私有小程序配置，包含 AppID 和本机设置。
- `package.json`：Node 后端启动脚本和依赖。
- `.env`：本地/服务器真实环境变量，禁止提交、禁止打包。
- `.env.example`：示例环境变量，只能放占位符。

## 2. 小程序页面

```text
pages/index/
pages/category/list/
pages/poster/
pages/product/detail/
pages/checkout/
pages/promotion/
pages/help/
pages/orders/
pages/profile/
```

### `pages/index`

首页页面。

关键文件：

- `index.js`：读取首页数据、搜索、Banner、入口、商品列表。
- `index.wxml`：首页结构。
- `index.wxss`：首页样式。
- `default-data.js`：接口失败时的前端兜底数据。

### `pages/category/list`

一级类目和二级类目商品列表。

功能：

- 从 `/api/home` 或 `/api/products` 读取最新类目/商品。
- 支持二级类目筛选。
- 空类目展示“新品正在上架中”并提供客服、返回全部、上传图片定制入口。

### `pages/product/detail`

商品详情页。

功能：

- 商品图片/视频轮播。
- 商品名称、价格、分类标签。
- 详情图文。
- 新人福利展示。
- “立即定制”和“推荐给朋友”。
- 点击下单时触发微信手机号授权登录。

### `pages/checkout`

确认定制/下单页。

功能：

- 接收 `productId` 或自由定制参数 `mode=custom&category=...`。
- 手机号校验：`^1[3-9]\d{9}$`。
- 上传参考图片，最多 9 张。
- AI 预览接口调用。
- 提交订单。
- 发起微信支付或本地 mock 支付。

### `pages/orders`

订单页。

功能：

- 未登录时弹出登录组件。
- 订单状态宫格。
- 最近订单。
- 猜你喜欢推荐。
- 退款申请。
- 订单推荐点击统计。

### `pages/profile`

我的页面。

功能：

- 微信快捷登录。
- 用户头像/手机号脱敏。
- 购物金/推广/订单/客服/收货地址/售后保障入口。
- Banner4。
- 版权信息。

### `pages/promotion`

推广页。

功能：

- 我的购物金、待发放、邀请人数、成交订单。
- 首页邀请链接和二维码。
- 推荐热门商品。
- 分享首页带 `invite` 参数。

### `pages/help`

帮助中心/售后保障。

功能：

- 帮助文章列表。
- 文章内容。
- Banner5。
- 客服入口。

## 3. 组件

```text
components/login-sheet/
```

统一登录授权底部弹窗：

- 商品详情页
- 订单页
- 我的页

使用微信官方 `open-type=getPhoneNumber`。

## 4. 工具模块

```text
utils/api.js
utils/auth.js
utils/theme.js
```

### `utils/api.js`

统一请求封装：

- 开发环境走 `http://127.0.0.1:3000`。
- release 走正式 HTTPS 域名。
- 自动带 `X-User-Session` 请求头。
- 支持 API 备用域名。
- 支持 `wx.uploadFile` fallback。

### `utils/auth.js`

微信登录与手机号授权：

- `getLoginState()`
- `ensureOpenid()`
- `loginWithPhoneDetail(detail)`
- `logout()`

### `utils/theme.js`

主题样式工具。当前远程换肤关闭：

```js
const ENABLE_REMOTE_THEME = false
```

小程序使用内置 `DEFAULT_THEME`。

## 5. 后台 CMS

```text
cms/server.js
cms/admin.html
cms/login.html
cms/test.html
cms/mysql/schema.sql
cms/data/
cms/uploads/
```

### `cms/server.js`

后端核心文件，包含：

- HTTP/HTTPS 服务
- 环境变量加载
- MySQL 初始化
- JSON 兜底存储
- API 路由
- 管理员登录
- 上传
- 商品/订单/支付/推广/主题/导入等业务逻辑

### `cms/admin.html`

后台管理单页应用。包含：

- 商品管理
- 类目管理
- 首页装修
- Banner
- 活动
- 帮助中心
- 订单
- 客户
- 推广
- 皮肤
- 批量导入商品

### `cms/data`

本地 JSON 数据兜底目录。生产如果使用 MySQL，仍可能用于初始 seed。

注意：`cms/data` 已加入小程序打包忽略。

### `cms/uploads`

本地上传文件目录。生产建议持久化。

注意：`cms/uploads` 已加入小程序打包忽略。

## 6. 主题目录

```text
themes/skin01/
themes/skin02/
themes/skin03/
themes/skin04/
```

每套皮肤包含：

- `colors.json`
- `theme.wxss`

后台皮肤管理保留，但小程序端当前不启用远程换肤。

## 7. 打包忽略

`project.config.json` 和 `project.private.config.json` 中已忽略：

- `.env`
- `.env.*`
- `cms`
- `cms/data`
- `cms/uploads`
- `themes`
- `package.json`
- `package-lock.json`
- `DEPLOY.md`
- `.env.example`

这可以防止后台、上传目录、配置和密钥进入小程序上传包。

