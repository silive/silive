#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/www/wwwroot/very-simple-custom}"
BACKUP_ROOT="${BACKUP_ROOT:-/www/backup/very-simple-custom}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
LOG_FILE="${LOG_FILE:-$BACKUP_ROOT/backup.log}"
NOW="$(date +%Y%m%d_%H%M%S)"

log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG_FILE"
}

fail() {
  log "FAILED: $*"
  exit 1
}

if [ ! -d "$APP_DIR" ]; then
  fail "APP_DIR not found: $APP_DIR"
fi

mkdir -p "$BACKUP_ROOT" || fail "cannot create backup dir: $BACKUP_ROOT"
touch "$LOG_FILE" || fail "cannot write log file: $LOG_FILE"

ENV_FILE="$APP_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  log "WARN: .env not found, MySQL backup will use environment/default values"
fi

MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_USER="${MYSQL_USER:-root}"
MYSQL_DATABASE="${MYSQL_DATABASE:-very_simple_custom}"
MYSQL_DUMP_FILE="$BACKUP_ROOT/mysql_${NOW}.sql.gz"
UPLOADS_FILE="$BACKUP_ROOT/uploads_${NOW}.tar.gz"

log "backup start"

if command -v mysqldump >/dev/null 2>&1; then
  log "dump mysql database: $MYSQL_DATABASE"
  if [ -n "${MYSQL_PASSWORD:-}" ]; then
    MYSQL_PWD="$MYSQL_PASSWORD" mysqldump \
      -h "$MYSQL_HOST" \
      -P "$MYSQL_PORT" \
      -u "$MYSQL_USER" \
      --single-transaction \
      --routines \
      --triggers \
      --events \
      --no-tablespaces \
      "$MYSQL_DATABASE" | gzip > "$MYSQL_DUMP_FILE" || fail "mysqldump failed"
  else
    mysqldump \
      -h "$MYSQL_HOST" \
      -P "$MYSQL_PORT" \
      -u "$MYSQL_USER" \
      --single-transaction \
      --routines \
      --triggers \
      --events \
      --no-tablespaces \
      "$MYSQL_DATABASE" | gzip > "$MYSQL_DUMP_FILE" || fail "mysqldump failed"
  fi
  chmod 600 "$MYSQL_DUMP_FILE"
  log "mysql backup saved: $MYSQL_DUMP_FILE"
else
  log "WARN: mysqldump not found, skip mysql backup"
fi

if [ -d "$APP_DIR/cms/uploads" ]; then
  log "archive uploads"
  tar -czf "$UPLOADS_FILE" -C "$APP_DIR/cms" uploads || fail "uploads backup failed"
  chmod 600 "$UPLOADS_FILE"
  log "uploads backup saved: $UPLOADS_FILE"
else
  log "WARN: uploads dir not found, skip uploads backup"
fi

log "remove backups older than ${RETENTION_DAYS} days"
find "$BACKUP_ROOT" -type f \( -name 'mysql_*.sql.gz' -o -name 'uploads_*.tar.gz' \) -mtime +"$RETENTION_DAYS" -print -delete >> "$LOG_FILE" 2>&1 || fail "retention cleanup failed"

log "backup completed"
