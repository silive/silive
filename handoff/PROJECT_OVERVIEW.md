# 非常智造项目交接总览

更新时间：2026-05-02

## 1. 项目定位

“非常智造”是一个微信小程序 + Node.js 后台 CMS 项目，面向定制礼物、电商商品展示、上传图片定制、订单支付、售后与推广裂变场景。

核心业务包括：

- 微信小程序首页商品展示、分类浏览、搜索、商品详情。
- 用户微信手机号授权登录。
- 上传参考图片，下单定制。
- 微信支付预下单与支付回调。
- 订单列表、退款申请、物流信息展示。
- 我的页面、帮助中心、客服入口、推广页。
- 后台 CMS 管理商品、类目、订单、Banner、帮助中心、活动、皮肤、批量导入商品。
- 图片上传、AI 预览接口预留、推广奖励与购物金逻辑。

## 2. 技术栈

- 小程序端：微信小程序原生 WXML / WXSS / JS。
- 后端：Node.js 原生 `http/https` 服务，入口为 `cms/server.js`。
- 数据库：优先 MySQL 8；未安装 `mysql2` 或本地开发时可回退 JSON 文件存储。
- 后台 CMS：原生 HTML + JS，主要文件 `cms/admin.html`、`cms/login.html`。
- 图片存储：本地 `cms/uploads/`，生产环境建议挂载持久化目录或对象存储。
- 进程管理：生产建议 PM2。
- Web 服务器：生产建议 Nginx 反向代理到 Node 3000 端口。

## 3. 当前运行方式

本地服务：

```bash
npm start
# 等价于
node cms/server.js
```

默认本地访问：

- 后台登录页：http://127.0.0.1:3000/login
- 后台管理页：http://127.0.0.1:3000/admin
- 健康检查：http://127.0.0.1:3000/api/health
- 小程序开发 API：http://127.0.0.1:3000

生产 API 域名配置在 `utils/api.js`：

- 主 API：`https://api.feichangjiandan.xyz`
- 备用 API：`https://hk-api.feichangjiandan.xyz`

## 4. 页面结构

小程序页面注册在 `app.json`：

- `pages/index/index`：首页
- `pages/category/list`：一级/二级类目商品列表
- `pages/poster/poster`：海报页
- `pages/product/detail`：商品详情页
- `pages/checkout/checkout`：确认定制/下单页
- `pages/promotion/promotion`：我的推广页
- `pages/help/help`：帮助中心/售后保障
- `pages/orders/orders`：订单页
- `pages/profile/profile`：我的页面

底部 Tab：

- 首页
- 订单
- 我的

## 5. 核心模块说明

### 首页

首页读取 `/api/home`，展示：

- Banner
- 动态入口
- 信任标签
- 热门推荐商品
- 爆款/评价/客服入口
- 搜索栏

首页商品数据主要来自 `home.products`，后台商品保存后同步到首页配置。

### 商品与类目

商品字段支持：

- 主图
- 轮播图
- 视频 URL
- 详情图
- 详情文字
- 一级/二级类目
- 标签
- 是否热门推荐
- 是否推广页热门
- 库存、成本价、推广奖励
- AI 预览配置

类目结构存放在系统设置中的 `categoryCatalog`。

### 登录

前端登录逻辑在 `utils/auth.js`：

- `wx.login` 获取 code。
- `getPhoneNumber` 按钮回调拿 `e.detail.code`。
- 后端 `/api/wechat/phone` 用手机号 code + loginCode 换手机号和 openid。
- 后端签发 `userSession`。
- 前端存储 `userSession`、`userToken`、`openid`、`memberPhone`。

### 订单

订单接口已加固：

- 用户端订单接口只认服务端签发的 `userSession/userToken`。
- 不信任前端直接传来的 `openid/userId/userToken`。
- 用户只能查看和操作自己的订单。
- 后台管理员接口可查看全部订单，但必须后台登录。

### 支付

微信支付接口：

- `/api/pay/wechat`：用户端创建微信 JSAPI 支付参数。
- `/api/pay/notify`：微信支付回调。
- `/api/pay/mock-success`：仅非生产、`PAY_MOCK=true`、本机或管理员登录时可用。

生产安全要求：

- `NODE_ENV=production`
- `PAY_MOCK=false`
- HTTPS 的 `PUBLIC_BASE_URL`
- 微信支付证书、公钥、APIv3 Key 均只放在 `.env`，不要进入代码仓库。

### 上传

公开上传接口 `/api/upload/public`：

- 登录用户：最大 10MB。
- 未登录临时上传：最大 5MB。
- 每次最多 9 张。
- 未登录限流：单 IP 10 分钟 20 次。
- 已登录限流：单 userSession 或单 IP 10 分钟 100 次。
- 只允许真实文件头检测通过的 jpg/png/webp/heic。
- 随机文件名，不使用原始文件名。
- `temp-` 临时图超过 24 小时且未绑定订单会自动清理。

### 后台 CMS

后台功能集中在 `cms/admin.html` + `cms/server.js`：

- 数据总览
- 商品中心
- 类目管理
- 订单中心
- 用户/客户
- 营销/推广
- 页面装修/Banner
- 活动管理
- 帮助中心
- 皮肤管理
- 商品批量导入

## 6. 当前主题状态

动态换肤后端与后台皮肤管理保留，但小程序前端为了稳定，当前 `utils/theme.js` 中：

```js
const ENABLE_REMOTE_THEME = false
```

因此前端固定使用本地 `skin01` 橙粉青春商城主题。后续若要恢复动态换肤，需要单独分支重构和测试。

## 7. 敏感信息说明

交接包不包含以下真实信息：

- 数据库密码
- 微信 AppSecret
- 微信支付 APIv3 Key
- 商户私钥
- 商户证书
- 微信支付公钥内容
- 后台真实密码
- 服务器 SSH 地址、账号、密码

真实配置只应存放在本地或服务器 `.env`，且 `.env` 已加入小程序上传包忽略。

