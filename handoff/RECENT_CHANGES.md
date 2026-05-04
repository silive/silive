# 近期重要变更记录

本记录用于帮助新接手者理解最近几轮修复方向。

## 1. 品牌统一

项目品牌已统一为：

```text
非常智造
```

涉及：

- 首页
- 订单页
- 我的页
- 分享文案
- 版权信息
- 后台展示字段

## 2. 登录体验

新增统一登录底部弹窗组件：

```text
components/login-sheet/
```

使用场景：

- 商品详情页点击立即定制
- 订单页未登录
- 我的页未登录

登录链路：

1. 用户点击授权手机号按钮。
2. 小程序得到 `e.detail.code`。
3. 同时执行 `wx.login` 获取 loginCode。
4. 后端 `/api/wechat/phone` 换手机号和 openid。
5. 后端签发 `userSession`。
6. 前端保存登录态。

## 3. 订单身份安全修复

订单接口已改为只信任服务端 session：

- 不再信任前端传来的 `openid/userId/userToken`。
- `/api/orders` 无有效 session 返回未登录。
- `/api/pay/wechat` 只使用 session 解析出的 openid。
- 用户只能查看自己的订单。
- 后台管理员接口查看全部订单，但必须登录后台。

## 4. 微信支付归属校验修复

修复了高危顺序问题：

旧问题：

- `createWechatPay()` 在订单归属校验前先执行 `setOrderOpenid(orderId, openid)`。

新逻辑：

1. 先读取订单。
2. 判断订单是否存在。
3. 校验订单 `openid/userToken` 是否归属当前 session。
4. 历史空身份订单直接 403。
5. 只有订单 `userToken` 匹配且 `openid` 为空时，才补写当前 openid。
6. 然后才进行微信统一下单。

## 5. 生产安全配置

新增/强化：

- 非 production 启动输出安全警告。
- 生产 `PAY_MOCK=true` 拒绝启动。
- 生产 `SESSION_SECRET` 缺失、过短或示例值，拒绝启动。
- 生产 `PUBLIC_BASE_URL` 必须为 HTTPS 且不能是本地地址。
- `/api/pay/mock-success` 生产固定返回 403。

## 6. 后台登录安全

新增：

- 同一 IP 10 分钟内最多失败 5 次。
- 超过后锁定 10 分钟。
- 成功登录后清除该 IP 失败计数。
- 生产 cookie 追加 `Secure`。

## 7. 图片上传安全

`/api/upload/public` 已加固：

- 已登录上传：10MB，单 session/IP 10 分钟 100 次。
- 未登录临时上传：5MB，单 IP 10 分钟 20 次。
- 每次最多 9 张。
- 真实文件头检测 jpg/png/webp/heic。
- 不信任扩展名或 MIME。
- 随机文件名。
- 未登录图片使用 `temp-` 前缀。
- 超过 24 小时未绑定订单的临时图片自动清理。

## 8. 推荐事件接口加固

`/api/order-recommendation/event`：

- 单 IP 每分钟 60 次。
- 事件类型只允许 `click/conversion`。
- 校验 `productId/orderId` 格式。
- 转化事件如果传 `orderId`，必须关联真实订单。

## 9. 商品批量导入

新增后台商品批量导入：

- 下载 Excel 模板。
- 上传 Excel。
- 上传 images.zip。
- 解析预览。
- 图片文件名匹配。
- 确认导入。
- 新增/更新商品。

安全加固：

- Excel 最大 5MB。
- ZIP 最大 50MB。
- ZIP 只允许图片。
- 禁止路径穿越。
- 禁止脚本/可执行文件。
- 失败清理临时文件。

## 10. 动态换肤状态

后台皮肤管理已实现，但小程序前端暂时停用远程主题：

```js
const ENABLE_REMOTE_THEME = false
```

当前前端稳定使用 `skin01`。

## 11. 当前本地后台账号

本交接包不记录真实后台密码。请查看 `.env` 获取本地账号，生产环境务必重新设置强密码。

