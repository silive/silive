# 非常智造阶段性收口检查（2026-08）

## 结论

**阶段收口：PASS。整体发布验收：BLOCKED。**

本次仅在本地工作区进行只读分析、语法检查和无外部副作用的测试；没有连接生产数据库、没有执行 MySQL 并发测试、没有发送真实企业微信消息、没有部署或提交。库存、支付和财务并发语义仍必须在隔离 MySQL 库中验收后，才具备发布结论。

基线为 `896b682a0f52fd7bfe2ee7a288251aaa934be855`（`main`）。开始及结束时 `git diff --check` 均通过。

## 工作区清单与分类

| 文件 | 分类 | 主要修改 | 是否与其他修复交叉 | 风险 |
|---|---|---|---|---|
| `cms/admin.html` | C AI 预览关闭 | 后台 AI 预览入口改为不可用提示 | 与 `cms/server.js` 路由开关配套 | 低；仅后台展示 |
| `cms/inventory-ledger.js` | E 部分退款库存 | `releaseOrderItemInventory` 改为按数量累计；`releaseOrderInventory` 复用逐项核心 | 与超时、取消、全额/部分退款共用 | 中；待 MySQL 并发验证 |
| `cms/server.js` | B/C/D/E/G | 支付财务 Worker、AI 前置守卫、订单 TTL、超时 Worker、退款数量释放和初始化 SQL | 是，全部关键链路汇合处 | 高；需隔离 MySQL 验收 |
| `cms/wecom-order-outbox.js` | B 支付财务 Outbox | `markOrderPaidAndEnqueue` 将支付事实、订单状态、财务事件与企业微信记录置于同一事务 | 与支付回调、WeCom Worker 配套 | 中；需 MySQL 故障注入 |
| `package.json` | B/D/F 测试 | 增加支付财务、回填与支付超时测试/工具命令 | 与新模块配套 | 低；未注册 `test:ai-preview-access` npm 别名 |
| `pages/checkout/checkout.js` | A 原有前端/C | 删除前台 AI 预览调用及其状态 | 与 AI 默认关闭一致 | 低；业务定制上传仍走原上传链路 |
| `pages/checkout/checkout.wxss` | A 原有前端/C | 删除 AI 预览样式 | 与上述页面代码配套 | 低 |
| `pages/orders/orders.js` | A 原有前端/E | 将部分退款与全额退款展示区分 | 与后端部分退款状态配套 | 低 |
| `project.config.json` | A 原有配置 | 增加上传包忽略目录 | 与后续包体优化有关，非本轮后端逻辑 | 中；`miniprogramRoot` 仍为 `./`，必须在开发者工具重测实际包体 |
| `project.private.config.json` | A 原有配置 | 本机上传忽略配置和大 Logo 排除 | 与包体配置配套 | 低；私有配置不会替代正式配置验证 |
| `scripts/test-security-ledgers.js` | F/E 测试 | 覆盖多次部分退款累计、幂等、模式边界和剩余释放 | 与库存账本核心配套 | 低 |
| `scripts/test-security-mysql.js` | F/B/D/E 测试 | 增加并发库存、超时、支付竞争、部分退款场景 | 与所有持久化并发语义交叉 | 高；本机无隔离库，未执行 |
| `scripts/test-security-p0.js` | F | 调整 P0 静态断言以覆盖当前路由/状态边界 | 与支付、AI、库存修复交叉 | 低 |
| `scripts/test-wecom-order-notification-db.js` | F/B | 企业微信通知记录的真实 MySQL 专项测试 | 与支付事务 Outbox 交叉 | 高；本机无隔离库，未执行 |
| `utils/auth.js` | A 原有前端 | 删除高频身份状态日志 | 与会话前端表现相关 | 低 |
| `WORKBUDDY_MINIPROGRAM_AUDIT.md` | H 审计报告 | 小程序包体、前端退款展示与日志记录 | 与后续包体工作相关 | 低；不应进入业务发布提交 |
| `artifacts/hanzhong-pendant/hanzhong_pendant.scad` | J 疑似无关 | 吊坠 CAD 文件 | 无 | 高；非本项目运行资源，不应提交 |
| `artifacts/hanzhong-pendant/hanzhong_pendant_preview.svg` | J 疑似无关 | CAD 预览 SVG | 无 | 高；不应提交 |
| `artifacts/hanzhong-pendant/hanzhong_pendant_preview.svg.png` | J 疑似无关 | CAD 预览 PNG | 无 | 高；不应提交 |
| `artifacts/hanzhong-pendant/hanzhong_pendant_preview_sips.png` | J 疑似无关 | CAD 预览 PNG | 无 | 高；不应提交 |
| `cms/ai-preview-access.js` | C AI 预览关闭 | `AI_PREVIEW_ENABLED === 'true'` 与路由决策 | 与 `cms/server.js:104,11186` 配套 | 低 |
| `cms/order-payment-timeout.js` | D 未支付超时关闭 | TTL、任务认领、锁超时恢复、关闭+释放同事务 | 与库存账本和支付回调竞争 | 高；待 MySQL 并发验收 |
| `cms/payment-finance-outbox.js` | B 支付财务 Outbox | 唯一业务键、认领、重试和显式补偿工具 | 与支付事务和 Worker 配套 | 高；待 MySQL 验收 |
| `cms/pickup-service-fee.js` | B 自提服务费边界 | 仅核销完成后可生成服务费的判断 | 与核销入口及财务 Worker 交叉 | 中；已做本地回归 |
| `docs/blue-team-full-audit-2026-08.md` | H 审计报告 | 蓝队基线与 P1 证据 | 本次修复的依据 | 低 |
| `docs/fix-partial-refund-inventory-release-2026-08.md` | H 修复报告 | 部分退款库存设计与限制 | 对应 E | 低 |
| `docs/fix-payment-finance-outbox-2026-08.md` | H 修复报告 | 财务 Outbox 设计与验证 | 对应 B | 低 |
| `docs/fix-unpaid-order-stock-timeout-2026-08.md` | H 修复报告 | 未支付 TTL 与库存释放设计 | 对应 D/E | 低 |
| `project.config.json.backup-20260730` | J 疑似无关 | 历史配置备份 | 无 | 中；不应提交或上传 |
| `scripts/audit-ai-preview-files.js` | H/F 审计工具 | AI 预览临时文件只读审计 | 对应 C | 低 |
| `scripts/audit-inventory-release-consistency.js` | H/F 审计工具 | 库存释放记录一致性只读审计 | 对应 E | 低 |
| `scripts/audit-payment-finance-outbox.js` | H/F 审计工具 | 财务 Outbox 一致性只读审计 | 对应 B | 低 |
| `scripts/backfill-inventory-release-events.js` | H/F 回填工具 | 旧库存释放事件补建，默认 dry-run | 对应 E | 中；生产 `--apply` 被拒绝 |
| `scripts/backfill-order-payment-expiry.js` | H/F 回填工具 | 历史未支付订单过期时间补建，默认 dry-run | 对应 D | 中；生产 `--apply` 被拒绝 |
| `scripts/backfill-payment-finance-outbox.js` | H/F 回填工具 | 缺失支付财务事件补建，默认 dry-run | 对应 B | 中；运行前需单独审查范围 |
| `scripts/test-ai-preview-access.js` | F/C 测试 | 默认关闭时匿名/登录用户均不可访问 | 对应 C | 低 |
| `scripts/test-order-payment-timeout.js` | F/D 测试 | 到期判断、任务状态和支付竞争的本地单元测试 | 对应 D | 低 |
| `scripts/test-payment-finance-backfill.js` | F/B 测试 | 补偿工具的 dry-run/apply 幂等模拟 | 对应 B | 低 |
| `scripts/test-payment-finance-outbox.js` | F/B 测试 | 财务事件创建、认领、重试和幂等模拟 | 对应 B | 低 |

