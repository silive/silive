CREATE TABLE IF NOT EXISTS payment_finance_outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type VARCHAR(60) NOT NULL, business_key VARCHAR(180) NOT NULL,
  aggregate_type VARCHAR(40) NOT NULL, aggregate_id VARCHAR(40) NOT NULL,
  payload_json JSON NULL, status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  attempt_count INT NOT NULL DEFAULT 0, available_at DATETIME NULL, locked_at DATETIME NULL,
  locked_by VARCHAR(64) NULL, processed_at DATETIME NULL, last_error VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY uniq_payment_finance_business (business_key),
  KEY idx_payment_finance_due (event_type,status,available_at), KEY idx_payment_finance_order (aggregate_id,event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
