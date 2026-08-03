SELECT table_name,engine,table_collation
FROM information_schema.tables
WHERE table_schema=DATABASE()
  AND table_name IN (
    'payment_finance_outbox','order_payment_timeout_jobs','order_inventory_reservations',
    'order_inventory_releases','order_inventory_release_events','financial_record_item_allocations',
    'store_referral_attributions','promotion_relation_claims'
  )
ORDER BY table_name;

SELECT table_name,column_name,column_type,is_nullable,column_default,extra,column_comment
FROM information_schema.columns
WHERE table_schema=DATABASE()
  AND table_name IN ('orders','payment_finance_outbox','order_payment_timeout_jobs','order_inventory_releases','refund_items')
ORDER BY table_name,ordinal_position;

SELECT table_name,index_name,non_unique,GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns_list
FROM information_schema.statistics
WHERE table_schema=DATABASE()
  AND table_name IN (
    'orders','payment_finance_outbox','order_payment_timeout_jobs','order_inventory_release_events',
    'refund_items','reward_records','store_settlement_records','sales_agent_commissions',
    'promotion_relation_claims','order_idempotency_keys','pickup_code_claims','order_payment_facts'
  )
GROUP BY table_name,index_name,non_unique
ORDER BY table_name,index_name;
