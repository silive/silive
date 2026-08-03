# 部分退款库存释放修复（2026-08）

## 状态

本轮仅修改本地工作区，未提交、未推送、未部署、未上传小程序，未连接或修改生产数据库。

**代码修复：PASS**

**普通自动测试：PASS**

**MySQL 并发验收：BLOCKED（未配置明确的隔离 MySQL 测试库）**

**总体状态：BLOCKED**

## 原始缺陷

旧版 `order_inventory_releases` 以 `order_item_id` 为主键，并把 `quantity` 当作一次性整条订单商品释放量。`releaseOrderInventory()` 仅能在首次调用时归还 `order_items.quantity` 全量库存，不能表示多个退款成功事实。

因此购买 5 件商品时，先后退款 2 件、1 件，再全额退款的正确库存变化应为 `2 + 1 + 2`；旧模型只会在最后释放 5 件，且部分退款没有库存释放入口。

## 新累计模型

`order_inventory_releases` 继续保留为每个 `order_item_id` 一行的汇总表，兼容既有数据：

- `quantity` 的语义改为 **累计已释放数量**；
- 增加 `updated_at`；
- 每次更新都使用 `quantity + 本次释放数量 <= order_items.quantity` 条件，数据库内保证 `0 <= quantity <= ordered_quantity`；
- 历史记录的 `quantity` 直接视为已经释放的累计数量，不重新增加商品库存。

## 逐次事件模型

新增 `order_inventory_release_events`：

- `business_key` 唯一，作为事件级幂等约束；
- 记录 `order_item_id`、订单、商品、本次数量、来源、原因与创建时间；
- `source_type + source_id`、订单商品、订单均有索引，便于追溯与审计。

当前稳定业务键：

| 场景 | 业务键 |
| --- | --- |
| 部分退款 | `refund:<refundId>:<refundItemId>:<orderItemId>` |
| 全额退款剩余释放 | `full_refund:<refundId>:<orderItemId>` |
| 用户取消 | `user_cancel:<orderId>:<orderItemId>` |
| 管理员关闭 | `admin_close:<orderId>:<orderItemId>` |
| 支付超时 | `payment_timeout:<orderId>:<orderItemId>` |
| 历史兼容 | `legacy_release:<orderItemId>` |

## 统一释放与事务边界

`cms/inventory-ledger.js:releaseOrderItemInventory()` 必须由调用方已经开启的 MySQL 事务调用，依次：

1. `SELECT ... FOR UPDATE` 锁定订单商品；
2. 仅允许快照库存模式为 `FINITE`；
3. 检查事件业务键是否已存在；
4. 锁定累计释放行，计算剩余可释放数量；
5. 写入事件；
6. 条件增加累计数量；
7. 增加商品实际库存；
8. 由调用方一起提交或回滚。

任何异常都会使事件、累计数和商品库存回滚。`UNLIMITED` 与 `MADE_TO_ORDER` 直接跳过，不写实际库存释放事件或累计账本。

`releaseOrderInventory()` 是整单入口，统一按每条订单商品的 `ordered - cumulative` 释放剩余量，供取消、关闭、超时与全额退款复用。

## 部分退款与已履约规则

MySQL 退款成功路径 `markRefundSuccess()` 在退款记录和 `refund_items` 已确认 `SUCCESS` 后、事务提交前处理库存：

- 非全额退款：仅按本次 `refund_items.refund_quantity` 调用统一核心；
- 全额退款：只释放每条商品尚未释放的剩余量；
- 退款申请创建、退款处理中或失败时不会释放库存；
- 已发货、到店、已核销、已自提或已完成履约的订单不自动回补可售库存。

部分退款与全额退款都在同一退款成功事务中，不依赖前端行为。

## 取消、关闭与超时

- 后台保存进入取消/关闭终态时，根据终态生成 `user_cancel`、`admin_close` 或通用终态来源，并释放剩余量；
- 支付超时 Worker 使用 `payment_timeout` 来源；
- 退款完成使用退款来源；
- 订单商品行锁、事件唯一键和累计上限共同覆盖取消、超时、退款的重复或并发调用。

## 历史数据兼容与审计

新增 `scripts/backfill-inventory-release-events.js`：

- 默认 dry-run；
- 仅在显式 `--apply` 和确认变量时写入；
- 生产环境硬性拒绝 `--apply`；
- 只为已有累计记录补 `legacy_release` 事件，不修改累计数量、商品库存或历史订单；
- `quantity > order_items.quantity` 的异常只报告。

新增只读 `scripts/audit-inventory-release-consistency.js`，检查累计越界、累计与事件不一致、缺失事件、成功退款未覆盖、已履约释放和非有限库存释放异常。

## 修改文件

- `cms/inventory-ledger.js`
- `cms/server.js`
- `cms/order-payment-timeout.js`
- `scripts/test-security-ledgers.js`
- `scripts/test-security-mysql.js`
- `scripts/test-order-payment-timeout.js`
- `scripts/backfill-inventory-release-events.js`
- `scripts/audit-inventory-release-consistency.js`
- 本报告

## 测试结果

已通过：

- `node --check`：本轮所有 JavaScript 文件；
- `npm run test:security-ledgers`：真实库存核心函数覆盖 5 件商品的 `2 + 1 + 2`、重复业务键、累计上限和非有限库存；
- `npm run test:order-payment-timeout`；
- `npm run test:order-domain`；
- `npm run test:order-chain`。

`scripts/test-security-mysql.js` 已扩展隔离 MySQL 场景：20 个相同退款通知、两个不同退款并发、部分退款与全额退款竞争、部分退款与取消竞争、支付超时与部分退款竞争、累计上限、全额剩余释放与事务回滚；当前因没有 `MYSQL_TEST_DATABASE` 而安全停止，没有连接任何数据库。

## 未完成验收

1. 在独立本机 MySQL（库名必须以 `vsc_security_test_` 开头）运行 `npm run test:security-mysql`；
2. 仅在人工审批后，先对生产数据库执行只读审计和 dry-run；
3. 不得直接对生产运行历史事件补建 `--apply`。

## 最终结论

多次部分退款已由事件级幂等与累计数量上限支持；整单入口只归还剩余数量。代码与普通自动测试通过，但真实 MySQL 并发验收未执行，故整体仍为 `BLOCKED`。
