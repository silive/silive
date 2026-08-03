# 生产只读蓝队审计（2026-08）

## 方法与边界

- 生产主机只执行版本、进程、文件元数据、`SHOW` / `information_schema` 和 `START TRANSACTION READ ONLY` 内的 `SELECT`。
- 没有执行任何 DDL/DML、迁移、补偿、重启、外部通知或支付退款调用。
- 本地基线：`896b682a0f52fd7bfe2ee7a288251aaa934be855`；生产目录不是 Git 工作区，`cms/server.js` 修改时间为 2026-07-29，故生产仍是旧版本，和本地不一致。

## 运行配置

- 服务：`very-simple-cms`，单 PM2 fork 实例，状态 `online`，Node 20.20.2。
- 健康接口：PASS，返回 `storage=mysql`。
- 生产 MySQL：8.0.45，数据库名已脱敏。
- 配置摘要：`NODE_ENV=production`，`PAY_MOCK=false`，企业微信配置存在；`STORAGE_MODE`、`AI_PREVIEW_ENABLED` 和 `TRUSTED_PROXY_IPS` 未显式配置。
- 本次连接账号具有写能力，因此所有数据查询均置于显式只读事务；不是专用只读账号，属于部署前权限风险。

## 迁移准备矩阵

| 对象 | 生产现状 | 新代码要求 | 状态 | 部署前动作 |
| -- | -- | -- | -- | -- |
| `order_payment_facts` | 已有 | 支付事实唯一约束 | 需部署时复核索引 | MANUAL_REVIEW |
| `payment_finance_outbox` | 缺少 | 事务财务 Outbox / Worker | 不兼容 | MIGRATION_REQUIRED |
| `order_payment_timeout_jobs` | 缺少 | 可恢复超时任务 | 不兼容 | MIGRATION_REQUIRED |
| `order_inventory_releases` | 已有 | 累计释放量 | 部分兼容 | 复核字段与索引 |
| `order_inventory_release_events` | 缺少 | 部分退款事件幂等 | 不兼容 | MIGRATION_REQUIRED |
| `order_inventory_reservations` | 缺少 | 下单库存预占事实 | 不兼容 | MIGRATION_REQUIRED |
| `refund_items` / session / 幂等 | 已有 | 新代码兼容读取 | 待字段核对 | MANUAL_REVIEW |

## 数据一致性结果

生产共有 10 笔订单：4 笔已支付类、6 笔未支付类；时间范围为 2026-05-25 至 2026-07-29。

- 已支付缺少支付时间：0，已取消/关闭仍已支付：0。
- 负库存：0；异常订单商品数量：0；重复退款号：0。
- 重复推广被邀请人、推广奖励业务键、门店结算业务键：均为 0。
- `PAID_AFTER_CANCEL`：0。
- 因生产未部署 Outbox、超时任务、库存事件和预占表，支付财务遗漏、未支付库存长期占用、部分退款事件累计等项目无法通过数据库完整证明：MIGRATION_REQUIRED。

## 发现的阻断项

1. **FAIL：订单保留原始 `user_token`。** 10/10 订单的该字段非空；部署前需先确定安全迁移和兼容窗口，不能直接删除历史值。
2. **FAIL：生产仍注册 `/api/ai/preview`。** 当前线上旧代码中路由存在，且发现 20 个 `ai-preview-*` 文件、共 33,632 字节；普通 `/api/upload/public` 另有独立路径。新版本默认关闭逻辑尚未部署。
3. **MIGRATION_REQUIRED：** 财务 Outbox、超时任务、库存释放事件和预占表均不存在，不能把本地隔离 MySQL 的可靠性结论外推到生产。
4. **MANUAL_REVIEW：** 最近 100 行服务错误日志命中 17 条泛错误/Worker 关键词；为避免输出潜在订单或用户信息，本次只统计，不展开日志内容。应在离峰由管理员脱敏复核。

## 未完成项

本轮未进行真机双账号权限验证、真实小额支付退款、生产迁移后的表结构/索引验证，也没有运行任何补建脚本。

## 结论

隔离MySQL验收：PASS

生产只读审计：FAIL

生产迁移准备：MIGRATION_REQUIRED

双账号真机：待执行

真实支付退款：待执行

正式发布：仍BLOCKED
