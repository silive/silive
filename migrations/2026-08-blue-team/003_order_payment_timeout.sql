ALTER TABLE orders ADD COLUMN payment_expires_at DATETIME NULL;
ALTER TABLE orders ADD COLUMN stock_reserved_at DATETIME NULL;
ALTER TABLE orders ADD COLUMN stock_released_at DATETIME NULL;

CREATE TABLE IF NOT EXISTS order_payment_timeout_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id VARCHAR(32) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  attempt_count INT NOT NULL DEFAULT 0,
  available_at DATETIME NOT NULL,
  locked_at DATETIME NULL,
  locked_by VARCHAR(64) NULL,
  processed_at DATETIME NULL,
  last_error VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_payment_timeout_order (order_id),
  KEY idx_payment_timeout_due (status,available_at),
  KEY idx_payment_timeout_lock (status,locked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_orders_payment_timeout ON orders (payment_status,payment_expires_at);
