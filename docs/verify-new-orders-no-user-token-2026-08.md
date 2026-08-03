# 新订单不保存 user_token 与 user_id 归属专项验证

- 日期：2026-08-04（Asia/Shanghai）
- 项目：`/Users/xiaomo/Documents/Codex/2026-04-25/gpt-5-5`
- 当前 HEAD：`896b682a0f52fd7bfe2ee7a288251aaa934be855`
- 专项状态：**PASS**
- 测试数据库：`vsc_security_test_order_ownership`
- 数据范围：仅虚构测试用户、Session、商品和订单；未读取 `.env`，未连接生产数据库。

## 结论

当前唯一对外的新订单创建入口 `/api/orders` 使用服务端验证后的 Session 解析 `customers.id`，请求体中的 `userId`、`openid`、手机号和 token 均会被覆盖。业务创建 SQL 与通用订单保存 SQL 均不再包含 `orders.user_token`；新订单该列保持 `NULL`。订单列表、详情、支付、退款和售后均以服务端 Session 得到的 `user_id` 为第一归属依据，新订单不会进入旧手机号/openid兼容分支。

后台 `/api/admin/orders` PUT 已限定为编辑已有订单，不能再借该接口补单、导入或克隆新订单。编辑新订单时不能写入 `user_token`；编辑带旧 token 的历史订单时保留旧值，不扩大兼容访问权限。`orders.user_token` 字段没有删除，历史数据没有修改或清理。

## 工作区基线

执行了用户指定的六项检查。基线为：分支 `main`，HEAD `896b682a0f52fd7bfe2ee7a288251aaa934be855`；工作区原有大量未提交修改。本轮未运行 `git reset`、`git clean`、`git restore`、`git checkout` 或 `git stash`，也未覆盖既存修改。开始和结束时 `git diff --check` 均通过。

## 新订单创建入口清单

| 入口 | 文件和函数 | user_id 来源 | 是否写 user_token |
|---|---|---|---|
| 小程序普通商品、购物车、定制上传下单 `POST /api/orders` | `cms/server.js`：路由处理 → `resolveIdentityFromRequest()` → `ensureInternalUserIdentity()` → `createOrder()` | 服务端校验 Session 后匹配/建立的内部 `customers.id`；客户端身份字段被覆盖 | 否；`createOrder()` 的 INSERT 已完全移除该列 |
| 管理后台订单批量 PUT（曾可作为补单/导入入口） | `cms/server.js`：`PUT /api/admin/orders` → `saveOrders()` | 不再允许创建；仅编辑数据库中已存在的订单 | 否；新记录被拒绝，更新 SQL 不触碰旧字段 |
| 空库启动时的历史 `orders.json` 种子导入 | `cms/server.js`：`initDb()` → `saveOrders(readSeed(...))` | 历史初始化数据，不是在线新订单；隔离测试通过 `MYSQL_TEST_SKIP_SEED_DATA=true` 禁用 | 不写；`saveOrders()` INSERT 已移除该列；既存历史行更新时保留原值 |
| MySQL 安全测试订单夹具 | `scripts/test-security-mysql.js`：`insertOrder()` | 虚构测试夹具，不是业务入口 | 否；INSERT 未包含该列 |
| 企业微信通知数据库测试夹具 | `scripts/test-wecom-order-notification-db.js` | 虚构测试夹具，不是业务入口 | 否；INSERT 未包含该列 |
| 本专项真实 MySQL 测试 | `scripts/test-order-ownership-mysql.js` | A/B 虚构内部用户与 token_hash Session | 新订单不写；另有一个明确标记的虚构历史夹具故意写旧值，用于证明编辑历史订单会保留兼容字段 |

全仓库没有找到独立的后台创建、补单、复制或克隆订单函数，也没有找到业务维护脚本创建真实订单；相关脚本对 `orders` 的其他操作均为 UPDATE。按“可触发新订单产生的应用入口”计数为 3：在线下单、后台 PUT（现已禁用创建）、历史种子初始化。当前可在线创建新订单的入口只有 1 个。

