# Sistema de Gestión de Taller — V1

Aplicación web para organizar el taller: trabajos (láser, serigrafía, ploteo/cartelería),
estados, cobro/facturación, cheques y pagos de servicios, con login familiar por roles.

> **Nota sobre el diseño:** el frontend de esta V1 es *funcional y sin diseño* a propósito
> (carpeta `backend/public`). La idea es reemplazar esa capa visual por tu diseño final
> (paleta, tipografías, etc.) sin tocar la lógica ni el backend.

---

## 1. Qué incluye

- **Backend** (Node.js + Express) con API REST y login JWT.
- **Base de datos** PostgreSQL con el esquema completo.
- **Frontend** estático servido por el mismo backend.
- **Docker Compose** para levantar todo con un comando.
- Roles: **admin** (todo), **gestor** (carga/edita), **consulta** (solo mira).

**Stack:** Node.js · Express · PostgreSQL · Docker · JWT · Vanilla JS (frontend)

## 2. Estructura

```
.
├─ docker-compose.yml       # levanta base de datos + app
├─ docker-compose.ai.yml    # stack opcional de IA (Ollama, n8n, WAHA, Whisper)
├─ .env.example             # copiar a .env y completar
├─ db/
│  ├─ init.sql              # esquema de la base (se crea solo la 1ª vez)
│  └─ migrations/           # migraciones para instalaciones existentes
├─ backend/
│  ├─ Dockerfile
│  ├─ package.json
│  ├─ src/                  # API (auth, trabajos, cheques, pagos, usuarios, dashboard, ingesta, bandeja)
│  └─ public/               # frontend funcional (index.html, app.js, styles.css)
├─ n8n/                     # workflow de ejemplo para la carga automática
└─ docs/                    # documento técnico del proyecto (plan, arquitectura)
```

---

## 3. Puesta en marcha en el NAS (Synology, QNAP o similar con Docker)

### 3.1 Requisitos
- Un NAS con **Docker / Container Manager** habilitado (o cualquier PC/mini-PC con Docker).
- Acceso por SSH al NAS, o la interfaz de Container Manager.

### 3.2 Pasos
1. **Clonar el proyecto** en el servidor:
   ```bash
   git clone https://github.com/TU_USUARIO/taller-app.git
   cd taller-app
   ```
2. **Crear el archivo `.env`** a partir del ejemplo y completar TODOS los valores:
   ```bash
   cp .env.example .env
   nano .env
   ```
   - `DB_PASSWORD`: una contraseña larga y aleatoria.
   - `JWT_SECRET`: generala con `openssl rand -base64 48`.
   - `ADMIN_EMAIL` y `ADMIN_PASSWORD`: el primer usuario administrador (papá).
3. **Levantar todo:**
   ```bash
   docker compose up -d --build
   ```
4. Entrar desde un navegador en la red de casa/taller a:
   ```
   http://<IP-del-NAS>:3000
   ```
   e iniciar sesión con el email/clave de admin del `.env`.

> La primera vez, el sistema crea la base y el usuario admin automáticamente.
> **Cambiá la contraseña del admin** apenas ingreses (Usuarios → Editar).

### 3.3 En Synology Container Manager (sin SSH)
1. Container Manager → **Proyecto** → **Crear**.
2. Elegí la carpeta donde copiaste `taller-app` y el `docker-compose.yml`.
3. Cargá las variables del `.env` y ejecutá el proyecto.

---

## 4. Acceso seguro desde afuera (Tailscale)

Para que la familia entre desde cualquier lugar **sin exponer el NAS a internet**:

1. Instalá **Tailscale** en el NAS (Synology y QNAP tienen paquete oficial; en otros, corré el
   contenedor oficial de Tailscale). Iniciá sesión y autorizá el equipo.
2. Instalá la app de **Tailscale** en el celular/PC de cada integrante de la familia y logueá a
   todos en la **misma cuenta/tailnet** (el plan gratuito permite hasta 6 usuarios).
3. Desde cualquier dispositivo con Tailscale activo, entrá a:
   ```
   http://<IP-de-Tailscale-del-NAS>:3000
   ```
   (la IP `100.x.y.z` que muestra Tailscale, o el nombre MagicDNS del NAS).

Resultado: túnel cifrado punto a punto, sin abrir puertos en el router, sin nada visible en
internet abierto.

> **No abras el puerto 3000 en el router hacia internet.** Todo el acceso externo debe pasar por
> Tailscale.

---

## 5. Seguridad (resumen operativo)

- Contraseñas guardadas con **hash bcrypt** (nunca en texto plano).
- Sesiones con **JWT** que vencen a las 12 horas.
- **Permisos por rol** en cada endpoint (crear/editar: admin+gestor; eliminar y usuarios: solo admin).
- La base de datos **no expone puertos** a la red: solo la usa el backend.
- **Bitácora** (`audit_log`): registra login y cambios (quién y cuándo).
- Cambiá el `JWT_SECRET` y las contraseñas por defecto antes de usar en serio.

### Opcional recomendado: HTTPS
Aún dentro de Tailscale podés servir por HTTPS usando **Tailscale Serve**, que le da un certificado
válido al NAS sin configurar nada más. Es un plus de seguridad para el tráfico interno.

---

## 6. Backups

Los datos viven en el volumen Docker `db_data`. Hacé una copia periódica:

```bash
# Backup manual de la base (guardá el archivo fuera del NAS también)
docker exec taller-db pg_dump -U <DB_USER> <DB_NAME> > backup_taller_$(date +%F).sql
```

Recomendado:
- **Backup diario** de la base (podés automatizarlo con una tarea programada del NAS).
- **Snapshots** del NAS activados.
- Una **copia fuera del NAS** (disco externo o nube cifrada) — regla 3-2-1.
- Probar de vez en cuando que un backup **se puede restaurar**.

Restaurar:
```bash
cat backup_taller_YYYY-MM-DD.sql | docker exec -i taller-db psql -U <DB_USER> -d <DB_NAME>
```

---

## 7. API (referencia rápida)

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| POST | `/api/auth/login` | público | Login, devuelve token |
| GET | `/api/dashboard` | cualquiera | Resumen para la pantalla de inicio |
| GET/POST | `/api/trabajos` | ver / editar | Listar y crear trabajos |
| PUT/PATCH | `/api/trabajos/:id` | editar | Editar / cambiar estado |
| DELETE | `/api/trabajos/:id` | admin | Eliminar |
| GET/POST/PUT | `/api/cheques` | ver / editar | Cheques |
| GET/POST/PUT | `/api/pagos` | ver / editar | Pagos de servicios |
| GET/POST/PUT/DELETE | `/api/usuarios` | admin | Gestión de usuarios |

---

## 8. Próximos pasos

1. Reemplazar el frontend de `backend/public` por tu diseño final (misma API).
2. (Fase 2) Portal público de solo lectura para clientes con Cloudflare Tunnel.
3. (Fase 2) Reportes, presupuestos/remitos en PDF, avisos de vencimientos.

---

## 9. Novedades v1.1 — listo para automatización (IA)

La app ya viene preparada para recibir cargas automáticas y revisarlas antes de darlas por buenas:

- **Campos nuevos** en trabajos, cheques y pagos: `origen` (manual/ia), `revisado`, `origen_ref`.
- **Pestaña Bandeja**: muestra todo lo cargado por IA pendiente de revisar; se confirma o descarta con un clic.
- **Endpoints de ingesta** (`/api/ingesta/...`) protegidos con `INGEST_API_KEY`, para que n8n cargue sin login humano.

Si ya tenías la base creada de un