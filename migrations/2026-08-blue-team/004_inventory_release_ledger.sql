CREATE TABLE IF NOT EXISTS order_inventory_reservations (
  order_item_id VARCHAR(60) NOT NULL,
  order_id VARCHAR(32) NOT NULL,
  product_id VARCHAR(32) NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(order_item_id),
  KEY idx_inventory_reservation_order(order_id),
  KEY idx_inventory_reservation_product(product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_inventory_releases (
  order_item_id VARCHAR(60) NOT NULL,
  order_id VARCHAR(32) NOT NULL,
  product_id VARCHAR(32) NOT NULL,
  quantity INT UNSIGNED NOT NULL COMMENT '累计已释放数量',
  reason VARCHAR(120) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY(order_item_id),
  KEY idx_inventory_release_order(order_id),
  KEY idx_inventory_release_product(product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE order_inventory_releases ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
ALTER TABLE order_inventory_releases MODIFY COLUMN quantity INT UNSIGNED NOT NULL COMMENT '累计已释放数量';