`cms/server.js` 的交叉区域包括：创建订单 `6590-6675`、支付结果处理 `6805+`、财务 Worker `6946+`、超时 Worker `7003+`、核销服务费 `5868/6271/6316/6385/7409`、退款库存释放 `7777-7915`、AI 路由 `11186-11197`、初始化 `9451+ / 9635+ / 9790+`。

## 交叉检查

### 支付财务 Outbox

PASS。`cms/wecom-order-outbox.js:18-123` 使用同一 MySQL 事务锁定订单，写入支付事实、更新订单支付状态、`enqueuePaymentFinanceEvent` 和企业微信通知记录后才提交。`payment_finance_outbox.business_key` 具有唯一索引（`cms/server.js:9790-9818`），Worker 使用条件更新、`locked_by` 和锁超时恢复（`cms/payment-finance-outbox.js:40-123`）。

未发现支付回调在提交后直接创建三类收益的路径；MySQL 路径由 `runPaymentFinanceWorker` 在出站事件被认领后创建奖励/门店佣金/业务员佣金（`cms/server.js:6888-6891`）。JSON 兼容分支仍为旧非生产模式，生产启动配置拒绝 JSON fallback 的结论需 MySQL 环境复验。

### PAID_AFTER_CANCEL

PASS（静态）。支付在取消、关闭或作废之后到达时，`cms/wecom-order-outbox.js:69-93` 仅写支付事实与 `PAID_AFTER_CANCEL`，且 `queued:false`，不会排入财务或企业微信订单成功链路；不重新扣库存，不自动履约。

