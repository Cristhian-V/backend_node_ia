# Hermes — Backend Node (Admin API)

**Asistente de normativa aduanera**

Backend Node.js/Express encargado de la gestion de usuarios y administracion del sistema. Comparte la base de datos PostgreSQL y el JWT con el backend Python.

## Stack

- **Express** (Node.js 22)
- **pg** (node-postgres)
- **bcrypt** — hash de passwords
- **jsonwebtoken** — JWT (compartido con backend Python via `SECRET_KEY`)

## Requisitos

- Node.js 22+
- PostgreSQL 16+ (puerto 5432 dev / 5433 prod)
- `SECRET_KEY` debe coincidir con el del backend Python

## Instalacion (dev)

```bash
cd backend_node
npm install
```

## Configuracion

Las variables de entorno se leen del `.env.prod` del root (en Docker) o de un `.env` local:

```env
PORT=4000
DATABASE_URL=postgresql://cumbre:cumbre123@localhost:5433/cumbre_ia
SECRET_KEY=change-me-to-a-random-secret-key
ACCESS_TOKEN_EXPIRE_MINUTES=1440
```

> **Critico:** `SECRET_KEY` debe ser identico al del backend Python para que los JWT sean validos entre ambos servicios.

## Comandos

```bash
# Dev
npm run dev

# Produccion
node src/index.js
```

## Estructura

```
backend_node/
├── src/
│   ├── index.js             # Server Express + CORS + health check
│   ├── config.js            # Config (dotenv): port, db url, secret, jwt expiry
│   ├── constants.js         # VALID_TOOLS, VALID_ROLES (espejo del backend Python)
│   ├── db.js                # Pool de conexiones PostgreSQL
│   ├── middleware/
│   │   └── auth.js          # authMiddleware (JWT verify) + adminMiddleware
│   └── routes/
│       ├── auth.js          # /auth/register, /auth/login, /auth/me
│       └── admin.js         # /admin/users CRUD (con tools + roles)
├── Dockerfile
├── .dockerignore
├── .gitignore
└── package.json
```

## API Endpoints

| Metodo | Ruta | Descripcion |
|---|---|---|
| POST | `/auth/register` | Registro (asigna tool default: consultor) |
| POST | `/auth/login` | Login |
| GET | `/auth/me` | Usuario actual + tools + roles |
| GET | `/admin/users` | Listar usuarios (admin) |
| POST | `/admin/users` | Crear usuario con tools + roles (admin) |
| PUT | `/admin/users/:id` | Actualizar usuario + tools (admin) |
| DELETE | `/admin/users/:id` | Eliminar usuario (admin) |
| GET | `/health` | Health check |

## Roles y Tools

| Tool | Rol | Acceso |
|---|---|---|
| `agente_aduanero_ia` | `consultor` | Chat + Historial |
| `agente_aduanero_ia` | `gestor` | Chat + Documentos + Historial + Pendientes + Checklist |
| `liquidador_ia` | — | (proximamente) |

## Puertos

| Entorno | Puerto |
|---|---|
| Dev | `4000` |
| Prod (Docker) | `4000` (host network) |
