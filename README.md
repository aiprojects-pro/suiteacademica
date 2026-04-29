# Suite Académica para Moodle · v8.0

Aplicación web para generar preguntas tipo test, resúmenes, mapas conceptuales y documentos maquetados para virtualización a partir de archivos Word y PDF.

## Funcionalidades

- Login, sesiones y panel de administración de usuarios.
- Preguntas test en formato Aiken y GIFT.
- Polaridad positiva, negativa o mixta en las preguntas.
- Penalización configurable en exportación GIFT.
- Resúmenes en `.txt` y `.docx`.
- Mapas conceptuales exportables en SVG, PNG y PDF.
- Maquetación SCORMXPRESS en Word `.docx`.
- Plantillas de color para maquetación.
- Historial por usuario.
- Integración con Moodle por webservice/token.
- Procesamiento por secciones para PDFs grandes en maquetación.

## Requisitos

- Node.js 18 o superior
- npm 8 o superior
- Acceso a Internet para Anthropic API

## Instalación

```bash
git clone https://github.com/aiprojects-pro/suiteacademica.git
cd suiteacademica
npm install
cp .env.example .env
npm start
```

## Variables de entorno

Configura al menos estas variables en `.env`:

```env
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-6
PORT=3000
HOST=127.0.0.1
NODE_ENV=production
HTTPS=true

SESSION_SECRET=
SESSION_HOURS=8
ADMIN_USER=admin
ADMIN_PASS=

MAX_TOPICS=100
MAX_FILE_MB=50
BATCH_SIZE=25
MAX_CHARS=12000
CACHE_TTL_H=4
MAQ_CHUNK_CHARS=25000
MAQ_SINGLE_CHARS=18000
HISTORY_LIMIT=200
```

## Estructura

- `server.js`: backend Express
- `public/index.html`: frontend principal
- `public/login.html`: pantalla de acceso
- `.env.example`: ejemplo de configuración

## Notas de despliegue

- No subas `.env` al repositorio.
- No subas `data/`; contiene usuarios, sesiones, historial y plantillas personales.
- En producción se recomienda poner la app detrás de Nginx con HTTPS.

## Estado

La versión actual del proyecto en este repositorio corresponde a la línea v7 desplegada en producción.

**El progreso no se actualiza en tiempo real**
→ Verificar que Nginx/Apache tiene `proxy_buffering off` (ver configuración)

**Error "Temas no encontrados"**
→ Los archivos se borran de memoria tras `CACHE_TTL_H` horas. Volver a subir los archivos.

**Timeouts en generaciones largas**
→ Aumentar `proxy_read_timeout` en Nginx a `3600s` o más

**Los PDFs no se procesan bien**
→ Asegurarse de que son PDFs de texto (no escaneados). Los PDFs escaneados (solo imagen) pueden dar resultados limitados.

**Error de API key**
→ Verificar que `.env` existe en la raíz del proyecto y contiene `ANTHROPIC_API_KEY` sin comillas adicionales

---

## Actualización

```bash
cd /var/www/suite-academica
# Sube los nuevos archivos (o git pull)
npm install               # Solo si cambiaron dependencias
sudo systemctl restart suite-academica
```
