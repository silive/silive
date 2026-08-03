# 测试订单白名单清理隔离 MySQL 彩排（2026-08）

状态：**PASS**

## 范围与安全边界

- 基础 HEAD：`896b682a0f52fd7bfe2ee7a288251aaa934be855`，分支 `main`。
- 本轮只新增白名单清理工具、真实 MySQL 专项测试及本报告；未修改支付、退款、库存等既有业务核心。
- 仅使用本机临时 MySQL，绑定 `127.0.0.1`，固定数据库名 `vsc_security_test_order_cleanup`，并使用临时最小范围测试账号。
- 通过真实 `cms/server.js` 从空库初始化完整结构；显式设置 `MYSQL_TEST_SKIP_DOTENV=true`、`MYSQL_TEST_SKIP_SEED_DATA=true`、`MYSQL_TEST_ISOLATED=true`、`MYSQL_TEST_DISABLE_WORKERS=true`。
- 夹具中的订单、支付号、退款号、用户、商品和门店信息均为纯虚构数据。
- 未读取 `.env`，未连接、读取或修改生产数据库，未调用支付/退款接口，未发送企业微信消息。

## 订单关联表矩阵

本轮从 `cms/server.js` 初始化 DDL、库存释放实现、支付财务 Outbox、超时任务、退款和结算调用中确认 21 张订单关联表。脚本还在每次运行时扫描 `information_schema.columns`；如果目标订单命中未登记的 `order_id`、`order_item_id`、`refund_id`、`transaction_id`、`business_key` 等关联，整批进入 `MANUAL_REVIEW`，不会忽略未知表。

| 表 | 关联字段 | 是否订单专属 | 删除顺序 | 是否允许自动删除 |
|---|---|---|---:|---|
| `orders` | `id`, `transaction_id`, `refund_id` | 是（根记录） | 21 | 是，最后删除 |
| `order_items` | `order_id`, `id` | 是 | 20 | 是 |
| `refund_items` | `refund_record_id`, `order_item_id` | 是 | 1 | 是 |
| `financial_record_item_allocations` | `order_id`, `order_item_id`, `record_id` | 是 | 2 | 是，财务可追溯且未结算时 |
| `payment_finance_outbox` | `aggregate_type`, `aggregate_id`, `business_key` | 是 | 3 | 是，仅 `aggregate_type=ORDER` 且目标订单 |
| `order_notification_records` | `order_id` | 是 | 4 | 是 |
| `wechat_fulfillment_records` | `order_id` | 是 | 5 | 是 |
| `order_payment_timeout_jobs` | `order_id` | 是 | 6 | 是 |
| `order_state_audit` | `order_id` | 是 | 7 | 是 |
| `order_payment_facts` | `order_id`, `transaction_id` | 是 | 8 | 是，交易号未共享且状态一致时 |
| `pickup_code_claims` | `order_id` | 是 | 9 | 是 |
| `order_request_keys` | `order_id` | 是 | 10 | 是 |
| `order_idempotency_keys` | `order_id` | 是 | 11 | 是 |
| `reward_records` | `order_id`, `business_key`, `related_record_id` | 是 | 12 | 是，仅未结算记录 |
| `store_settlement_records` | `order_id`, `business_key`, `related_record_id` | 是 | 13 | 是，仅未结算记录 |
| `sales_agent_commissions` | `order_id`, `business_key`, `related_record_id` | 是 | 14 | 是，仅未结算记录 |
| `refund_records` | `order_id`, `id`, `refund_no`, `wechat_refund_id` | 是 | 15 | 是，退款状态一致时 |
| `order_inventory_release_events` | `order_id`, `order_item_id`, `business_key` | 是 | 16 | 是，完成剩余库存释放后 |
| `order_inventory_releases` | `order_id`, `order_item_id` | 是 | 17 | 是，事件总量与累计量一致时 |
| `order_inventory_reservations` | `order_id`, `order_item_id` | 是 | 18 | 是，预占结构可证明时 |
| `store_referral_attributions` | `last_order_id` | 否，共享归因主记录 | 19（解除引用） | 不删除记录，只将目标 `last_order_id` 置空 |

