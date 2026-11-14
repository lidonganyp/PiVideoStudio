#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# PiVideoStudio Storage Cleanup Script
# 清理临时素材文件，保留数据库和近期文件
# 用法: ./scripts/cleanup-storage.sh [--dry-run] [--max-age 7] [--max-size 10G]
# ============================================================

STORAGE_DIR="${PIVIDEO_STORAGE_DIR:-$(pwd)/storage}"
MAX_AGE_DAYS=7
MAX_SIZE="10G"
DRY_RUN=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --max-age)
      MAX_AGE_DAYS="$2"
      shift 2
      ;;
    --max-size)
      MAX_SIZE="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

echo "========================================"
echo "PiVideoStudio Storage Cleanup"
echo "========================================"
echo "Storage dir:  $STORAGE_DIR"
echo "Max age:      ${MAX_AGE_DAYS} days"
echo "Max size:     $MAX_SIZE"
echo "Dry run:      $DRY_RUN"
echo "========================================"
echo ""

# Ensure storage directory exists
if [[ ! -d "$STORAGE_DIR" ]]; then
  echo "Error: Storage directory does not exist: $STORAGE_DIR"
  exit 1
fi

# Step 1: Clean old temporary files (older than MAX_AGE_DAYS)
# Skip: *.db, *.db-journal, *.db-wal, *.db-shm
echo "[1/3] Cleaning files older than ${MAX_AGE_DAYS} days..."

OLD_FILES=$(find "$STORAGE_DIR" \
  -type f \
  -mtime +"$MAX_AGE_DAYS" \
  ! -name '*.db' \
  ! -name '*.db-journal' \
  ! -name '*.db-wal' \
  ! -name '*.db-shm' \
  2>/dev/null || true)

if [[ -n "$OLD_FILES" ]]; then
  OLD_COUNT=$(echo "$OLD_FILES" | wc -l)
  OLD_SIZE=$(echo "$OLD_FILES" | xargs du -ch 2>/dev/null | tail -1 | cut -f1)
  echo "  Found $OLD_COUNT file(s), total size: $OLD_SIZE"

  if [[ "$DRY_RUN" == "false" ]]; then
    echo "$OLD_FILES" | xargs rm -f
    echo "  Deleted $OLD_COUNT file(s)"
  else
    echo "  [DRY RUN] Would delete $OLD_COUNT file(s)"
  fi
else
  echo "  No old files found"
fi
echo ""

# Step 2: Clean oversized files (larger than MAX_SIZE)
echo "[2/3] Cleaning files larger than $MAX_SIZE..."

# Convert MAX_SIZE to bytes for find
MAX_SIZE_BYTES=$(numfmt --from=auto "$MAX_SIZE" 2>/dev/null || echo "10737418240")

LARGE_FILES=$(find "$STORAGE_DIR" \
  -type f \
  -size +"${MAX_SIZE_BYTES}c" \
  ! -name '*.db' \
  ! -name '*.db-journal' \
  ! -name '*.db-wal' \
  ! -name '*.db-shm' \
  2>/dev/null || true)

if [[ -n "$LARGE_FILES" ]]; then
  LARGE_COUNT=$(echo "$LARGE_FILES" | wc -l)
  LARGE_SIZE=$(echo "$LARGE_FILES" | xargs du -ch 2>/dev/null | tail -1 | cut -f1)
  echo "  Found $LARGE_COUNT file(s), total size: $LARGE_SIZE"

  if [[ "$DRY_RUN" == "false" ]]; then
    echo "$LARGE_FILES" | xargs rm -f
    echo "  Deleted $LARGE_COUNT file(s)"
  else
    echo "  [DRY RUN] Would delete $LARGE_COUNT file(s)"
  fi
else
  echo "  No oversized files found"
fi
echo ""

# Step 3: Clean empty directories
echo "[3/3] Cleaning empty directories..."

if [[ "$DRY_RUN" == "false" ]]; then
  find "$STORAGE_DIR" -type d -empty -delete 2>/dev/null || true
  echo "  Empty directories removed"
else
  EMPTY_DIRS=$(find "$STORAGE_DIR" -type d -empty 2>/dev/null || true)
  if [[ -n "$EMPTY_DIRS" ]]; then
    echo "  [DRY RUN] Would remove $(echo "$EMPTY_DIRS" | wc -l) empty dir(s)"
  else
    echo "  No empty directories found"
  fi
fi
echo ""

# Summary
echo "========================================"
echo "Cleanup complete"
echo "========================================"
CURRENT_SIZE=$(du -sh "$STORAGE_DIR" 2>/dev/null | cut -f1)
echo "Current storage size: $CURRENT_SIZE"
