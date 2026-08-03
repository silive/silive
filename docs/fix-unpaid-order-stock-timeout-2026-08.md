# 有限库存未支付订单超时释放修复（2026-08）

## 状态

本轮仅修改本地工作区，未提交、未推送、未部署，未连接或修改生产数据库。

**代码修复：PASS**

**普通自动测试：PASS（企业微信实发测试因本地未配置 webhook 安全停止）**

**MySQL 并发验收：BLOCKED（未配置显式隔离测试库，本轮未创建或使用任何数据库）**

**总体状态：BLOCKED，等待隔离 MySQL 并发验收后再评估部署。**

## 原始根因

蓝队报告 `docs/blue-team-full-audit-2026-08.md` 的 BT-P1-02 确认：

1. `cms/server.js` 的 `createOrder()` 会在 MySQL 事务内锁定 `products` 行，并对 `FINITE` 商品执行条件扣减库存。
2. 已有库存归还入口主要来自用户取消、后台关闭及退款；归还核心为 `cms/inventory-ledger.js` 的 `releaseOrderInventory()`。
3. 原代码没有针对未支付订单的服务端截止时间、可恢复任务记录或定期扫描 Worker；放弃支付的有限库存订单可持续占用库存。

## 当前库存模型与调用链

| 环节 | 代码 / 数据表 | 事务与并发控制 |
| --- | --- | --- |
| 创建订单 | `cms/server.js:createOrder()` | MySQL 事务；`SELECT ... FOR UPDATE` 锁商品；`UPDATE products ... stock >= quantity` 条件扣减 |
| 模式判断 | `cms/order-domain.js:normalizeInventoryMode()` | `FINITE`、`UNLIMITED`、`MADE_TO_ORDER` |
| 订单快照 | `order_items` | 同创建订单事务写入；记录 `inventory_mode` 与数量 |
| 预占事实 | `order_inventory_reservations` | 新增；每个 `order_item_id` 一条，和订单、库存扣减同事务写入 |
| 支付截止 | `orders.payment_expires_at` | 服务端由 `ORDER_PAYMENT_TIMEOUT_MINUTES` 生成；默认 30 分钟，最大 1440 分钟 |
| 超时任务 | `order_payment_timeout_jobs` | 新增；`order_id` 唯一、到期索引、认领锁、尝试计数、错误与重试时间 |
| 超时关闭 | `cms/order-payment-timeout.js:closeOrderForPaymentTimeout()` | 锁任务、锁订单、核对已核验支付事实、条件更新订单、归还库存、状态审计和任务完成在一个事务内 |
| 取消 / 管理关闭 / 退款 | `cms/server.js:saveOrders()`、退款事务 | 继续复用 `releaseOrderInventory()`，不再新增各自的加库存逻辑 |
| 实际库存释放 | `cms/inventory-ledger.js:releaseOrderInventory()` | `order_inventory_releases.order_item_id` 主键为唯一业务键；`INSERT IGNORE` 成功后才增加对应 `FINITE` 商品库存 |

`UNLIMITED` 与 `MADE_TO_ORDER` 不扣减实际库存，也不会在释放函数中执行库存增加。

## 支付截止与超时关闭

创建可支付订单时，截止时间只由服务器计算，客户端不能传入或覆盖。有限库存订单在同一个订单事务内完成：

1. 锁定商品并校验可用库存；
2. 条件扣减 `FINITE` 商品库存；
3. 创建订单和订单商品快照；
4. 写入 `stock_reserved_at`、`payment_expires_at` 与预占事实；
5. 插入该订单唯一的超时任务；
6. 一起提交。

到期 Worker 只会处理状态仍为未支付、截止已到、没有交易号/支付时间且没有 `order_payment_facts` 中 `SUCCESS + amount_verified=1` 事实的订单。超时成功后写入：

- `orders.status = 已关闭`
- `orders.payment_status = 支付超时关闭`
- `orders.stock_released_at`
- `order_state_audit`

订单状态更新、库存释放账本和任务完成同一事务提交。外部 HTTP 通知不在该事务中。

## 幂等与竞争处理

库存释放的唯一键是 `order_inventory_releases.order_item_id`，等价于每个订单商品一个 `stock_release:<orderId>:<orderItemId>` 业务事实。不同入口即使并发调用，只有获得该主键插入的一方会增加库存。

超时任务以 `order_payment_timeout_jobs.order_id` 唯一，并通过条件更新原子认领：