`customers`、`products`、`partner_stores`、`store_members`、`sales_agents`、推广关系和商品/门店主数据均为共享主数据，禁止自动删除。库存只能通过 `cms/inventory-ledger.js` 的统一释放核心修改商品库存。

## 白名单机制

- 唯一选择条件是外部 JSON 文件中的明确 `orderIds`；不支持最近 N 笔、`user_token`、时间、金额、备注或状态模糊选择。
- 白名单路径必须为绝对路径，数组不能为空，空 ID 和超过 `orders.id` 长度的 ID 被拒绝。
- 去重后最多 20 笔；本次重复 ID 测试正确去重并报告 1 笔重复。
- 默认只做 dry-run。写入必须同时存在 `--apply` 和 `--confirm-delete-test-orders`。
- 运行时拒绝 `NODE_ENV=production`、非 `127.0.0.1/localhost` Host、缺失测试用户名、缺失/错误测试库名及疑似生产连接信息。
- 脚本不加载任何 `.env`；报告和日志只包含汇总、原因和脱敏 ID。
- 白名单测试文件创建在系统临时目录，测试结束删除，未进入 Git。

## dry-run 结果

状态：**PASS**

- 白名单：10 笔唯一虚构订单（另输入 1 个重复 ID 并成功去重）。
- 可自动删除：10；`MANUAL_REVIEW`：0；不存在：0。
- 库存预计归还：12 件有限库存商品。
- 财务汇总：订单金额 300.00，成功退款 40.00，推广奖励 10.00，门店记录 20.00，业务员佣金 30.00（均为虚构金额）。
- 预计已有记录：订单 10、订单商品 10、退款记录 2、退款商品 2、支付事实 4、财务 Outbox 10、超时任务 10、通知 10、履约记录 10、财务分摊 10、推广奖励 10、门店财务 10、业务员佣金 10、预占记录 8、既有库存累计记录 5、既有释放事件 5；其他订单直接关联表各 10。
- 对 dry-run 前后所有目标与非目标表逐行快照比较，完全一致，零写入。

## apply 彩排与删除顺序

状态：**PASS**

单一数据库事务按以下顺序完成：锁定全部白名单订单与订单商品 → 再次分析关联和安全条件 → 调用统一库存核心释放剩余有限库存 → 删除退款商品和财务分摊 → 删除 Outbox、通知、履约、超时、审计、支付事实、取货码、请求/幂等记录 → 删除未结算财务记录和退款记录 → 删除库存事件、累计与预占记录 → 解除共享归因记录的 `last_order_id` → 删除订单商品 → 删除订单 → 事务内一致性检查 → 提交。

- 允许删除订单：10；实际删除订单：10。
- 白名单订单剩余：0；白名单外订单剩余：2。
- 清理期间新增 5 条剩余库存释放事件；删除前总释放事件 10 条、累计记录 8 条、预占记录 8 条，随后随订单专属数据清理。
- 使用故障注入在库存释放后抛错，订单、库存和全部关联记录整体回滚，退出码非 0。
- 使用同一白名单再次 apply：10 笔均报告不存在，删除数 0，退出码 0，幂等安全。

## 库存处理

状态：**PASS**

- `FINITE` 未释放：通过 `releaseOrderItemInventory()` 使用稳定业务键 `test_order_cleanup:<orderId>:<orderItemId>` 归还全部剩余量。
- `FINITE` 部分释放：只归还 `ordered_quantity - cumulative_released_quantity`。
- `FINITE` 已完整释放：不再增加库存。
- `UNLIMITED` 与 `MADE_TO_ORDER`：不改变实际库存。
- 清理前验证商品存在、库存模式一致、预占数量等于购买数量、累计释放不超购买量、事件总量等于累计量；无法证明时进入 `MANUAL_REVIEW`。
- 彩排库存归还合计 12 件；清理后负库存 0，超量释放 0，事件/累计不一致 0。

