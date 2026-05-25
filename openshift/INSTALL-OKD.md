# Despliegue en OKD 4 SNO con LVM Storage

Esta guía despliega **Suite Académica Moodle v8.1** en un cluster
**OKD 4.22 Single-Node OpenShift** con almacenamiento provisto por el
**LVM Storage Operator (LVMS)**.

## Resumen rápido

```bash
# 1. Descomprime y entra
unzip suiteacademica-okd.zip
cd suiteacademica-main/

# 2. Login en el cluster
oc login -u <usuario> https://api.<cluster>.<domain>:6443

# 3. Ejecuta el script guiado (te pedirá la ANTHROPIC_API_KEY)
bash openshift/deploy-okd.sh
```

Eso es todo. El script hace los pasos 4-10 de abajo automáticamente.

---

## Despliegue paso a paso (si prefieres ir manual)

### 1. Prerrequisitos en el cluster

- **OKD 4.x SNO** (probado contra 4.18+, compatible con 4.22)
- **LVM Storage Operator (LVMS)** instalado y un `LVMCluster` aprovisionado.
  Comprobar que existe un StorageClass:
  ```bash
  oc get sc | grep -i lvm
  ```
  Debería ver algo como `lvms-vg1` con provisioner `topolvm.io`. Si tu SC se llama
  distinto, edita `openshift/30-pvc-data.yaml` y `31-pvc-backups.yaml` y cambia
  `storageClassName: lvms-vg1` por el nombre real. El script `deploy-okd.sh` lo
  hace solo si detecta otro nombre.

- **Imagen registry interno** habilitado (default en OKD).

- **CLI `oc`** instalado en tu máquina con sesión activa en el cluster.

### 2. Crear el proyecto

```bash
oc apply -f openshift/00-namespace.yaml
oc project suiteacademica
```

### 3. Crear el Secret con las claves

**Opción A — con el script (recomendado):**
El script `deploy-okd.sh` te pide la `ANTHROPIC_API_KEY` y genera
automáticamente `SESSION_SECRET` (48 bytes) y `HEALTH_TOKEN` (32 bytes).

**Opción B — manual:**
```bash
SESSION_SECRET="$(openssl rand -base64 48)"
HEALTH_TOKEN="$(openssl rand -base64 32)"

oc create secret generic suiteacademica-secrets \
  --namespace=suiteacademica \
  --from-literal="ANTHROPIC_API_KEY=sk-ant-XXXXXXXXX" \
  --from-literal="SESSION_SECRET=$SESSION_SECRET" \
  --from-literal="HEALTH_TOKEN=$HEALTH_TOKEN"
```

NO uses `10-secret.yaml.template` con `oc apply`: ese fichero es sólo una
referencia documentada del formato.

### 4. Aplicar todos los manifests

```bash
oc apply -k openshift/
```

Esto crea:

| Recurso | Para qué |
|---------|----------|
| `ConfigMap` `suiteacademica-config` | Variables no sensibles (límites, flags, timeouts) |
| `PVC` `suiteacademica-data` (5 Gi) | Datos persistentes: users.json, sesiones, history, audit.log |
| `PVC` `suiteacademica-backups` (10 Gi) | Salida del CronJob de backup |
| `ImageStream` + `BuildConfig` | Para construir la imagen dentro del cluster |
| `Deployment` 1 réplica + `Service` ClusterIP | La aplicación |
| `Route` TLS edge | Acceso HTTPS desde fuera del cluster |
| `NetworkPolicy` | Ingreso sólo desde router · egreso DNS+HTTPS |
| `CronJob` diario a las 03:00 (Europe/Madrid) | Backup tar.gz con rotación de 14 días |

### 5. Construir la imagen

```bash
oc start-build suiteacademica --from-dir=. --follow --wait
```

Esto sube el código al cluster, construye la imagen según el `Containerfile` y
la deja en el registry interno. El Deployment tiene un trigger que la
recoge automáticamente.

La primera build tarda **3-5 minutos** porque tiene que compilar módulos
nativos (`better-sqlite3`, `bcrypt`).

### 6. Esperar a que el pod arranque

```bash
oc rollout status deployment/suiteacademica
oc get pods -l app=suiteacademica
```

Cuando esté `Running` y `Ready 1/1`, sigue.

### 7. Obtener la contraseña inicial del admin

El primer arranque genera una contraseña aleatoria y la deja en un fichero
dentro del PVC. La leemos así:

```bash
oc exec deployment/suiteacademica -- cat /app/data/ADMIN_INITIAL_PASSWORD.txt
```

