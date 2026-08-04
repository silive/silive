# 生产部署手册（2026-08，RC3 受控入口）

正式发布仍需独立维护窗口授权。本手册只定义受控顺序；任何命令缺少生产确认参数、数据库指纹、固定 RC3 SHA、外部计划/备份清单或操作日志时必须停止。

## 不可绕过的门禁

- 仅固定 RC3 SHA、干净工作树及受审批执行人可操作。`--production`、`--confirm-production`、`--expected-database`、`--expected-server-uuid`、`--expected-git-sha` 缺一不可。
- 每个数据库连接都读取 `DATABASE()`、`@@hostname`、`@@server_uuid`、`@@version`、`CURRENT_USER()`；名称、UUID、Git SHA 或结构摘要不一致即停止。测试库前缀在生产模式会被拒绝。
- preflight 只能只读：`SET SESSION TRANSACTION READ ONLY`、`START TRANSACTION READ ONLY` 后只使用查询语句。它只会生成有效期不超过 60 分钟的计划，不含凭据、订单号、手机号或 OpenID。
- 迁移和清理 apply 都必须验证一个两小时内的备份清单：数据库/UUID、文件、大小、重新计算的 SHA-256、`checksumVerified=true`、`restoreVerification=PASS`。空间不足时停止，任何脚本默认不删除旧备份或日志。
- 生产模式必须将 `NODE_ENV=production`、`STORAGE_MODE=mysql`、`PAY_MOCK=false`，并且 `AI_PREVIEW_ENABLED` 不为 `true`。审计日志必须位于仓库外且权限为 0600。
- MySQL DDL 可能隐式提交；7 个迁移**不能**宣称可作为一个事务整体回滚。任一步失败即停止后续迁移、停止 Worker 恢复动作，并按部分结构状态处理。

## 正式维护窗口（每阶段均需人工停点）

1. **创建并校验新全量备份。** 先确认空间；创建数据库、配置和必要上传文件备份，验证校验和与恢复，并生成外部备份清单。
2. **生产 preflight 只读计划。** 使用 `--production --read-only` 生成外部计划和 0600 审计日志。
3. **测试订单清理 dry-run。** 使用仓库外的逐笔白名单、`--expected-count=10` 生成不可变清理计划。
4. **人工核对计划和白名单。** 业务和数据库负责人核对脱敏订单标识、库存归还、财务汇总、`MANUAL_REVIEW=0` 与计划有效期。
5. **测试订单清理 apply。** 重新校验白名单、计划摘要、状态摘要、结构摘要和备份清单；同时提供 `--apply --confirm-delete-test-orders --confirm-exact-count=10`。不允许静默跳过订单。
6. **清理后只读复核。** 确认仅计划内订单受影响；主数据、白名单外订单、库存、财务和孤立数据无异常。
7. **再次运行迁移 preflight。** 清理会改变结构前计划所依赖的业务状态，必须重新生成新的只读迁移计划。
8. **执行 7 个迁移。** 明确 `--apply --confirm-run-seven-migrations`，仅按 `001` 至 `007` 固定顺序执行；逐步记录结构变化、时间和结果。
9. **迁移后结构复核。** 用只读检查确认表、字段、索引、引擎和字符集；异常时不启动 Worker。
10. **部署固定 RC3 SHA。** 单独审批的代码部署步骤；不得由迁移脚本执行部署、启动服务或启动 Worker。
11. **健康、Worker、AI 预览和 user_token 检查。** 保持 AI 关闭，确认新订单 `user_id`、空 `user_token` 和任务队列状态。
12. **双账号和小额支付退款。** 在业务/财务单独审批后验证隔离、支付、部分退款、库存和 Outbox。
13. **最后上传小程序。** 是完全独立的审批步骤，前述所有证据签字前不得上传、提审或发布。

## 迁移与清理参数骨架

所有路径均为仓库外绝对路径，所有值由当班负责人从本次只读结果复制，不能复用旧窗口值：

```sh
node scripts/preflight-production-migration.js \
  --production --read-only --confirm-production \
  --expected-database=... --expected-server-uuid=... --expected-git-sha=<RC3完整SHA> \
  --output-plan=/secure/window/preflight.json --operation-log=/secure/window/operations.log
```

清理 dry-run/apply 和迁移 apply 均还必须带各自计划文件及 SHA-256、相同数据库指纹、备份清单和操作日志。不得把阶段 1–10 合并为无人工确认的连续脚本。

## 禁止事项与证据

不得临时降低测试库保护、编辑环境文件、自动删除备份、吞掉 DDL 错误、自动修复数据、自动重试危险 DDL、自动启动 Worker 或部署代码。必须保留：固定 SHA、备份和恢复校验、preflight/cleanup 计划摘要、白名单摘要、操作日志、每个迁移文件摘要和结构差异、清理后复核及人工审批记录。
