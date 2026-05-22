#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
#  Script guiado de despliegue en OKD 4 SNO con LVM Storage.
#
#  Ejecutar DESDE LA RAÍZ del proyecto descomprimido:
#    cd suiteacademica-main/
#    bash openshift/deploy-okd.sh
#
#  El script:
#    1. Comprueba que `oc` está disponible y hay sesión activa.
#    2. Detecta el StorageClass LVMS y lo sustituye si no es "lvms-vg1".
#    3. Pide los secretos (o los genera) y crea el Secret en el cluster.
#    4. Aplica todos los manifests con kustomize.
#    5. Lanza la build de la imagen con `oc start-build --from-dir=.`.
#    6. Espera a que el pod esté Ready.
#    7. Imprime la URL pública y la contraseña inicial del admin.
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

NS="suiteacademica"
APP="suiteacademica"

log()  { printf '\033[1;32m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
err()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ask()  { printf '\033[1;36m? %s\033[0m ' "$*"; }

# 1) Comprobaciones previas
command -v oc >/dev/null || err "El cliente 'oc' no está instalado. Instala el OpenShift CLI."
oc whoami >/dev/null 2>&1 || err "No hay sesión activa en oc. Ejecuta 'oc login ...' primero."

CLUSTER_USER="$(oc whoami)"
CLUSTER_URL="$(oc whoami --show-server)"
log "Conectado al cluster: $CLUSTER_URL como $CLUSTER_USER"

# 2) Detectar StorageClass LVMS
log "Buscando StorageClass LVMS en el cluster…"
SC_DEFAULT="lvms-vg1"
SC_FOUND=$(oc get sc -o jsonpath='{.items[?(@.provisioner=="topolvm.io")].metadata.name}' 2>/dev/null | tr ' ' '\n' | head -1)
[ -z "$SC_FOUND" ] && SC_FOUND=$(oc get sc -o jsonpath='{.items[?(@.provisioner=="lvms.io")].metadata.name}' 2>/dev/null | tr ' ' '\n' | head -1)
[ -z "$SC_FOUND" ] && SC_FOUND=$(oc get sc -o name 2>/dev/null | grep -iE 'lvms|lvm' | head -1 | sed 's|.*/||')

if [ -n "$SC_FOUND" ] && [ "$SC_FOUND" != "$SC_DEFAULT" ]; then
  warn "StorageClass LVMS detectado: '$SC_FOUND' (los manifests usan '$SC_DEFAULT')"
  ask "¿Sustituyo '$SC_DEFAULT' por '$SC_FOUND' en los PVCs antes de aplicar? [Y/n]"
  read -r yn
  if [[ ! "$yn" =~ ^[Nn]$ ]]; then
    sed -i.bak "s|storageClassName: $SC_DEFAULT|storageClassName: $SC_FOUND|g" \
      openshift/30-pvc-data.yaml openshift/31-pvc-backups.yaml
    rm -f openshift/*.bak
    log "Manifests ajustados a StorageClass '$SC_FOUND'."
  fi
elif [ -z "$SC_FOUND" ]; then
  warn "No detecto un StorageClass LVMS. Los manifests usan '$SC_DEFAULT' por defecto."
  warn "Si tu cluster usa otro nombre, edita openshift/30-pvc-data.yaml y 31-pvc-backups.yaml."
fi

# 3) Namespace
log "Aplicando namespace…"
oc apply -f openshift/00-namespace.yaml
oc project "$NS" >/dev/null

# 4) Secret — pedir o generar valores
if oc get secret suiteacademica-secrets -n "$NS" >/dev/null 2>&1; then
  log "Secret 'suiteacademica-secrets' ya existe. No lo toco."
else
  log "Creando Secret 'suiteacademica-secrets'…"
  ask "Introduce ANTHROPIC_API_KEY (sk-ant-...):"
  read -r -s ANTHROPIC_KEY
  echo
  [ -z "$ANTHROPIC_KEY" ] && err "ANTHROPIC_API_KEY no puede estar vacía."

  if command -v openssl >/dev/null; then
    SESSION_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
    HEALTH_TOKEN="$(openssl rand -base64 32 | tr -d '\n')"
  else
    SESSION_SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
    HEALTH_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
  fi

  oc create secret generic suiteacademica-secrets \
    --namespace="$NS" \
    --from-literal="ANTHROPIC_API_KEY=$ANTHROPIC_KEY" \
    --from-literal="SESSION_SECRET=$SESSION_SECRET" \
    --from-literal="HEALTH_TOKEN=$HEALTH_TOKEN" \
    >/dev/null

  # No mostrar los secretos en pantalla; el admin los recupera del cluster si los necesita.
  log "Secret creado. Para recuperar HEALTH_TOKEN (uso operacional):"
  echo "    oc get secret suiteacademica-secrets -n $NS -o jsonpath='{.data.HEALTH_TOKEN}' | base64 -d; echo"
fi

# 5) Aplicar el resto con kustomize
log "Aplicando manifests con kustomize…"
oc apply -k openshift/

# 6) Construir la imagen desde el código local
log "Lanzando build de la imagen (puede tardar 3-5 min la primera vez)…"
oc start-build suiteacademica --namespace="$NS" --from-dir=. --follow --wait

# 7) Esperar a que el pod esté Ready
log "Esperando a que el pod esté Ready (timeout 5 min)…"
if ! oc rollout status deployment/suiteacademica -n "$NS" --timeout=5m; then
  err "El deployment no se estabilizó. Revisa: oc logs -n $NS deployment/suiteacademica"
fi

# 8) Mostrar URL y contraseña inicial
ROUTE_HOST=$(oc get route suiteacademica -n "$NS" -o jsonpath='{.spec.host}' 2>/dev/null || true)
PODNAME=$(oc get pod -n "$NS" -l app=suiteacademica -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo " DESPLIEGUE COMPLETADO"
echo "═══════════════════════════════════════════════════════════════════════"
[ -n "$ROUTE_HOST" ] && echo " URL pública:  https://$ROUTE_HOST"
echo " Namespace:    $NS"
echo " Pod:          $PODNAME"
echo ""
if [ -n "$PODNAME" ]; then
  echo " Contraseña inicial del admin (cópiala, te exigirá cambiarla en el 1er login):"
  oc exec -n "$NS" "$PODNAME" -- cat /app/data/ADMIN_INITIAL_PASSWORD.txt 2>/dev/null \
    | sed 's/^/    /' || warn "  (todavía no se ha generado; reintenta en unos segundos)"
fi
echo ""
echo " Próximos pasos:"
echo "   1. Entra en https://$ROUTE_HOST/login con admin + contraseña inicial."
echo "   2. Cambia la contraseña (mín 12 chars + 3 clases)."
echo "   3. Activa 2FA — escanea el QR con tu app."
echo "   4. GUARDA los 10 backup codes en un gestor de contraseñas."
echo "   5. Borra el fichero ADMIN_INITIAL_PASSWORD.txt del pod:"
echo "        oc exec -n $NS $PODNAME -- rm /app/data/ADMIN_INITIAL_PASSWORD.txt"
echo ""
echo " Operación:"
echo "   - Logs:        oc logs -n $NS deployment/suiteacademica -f"
echo "   - Audit log:   oc exec -n $NS $PODNAME -- cat /app/data/audit.log | tail -50"
echo "   - Backups:     oc get cronjob -n $NS"
echo "                  oc exec -n $NS deployment/suiteacademica -- ls -lh /app/data"
echo "   - Healthcheck: ver INSTALL-OKD.md"
echo "═══════════════════════════════════════════════════════════════════════"
