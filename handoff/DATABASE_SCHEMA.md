# 数据库结构说明

数据库名称默认：

```text
very_simple_custom
```

实际名称由 `.env` 中 `MYSQL_DATABASE` 决定。

后端在 `cms/server.js` 的 `initDb()` 中自动创建数据库和表。如果未安装 `mysql2` 或连接失败，本地开发会回退到 `cms/data/*.json`。

## 1. home_config

首页装修配置表。

```sql
CREATE TABLE IF NOT EXISTS home_config (
  id INT PRIMARY KEY,
  data JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)
```

用途：

- 首页 Banner
- 首页入口
- 商品展示配置
- 联系方式
- 页面装修数据

## 2. products

商品表。

```sql
CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  intro VARCHAR(255),
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  cost_price DECIMAL(10,2) DEFAULT 0,
  badge VARCHAR(30),
  cover VARCHAR(30),
  image_url VARCHAR(500),
  gallery_images JSON,
  video_url VARCHAR(500),
  detail_images JSON,
  detail_text TEXT,
  categories JSON,
  status VARCHAR(20) DEFAULT 'on',
  stock INT DEFAULT 0,
  is_hot VARCHAR(10) DEFAULT 'false',
  promotion_hot VARCHAR(10) DEFAULT 'false',
  ai_preview_enabled VARCHAR(10) DEFAULT 'false',
  ai_preview_type VARCHAR(30),
  reward_enabled VARCHAR(10) DEFAULT 'true',
  first_reward DECIMAL(10,2) DEFAULT 0,
  second_reward DECIMAL(10,2) DEFAULT 0,
  sort_order INT DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)
```

字段说明：

- `id`：商品 ID。
- `name`：商品名称。
- `intro`：副标题/卖点。
- `price`：售价，单位元。
- `cost_price`：成本价，用于利润统计。
- `badge`：标签，如新品、人气、爆品。
- `image_url`：主图。
- `gallery_images`：轮播图 JSON 数组。
- `video_url`：商品视频 URL。
- `detail_images`：详情图 JSON 数组。
- `detail_text`：详情文字。
- `categories`：一级/二级类目数组。
- `status`：`on/off`。
- `stock`：库存。
- `is_hot`：首页热门推荐。
- `promotion_hot`：推广页热门商品。
- `ai_preview_enabled`：是否开启 AI 预览。
- `ai_preview_type`：叶雕/摆件/木牌/军牌/情侣礼物。
- `reward_enabled`：是否参与推广奖励。
- `first_reward`：一级奖励金额。
- `second_reward`：二级奖励金额。
- `sort_order`：排序值。

## 3. orders

订单表。

```sql
CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(32) PRIMARY KEY,
  customer_name VARCHAR(50) NOT NULL,
  phone VARCHAR(30),
  product_name VARCHAR(100),
  amount DECIMAL(10,2),
  status VARCHAR(30),
  payment_status VARCHAR(30) DEFAULT '待支付',
  transaction_id VARCHAR(80),
  openid VARCHAR(80),
  user_id VARCHAR(80),
  user_token VARCHAR(120),
  address VARCHAR(255),
  custom_request TEXT,
  original_image_url VARCHAR(500),
  original_image_urls JSON,
  ai_preview_url VARCHAR(500),
  final_design_url VARCHAR(500),
  category VARCHAR(80),
  is_custom_order VARCHAR(10) DEFAULT 'false',
  remark TEXT,
  product_id VARCHAR(32),
  inviter_code VARCHAR(32),
  shipping_company VARCHAR(80),
  tracking_number VARCHAR(80),
  shipped_at DATETIME,
  refund_type VARCHAR(30),
  refund_status VARCHAR(30),
  refund_reason VARCHAR(255),
  refund_amount DECIMAL(10,2),
  refund_remark TEXT,
  refund_image_url VARCHAR(500),
  refund_reject_reason VARCHAR(255),
  refund_reviewed_at DATETIME,
  created_at DATETIME,
  paid_at DATETIME,
  completed_at DATETIME,
  refund_at DATETIME
)
```

订单身份：

- 用户端主要用 `openid` 与 `user_token` 绑定。
- 用户端接口不信任前端直接传来的身份。
- 后台管理员可查看全部订单。

订单状态建议：