### 8. Primer acceso

```bash
oc get route suiteacademica -o jsonpath='{.spec.host}'
```

Abre `https://<la-route>/login` y:

1. **Login**: `admin` + contraseña inicial del paso 7.
2. **Cambia la contraseña** (te lo exige; mínimo 12 chars con 3 clases).
3. **Activa 2FA** desde el panel de cuenta (te lo exige también porque
   `REQUIRE_TOTP_FOR_ADMINS=true`).
4. Escanea el QR con tu app (Google Authenticator, 1Password, Authy…).
5. **Guarda los 10 códigos de respaldo** en un gestor de contraseñas.
6. **Borra el fichero de contraseña inicial:**
   ```bash
   POD=$(oc get pod -l app=suiteacademica -o jsonpath='{.items[0].metadata.name}')
   oc exec $POD -- rm /app/data/ADMIN_INITIAL_PASSWORD.txt
   ```

---

## Operación

### Ver logs

```bash
# Aplicación (incluye los warnings de seguridad ⚠ [SECURITY] ...)
oc logs deployment/suiteacademica -f

# Auditoría (eventos: login_ok, login_fail, password_change, totp_enable, ...)
oc exec deployment/suiteacademica -- tail -50 /app/data/audit.log

# Build (si hay un build en curso)
oc logs -f bc/suiteacademica
```

### Healthcheck con métricas

Sin token devuelve `{status:'ok'}` (uso externo no autenticado):
```bash
curl -sk https://<route>/api/health
```

Con token devuelve métricas operacionales:
```bash
HEALTH_TOKEN=$(oc get secret suiteacademica-secrets -o jsonpath='{.data.HEALTH_TOKEN}' | base64 -d)
curl -sk -H "X-Health-Token: $HEALTH_TOKEN" https://<route>/api/health
# {"status":"ok","version":"8.1.0","uptimeSec":1234,"rssMB":...,"sessionsActive":...}
```

### Backups

Los backups se ejecutan automáticamente todos los días a las **03:00
(Europe/Madrid)** y se guardan en el PVC `suiteacademica-backups`.

```bash
# Ver el CronJob y sus últimos jobs
oc get cronjob suiteacademica-backup
oc get jobs -l role=backup

# Disparar un backup manual
oc create job --from=cronjob/suiteacademica-backup backup-manual-$(date +%s)

# Listar los backups guardados
oc run -it --rm tmp-ls --image=registry.access.redhat.com/ubi9-minimal:latest \
  --restart=Never --overrides='{"spec":{"volumes":[{"name":"b","persistentVolumeClaim":{"claimName":"suiteacademica-backups"}}],"containers":[{"name":"tmp-ls","image":"registry.access.redhat.com/ubi9-minimal:latest","command":["ls","-lh","/backups"],"volumeMounts":[{"name":"b","mountPath":"/backups"}]}]}}'
```

### Restaurar un backup

1. Para la aplicación:
   ```bash
   oc scale deployment/suiteacademica --replicas=0
   ```

2. Lanza un pod temporal con AMBOS PVCs montados y extrae el backup elegido:
   ```bash
   oc apply -f - <<'EOF'
   apiVersion: v1
   kind: Pod
   metadata:
     name: restore-helper
     namespace: suiteacademica
   spec:
     restartPolicy: Never
     containers:
     - name: restore
       image: registry.access.redhat.com/ubi9-minimal:latest
       command: ["sleep","3600"]
       volumeMounts:
       - { name: data, mountPath: /data }
       - { name: backups, mountPath: /backups, readOnly: true }
     volumes:
     - name: data
       persistentVolumeClaim: { claimName: suiteacademica-data }
     - name: backups
       persistentVolumeClaim: { claimName: suiteacademica-backups }
   EOF

   oc exec -it restore-helper -- /bin/sh
   # dentro del pod:
   #   cd /data
   #   ls /backups/                       # ver backups disponibles
   #   tar -xzf /backups/backup-YYYYMMDD-HHMMSS.tar.gz -C /data
   #   exit
   oc delete pod restore-helper
   ```

3. Vuelve a escalar:
   ```bash
   oc scale deployment/suiteacademica --replicas=1
   ```

### Actualizar la aplicación

Cuando recibas una nueva versión del código:

```bash
# Sustituye el código local por la nueva versión y vuelve a construir:
oc start-build suiteacademica --from-dir=. --follow

# El Deployment se actualiza solo cuando termine la build (ImageStream trigger).
oc rollout status deployment/suiteacademica
```

