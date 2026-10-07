#!/bin/bash
# ============================================================
#  switch-db.sh — switch Directus between databases safely
#  Usage:
#     ./switch-db.sh old      -> use the OLD database  (directus)
#     ./switch-db.sh new      -> use the NEW database  (directus_migrated)
#     ./switch-db.sh status   -> show what's active now
#
#  Nothing is deleted. Switching only edits DB_DATABASE in .env
#  and recreates the Directus app container (not Postgres).
#  Optional backup: set DO_BACKUP=1 to pg_dump before switching.
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"

OLD_DB="directus"
NEW_DB="directus_migrated"
DO_BACKUP=1                          # 0 = skip, 1 = dump before switching

dump_db() {
  local db="$1"
  local stamp
  stamp="$(date +%Y-%m-%d_%H-%M-%S)"
  echo ">> Backing up database '$db'..."
  docker exec directus-database pg_dump -U directus -d "$db" -Fc \
    -f "/tmp/${db}_${stamp}.dump"
  docker exec directus-database ls -lh "/tmp/${db}_${stamp}.dump"
  echo "   backup: /tmp/${db}_${stamp}.dump"
}

set_db() {
  local db="$1"
  sed -i '' "s/^DB_DATABASE=.*/DB_DATABASE=${db}/" .env
  echo ">> .env now: DB_DATABASE=${db}"
}

recreate() {
  echo ">> Recreating Directus app container (Postgres untouched)..."
  docker compose up -d --force-recreate directus
  sleep 12
  echo ">> Health: $(curl -s http://localhost:8055/server/health)"
}

show_status() {
  echo ">> .env says:        DB_DATABASE=$(grep '^DB_DATABASE=' .env | cut -d= -f2)"
  echo ">> App connected to: $(docker exec directus-database psql -U directus -d postgres -tAc "SELECT DISTINCT datname FROM pg_stat_activity WHERE usename='directus' AND client_addr IS NOT NULL")"
  echo ">> Databases present:"
  docker exec directus-database psql -U directus -d postgres -tAc "SELECT datname || '  (' || pg_size_pretty(pg_database_size(datname)) || ')' FROM pg_database WHERE datname IN ('directus','directus_migrated') ORDER BY 1"
}

case "${1:-}" in
  old)
    [ "$DO_BACKUP" = "1" ] && dump_db "$NEW_DB"
    set_db "$OLD_DB"
    recreate
    echo ">> On the OLD database now. Open http://localhost:8055"
    show_status
    ;;
  new)
    [ "$DO_BACKUP" = "1" ] && dump_db "$OLD_DB"
    set_db "$NEW_DB"
    recreate
    echo ">> On the NEW database now. Open http://localhost:8055"
    show_status
    ;;
  status)
    show_status
    ;;
  *)
    echo "Usage: $0 {old|new|status}"
    exit 1
    ;;
esac