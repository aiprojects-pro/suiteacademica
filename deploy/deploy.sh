#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
#  Script de despliegue para Suite Académica Moodle
#  Idempotente: se puede ejecutar varias veces sin romper nada.
#
#  Uso:
#    sudo bash deploy.sh /opt/suiteacademica [usuario] [grupo]
#
#  Por defecto: /opt/suiteacademica, usuario `suiteapp`, grupo `suiteapp`.
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="${1:-/opt/suiteacademica}"
APP_USER="${2:-suiteapp}"
APP_GROUP="${3:-suiteapp}"
NODE_MIN_MAJOR=18

log()  { printf '\033[1;32m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
err()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# 1) Comprobaciones previas
[ "$EUID" -eq 0 ] || err "Este script debe ejecutarse como root (sudo)."

command -v node >/dev/null || err "Node.js no está instalado. Instala Node $NODE_MIN_MAJOR o superior."
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge "$NODE_MIN_MAJOR" ] || err "Node $NODE_MIN_MAJOR+ requerido. Actual: $(node -v)"

command -v npm >/dev/null || err "npm no está instalado."

# 2) Crear usuario/grupo de servicio si no existen
if ! id "$APP_USER" >/dev/null 2>&1; then
  log "Creando usuario de servicio: $APP_USER"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
else
  log "Usuario $APP_USER ya existe."
fi

# 3) Preparar el directorio de la aplicación
log "Preparando $APP_DIR"
mkdir -p "$APP_DIR"

# Si el script se ejecuta desde dentro del proyecto, copiar el código
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ "$PROJECT_DIR" != "$APP_DIR" ]; then
  log "Copiando código desde $PROJECT_DIR a $APP_DIR"
  rsync -a --delete \
    --exclude '.env' \
    --exclude 'data/' \
    --exclude 'node_modules/' \
    --exclude '.git/' \
    "$PROJECT_DIR"/ "$APP_DIR"/
fi

# 4) Instalar dependencias en modo producción (reproducible)
log "Instalando dependencias con npm ci --omit=dev"
cd "$APP_DIR"
if [ -f package-lock.json ]; then
  sudo -u "$APP_USER" -H npm ci --omit=dev || \
    err "npm ci falló. Comprueba que package-lock.json sea consistente con package.json"
else
  warn "package-lock.json no encontrado. Usando npm install (no reproducible)."
  sudo -u "$APP_USER" -H npm install --omit=dev
fi

# 5) Crear `data/` y `data/sessions/` con permisos 0700 antes del primer arranque
mkdir -p "$APP_DIR/data/sessions" "$APP_DIR/data/history" "$APP_DIR/data/templates"
chmod 0700 "$APP_DIR/data" "$APP_DIR/data/sessions" "$APP_DIR/data/history" "$APP_DIR/data/templates"

# 6) Si no existe .env, copiar el ejemplo y avisar al operador
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/deploy/.env.production.example" "$APP_DIR/.env"
  chmod 0600 "$APP_DIR/.env"
  warn "Se ha creado $APP_DIR/.env desde el ejemplo. EDITAR antes de arrancar:"
  warn "  - SESSION_SECRET (48 bytes aleatorios)"
  warn "  - ANTHROPIC_API_KEY"
  warn "  - HEALTH_TOKEN (32 bytes aleatorios)"
  warn "Genera secretos con:"
  warn "  node -e \"console.log(require('crypto').randomBytes(48).toString('base64'))\""
else
  log ".env existente conservado (no sobreescrito)."
fi

# 7) Propiedad y permisos
log "Ajustando propiedad a $APP_USER:$APP_GROUP"
chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
chmod 0700 "$APP_DIR/data"
[ -f "$APP_DIR/.env" ] && chmod 0600 "$APP_DIR/.env"

# 8) Instalar unit de systemd si está presente
SYSTEMD_UNIT="$APP_DIR/deploy/suiteacademica.service"
if [ -f "$SYSTEMD_UNIT" ]; then
  TARGET="/etc/systemd/system/suiteacademica.service"
  # Sustituir placeholders en la unit
  sed -e "s|@APP_DIR@|$APP_DIR|g" \
      -e "s|@APP_USER@|$APP_USER|g" \
      -e "s|@APP_GROUP@|$APP_GROUP|g" \
      "$SYSTEMD_UNIT" > "$TARGET"
  chmod 0644 "$TARGET"
  systemctl daemon-reload
  log "Unit instalada en $TARGET. Habilitar con: systemctl enable --now suiteacademica"
fi

# 9) Mostrar próximos pasos
cat <<EOF

═══════════════════════════════════════════════════════════════════════
 DESPLIEGUE BASE COMPLETADO
═══════════════════════════════════════════════════════════════════════

Próximos pasos manuales:

  1. Editar $APP_DIR/.env con los secretos reales:
       sudo -u $APP_USER nano $APP_DIR/.env

  2. (Opcional) Configurar nginx delante: ver $APP_DIR/deploy/nginx.conf.example

  3. Arrancar el servicio:
       sudo systemctl enable --now suiteacademica
       sudo systemctl status suiteacademica
       sudo journalctl -u suiteacademica -f

  4. Primer login:
       sudo cat $APP_DIR/data/ADMIN_INITIAL_PASSWORD.txt
       (usar esa contraseña, cambiarla al entrar, activar 2FA, guardar backup
        codes, borrar el fichero ADMIN_INITIAL_PASSWORD.txt)

═══════════════════════════════════════════════════════════════════════
EOF