### 自提服务费

PASS（静态/本地回归）。`cms/pickup-service-fee.js` 的资格判断仅在已核销完成后的 `createPickupServiceFeeForVerifiedOrder` 使用。支付成功处理不调用该函数；门店核销和后台强制核销才调用（`cms/server.js:6271,6316,6385,7409`）。

### 未支付订单超时和库存释放

PASS（静态/本地回归）。有限库存订单在创建事务内锁商品、条件扣减库存、创建订单项与 reservation，并创建支付超时任务（`cms/server.js:6604-6675`）。超时关闭使用数据库任务认领、订单 `FOR UPDATE`、支付事实复核、订单关闭、库存释放和状态审计的单一事务（`cms/order-payment-timeout.js:85-237`）。

任务扫描基于 `order_payment_timeout_jobs(status, available_at)` 索引，批量上限为 100，锁超时可再次认领。Worker 定时器在每个进程启动，但实际任务认领通过条件 `UPDATE` 和 `locked_by` 实现跨实例竞争保护；进程内防重仅用于同一实例。

### 部分退款与全量释放

PASS（静态/本地回归）。`order_inventory_releases.order_item_id` 不再表示“只能释放一次”；其 `quantity` 明确是“累计已释放数量”（`cms/server.js:9635-9645`）。每次释放先锁订单项和累计行，在事件业务键唯一约束下插入事件，再用 `quantity + :quantity <= :orderedQuantity` 条件累计更新，最后增加实际有限库存（`cms/inventory-ledger.js:72-179`）。

部分退款在微信退款 `SUCCESS` 事务内按退款项数量写业务键 `refund:<refundRecord>:<refundItem>:<orderItem>`（`cms/server.js:7777-7915`）；整单取消、管理员关闭、超时关闭和全额退款都通过 `releaseOrderInventory(... releaseRemaining:true)` 仅释放剩余数量。`UNLIMITED` 和 `MADE_TO_ORDER` 在核心函数 `cms/inventory-ledger.js:82-84` 直接跳过。

### AI 预览关闭与上传隔离

PASS。唯一生产路由在 `cms/server.js:11186-11197`：在读取请求体、落盘或调用 `createAiPreview` 之前执行 `aiPreviewRouteDecision`。开关只接受 `process.env.AI_PREVIEW_ENABLED === 'true'`（`cms/ai-preview-access.js:3-5`）；未显式开启或非管理员 `POST` 都返回 404。普通图片上传仍位于独立的 `/api/upload`、`/api/upload/public` 分支（`cms/server.js:11602+`），未被该守卫覆盖。全仓仅存在该路由、函数、测试及文档引用，未发现小程序前端调用残留。

### 初始化与历史数据

PASS（新结构幂等，历史运行限制需人工确认）。以下新结构均为 `CREATE TABLE IF NOT EXISTS` 加 `ensureColumn/ensureIndex`：

- `payment_finance_outbox`：`uniq_payment_finance_business`，以及 due/order 索引；
- `order_payment_timeout_jobs`：`uniq_payment_timeout_order`，以及 due/lock 索引；
- `order_inventory_release_events`：`uniq_inventory_release_event_business`；
- `order_inventory_releases.quantity`：累计释放数。

没有发现上述三个新表在 `cms/server.js` 中的重复定义。检索显示的 `promotion_relation_claims` 重复定义是已有无关表，不属于本轮三张表。

