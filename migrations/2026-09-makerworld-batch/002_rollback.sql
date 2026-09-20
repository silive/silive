-- 只在回滚本功能且已备份数据后执行。会删除批次历史及新增的补全信息字段。
DROP TABLE IF EXISTS makerworld_import_batches;
ALTER TABLE products DROP COLUMN IF EXISTS model_info_note;
ALTER TABLE products DROP COLUMN IF EXISTS model_info_status;
ALTER TABLE products DROP COLUMN IF EXISTS model_imported_at;
ALTER TABLE products DROP COLUMN IF EXISTS model_fetched_at;
ALTER TABLE products DROP COLUMN IF EXISTS model_author_url;
ALTER TABLE products DROP COLUMN IF EXISTS model_author_id;
ALTER TABLE products DROP COLUMN IF EXISTS model_source_original_url;
