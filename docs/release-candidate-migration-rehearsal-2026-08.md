# 旧生产结构到新服务的隔离迁移彩排（2026-08）

## 结论

迁移前检查：**PASS**
迁移第一次执行：**PASS**
迁移后结构：**PASS**
迁移重复执行：**PASS**
重复迁移业务数据变化：**0**
新服务启动：**PASS**
启动自动历史写入：**0**
支付 Worker：**PASS**
超时 Worker：**PASS**
测试订单清理 dry-run：**PASS（10 笔）**
测试订单清理 apply：**PASS（10 笔）**
误删白名单外订单：**0**
迁移后 MySQL 并发：**PASS**
新订单 `user_token`：**PASS（0 笔非空）**
AI 预览默认状态：**PASS（关闭）**
数据一致性终检：**PASS（异常 0）**

发布候选准备：**PASS**
迁移彩排：**PASS**
测试订单清理彩排：**PASS**
新订单 `user_token` 验证：**PASS**
允许进入受控生产部署准备：**YES**
正式发布状态：**仍 BLOCKED**

“YES”只表示可以继续准备生产变更单、备份、白名单复核和人工审批；本轮没有连接生产、执行生产迁移、部署、提交、推送或上传。

## 隔离与旧结构重建

- 基础 HEAD：`896b682a0f52fd7bfe2ee7a288251aaa934be855`；当前工作区原有蓝队修改全部保留。
- 数据库：`vsc_security_test_migration_rehearsal`，MySQL 8.0.46，仅监听 `127.0.0.1:33321`，使用纯虚构账号和数据。
- 未读取 `.env`，所有服务和脚本均显式传入测试连接；未导入生产业务数据。
- 先用当前 `cms/server.js` 在空隔离库生成完整结构模板，再按生产只读报告降级：移除 7 张新表、支付截止/库存时间字段、新业务键列、Worker 索引等，保留旧 `orders.user_token`、旧订单、退款、库存累计和财务数据。
- 旧结构夹具包含 1 个用户、12 个商品、1 个门店、1 个门店成员、1 个业务员、10 笔测试订单和 2 笔正常订单；覆盖未支付、已支付、取消、部分/全额退款、三种库存模式、部分/完整释放、未结算和已结算财务。

旧结构没有提前保留 `payment_finance_outbox`、`order_payment_timeout_jobs`、`order_inventory_reservations`、`order_inventory_release_events`、`financial_record_item_allocations`、`store_referral_attributions` 或 `promotion_relation_claims`。

## 迁移目录完整性

| 文件 | 创建/修改对象 | 前置条件 | 是否修改业务数据 | 是否可重复执行 |
|---|---|---|---|---|
| `001_precheck.sql` | 只读版本、表/列/索引计数；完整数据门禁由只读 preflight 执行 | 本地隔离连接 | 否 | 是 |
| `002_payment_finance_outbox.sql` | 财务 Outbox、状态/锁/重试字段、业务键及 Worker 索引 | preflight 无重复 | 否 | 是，表存在时跳过 |
| `003_order_payment_timeout.sql` | 订单支付截止/预占/释放时间、超时任务及 due/lock 索引 | `orders` 存在 | 否 | 是，列/等价索引由执行器跳过 |
| `004_inventory_release_ledger.sql` | 预占表、累计释放模型、`updated_at` 和索引 | `order_inventory_releases` 数据合法 | 否 | 是 |
| `005_inventory_release_events.sql` | 库存释放事件、唯一业务键和来源索引 | preflight 无异常累计 | 否 | 是 |
| `006_required_indexes.sql` | 退款商品字段/索引、财务业务键、财务分摊、推广认领、门店归因、通知 claim 字段、支付/幂等/取货唯一约束 | 所有唯一候选无重复 | 否 | 是，等价对象跳过 |
| `007_postcheck.sql` | `information_schema` 表/列/索引/引擎/字符集终检 | 前六步成功 | 否 | 是 |

所有新表显式使用 `InnoDB`、`utf8mb4`、`utf8mb4_unicode_ci`，与旧库一致。迁移不含 `DROP`、`TRUNCATE`、历史订单删除、`user_token` 清空、库存释放、订单关闭、财务补建或 Worker 启动。

