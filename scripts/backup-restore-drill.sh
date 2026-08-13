#!/usr/bin/env bash
# Rehearse a database backup and restore.
#
# Dumps the running Postgres, restores the dump into a throwaway database, and
# proves the copy matches the source two ways: the schema-only dumps are
# identical, so every table, trigger, and constraint round-trips, and every
# table holds the same number of rows. A dump that pg_dump can write but no one
# has ever restored is not a backup; this exercises the restore path.
#
# pg_dump and psql run inside the compose db container, so the client and server
# versions always agree. Production uses RDS automated snapshots; this drill
# covers the logical-dump path against the local database.
set -euo pipefail

SERVICE=db
DB_USER=authledger
SRC_DB=authledger
CHECK_DB=authledger_restore_check
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

dc() { docker compose exec -T "$SERVICE" "$@"; }

echo "==> Backing up $SRC_DB"
dc pg_dump -U "$DB_USER" -d "$SRC_DB" >"$WORK/backup.sql"
echo "    wrote $(wc -c <"$WORK/backup.sql" | tr -d ' ') bytes"

echo "==> Restoring into a throwaway database ($CHECK_DB)"
dc psql -U "$DB_USER" -d postgres -qc "DROP DATABASE IF EXISTS $CHECK_DB"
dc psql -U "$DB_USER" -d postgres -qc "CREATE DATABASE $CHECK_DB"
dc psql -U "$DB_USER" -d "$CHECK_DB" -q -v ON_ERROR_STOP=1 <"$WORK/backup.sql" >/dev/null

echo "==> Comparing schema"
# pg_dump 18 wraps each dump in a random \restrict/\unrestrict token; drop it so
# the comparison sees only real schema.
schema_dump() {
  dc pg_dump -U "$DB_USER" -d "$1" --schema-only | grep -vE '^\\(un)?restrict '
}
schema_dump "$SRC_DB" >"$WORK/src-schema.sql"
schema_dump "$CHECK_DB" >"$WORK/dst-schema.sql"
if diff -u "$WORK/src-schema.sql" "$WORK/dst-schema.sql"; then
  echo "    schema identical"
else
  echo "!! schema differs after restore"
  exit 1
fi

echo "==> Comparing row counts"
# One row per public base table as "name<tab>count". query_to_xml runs the count
# for each table so the whole manifest comes back from a single query.
counts() {
  dc psql -U "$DB_USER" -d "$1" -tA -F$'\t' -v ON_ERROR_STOP=1 -c "
    SELECT table_name,
           (xpath('//text()[normalize-space()]',
             query_to_xml(format('SELECT count(*) FROM %I.%I', table_schema, table_name),
                          false, true, '')))[1]::text::bigint
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name"
}
src_counts=$(counts "$SRC_DB")
dst_counts=$(counts "$CHECK_DB")
# Guard against a broken manifest reading as a match of two empty results.
if [ -z "$src_counts" ]; then
  echo "!! could not read source row counts"
  exit 1
fi
if diff -u <(printf '%s\n' "$src_counts") <(printf '%s\n' "$dst_counts"); then
  echo "    row counts match ($(printf '%s\n' "$src_counts" | wc -l | tr -d ' ') tables)"
else
  echo "!! row counts differ after restore"
  exit 1
fi

echo "==> Cleaning up"
dc psql -U "$DB_USER" -d postgres -qc "DROP DATABASE $CHECK_DB"

echo "==> Backup/restore rehearsal PASSED"
