# Despliegue — Suite Académica Moodle

Esta carpeta contiene todo lo necesario para desplegar la aplicación en
un servidor Linux con systemd + nginx.

## Contenido

| Fichero | Para qué sirve |
|---------|----------------|
| `deploy.sh` | Script idempotente que copia el código, instala dependencias, crea el usuario de servicio, ajusta permisos e instala la unit de systemd. |
| `suiteacademica.service` | Unit de systemd con sandboxing endurecido. |
| `nginx.conf.example` | Vhost de nginx (TLS, proxy a Node, SSE, límites de tamaño). |
| `.env.production.example` | Plantilla de variables de entorno para producción. |

## Despliegue paso a paso

### 1. Requisitos en el servidor

- Linux con systemd (Debian/Ubuntu/RHEL recientes)
- **Node.js 18+** (recomendado 20 LTS o 22 LTS)
- npm
- nginx
- (Opcional) certbot para Let's Encrypt

### 2. Subir el código

Desde tu máquina, sube el proyecto entero al servidor (sin `node_modules/`,
sin `.env` previo, sin `data/`):

```bash
rsync -av --exclude node_modules --exclude .env --exclude data \
      --exclude .git --exclude .claude \
      ./suiteacademica-main/ \
      usuario@servidor:/tmp/suiteacademica-src/
```

### 3. Ejecutar el script de despliegue

En el servidor, como root:

```bash
cd /tmp/suiteacademica-src
sudo bash deploy/deploy.sh /opt/suiteacademica suiteapp suiteapp
```

Esto:
1. Crea el usuario de servicio `suiteapp` (no login, sin home).
2. Copia el código a `/opt/suiteacademica`.
3. Instala dependencias con `npm ci --omit=dev`.
4. Crea `data/`, `data/sessions/`, `data/history/`, `data/templates/` con
   permisos `0700`.
5. Copia `.env.production.example` → `.env` si no existe (permisos `0600`).
6. Instala la unit `suiteacademica.service` en `/etc/systemd/system/`.
7. Imprime los próximos pasos.

### 4. Generar secretos y editar `.env`

```bash
# Generar secretos fuertes
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"  # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # HEALTH_TOKEN

# Editar el .env
sudo -u suiteapp nano /opt/suiteacademica/.env
```

**Obligatorio** rellenar:
- `ANTHROPIC_API_KEY` (la clave real de Anthropic)
- `SESSION_SECRET` (los 48 bytes generados arriba)
- `HEALTH_TOKEN` (los 32 bytes generados arriba)

**Recomendado** dejar tal cual:
- `NODE_ENV=production`
- `HTTPS=true`
- `HOST=127.0.0.1`
- `REQUIRE_TOTP_FOR_ADMINS=true`

**NO definir `ADMIN_PASS`** — el sistema genera una aleatoria fuerte en
el primer arranque.

### 5. Arrancar el servicio

```bash
sudo systemctl enable --now suiteacademica
sudo systemctl status suiteacademica       # verificar estado
sudo journalctl -u suiteacademica -f       # ver logs en vivo
```

### 6. Configurar nginx delante

```bash
sudo cp /opt/suiteacademica/deploy/nginx.conf.example /etc/nginx/sites-available/suiteacademica
sudo nano /etc/nginx/sites-available/suiteacademica   # cambiar el server_name
sudo ln -s /etc/nginx/sites-available/suiteacademica /etc/nginx/sites-enabled/
sudo nginx -t                                          # comprobar sintaxis
sudo systemctl reload nginx
```

### 7. Obtener certificado TLS (Let's Encrypt)

```bash
sudo certbot --nginx -d suiteacademica.tudominio.com
```

Activa HSTS sólo después de comprobar que todo funciona por HTTPS:
descomenta la línea `add_header Strict-Transport-Security ...` en el vhost.

### 8. Primer acceso

```bash
# Obtener la contraseña del admin inicial
sudo cat /opt/suiteacademica/data/ADMIN_INITIAL_PASSWORD.txt
```

1. Entra en `https://suiteacademica.tudominio.com/login`
2. Usuario: `admin` · Contraseña: la del fichero
3. La app te fuerza a cambiar la contraseña (mínimo 12 chars + 3 clases)
4. Como `REQUIRE_TOTP_FOR_ADMINS=true`, te exige activar 2FA antes de
   acceder al resto de funciones
5. Escanea el QR con Google Authenticator, 1Password, Authy…
6. **Guarda los 10 códigos de respaldo en un gestor de contraseñas seguro**
7. **Borra el fichero ADMIN_INITIAL_PASSWORD.txt**:
   ```bash
   sudo rm /opt/suiteacademica/data/ADMIN_INITIAL_PASSWORD.txt
   ```

## Operación

### Logs