### Cambiar la configuración

- Para vars **no sensibles**: edita `openshift/20-configmap.yaml` y `oc apply -f`.
  Hay que reiniciar el pod para que las recoja:
  ```bash
  oc rollout restart deployment/suiteacademica
  ```

- Para vars **sensibles**: edita el Secret directamente:
  ```bash
  oc edit secret suiteacademica-secrets
  # tras guardar:
  oc rollout restart deployment/suiteacademica
  ```

### Activar/desactivar 2FA obligatorio

`REQUIRE_TOTP_FOR_ADMINS` vive en el ConfigMap. Cambia a `"false"` y reinicia
el pod si necesitas desactivarlo temporalmente.

---

## Diagnóstico específico del flujo de maquetación

La maquetación es el endpoint más sensible porque combina (a) un SSE de larga
duración entre cliente y pod, (b) una llamada streaming a `api.anthropic.com`,
y (c) puede generar mucho output (chunks grandes).

### "Piensa pero no maqueta" — qué mirar

1. **¿Sube el contador de caracteres en pantalla?** El cliente recibe heartbeats
   cada ~5 s mientras Claude responde, con texto del tipo
   `"Sección 1/2 · 12.345 caracteres generados"`.
   - **Sí avanza** → la API funciona y el SSE llega. Si al final falla, mira
     `parseMaqJson` en logs (JSON inválido del modelo).
   - **No avanza ni un solo carácter** → el stream nunca empezó. Sigue al paso 2.

2. **Logs del pod durante un intento**:
   ```bash
   oc logs -f deployment/suiteacademica -n suiteacademica
   ```
   Dispara una maquetación. Esperar:
   - `[claude abc123] start model=... max_tokens=16000`
   - (silencio mientras Claude genera)
   - `[claude abc123] done ms=23456 in=2100 out=8400 chars=18500`

   Si NO aparece `start` → la petición ni llegó a Anthropic. Pasa al paso 3.
   Si aparece `start` pero nunca `done` ni `FAIL` → cuelgue real del stream.
   Si aparece `FAIL ms=... status=... err=...` → ese es el error exacto.

3. **¿El pod tiene salida a `api.anthropic.com`?**
   ```bash
   oc rsh deployment/suiteacademica -n suiteacademica
   # dentro del pod (UID asignado por SCC):
   node -e "fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':'invalid','anthropic-version':'2023-06-01','content-type':'application/json'},body:'{}'}).then(r=>console.log('HTTP',r.status)).catch(e=>console.log('ERR',e.message))"
   ```
   - `HTTP 401` → la red sale OK (Anthropic responde "invalid key").
   - `ERR ENOTFOUND` → DNS no resuelve `api.anthropic.com`.
   - `ERR ETIMEDOUT` → la red no llega (firewall corporativo, proxy obligatorio…).
   - `ERR EHOSTUNREACH` o similar → revisar NetworkPolicy y egress del cluster.

   Si hay un **proxy corporativo**, edita `openshift/20-configmap.yaml`,
   descomenta las líneas `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` y reinicia:
   ```bash
   oc apply -f openshift/20-configmap.yaml
   oc rollout restart deployment/suiteacademica
   ```

4. **¿El router HAProxy corta el SSE?** Comprobar las anotaciones de la Route:
   ```bash
   oc get route suiteacademica -o yaml | grep -A1 annotations
   ```
   Debe tener al menos:
   ```
   haproxy.router.openshift.io/timeout: 10m
   haproxy.router.openshift.io/timeout-tunnel: 10m
   ```
   Si faltan, aplica el manifest:
   ```bash
   oc apply -f openshift/70-route.yaml
   ```

5. **¿La NetworkPolicy bloquea egress?** Si tu cluster tiene OVN-Kubernetes
   o Calico con NetworkPolicy activa, comprueba que el egress a 443 funciona:
   ```bash
   oc get networkpolicy -n suiteacademica
   # debería listar `allow-egress-dns-and-https`
   ```
   Si **temporalmente** quieres descartar la NetworkPolicy como causa:
   ```bash
   oc delete networkpolicy allow-egress-dns-and-https -n suiteacademica
   # tras diagnóstico, vuelve a aplicarla:
   oc apply -f openshift/80-networkpolicy.yaml
   ```

### "Sección sin maquetar" en el docx final

Si el docx tiene bloques `⚠ No se pudo maquetar automáticamente esta sección
(motivo)`, ese mensaje es el **motivo real del fallo**. Casos típicos:

