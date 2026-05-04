CREATE DATABASE IF NOT EXISTS very_simple_custom
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE very_simple_custom;

CREATE TABLE IF NOT EXISTS home_config (
  id INT PRIMARY KEY,
  data JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

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
  promotion_hot VARCHAR(10) DEFAULT 'false',
  ai_preview_enabled VARCHAR(10) DEFAULT 'false',
  ai_preview_type VARCHAR(30),
  reward_enabled VARCHAR(10) DEFAULT 'true',
  first_reward DECIMAL(10,2) DEFAULT 0,
  second_reward DECIMAL(10,2) DEFAULT 0,
  sort_order INT DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

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
);

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
);

CREATE TABLE IF NOT EXISTS promotion_relations (
  id VARCHAR(32) PRIMARY KEY,
  inviter_phone VARCHAR(30),
  inviter_name VARCHAR(50),
  inviter_code VARCHAR(32),
  invitee_phone VARCHAR(30),
  invitee_name VARCHAR(50),
  level INT DEFAULT 1,
  created_at DATETIME
);

CREATE TABLE IF NOT EXISTS promotion_visits (
  id VARCHAR(32) PRIMARY KEY,
  invite VARCHAR(64),
  visitor_id VARCHAR(64),
  created_at DATETIME,
  UNIQUE KEY uniq_invite_visitor (invite, visitor_id)
);

CREATE TABLE IF NOT EXISTS reward_rules (
  id VARCHAR(32) PRIMARY KEY,
  product_id VARCHAR(32),
  product_name VARCHAR(100),
  first_reward DECIMAL(10,2) DEFAULT 0,
  second_reward DECIMAL(10,2) DEFAULT 0
);

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
);

CREATE TABLE IF NOT EXISTS system_settings (
  id INT PRIMARY KEY,
  data JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