## 财务处理与 MANUAL_REVIEW

状态：**PASS**

未结算且订单专属的推广奖励、门店佣金/自提服务费、业务员佣金、分摊和 Outbox 可以自动删除。出现 `settled_at`、结算批次或 settled/completed/paid/confirmed 等已结算状态时阻止整批 apply；脚本不会删除共享结算批次或通过删记录掩盖财务不平。

以下真实 MySQL 反例均正确返回非 0 并保留数据：

- `transaction_id` 被白名单外订单共享；
- 已结算门店财务记录；
- 新增未登记的 `mystery_order_links.order_id` 且命中目标订单；
- 库存释放后注入事务故障。

此外，支付事实与订单状态矛盾、退款结构不完整、商品或预占缺失、未知库存模式、库存事件/累计不一致、财务记录跨订单引用等都会进入 `MANUAL_REVIEW`。

## 白名单外与主数据保护

状态：**PASS**

- 2 笔白名单外订单及其订单商品、库存预占、Outbox、超时任务、通知、履约、财务记录、取货码、审计和幂等数据在 apply 前后逐行完全一致。
- 主数据删除数量为 0：客户、12 个商品、门店、门店成员、业务员及共享门店归因记录均保留。
- 共享门店归因只解除已删除测试订单的 `last_order_id`，不删除归因主体。

## 孤立数据终检

状态：**PASS**

| 检查 | 结果 |
|---|---:|
| 白名单订单剩余 | 0 |
| 白名单外订单剩余 | 2 |
| 孤立 `order_items` | 0 |
| 孤立 `refund_items` | 0 |
| 孤立财务记录 | 0 |
| 孤立 Outbox | 0 |
| 孤立库存释放事件 | 0 |
| 负库存 | 0 |
| 累计释放超过购买量 | 0 |
| 库存事件与累计不一致 | 0 |
| 白名单外数据变化 | 0 |
| 主数据删除 | 0 |

## 测试结果

状态：**PASS**

- `npm run test:cleanup-test-orders-mysql`：36/36 PASS，使用真实 MySQL 事务，不是 Mock 或字符串检查。
- `npm run test:security-mysql`：PASS，支付、库存、退款并发和事务回滚验收全部通过。
- `npm run test:security-ledgers`：PASS。
- `npm run test:order-payment-timeout`：PASS。
- `npm run test:order-domain`：PASS。
- `npm run test:order-chain`：PASS。
- `npm run test:security-boundaries`：PASS。
- `npm run test:security-p0`：PASS。
- 本轮新增 JavaScript 的 `node --check`：PASS。
- `git diff --check`：PASS。

## 本轮修改文件

- `scripts/cleanup-production-test-orders.js`：白名单清理 CLI、连接门禁、关联发现、逐单审查、事务清理和脱敏报告。
- `scripts/test-cleanup-test-orders-mysql.js`：完整虚构夹具及 36 项真实 MySQL 验收。
- `package.json`：增加 `test:cleanup-test-orders-mysql` 命令（保留并未覆盖已有蓝队修改）。
- `docs/test-order-cleanup-rehearsal-2026-08.md`：本报告。

## 生产执行前仍需提供

当前脚本按本轮安全要求硬性拒绝生产环境、非本机 Host 和非固定隔离库，**不能直接用于生产执行**。生产执行前至少还需要：

1. 业务负责人和数据库负责人双人复核的外部白名单文件（不得提交 Git）；
2. 生产只读关联扫描结果、备份/恢复点、维护窗口和变更单；
3. 对实际生产结构重新生成关联矩阵，确认没有新增或未知关联；
4. 已结算财务、共享交易号或结构异常订单的逐单人工处置结论；
5. 独立安全评审后形成受控生产版本，明确调整本轮硬门禁，使用最小权限临时账号；
6. 正式执行前再次 dry-run、双人确认输出及执行后只读一致性复核。

本报告不授权生产连接、生产删除、迁移、部署、提交、推送或发布。