- **Aplicación**: `sudo journalctl -u suiteacademica -f`
- **Auditoría**: `sudo cat /opt/suiteacademica/data/audit.log` (JSON-line)
- **Nginx**: `/var/log/nginx/suiteacademica.{access,error}.log`

### Healthcheck con métricas

```bash
curl -s -H "X-Health-Token: <tu HEALTH_TOKEN>" https://tudominio.com/api/health
```

Devuelve `uptimeSec`, `rssMB`, `heapUsedMB`, `sessionsActive`, `users`,
`pid`, `nodeVersion`. Sin token devuelve sólo `{status:'ok'}` para checks
externos no autenticados.

### Backups

Programar copia diaria de:

```
/opt/suiteacademica/data/users.json          # cuentas y secretos TOTP
/opt/suiteacademica/data/sessions/           # sesiones activas
/opt/suiteacademica/data/history/            # historial por usuario
/opt/suiteacademica/data/templates/          # plantillas de color
/opt/suiteacademica/data/audit.log*          # auditoría
/opt/suiteacademica/.env                     # configuración + secretos
```

### Actualizar la aplicación

```bash
# En tu máquina: subir el código nuevo
rsync -av --exclude node_modules --exclude .env --exclude data \
      ./suiteacademica-main/ usuario@servidor:/tmp/suiteacademica-src/

# En el servidor
sudo systemctl stop suiteacademica
sudo bash /tmp/suiteacademica-src/deploy/deploy.sh /opt/suiteacademica
sudo systemctl start suiteacademica
sudo journalctl -u suiteacademica -f
```

El script `deploy.sh` es idempotente: si ya hay `.env` no lo sobreescribe,
si ya hay `data/` no la toca.

### Rotación de logs de audit

Ya gestionada por el propio servidor: cuando `data/audit.log` supera
`AUDIT_MAX_BYTES` (defecto 5 MB) se rota a `audit.log.1` y se vacía.
Si quieres más histórico, añade un `logrotate` externo.

### Vigilancia de seguridad

El propio servidor imprime en stderr un warning destacado si hay una
concentración anormal de eventos sensibles:

```
⚠ [SECURITY] N eventos sensibles en los últimos 5 min — posible ataque.
```

Estos warnings llegan al `journalctl`. Considerar conectar journald con
un sistema de alertas (Loki/Grafana, Elastic, Datadog…).

## Diagnóstico de problemas

### El servicio no arranca

```bash
sudo journalctl -u suiteacademica -n 50
```

Errores típicos:
- `SESSION_SECRET es demasiado débil` → editar `.env` con un valor fuerte.
- `ANTHROPIC_API_KEY no definida` → editar `.env`.
- Puerto ocupado → cambiar `PORT` en `.env`.

### El admin se ha bloqueado por intentos fallidos

```bash
# Borrar el fichero de fallos (libera el lockout)
sudo rm /opt/suiteacademica/data/login-fails.json
sudo systemctl restart suiteacademica
```

### El admin ha perdido el dispositivo 2FA y los backup codes

```bash
# Edita users.json para quitar la 2FA del admin (sólo en emergencia)
sudo systemctl stop suiteacademica
sudo -u suiteapp node -e "
const fs=require('fs');
const u=JSON.parse(fs.readFileSync('/opt/suiteacademica/data/users.json','utf8'));
const a=u.find(x=>x.role==='admin');
delete a.totpSecret; delete a.totpEnabled; delete a.totpBackupCodes; delete a.totpEnrolledAt;
a.mustChangePassword=true;
fs.writeFileSync('/opt/suiteacademica/data/users.json',JSON.stringify(u,null,2),{mode:0o600});
console.log('2FA del admin desactivado. Cambia password en el primer login.');
"
sudo systemctl start suiteacademica
```

## Seguridad

Resumen de capas activas (todas verificadas en auditoría):

- TLS terminado en nginx, Node sólo en loopback
- CSP estricta (`script-src 'self'`, sin `unsafe-inline` para scripts)
- Helmet con todos los headers de seguridad
- CSRF doble-submit con `timingSafeEqual`
- Cookies `httpOnly` + `sameSite:strict` + `secure` en HTTPS
- Sesiones en SQLite con regeneración tras login y logout global tras cambio de password
- Rate limit por IP + lockout por cuenta + monitor de eventos sensibles
- 2FA TOTP con 10 backup codes
- Bcrypt nativo (cost 12)
- Política de contraseñas (12+ chars, 3 clases)
- Validación de firma mágica + worker aislado (memoria + timeout) para parsing PDF/DOCX
- IDOR cerrado por `userId` en cache de topics
- SSRF cerrado (DNS resolve + blacklist IPs privadas) en proxy Moodle
- Permisos 0700/0600 en `data/`
- Logs de auditoría JSON con rotación