- `PENDING` / `RETRY` 且到达 `available_at` 的任务可认领；
- `PROCESSING` 锁超过 5 分钟后可被恢复认领；
- Worker 每 30 秒扫描一次，单批最多 20 个；
- 每条任务最多 12 次，错误记录后一分钟重试，达到上限标记 `FAILED`，不会无限重试；
- 服务重启后会立即扫描数据库中的遗留任务，不依赖内存定时器或前端访问。

支付与超时任务竞争时：

1. 支付事务先锁定并完成已支付事实时，超时事务会看见已核验支付事实或支付证据，取消超时任务，不关闭也不释放库存。
2. 超时事务先完成关闭和释放时，后续真实支付沿现有 `PAID_AFTER_CANCEL` 路径处理；不重新扣库存、不自动履约，也不创建正常支付财务效果。
3. 支付事实存在但订单状态尚未同步时，超时任务同样跳过释放。

## 历史订单兼容

新脚本 `scripts/backfill-order-payment-expiry.js` 默认只读 dry-run，支持：

```bash
npm run backfill:order-payment-expiry -- --limit 100
npm run backfill:order-payment-expiry -- --start-at '2026-08-01 00:00:00' --end-at '2026-08-02 00:00:00'
```

它仅查询：缺少支付截止时间、仍未支付、存在 `FINITE` 商品、未有库存释放记录且未有超时任务的订单；存在已核验支付事实的矛盾记录只统计为冲突，不会关闭。输出只展示订单号尾部。

写入必须显式传入 `--apply` 和 `ORDER_PAYMENT_EXPIRY_BACKFILL_CONFIRM=APPLY`，同时脚本在 `NODE_ENV=production` 下硬性拒绝执行。本轮没有运行 `--apply`，也没有对历史订单做任何改写。

## 修改文件

- `cms/server.js`
- `cms/order-payment-timeout.js`
- `package.json`
- `scripts/test-order-payment-timeout.js`
- `scripts/test-security-mysql.js`
- `scripts/backfill-order-payment-expiry.js`
- 本报告

## 自动测试

已通过：

- `node --check cms/server.js`
- `node --check cms/order-payment-timeout.js`
- `node --check cms/inventory-ledger.js`
- `node --check scripts/test-order-payment-timeout.js`
- `node --check scripts/backfill-order-payment-expiry.js`
- `node --check scripts/test-security-mysql.js`
- `npm run test:order-domain`
- `npm run test:order-chain`
- `npm run test:security-p0`
- `npm run test:security-boundaries`
- `npm run test:security-ledgers`
- `npm run test:payment-finance-outbox`
- `npm run test:payment-finance-backfill`
- `npm run test:security-session-promotion`
- `npm run test:wecom-order-notifier`
- `npm run test:order-payment-timeout`
- `git diff --check`

`npm run test:wecom-order-notification` 因本地没有配置企业微信 webhook 返回“未配置”，属于安全环境阻断，不是库存超时逻辑失败。

项目没有 `lint`、`typecheck` 或 `build` npm script，也没有 TypeScript 文件，因此这些检查在当前仓库无可执行目标。

## MySQL 专项准备与未完成验收

`scripts/test-security-mysql.js` 已新增并准备以下隔离库场景：

1. 20 并发订单竞争有限库存；
2. 20 并发 Worker 认领同一超时任务；
3. 同一订单只释放一次；
4. 已核验支付事实阻止超时释放；
5. 超时后晚到支付进入 `PAID_AFTER_CANCEL` 且不重新扣库存；
6. 超时关闭事务中断时订单状态与库存同时回滚；
7. 超时 Worker 锁超时恢复；
8. 支付与超时关闭并发；
9. 用户取消、管理员关闭与超时释放并发；
10. `FINITE`、`UNLIMITED`、`MADE_TO_ORDER` 边界；
11. 多商品/库存账本唯一键路径可由同一核心函数覆盖。

脚本仅允许 `localhost`、`127.0.0.1` 或 `::1`，仅接受 `vsc_security_test_` 前缀的 `MYSQL_TEST_DATABASE`，并拒绝 `NODE_ENV=production`。本地没有配置显式隔离测试库，故本轮没有执行它，也不能把 MySQL 并发验收标记为通过。

## 未完成验收与下一步

1. 在独立本地 MySQL 测试库配置 `MYSQL_TEST_DATABASE=vsc_security_test_<name>` 后运行 `npm run test:security-mysql`。
2. 对真实生产数据库仅先做 dry-run 统计，人工评估历史未支付有限库存订单，再决定是否执行受控补建。
3. 在隔离 MySQL 验收通过前，不建议提交、部署或将该项标记为可生产发布。