## 迁移前只读检查

新增 `scripts/preflight-production-migration.js`，在显式 `START TRANSACTION READ ONLY` 中检查：

- 缺失表、字段和索引；
- 支付交易号、退款号、三类财务业务键、推广 invitee、幂等作用域、取货码/订单的重复候选；
- 负库存、异常订单数量、孤立订单商品、累计释放超购买量；
- 旧订单非空 `user_token` 数量和缺失 `user_id` 数量；
- `AI_PREVIEW_ENABLED` 必须保持关闭。

旧夹具正确报告 7 张新表缺失、12 笔旧订单保留虚构 `user_token`，重复候选和历史一致性异常均为 0。另插入一条重复 invitee 反例后，迁移在任何 DDL 前以 `MANUAL_REVIEW` 安全停止，结构没有变化；日志只给出哈希脱敏示例。

## 第一次完整迁移执行记录

| 顺序 | 文件 | UTC 开始 | UTC 结束 | 退出码 | 新增对象摘要 | 业务数据修改 |
|---:|---|---|---|---:|---|---|
| 1 | `001_precheck.sql` | 18:06:10.243 | 18:06:10.248 | 0 | 只读校验 | 否 |
| 2 | `002_payment_finance_outbox.sql` | 18:06:10.248 | 18:06:10.255 | 0 | Outbox 表、15 字段、4 索引 | 否 |
| 3 | `003_order_payment_timeout.sql` | 18:06:10.255 | 18:06:10.286 | 0 | 订单 3 字段、超时任务表、5 索引 | 否 |
| 4 | `004_inventory_release_ledger.sql` | 18:06:10.286 | 18:06:10.296 | 0 | 预占表、累计释放 `updated_at` | 否 |
| 5 | `005_inventory_release_events.sql` | 18:06:10.296 | 18:06:10.304 | 0 | 释放事件表、唯一键和 3 个查询索引 | 否 |
| 6 | `006_required_indexes.sql` | 18:06:10.304 | 18:06:10.388 | 0 | 3 张表、财务/通知字段、19 个新增索引 | 否 |
| 7 | `007_postcheck.sql` | 18:06:10.388 | 18:06:10.395 | 0 | 3 组结构校验查询 | 否 |

执行器逐文件执行；任一语句失败会停止，不执行后续文件。10 个已有等价字段/索引在第 6 步被幂等跳过。

## 迁移后结构验证

通过真实 `SHOW CREATE TABLE`、`DESCRIBE`、`SHOW INDEX` 和 `information_schema` 验证：

1. `payment_finance_outbox.business_key` 唯一，due/order 索引包含 Worker 查询字段；
2. `orders.payment_expires_at/stock_reserved_at/stock_released_at` 存在；
3. 超时任务使用自增 `id`、唯一 `order_id`，包含 `available_at/locked_at/locked_by/processed_at/last_error` 和 due/lock 索引；
4. 库存预占表存在；`order_inventory_releases.quantity` 注释和语义均为累计量；
5. 库存事件业务键唯一，item/order/source 索引存在；
6. 退款数量/金额/冲正字段和 `(order_item_id,status)` 索引存在；
7. 推广奖励、门店财务、业务员佣金业务键唯一；
8. promotion invitee、幂等作用域、取货码订单和支付 transaction 唯一约束存在；
9. 所有新表的类型、默认值、引擎和 collation 与当前服务 SQL 一致。

## 重复迁移

未重建数据库，第二次按相同 7 文件执行：全部退出码 0；已有表、列和等价索引被跳过或执行无变化的元数据校验。

- 表数量变化：0；列数量变化：0；索引数量变化：0。
- 订单、商品、客户、库存累计、支付事实、退款、推广和三类财务逐字段快照变化：0。
- 各业务表行数变化：0。
- 未产生重复初始化数据。

## 真实新服务启动

迁移后使用真实 `cms/server.js`，`NODE_ENV=test`、`STORAGE_MODE=mysql`、`PAY_MOCK=true`、`AI_PREVIEW_ENABLED=false`、空企业微信/OpenAI/微信配置和本地端口启动；Worker 未禁用。

