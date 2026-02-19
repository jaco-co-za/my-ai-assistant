# MySQL Docker Server

Runs a local MySQL server with Docker Compose using values from `.env`.

## Start

```bash
cd servers/mysql-docker
cp .env.example .env
chmod +x install.sh
./install.sh
```

If `.env` does not exist, `install.sh` creates it from `.env.example`.

## Env values

Set these in `.env`:

- `MYSQL_IMAGE`
- `MYSQL_CONTAINER_NAME`
- `MYSQL_HOST_BIND_IP`
- `MYSQL_PORT`
- `MYSQL_ROOT_PASSWORD`
- `MYSQL_DATABASE`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `MYSQL_DATA_DIR`
- `MYSQL_TZ`

## Useful commands

```bash
docker compose --env-file .env -f docker-compose.yml logs -f
docker compose --env-file .env -f docker-compose.yml down
```
