# 隔离 MySQL 蓝队并发验收（2026-08）

## 范围与隔离

- 基线：`896b682a0f52fd7bfe2ee7a288251aaa934be855`，`main`。
- 使用本机 MySQL `8.0.46`，仅绑定 `127.0.0.1` 的随机端口，测试库为
  `vsc_security_test_full_acceptance`。
- 使用临时最小权限账号，只授予该测试库权限；未读取 `.env`，未使用生产账号、生产数据、生产服务或外部 Webhook。
- 通过 `cms/server.js` 的真实 `initDb()` 从空库初始化。测试模式只禁止 seed 数据、外部补偿和后台定时器，未使用手工简化 DDL。
- 结束时已关闭本地 CMS 和临时 MySQL；测试库及临时日志保留在系统临时目录供复核。

## 数据库约束

真实 `SHOW CREATE TABLE` / `SHOW INDEX` 验证通过：

- `payment_finance_outbox.uniq_payment_finance_business`：`business_key` 唯一；`idx_payment_finance_due(event_type,status,available_at)`。
- `order_inventory_releases`：`order_item_id` 主键，`quantity` 注释及实现均为累计已释放数量。
- `order_inventory_release_events.uniq_inventory_release_event_business`：释放事件业务键唯一。
- `orders.idx_orders_payment_timeout(payment_status,payment_expires_at)`。
- 支付流水 `uniq_payment_fact_transaction`、推广被邀请人主键、取货码唯一订单、以及用户/操作/请求键范围的订单幂等唯一索引均存在。

## 并发验收结果

### 支付与财务 Outbox：PASS

- 20 个并发支付回调仅创建一条支付事实、一条企业微信通知记录和一条支付财务 Outbox。
- Outbox 插入触发器故障时，支付状态、支付事实和 Outbox 一起回滚。
- 已取消、退款中和已退款订单不会新建财务 Outbox；超时后支付进入 `PAID_AFTER_CANCEL`，不重新扣库存。
- 两个真实数据库认领者只能认领一个财务事件；重试、陈旧锁恢复和业务键唯一性通过。
- 额外以启用真实 CMS Worker 的临时服务验证：`WORKER-E2E` Outbox 最终为 `COMPLETED`，尝试次数为 `1`。

### 有限库存、超时与退款：PASS

- 真实 `/api/orders`：库存 1 的 20 并发请求仅 1 个成功，库存 5 的 20 并发请求仅 5 个成功；不足库存返回 409，混合购物车整体回滚。
- `UNLIMITED` 与 `MADE_TO_ORDER` 不写实际库存释放。
- 20 个超时 Worker 对同一订单只能认领和关闭一次；支付事实阻止释放，陈旧锁可恢复，审计写入失败时事务整体回滚。
- 多次部分退款、20 个相同退款通知、两笔不同部分退款并发、部分退款与全额退款/取消/超时竞争均使用事件业务键和累计释放量，最终不超过订单商品数量。
- 已履约退款边界、取货服务费核销边界、结算/退款冲正唯一业务键及推广绑定唯一性通过。

## 终检

测试库一致性查询异常数均为 `0`：负库存、超量释放、事件与累计量不一致、重复财务 Outbox、重复支付流水、符合条件的已支付订单缺失财务 Outbox、`PAID_AFTER_CANCEL` 财务 Outbox、重复推广认领。

## 相关回归

以下均退出码 `0`：`test:payment-finance-outbox`、`test:payment-finance-backfill`、`test:order-payment-timeout`、`test:order-domain`、`test:order-chain`、`test:security-p0`、`test:security-session-promotion`、`test:security-boundaries`、`test:security-ledgers`、`test:ai-preview-access`、`test:wecom-order-notifier`、`test:wecom-order-notification-db` 与 `scripts/test-product-image-optimizer.js`。

`test:wecom-order-notification` 未运行：该脚本会读取 `.env` 并向真实企业微信发送消息，不符合本轮隔离限制。

所有本轮及已有修改的 JavaScript 均通过 `node --check`，`git diff --check` 通过。

## 测试中修复

- 验收脚本为 `information_schema.tables.table_name` 增加显式小写别名，修正 MySQL 字段大小写导致的“缺表”误报。
- 部分释放的既有累计释放测试夹具补齐对应释放事件，保持“事件数量之和等于累计量”的真实数据不变量；未降低任何断言或并发量。
- `cms/server.js` 的测试环境开关只用于阻止隔离验收继承 `.env`、写 seed/补偿数据或启动竞争 Worker；默认生产行为不变。

## 结论

技术代码及隔离MySQL验收：PASS

生产只读审计：待执行

双账号真机隔离：待执行

真实小额支付退款：待执行

正式发布状态：仍BLOCKED
