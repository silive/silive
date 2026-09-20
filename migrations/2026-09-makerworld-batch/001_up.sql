-- MakerWorld 批量链接导入。正常发布由 cms/server.js 的幂等 initDb 执行；本文件供手工审阅。
ALTER TABLE products ADD COLUMN IF NOT EXISTS model_source_original_url VARCHAR(1000);
ALTER TABLE products ADD COLUMN IF NOT EXISTS model_author_id VARCHAR(100);
ALTER TABLE products ADD COLUMN IF NOT EXISTS model_author_url VARCHAR(500);
ALTER TABLE products ADD COLUMN IF NOT EXISTS model_fetched_at VARCHAR(40);
ALTER TABLE products ADD COLUMN IF NOT EXISTS model_imported_at VARCHAR(40);
ALTER TABLE products ADD COLUMN IF NOT EXISTS model_info_status VARCHAR(40);
ALTER TABLE products ADD COLUMN IF NOT EXISTS model_info_note TEXT;

CREATE TABLE IF NOT EXISTS makerworld_import_batches (
  id VARCHAR(50) PRIMARY KEY,
  started_at VARCHAR(40) NOT NULL,
  completed_at VARCHAR(40),
  submitted_count INT NOT NULL DEFAULT 0,
  success_count INT NOT NULL DEFAULT 0,
  existing_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  results_json JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_makerworld_batches_started (started_at)
);