| Motivo en el docx | Diagnóstico |
|-------------------|-------------|
| "Streaming is strongly recommended for operations that may take longer than 10 minutes" | El SDK rechaza la llamada non-streaming. Ya corregido en v8.1+ (usamos `messages.stream`). Si lo ves, la versión desplegada está obsoleta — re-construye con `oc start-build --from-dir=.` |
| "Claude API: 400 max_tokens..." | El modelo no admite ese `max_tokens`. Bajar `MAQ_MAX_TOKENS` en el ConfigMap. |
| "Claude API: 401 ..." | API key inválida. Revisar Secret `ANTHROPIC_API_KEY`. |
| "Claude API: 404 model not found" | El nombre del modelo no existe. Revisar ConfigMap `ANTHROPIC_MODEL`. |
| "Claude API: 429 ..." | Cuota de Anthropic agotada o rate-limit. Esperar / subir plan. |
| "JSON inválido: ..." | Claude devolvió texto que no es JSON parseable. Suele resolverse con un reintento — el código ya hace 2 intentos. Si persiste, el prompt necesita ajuste. |

## Diagnóstico de problemas

### El pod no arranca

```bash
oc describe pod -l app=suiteacademica
oc logs -l app=suiteacademica --tail=100
```

Errores típicos:

| Mensaje | Causa | Solución |
|---------|-------|----------|
| `SESSION_SECRET es demasiado débil` | El Secret tiene el placeholder | Recreate el Secret con `openssl rand -base64 48` |
| `ANTHROPIC_API_KEY no definida` | Falta en el Secret | Edita el Secret |
| `EACCES /app/data` | PVC con permisos hostiles | Borra el pod, deja que el SCC reasigne UID; si persiste, recreate el PVC |
| Build falla en `npm ci` | `package-lock.json` desincronizado | Regenera localmente con `npm install` y vuelve a subir |

### Las sesiones se pierden tras reiniciar el pod

Verifica que el PVC se monta correctamente:
```bash
oc exec deployment/suiteacademica -- ls -la /app/data/sessions/
```
Debe existir `sessions.sqlite`. Si no, el volumen no se está montando.

### El admin se ha bloqueado por intentos fallidos

```bash
oc exec deployment/suiteacademica -- rm /app/data/login-fails.json
oc rollout restart deployment/suiteacademica
```

### El admin ha perdido el 2FA Y los backup codes

```bash
oc scale deployment/suiteacademica --replicas=0
# tras el rsh restaura desde un backup ANTERIOR a la activación del 2FA
oc exec deployment/suiteacademica -- node -e "
const fs=require('fs');
const u=JSON.parse(fs.readFileSync('/app/data/users.json','utf8'));
const a=u.find(x=>x.role==='admin');
delete a.totpSecret; delete a.totpEnabled; delete a.totpBackupCodes; delete a.totpEnrolledAt;
a.mustChangePassword=true;
fs.writeFileSync('/app/data/users.json',JSON.stringify(u,null,2),{mode:0o600});
"
oc scale deployment/suiteacademica --replicas=1
```

---

## Seguridad activa (resumen de la auditoría)

Todas las capas han sido verificadas funcionalmente:

- TLS edge en la Route + redirección HTTP→HTTPS
- CSP estricta (`script-src 'self'`)
- CSRF doble-submit con `timingSafeEqual`
- Cookies `httpOnly` + `sameSite:strict` + `secure`
- Sesiones en SQLite con `regenerate()` tras login + logout global tras cambio de password
- Rate limit por IP + lockout por cuenta + monitor de eventos sensibles
- 2FA TOTP con 10 backup codes + REQUIRE_TOTP_FOR_ADMINS
- Bcrypt nativo (cost 12) + política de contraseñas (12+ chars, 3 clases)
- Validación de firma mágica en uploads + worker_threads aislado (memoria + timeout)
- IDOR cerrado por `userId` en cache + SSRF cerrado en proxy Moodle
- Permisos 0700/0600 en `data/` + auditoría JSON con rotación
- NetworkPolicies: ingreso sólo desde router OpenShift; egreso DNS + HTTPS
- SCC `restricted-v2`: non-root, sin CAPs, sin privilegios
- 0 vulnerabilidades en `npm audit`

## Soporte

Si algo no funciona durante el despliegue, lo más útil para diagnosticar es:

```bash
oc get all,pvc,secret,configmap -n suiteacademica
oc logs deployment/suiteacademica --tail=200
oc describe pod -l app=suiteacademica
```
