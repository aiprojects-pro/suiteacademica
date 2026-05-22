# ─────────────────────────────────────────────────────────────────────
#  Suite Académica Moodle · Containerfile (OCI image)
#
#  Multi-stage:
#    1. builder  → instala devDeps necesarias para compilar módulos nativos
#                  (better-sqlite3, bcrypt) y produce node_modules limpio.
#    2. runtime  → imagen final ligera con sólo lo necesario para correr.
#
#  Compatible con OKD/OpenShift SCC `restricted-v2`:
#    - Usuario no-root con UID alto (10001).
#    - Grupo primario root (0) para que volúmenes montados con fsGroup sean
#      escribibles cualquiera que sea el UID asignado por el SCC.
#    - Sin CAPs, sin privileged, sin setuid.
# ─────────────────────────────────────────────────────────────────────

# ═══ Stage 1: builder ════════════════════════════════════════════════
FROM docker.io/library/node:22-bookworm-slim AS builder

# Herramientas para compilar módulos nativos (better-sqlite3, bcrypt)
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Capa cacheable de dependencias
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Resto del código
COPY server.js ./server.js
COPY public/ ./public/
COPY workers/ ./workers/

# ═══ Stage 2: runtime ════════════════════════════════════════════════
FROM docker.io/library/node:22-bookworm-slim AS runtime

# Sólo certificados raíz (para HTTPS saliente a api.anthropic.com)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /app

# Copiar artefactos del builder
COPY --from=builder --chown=10001:0 /build/node_modules ./node_modules
COPY --from=builder --chown=10001:0 /build/server.js     ./server.js
COPY --from=builder --chown=10001:0 /build/public/       ./public/
COPY --from=builder --chown=10001:0 /build/workers/      ./workers/
COPY --chown=10001:0 package.json ./package.json

# Directorio para datos (montaremos un PVC aquí). Permisos abiertos al grupo 0
# para compatibilidad con cualquier UID que asigne el SCC de OpenShift.
RUN mkdir -p /app/data /app/data/sessions /app/data/history /app/data/templates \
    && chown -R 10001:0 /app \
    && chmod -R g=u /app \
    && chmod 0770 /app/data /app/data/sessions /app/data/history /app/data/templates

# Variables por defecto del runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data \
    HTTPS=true

EXPOSE 3000

# Healthcheck básico (el liveness/readiness del Deployment refinará esto)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health', r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Tini como init para reaping de procesos zombies (workers)
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]

# UID alto compatible con OpenShift SCC. El SCC `restricted-v2` reasignará
# uno aleatorio del rango del namespace en ejecución, pero conservará gid=0
# por el chown anterior y los chmod g=u.
USER 10001:0

LABEL org.opencontainers.image.title="Suite Académica Moodle" \
      org.opencontainers.image.version="8.1.0" \
      org.opencontainers.image.licenses="Proprietary"
