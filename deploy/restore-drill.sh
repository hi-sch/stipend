#!/usr/bin/env bash
# Prove a backup can be restored, against throwaway databases.
#
# An untested backup is not a backup. This takes a dump of a database, restores it into a
# fresh one, and compares what came back — so the procedure in DEPLOYMENT.md is one somebody
# has actually run rather than one that looks right.
#
# In Kubernetes the real thing is a CloudNativePG recovery; this is the same shape at a size
# you can run on a laptop, and it exercises the part that usually breaks: the dump reaching
# the restore intact.
#
#   deploy/restore-drill.sh                 # drill against a seeded scratch database
#   SOURCE_DB=stipend deploy/restore-drill.sh   # drill against a real one (reads only)
set -euo pipefail

PGC=${PGC:-stipend-pg}                 # container running Postgres
PGUSER=${PGUSER:-stipend}
SOURCE_DB=${SOURCE_DB:-}
STAMP=$(date +%s)
SEEDED="drill_source_${STAMP}"
TARGET="drill_restored_${STAMP}"
# Whether this run built its own source. Not `[ -z "$SOURCE_DB" ]`: SOURCE_DB is reassigned
# to the seeded name below, so by the time cleanup runs that test is false and the database
# this script created would be left behind.
CREATED_SOURCE=0

psql_() { container exec "$PGC" psql -U "$PGUSER" -v ON_ERROR_STOP=1 "$@"; }

cleanup() {
  psql_ -d postgres -c "DROP DATABASE IF EXISTS ${TARGET} WITH (FORCE)" >/dev/null 2>&1 || true
  if [ "$CREATED_SOURCE" = 1 ]; then
    psql_ -d postgres -c "DROP DATABASE IF EXISTS ${SEEDED} WITH (FORCE)" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ -z "$SOURCE_DB" ]; then
  CREATED_SOURCE=1
  echo "→ building a source database to drill against"
  psql_ -d postgres -c "CREATE DATABASE ${SEEDED}" >/dev/null
  psql_ -d "$SEEDED" -c "CREATE TABLE drill (id serial primary key, note text, at timestamptz default now())" >/dev/null
  psql_ -d "$SEEDED" -c "INSERT INTO drill (note) SELECT 'row ' || g FROM generate_series(1, 500) g" >/dev/null
  SOURCE_DB="$SEEDED"
fi

echo "→ source: ${SOURCE_DB}"
before=$(psql_ -tAd "$SOURCE_DB" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
echo "  tables: ${before}"

echo "→ dumping"
container exec "$PGC" pg_dump -U "$PGUSER" -Fc -d "$SOURCE_DB" -f "/tmp/${SOURCE_DB}.dump"
size=$(container exec "$PGC" stat -c %s "/tmp/${SOURCE_DB}.dump")
[ "$size" -gt 0 ] || { echo "dump is empty"; exit 1; }
echo "  ${size} bytes"

echo "→ restoring into ${TARGET}"
psql_ -d postgres -c "CREATE DATABASE ${TARGET}" >/dev/null
container exec "$PGC" pg_restore -U "$PGUSER" -d "$TARGET" "/tmp/${SOURCE_DB}.dump"

after=$(psql_ -tAd "$TARGET" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
echo "  tables: ${after}"
[ "$before" = "$after" ] || { echo "FAIL: ${before} tables dumped, ${after} restored"; exit 1; }

# Compare every table's row count, not just that the tables exist.
echo "→ comparing row counts"
mismatch=0
for t in $(psql_ -tAd "$SOURCE_DB" -c "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"); do
  a=$(psql_ -tAd "$SOURCE_DB" -c "SELECT count(*) FROM \"$t\"")
  b=$(psql_ -tAd "$TARGET" -c "SELECT count(*) FROM \"$t\"")
  if [ "$a" != "$b" ]; then echo "  MISMATCH ${t}: source ${a}, restored ${b}"; mismatch=1; fi
done
[ "$mismatch" = 0 ] || { echo "FAIL: restored data does not match"; exit 1; }

container exec "$PGC" rm -f "/tmp/${SOURCE_DB}.dump"
echo "✓ restore drill passed: ${after} tables, every row count matched"