## 初始失败证据与最小修复

修复前，在第一次干净隔离库中通过真实管理员登录和 `PUT /api/admin/orders` 提交虚构订单：

```text
INITIAL-FAIL-USER-TOKEN  USER-FICTIONAL  plaintext-session-must-not-save
```

数据库查询证明明文 token 被保存，因此初始结果为 FAIL。随后仅做以下范围内修复：

1. 从 `createOrder()` 的 INSERT 中移除 `user_token` 列和值。
2. 从 `saveOrders()` 的 INSERT/ON DUPLICATE KEY UPDATE 中移除 `user_token`，JSON 模式中新记录清空、历史记录保留原值。
3. 后台订单 PUT 遇到不存在的订单 ID 时返回 400，取消其隐式创建/导入能力。
4. 合并同名注销路由的用户 Session 撤销动作，确保 token_hash 记录与内存 Session 同时失效。
5. 退款/售后越权明确返回 403。

未删除字段，未修改或清理历史订单，未扩大手机号/openid旧兼容分支。

## 真实隔离 MySQL 专项结果

专项命令：

```text
MYSQL_TEST_SKIP_DOTENV=true NODE_ENV=test MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 \
MYSQL_USER=root MYSQL_PASSWORD='' MYSQL_TEST_DATABASE=vsc_security_test_order_ownership \
npm run test:order-ownership-mysql
```

每次测试先精确删除并重建 `vsc_security_test_order_ownership`，由真实 `cms/server.js` 初始化完整项目表，再经真实 HTTP 路由调用 `createOrder()`。最终结果：

| 验证项 | 结果 |
|---|---|
| 用户 A 与服务端 Session | PASS；数据库只存 token_hash |
| 用户 A 正常创建订单 | PASS |
| `orders.user_id` 等于 A 内部 ID | PASS；`USER-A-INTERNAL` |
| `orders.user_token` | PASS；`NULL` |
| 伪造 B 的 user_id | PASS；被忽略 |
| 伪造 B 的 openid/手机号 | PASS；被忽略 |
| A 列表/详情读取 | PASS |
| B 列表不可见 | PASS |
| B 详情读取 | PASS；404 |
| B 支付 | PASS；403 |
| B 退款 | PASS；403 |
| B 售后 | PASS；403 |
| A 注销后旧 Session | PASS；401 |
| A 新 Session 读取历史订单 | PASS；通过相同内部 user_id 可见 |
| 旧 `userToken` 参数与 `x-user-token` 路径 | PASS；均为 401，不能访问新订单 |
| 后台伪造新订单 | PASS；400 且数据库无记录 |
| 后台编辑注入 token | PASS；新订单列仍为 NULL |
| 历史 token 字段保留 | PASS；编辑虚构历史夹具后旧值保持不变 |

安全护栏也做了负向自测：缺少 `MYSQL_TEST_DATABASE`、`NODE_ENV=production`、非本机 host、数据库名无 `vsc_security_test_` 前缀均在连接/建库前拒绝。

## 回归结果

| 命令 | 结果 |
|---|---|
| `npm run test:security-session-promotion` | PASS |
| `npm run test:order-domain` | PASS |
| `npm run test:order-chain` | PASS |
| `npm run test:security-boundaries` | PASS |
| `npm run test:security-p0` | PASS |
| `npm run test:order-ownership-mysql` | PASS |
| `node --check cms/server.js` | PASS |
| `node --check scripts/test-order-ownership-mysql.js` | PASS |
| `git diff --check` | PASS |

## 最终判定

**PASS**

所有在线新订单入口均不写 `user_token`；新订单 `user_id` 来自服务端认证 Session；真实 MySQL 测试和指定回归均通过；B 无法访问、支付、退款或售后 A 的订单；注销后旧 Session 失效；重新登录仍通过内部 `user_id` 访问历史订单；旧 token 路径不能访问新订单。

本轮未提交、未推送、未部署、未上传小程序。
