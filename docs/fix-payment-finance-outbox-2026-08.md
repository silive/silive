# 支付后财务可靠性修复（2026-08）

## 结论

| 项目 | 结果 |
| --- | --- |
| 支付财务 Outbox 代码复核 | PASS |
| 自提服务费触发时点修正 | PASS（代码与单元测试） |
| 启动历史补建改造 | PASS（默认不写） |
| 隔离 MySQL 并发验收 | BLOCKED（本机回环 MySQL `ECONNREFUSED`） |
| 生产数据库、支付、退款、企业微信 | 未触碰 |
| 总体 | **BLOCKED，不能据此部署** |

本轮仅处理支付财务 Outbox 与自提服务费边界。未修改库存超时释放、AI 预览、小程序包体积、小程序前端、支付金额、佣金比例、结算规则或生产环境。

## 1. 支付入口与事务边界复核

MySQL 正常支付入口均收敛到 `markOrderPaid()`，再调用 `markOrderPaidAndEnqueue()`：

| 入口 | 结果 |
| --- | --- |
| 微信支付通知 `/api/pay/notify` | 验签、解密、主动查询、金额/主体核验后进入统一支付事务 |
| 本地 mock `/api/pay/mock-success` | 非生产且显式启用时复用统一支付事务 |
| 重复支付通知/主动补单 | 订单行锁及唯一业务键保证复用或补建同一事件 |
| 退款中、已退款订单收到支付事实 | 仅持久化支付事实与审计，不创建财务事件 |
| 已取消/关闭订单收到支付事实 | 标记 `PAID_AFTER_CANCEL`，不自动履约或创建财务事件 |

正常路径顺序为：

```text
支付事实校验成功
  -> MySQL 事务：锁订单
  -> 写 order_payment_facts
  -> 更新 orders 为已支付
  -> 写状态审计
  -> INSERT IGNORE payment_finance_outbox
  -> 可选写企业微信通知 Outbox 记录
  -> COMMIT
  -> 财务 Worker 认领事件并在独立事务内处理
```

财务 Outbox 写入失败会导致支付状态更新、支付事实和审计一起回滚；企业微信 HTTP 发送不在该事务中。`payment_success:<orderId>:<transactionId>` 为唯一业务键，避免重复回调或并发回调重复建事件。

## 2. 自提服务费语义校正

此前支付 Worker 复用了同时生成“门店推广佣金 + 自提服务费”的函数，存在已支付未核销订单提前产生服务费的语义错误。

现已拆分为两个显式入口：

| 入口 | 可生成记录 |
| --- | --- |
| `createStoreReferralCommissionForOrder()` | 仅 `store_referral_commission` |
| `createPickupServiceFeeForVerifiedOrder()` | 仅 `pickup_service_fee` |

支付财务 Worker 只调用前者，以及个人一级/二级推广奖励、业务员销售佣金；不会写 `pickup_service_fee`。

自提服务费必须同时满足：订单已支付、配送方式为自提、存在自提门店、`pickup_status=picked_up`、有正常或强制核销时间戳，且订单不在取消/退款/售后阻断状态。门店取货码核销、按码核销和管理员强制核销完成后才调用该入口。

门店推广佣金与自提服务费使用不同的唯一业务键：

```text
<orderId>:<storeId>:store_referral_commission
<orderId>:<storeId>:pickup_service_fee
```

因此重复核销只会命中同一服务费键；非本门店、未核销、配送订单、已取消或退款且未核销的订单均不会生成服务费。既有“已完成真实自提后退款保留已产生服务费”的退款规则未改变；本轮没有改动部分退款口径。

## 3. 历史补建改造

服务启动不再自动扫描或写入近90天订单。`cms/server.js` 中不存在 `compensateMissingPaymentFinanceEvents()` 的启动调用。

新增独立命令：

```bash
# 默认只读，不写 Outbox
node scripts/backfill-payment-finance-outbox.js --days 30 --limit 100

# 只有显式 --apply 才写 payment_finance_outbox；本轮未执行
node scripts/backfill-payment-finance-outbox.js --apply --days 30 --batch-size 25 --limit 100
```

