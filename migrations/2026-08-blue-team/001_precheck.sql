-- Read-only marker. scripts/run-blue-team-migrations.js runs the complete
-- information_schema/data preflight before executing any DDL and stops on
-- duplicate candidates or historical consistency anomalies.
SELECT
  DATABASE() AS database_name,
  @@version AS mysql_version,
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE()) AS table_count,
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE()) AS column_count,
  (SELECT COUNT(DISTINCT CONCAT(table_name,':',index_name)) FROM information_schema.statistics WHERE table_schema=DATABASE()) AS index_count;