新回填脚本默认 dry-run，库存/过期回填在生产环境拒绝 `--apply` 且要求额外确认。服务启动不会自动运行这三份回填脚本。注意：现有启动流程仍会执行 `ensureLegacyStoreMembers()`、`ensureReferralRewardRecords()`，并对最近 48 小时支付订单运行企业微信漏通知补偿（最多扫描 90 天、限额 200；`cms/server.js:7121-7130,12512-12524`）。这不是本轮库存或财务历史回填，但属于既有“启动时会写历史兼容/通知记录”的行为，部署前应单独确认其业务可接受性。

### 前端与配置交叉影响

PASS（静态）。本轮 AI 关闭删除了 checkout 的预览调用/样式，不改变支付、商品图片上传或订单金额。订单页仅修正部分退款标签。`project.config.json` 与私有配置新增上传忽略目录，没有修改 API 域名、页面注册或支付配置。由于 `miniprogramRoot` 仍为仓库根目录，包体必须在微信开发者工具中重新实测；本检查没有开始包体优化。

## 测试与检查结果

| 命令/检查 | 结果 | 说明 |
|---|---|---|
| `npm run test:payment-finance-outbox` | PASS | 本地模拟通过 |
| `npm run test:payment-finance-backfill` | PASS | dry-run/apply 幂等模拟通过 |
| `npm run test:order-payment-timeout` | PASS | 到期、关闭和竞争状态模拟通过 |
| `npm run test:order-domain` | PASS | 订单/退款数量域规则通过 |
| `npm run test:order-chain` | PASS | 订单链路回归通过 |
| `npm run test:security-p0` | PASS | P0 静态安全断言通过 |
| `npm run test:security-session-promotion` | PASS | 会话和归因测试通过 |
| `npm run test:security-boundaries` | PASS | 权限边界测试通过 |
| `npm run test:security-ledgers` | PASS | 累计库存释放、幂等和模式边界通过 |
| `npm run test:wecom-order-notifier` | PASS | 使用 mock，不发送真实企业微信消息 |
| `npm run test:wecom-order-notification-db` | BLOCKED | 缺少 `vsc_security_test_` 隔离 MySQL；脚本安全拒绝 |
| `WECOM_ORDER_WEBHOOK_URL='' npm run test:wecom-order-notification` | BLOCKED | 有意清空 webhook，脚本安全拒绝发送；未发生外部请求 |
| `node scripts/test-ai-preview-access.js` | PASS | 默认关闭与管理员开关断言通过 |
| `npm run test:security-mysql` | BLOCKED | 本次按要求不运行；此前无隔离 MySQL 配置 |
| 所有修改/未跟踪 `.js` 的 `node --check`（24 个） | PASS | 无语法错误 |
| `git diff --check` | PASS | 无空白错误 |

`package.json` 没有 `lint`、`typecheck` 或 `build` 脚本；项目也没有 TypeScript 配置，因此无可执行的 Lint/TypeScript/Build 命令。`scripts/test-ai-preview-access.js` 存在并已直接执行，但未注册为 `npm run test:ai-preview-access`；这是测试命令完整性的非业务缺口，应在下一次允许修改测试配置时补齐。

## 敏感信息与误修改检查

对受版本控制和未跟踪源文件（排除 `artifacts/`、`.git`、`node_modules`）进行了私钥、常见 token、完整企业微信 webhook 和明文密码模式扫描；未发现真实凭据。测试文件只包含测试占位内容。未发现客户手机号、OpenID 或地址被新日志直接输出。

疑似无关、应继续保持未跟踪且不得混入阶段性提交的文件：`artifacts/hanzhong-pendant/*`、`project.config.json.backup-20260730`、`WORKBUDDY_MINIPROGRAM_AUDIT.md`。后者是审计材料而非运行代码，是否纳入后续文档提交应与业务修复提交分开决定。

## 下一步

可以开始**只针对小程序包体的独立优化工作**，但不可把本工作区直接判定为可发布：支付、财务 Outbox、超时关闭、部分退款和跨 Worker 并发仍未在受保护的隔离 MySQL 库完成真实事务验证。建议先建立 `vsc_security_test_` 前缀的本地回环测试库，执行 `test:security-mysql` 与 `test:wecom-order-notification-db`，随后再决定阶段性提交边界。
