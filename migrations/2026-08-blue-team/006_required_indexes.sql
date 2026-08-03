-- The migration runner completed the duplicate-data preflight before this file.
-- CREATE INDEX statements are skipped only when an equivalent index exists.

ALTER TABLE refund_items ADD COLUMN sku_id VARCHAR(60) NULL;
ALTER TABLE refund_items ADD COLUMN refund_quantity INT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE refund_items ADD COLUMN product_refund_cents INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE refund_items ADD COLUMN discount_refund_cents INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE refund_items ADD COLUMN shipping_refund_cents INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE refund_items ADD COLUMN store_commission_reversal_cents INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE refund_items ADD COLUMN personal_reward_reversal_cents INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE refund_items ADD COLUMN pickup_service_fee_impact VARCHAR(30) NOT NULL DEFAULT 'NONE';
ALTER TABLE refund_items ADD COLUMN status VARCHAR(30) NOT NULL DEFAULT 'PROCESSING';
ALTER TABLE refund_items ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE order_notification_records ADD COLUMN claim_token VARCHAR(64) NULL;
ALTER TABLE order_notification_records ADD COLUMN processing_started_at DATETIME NULL;

ALTER TABLE reward_records ADD COLUMN business_key VARCHAR(180) NULL;
ALTER TABLE reward_records ADD COLUMN related_record_id VARCHAR(60) NULL;
ALTER TABLE store_settlement_records MODIFY COLUMN type VARCHAR(40) NULL;
ALTER TABLE store_settlement_records ADD COLUMN business_key VARCHAR(180) NULL;
ALTER TABLE store_settlement_records ADD COLUMN related_record_id VARCHAR(60) NULL;
ALTER TABLE sales_agent_commissions ADD COLUMN business_key VARCHAR(180) NULL;
ALTER TABLE sales_agent_commissions ADD COLUMN related_record_id VARCHAR(80) NULL;

CREATE TABLE IF NOT EXISTS financial_record_item_allocations (
  id VARCHAR(80) PRIMARY KEY,
  ledger_type VARCHAR(30) NOT NULL,
  record_id VARCHAR(60) NOT NULL,
  order_id VARCHAR(32) NOT NULL,
  order_item_id VARCHAR(60) NOT NULL,
  sku_id VARCHAR(60) NULL,
  quantity INT UNSIGNED NOT NULL,
  allocated_amount_cents INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_financial_item_allocation (ledger_type,record_id,order_item_id),
  KEY idx_financial_allocation_order (order_id,order_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS store_referral_attributions (
  id VARCHAR(60) PRIMARY KEY,
  token_hash CHAR(64) NOT NULL,
  store_id VARCHAR(40) NOT NULL,
  user_id VARCHAR(32) NULL,
  visitor_hash CHAR(64) NULL,
  source VARCHAR(80) NULL,
  share_code VARCHAR(80) NULL,
  attribution_type VARCHAR(30) NOT NULL DEFAULT 'store_external',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  last_order_id VARCHAR(32) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_store_attribution_token (token_hash),
  KEY idx_store_attribution_user (user_id,status,expires_at),
  KEY idx_store_attribution_visitor (visitor_hash,status,expires_at),
  KEY idx_store_attribution_store (store_id,status,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS promotion_relation_claims (
  invitee_phone VARCHAR(30) NOT NULL,
  relation_id VARCHAR(32) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (invitee_phone),
  UNIQUE KEY uniq_promotion_relation_claim (relation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE UNIQUE INDEX uniq_payment_fact_transaction ON order_payment_facts(transaction_id);
CREATE INDEX idx_refund_item_order_item ON refund_items(order_item_id,status);
CREATE UNIQUE INDEX uniq_reward_business ON reward_records(business_key);
CREATE UNIQUE INDEX uniq_store_settlement_business ON store_settlement_records(business_key);
CREATE UNIQUE INDEX uniq_sales_agent_business ON sales_agent_commissions(business_key);
CREATE UNIQUE INDEX uniq_order_idempotency_scope ON order_idempotency_keys(user_id,operation,request_key);
CREATE INDEX idx_order_idempotency_order ON order_idempotency_keys(order_id);
CREATE INDEX idx_order_idempotency_expiry ON order_idempotency_keys(expires_at);
CREATE UNIQUE INDEX uniq_pickup_code_order ON pickup_code_claims(order_id);