- 未支付
- 待确认
- 待发货
- 已发货
- 已完成
- 退款中
- 已退款

支付字段：

- `payment_status`：待支付/已支付/已退款。
- `transaction_id`：微信支付交易号。
- `paid_at`：支付时间。

物流字段：

- `shipping_company`
- `tracking_number`
- `shipped_at`

售后字段：

- `refund_type`
- `refund_status`
- `refund_reason`
- `refund_amount`
- `refund_remark`
- `refund_image_url`
- `refund_reject_reason`
- `refund_reviewed_at`
- `refund_at`

## 4. customers

客户表。

```sql
CREATE TABLE IF NOT EXISTS customers (
  id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  phone VARCHAR(30),
  wechat VARCHAR(80),
  orders INT DEFAULT 0,
  total_amount DECIMAL(10,2) DEFAULT 0,
  last_contact DATE,
  invite_code VARCHAR(32),
  shopping_money DECIMAL(10,2) DEFAULT 0
)
```

用途：

- 客户资料。
- 订单统计。
- 邀请码。
- 购物金。

## 5. promotion_relations

推广关系表。

```sql
CREATE TABLE IF NOT EXISTS promotion_relations (
  id VARCHAR(32) PRIMARY KEY,
  inviter_phone VARCHAR(30),
  inviter_name VARCHAR(50),
  inviter_code VARCHAR(32),
  invitee_phone VARCHAR(30),
  invitee_name VARCHAR(50),
  level INT DEFAULT 1,
  created_at DATETIME
)
```

用于二级推广关系。

## 6. promotion_visits

邀请访问表。

```sql
CREATE TABLE IF NOT EXISTS promotion_visits (
  id VARCHAR(32) PRIMARY KEY,
  invite VARCHAR(64),
  visitor_id VARCHAR(64),
  created_at DATETIME,
  UNIQUE KEY uniq_invite_visitor (invite, visitor_id)
)
```

用于统计邀请访问人数。

## 7. reward_rules

奖励规则表。

```sql
CREATE TABLE IF NOT EXISTS reward_rules (
  id VARCHAR(32) PRIMARY KEY,
  product_id VARCHAR(32),
  product_name VARCHAR(100),
  first_reward DECIMAL(10,2) DEFAULT 0,
  second_reward DECIMAL(10,2) DEFAULT 0
)
```

注意：当前奖励规则也已并入商品编辑抽屉，商品字段为准。

## 8. reward_records

奖励记录表。

```sql
CREATE TABLE IF NOT EXISTS reward_records (
  id VARCHAR(40) PRIMARY KEY,
  order_id VARCHAR(32),
  product_name VARCHAR(100),
  buyer_phone VARCHAR(30),
  promoter_phone VARCHAR(30),
  promoter_name VARCHAR(50),
  level INT DEFAULT 1,
  amount DECIMAL(10,2) DEFAULT 0,
  status VARCHAR(30),
  release_at DATETIME,
  created_at DATETIME,
  updated_at DATETIME
)
```

状态：

- 待发放
- 已发放
- 已扣回

规则：

- 订单完成 7 天后发放。
- 退款成功后扣回。

## 9. system_settings

系统设置表。

```sql
CREATE TABLE IF NOT EXISTS system_settings (
  id INT PRIMARY KEY,
  data JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)
```

包含：

- 类目管理 `categoryCatalog`
- 活动管理
- 帮助中心文章
- 客服配置
- 新人福利
- 皮肤管理
- 当前启用皮肤

## 10. JSON 兜底数据

本地 JSON 存储文件：

```text
cms/data/home.json
cms/data/orders.json
cms/data/customers.json
cms/data/settings.json
cms/data/promotion-relations.json
cms/data/promotion-visits.json
cms/data/reward-rules.json
cms/data/reward-records.json
cms/data/order-recommendation-events.json
```

注意：

- 生产建议使用 MySQL。
- JSON 只适合本地开发或临时演示。
- `cms/data` 已被小程序打包忽略。

## 11. 建议增加的索引

当前代码主要依赖主键与简单查询。上线后建议补充：

```sql
CREATE INDEX idx_orders_openid ON orders(openid);
CREATE INDEX idx_orders_user_token ON orders(user_token);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_sort_order ON products(sort_order);
CREATE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_reward_records_order_id ON reward_records(order_id);
```