支持 `--from`、`--to`、`--cursor`、`--batch-size`、`--limit`。补建只创建缺失的 Outbox 记录，不直接写奖励、佣金、服务费或结算记录；查询排除取消、关闭、作废、退款中、已退款和 `PAID_AFTER_CANCEL`。输出仅显示汇总与脱敏游标。

## 4. Worker 与异常窗口

`payment_finance_outbox` 使用数据库级条件更新认领：`PENDING/RETRY` 到期任务或锁超时的 `PROCESSING` 任务才可被领取。领取后递增尝试次数；同一 Worker 在事务中锁事件、锁订单、写支付时成立的财务记录并将事件置为 `COMPLETED` 或 `SKIPPED`。失败仅将事件改为 `RETRY/FAILED`，不会回滚已支付订单。

这覆盖：事务提交后进程崩溃（重启 Worker 扫描 `PENDING`）、处理中崩溃（锁超时再认领）、财务写入失败（事务回滚、事件重试）。没有外部 HTTP 在财务事务中执行。

## 5. 修改文件

| 文件 | 内容 |
| --- | --- |
| `cms/server.js` | 支付 Outbox Worker；支付/核销收益入口显式分流；移除启动自动财务补建 |
| `cms/wecom-order-outbox.js` | 支付状态、财务 Outbox、可选企业微信 Outbox 同事务持久化 |
| `cms/payment-finance-outbox.js` | 入队、原子认领、完成、重试和可控补建 |
| `cms/pickup-service-fee.js` | 自提服务费严格资格判定 |
| `scripts/backfill-payment-finance-outbox.js` | 默认 dry-run 的人工补建命令 |
| `scripts/test-payment-finance-outbox.js` | Outbox 与自提费资格单元测试 |
| `scripts/test-payment-finance-backfill.js` | 默认 dry-run、显式 apply、重复幂等单元测试 |
| `scripts/test-security-mysql.js` | 回环地址/测试库前置保护及 MySQL 并发验收覆盖 |
| `scripts/audit-payment-finance-outbox.js` | 只读对账汇总 |
| `package.json` | 新增测试与补建命令 |

## 6. 测试结果

| 命令 | 结果 |
| --- | --- |
| `node --check`（Server、Outbox、补建与专项脚本） | PASS |
| `npm run test:payment-finance-outbox` | PASS |
| `npm run test:payment-finance-backfill` | PASS |
| `npm run test:security-p0` | PASS |
| `npm run test:order-chain` | PASS |
| `npm run test:order-domain`、`security-session-promotion`、`security-boundaries`、`security-ledgers` | PASS（本轮前后回归） |
| `MYSQL_TEST_DATABASE=vsc_security_test_payment_outbox npm run test:security-mysql` | BLOCKED：`127.0.0.1:3306` 拒绝连接；数据库创建前即退出 |

专项 MySQL 脚本只接受回环地址和 `vsc_security_test_*` 库，创建后会在结束时删除该隔离库。待可用的本机或 Docker MySQL 后，脚本将实际检查：20并发同支付事实、单支付事实/订单/Outbox、事务内 Outbox 插入失败回滚、取消/退款路径不入队、双 Worker 单认领、重试、陈旧锁恢复、个人/门店/业务员业务键去重、未核销自提无服务费、核销一次、重复核销、错误门店、配送订单和两类门店收益键分离。

本机未安装 `mysql` 客户端，未检测到 Docker，且本地配置目标为回环地址但端口不可达；因此没有建立、写入或删除任何测试库，也没有使用生产数据库替代。

## 7. 下一步与限制

在提供或启动一个本机 MySQL/Docker 实例前，必须保持总体状态为 **BLOCKED**。可使用临时环境变量指定隔离库，例如：

```bash
MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 MYSQL_USER=<test-user> \
MYSQL_PASSWORD=<test-password> MYSQL_TEST_DATABASE=vsc_security_test_payment_outbox \
npm run test:security-mysql
```

不得将上述凭证写入代码或提交。MySQL 验收通过后仍需复核测试输出、再决定是否提交、推送或部署；本轮未提交、未推送、未部署、未重启服务，未执行真实支付、退款、结算、企业微信或生产数据库操作。
