CREATE TABLE IF NOT EXISTS order_inventory_release_events (
  id VARCHAR(80) NOT NULL, business_key VARCHAR(180) NOT NULL, order_item_id VARCHAR(60) NOT NULL, order_id VARCHAR(32) NOT NULL, product_id VARCHAR(32) NOT NULL,
  quantity INT UNSIGNED NOT NULL, reason VARCHAR(120) NULL, source_type VARCHAR(40) NOT NULL, source_id VARCHAR(80) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(id), UNIQUE KEY uniq_inventory_release_event_business(business_key), KEY idx_inventory_release_event_item(order_item_id), KEY idx_inventory_release_event_order(order_id), KEY idx_inventory_release_event_source(source_type,source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
