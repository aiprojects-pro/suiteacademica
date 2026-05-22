#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
#  Script de backup para entornos systemd (NO OKD).
#  Para OKD el backup lo hace el CronJob de openshift/90-backup-cronjob.yaml.
#
#  Uso:
#    bash deploy/backup.sh [SRC_DIR] [DST_DIR] [KEEP_DAYS]
#
#  Defaults:
#    SRC_DIR=/opt/suiteacademica/data
#    DST_DIR=/var/backups/suiteacademica
#    KEEP_DAYS=14
#
#  Recomendación: añadir a crontab del usuario `suiteapp` (o root):
#    0 3 * * * /opt/suiteacademica/deploy/backup.sh >> /var/log/suiteacademica-backup.log 2>&1
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

SRC_DIR="${1:-/opt/suiteacademica/data}"
DST_DIR="${2:-/var/backups/suiteacademica}"
KEEP_DAYS="${3:-14}"

TS=$(date -u +%Y%m%d-%H%M%S)
OUT="$DST_DIR/backup-$TS.tar.gz"

log() { printf '[backup %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

[ -d "$SRC_DIR" ] || { log "ERROR: SRC_DIR no existe: $SRC_DIR"; exit 1; }
mkdir -p "$DST_DIR"

log "Creando $OUT desde $SRC_DIR"
# Excluimos sessions (regenerable + SQLite puede estar abierta) y el fichero
# de password inicial.
tar -czf "$OUT" \
    --exclude='sessions' \
    --exclude='ADMIN_INITIAL_PASSWORD.txt' \
    -C "$SRC_DIR" . 2>/dev/null || {
  log "WARN: tar reportó cambios durante la lectura; reintentando estricto…"
  tar -czf "$OUT" --exclude='sessions' --exclude='ADMIN_INITIAL_PASSWORD.txt' -C "$SRC_DIR" .
}
chmod 0600 "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)
log "OK ($SIZE)"

# Rotación: borrar backups con más de KEEP_DAYS días
find "$DST_DIR" -maxdepth 1 -name 'backup-*.tar.gz' -type f -mtime "+$KEEP_DAYS" -delete -print | while read -r f; do
  log "Borrado por rotación (>$KEEP_DAYS días): $f"
done

log "Backups conservados:"
ls -lh "$DST_DIR"/backup-*.tar.gz 2>/dev/null | awk '{printf "  %s  %s\n", $5, $9}' || log "(ninguno)"