- `/api/home` 和 `/api/health` 正常；服务启动后完整结构快照变化为 0。
- 支付财务、支付超时、企业微信通知 Worker 均输出 ready，1.2 秒观察窗内无错误、失败任务或重试风暴。
- 启动前后订单状态、库存、退款和财务逐字段快照完全一致。
- 启动历史补偿改为 `STARTUP_HISTORY_COMPENSATION_ENABLED=true` 才可显式开启；默认不会补推广收益、门店成员、旧业务键或企业微信漏通知。
- 未自动创建超时任务、财务 Outbox、释放库存、关闭订单、清空 `user_token` 或删除 AI 文件。
- 未调用企业微信、支付或 AI 外部服务。

迁移后真实 API 成功创建一笔虚构新订单：`user_id` 非空，`user_token` 为 `NULL`。旧订单的虚构 `user_token` 启动后仍保留。

## 迁移后测试订单清理

迁移本身不回填历史库存审计。为让旧释放累计数据具备清理脚本要求的可证明链路，专项测试在迁移完整性验证之后，单独添加纯虚构的预占事实和 legacy 释放事件；该步骤不调整商品库存、累计释放量或订单状态，不属于迁移文件。

- dry-run：10 笔可自动删除，`MANUAL_REVIEW=0`，零写入；2 笔正常订单不在计划内。
- apply：实际删除 10，白名单外订单变化 0，主数据删除 0，库存归还正确，财务一致。
- 重复 apply：删除 0，不存在 10，幂等 PASS。
- 清理专项独立真实 MySQL 测试：36/36 PASS，并直接运行在迁移后结构上。

生产历史库存事实不能仿照夹具直接写入；必须先运行只读审计和 `backfill-inventory-release-events.js` dry-run，由人工逐单核对后另行审批。

## 完整回归

以下均 PASS：

- `test:blue-team-migrations-mysql`（30/30）；
- `test:security-mysql`（包含支付、部分退款、库存和财务并发）；
- `test:cleanup-test-orders-mysql`（36/36）；
- `test:order-ownership-mysql`；
- `test:payment-finance-outbox`、`test:payment-finance-backfill`、`test:order-payment-timeout`；
- `test:order-domain`、`test:order-chain`、`test:security-p0`、`test:security-session-promotion`、`test:security-boundaries`、`test:security-ledgers`；
- `test:ai-preview-access`、`test:wecom-order-notifier`、`test:wecom-order-notification-db`；
- `test:wecom-order-notification` 使用本机 TLS 假 Webhook，未读取 `.env`、未发送外网消息；
- 包体配置审计 PASS，本地忽略规则估算 479.21 KiB；未上传小程序。

## 数据一致性终检

负库存、累计释放超购买量、事件/累计不一致、重复财务业务键、重复 Outbox 业务键、重复 transaction、孤立订单商品、孤立退款商品、孤立库存事件、孤立 Outbox、白名单外订单变化、主数据删除、新订单非空 `user_token`、Worker 失败任务积压：**全部为 0**。

## 本轮文件

- `migrations/2026-08-blue-team/001_precheck.sql` 至 `007_postcheck.sql`；
- `scripts/preflight-production-migration.js`；
- `scripts/run-blue-team-migrations.js`；
- `scripts/test-blue-team-migrations-mysql.js`；
- `scripts/cleanup-production-test-orders.js`、`scripts/test-cleanup-test-orders-mysql.js` 的迁移隔离库兼容；
- `cms/server.js` 的启动历史补偿显式门禁和空客户日期兼容；
- `scripts/test-wecom-order-notification.js` 的隔离测试 `.env` 禁用开关；
- `package.json`、本报告和生产部署手册。

## 未解除的正式发布阻断

- 尚未固定并提交发布候选 SHA；
- 尚未取得生产备份、变更单、维护窗口和双人审批；
- 当前迁移/清理执行器按本轮要求硬性拒绝生产连接，生产版本必须单独安全评审，不能现场临时削弱门禁；
- 尚未在受控生产窗口完成清理、迁移、真实小额支付/部分退款和双微信账号验证；
- 尚未上传小程序。
