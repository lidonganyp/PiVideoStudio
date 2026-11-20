#!/usr/bin/env bash
# PiVideoStudio SQLite 备份
BACKUP_DIR="/root/PiVideoStudio/storage/backups"
DB_PATH="/root/PiVideoStudio/storage/pivideo.db"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
cp "$DB_PATH" "$BACKUP_DIR/pivideo.db.bak.$TIMESTAMP"
# 保留最近 7 天
find "$BACKUP_DIR" -name "pivideo.db.bak.*" -mtime +7 -delete
