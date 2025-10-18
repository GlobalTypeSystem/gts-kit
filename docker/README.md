# Docker Deployment Guide

This guide covers deploying GTS Viewer using Docker and Docker Compose.

All Docker-related files are located in this directory.

## Files in This Directory

- **`docker-compose.yml`** - Main Docker Compose configuration
- **`Dockerfile.server`** - Dockerfile for the backend server
- **`Dockerfile.web`** - Dockerfile for the frontend web app
- **`nginx.conf`** - Nginx configuration for serving the web app
- **`docker-entrypoint-web.sh`** - Entrypoint script for web container (runtime config)
- **`.dockerignore`** - Files to exclude from Docker build context
- **`.env.example`** - Example environment variables file

## Quick Start

```bash
# 1. Optional: Customize configuration
cp docker/.env.example docker/.env
# Edit docker/.env to change ports, verbosity, etc.

# 2. Start services (from project root)
docker-compose -f docker/docker-compose.yml up -d

# Or use Make
make docker-up

# 3. Access the application
# Web UI: http://localhost:7805
# Server API: http://localhost:7806
```

## Architecture

The Docker setup consists of two services:

1. **gts-backend** - Backend API server
   - Built from `docker/Dockerfile.server`
   - Runs on port 7806 (configurable)
   - Stores data in `${HOME}/.gts-viewer/server/` (mounted volume)

2. **gts-frontend** - Frontend web application
   - Built from `docker/Dockerfile.web`
   - Runs on port 7805 (configurable)
   - Served by nginx
   - Connects to server API from the browser

## Configuration

### Environment Variables

Create a `.env` file in this directory (copy from `.env.example`):

```bash
# Server Configuration
GTS_SERVER_PORT=7806
GTS_SERVER_VERBOSITY=normal  # silent, normal, or debug

# Web App Configuration
GTS_SERVER_API_BASE=http://localhost:7806

# Port Mappings
WEB_PORT=7805      # External web app port
SERVER_PORT=7806   # External server port

# Data Directory (optional)
# DATA_DIR=/custom/path/to/data
```

### Changing Ports

Edit `docker/.env` file:
```bash
WEB_PORT=9090
SERVER_PORT=9091
GTS_SERVER_API_BASE=http://localhost:9091
```

Then restart:
```bash
docker-compose -f docker/docker-compose.yml down
docker-compose -f docker/docker-compose.yml up -d

# Or use Make
make docker-down
make docker-up
```

### Custom Data Directory

By default, data is stored in `${HOME}/.gts-viewer/server/`. To change:

```bash
# In docker/.env file
DATA_DIR=/path/to/custom/data

# Or directly in docker/docker-compose.yml
volumes:
  - /path/to/custom/data:/data
```

## Common Commands

### Starting Services

```bash
# Start in background
docker-compose -f docker/docker-compose.yml up -d

# Start with logs visible
docker-compose -f docker/docker-compose.yml up

# Start specific service
docker-compose -f docker/docker-compose.yml up -d gts-server
```

### Stopping Services

```bash
# Stop all services
docker-compose -f docker/docker-compose.yml down

# Stop but keep containers
docker-compose -f docker/docker-compose.yml stop

# Stop specific service
docker-compose -f docker/docker-compose.yml stop gts-web
```

### Viewing Logs

```bash
# All services
docker-compose -f docker/docker-compose.yml logs -f

# Specific service
docker-compose -f docker/docker-compose.yml logs -f gts-server

# Last 100 lines
docker-compose -f docker/docker-compose.yml logs --tail=100
```

### Rebuilding

```bash
# Rebuild all services
docker-compose -f docker/docker-compose.yml build

# Rebuild without cache
docker-compose -f docker/docker-compose.yml build --no-cache

# Rebuild and restart
docker-compose -f docker/docker-compose.yml up -d --build
```

### Checking Status

```bash
# Service status
docker-compose -f docker/docker-compose.yml ps

# Resource usage
docker stats gts-backend gts-frontend
```

## Building Individual Images

```bash
# Build server image
docker build -f docker/Dockerfile.server -t gts-backend:latest .

# Build web image
docker build -f docker/Dockerfile.web -t gts-frontend:latest .

# Run manually
docker run -d \
  -p 7806:7806 \
  -v ${HOME}/.gts-viewer/server:/data \
  -e GTS_SERVER_VERBOSITY=normal \
  gts-backend:latest

docker run -d \
  -p 7805:80 \
  -e GTS_SERVER_API_BASE=http://localhost:7806 \
  gts-frontend:latest
```

## Data Management

### Backup

```bash
# Backup the database
cp -r ~/.gts-viewer/server ~/.gts-viewer/server.backup

# Or use docker cp
docker cp gts-backend:/data ./backup
```

### Restore

```bash
# Restore from backup
docker-compose -f docker/docker-compose.yml down
cp -r ~/.gts-viewer/server.backup ~/.gts-viewer/server
docker-compose -f docker/docker-compose.yml up -d
```

### Reset Data

```bash
# Stop services
docker-compose -f docker/docker-compose.yml down

# Remove data
rm -rf ~/.gts-viewer/server/*

# Restart
docker-compose -f docker/docker-compose.yml up -d
```

## Troubleshooting

### Cannot Connect to Server

```bash
# Check if containers are running
docker-compose -f docker/docker-compose.yml ps

# Check server logs
docker-compose -f docker/docker-compose.yml logs gts-backend

# Test server health
curl http://localhost:7806/health
```

### Port Already in Use

```bash
# Find process using the port
lsof -ti:7806

# Stop Docker services
docker-compose -f docker/docker-compose.yml down

# Or change port in .env file
```

### Permission Issues

```bash
# Ensure data directory exists and has correct permissions
mkdir -p ~/.gts-viewer/server
chmod 755 ~/.gts-viewer/server

# Check container user
docker-compose -f docker/docker-compose.yml exec gts-backend id
```

### Web App Cannot Connect to Server

1. Ensure `GTS_SERVER_API_BASE` in `.env` points to `http://localhost:7806` (or your custom port)
2. Check that the server port is correctly mapped in `docker/docker-compose.yml`
3. Verify server is accessible: `curl http://localhost:7806/health`

### Build Failures

```bash
# Clean build
docker-compose -f docker/docker-compose.yml down
docker-compose -f docker/docker-compose.yml build --no-cache
docker-compose -f docker/docker-compose.yml up -d

# Check Docker disk space
docker system df

# Clean up unused resources
docker system prune -a
```

### Container Keeps Restarting

```bash
# Check logs for errors
docker-compose -f docker/docker-compose.yml logs gts-backend

# Run without restart policy
docker-compose -f docker/docker-compose.yml up gts-backend

# Check resource limits
docker stats gts-backend
```

## Production Considerations

### Security

1. **Change default ports** if exposing to the internet
2. **Use HTTPS** with a reverse proxy (nginx, Caddy, Traefik)
3. **Set up authentication** if needed
4. **Limit network exposure** using Docker networks

### Performance

1. **Resource limits**: Add to `docker/docker-compose.yml`:
   ```yaml
   services:
     gts-backend:
       deploy:
         resources:
           limits:
             cpus: '1'
             memory: 512M
   ```

2. **Volume performance**: Use named volumes for better performance:
   ```yaml
   volumes:
     gts-data:
   services:
     gts-backend:
       volumes:
         - gts-data:/data
   ```

### Monitoring

```bash
# Resource usage
docker stats gts-backend gts-frontend

# Health checks
curl http://localhost:7806/health

# Container logs
docker-compose -f docker/docker-compose.yml logs --tail=100 -f
```

## Advanced Usage

### Using with Reverse Proxy

Example nginx configuration:

```nginx
server {
    listen 80;
    server_name gts.example.com;

    location / {
        proxy_pass http://localhost:7805;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /api/ {
        proxy_pass http://localhost:7806/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Custom Network

```yaml
networks:
  gts-network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.28.0.0/16
```

### Multiple Instances

To run multiple instances, create separate docker-compose files:

```bash
# docker/docker-compose.dev.yml
docker-compose -f docker/docker-compose.dev.yml up -d

# docker/docker-compose.prod.yml
docker-compose -f docker/docker-compose.prod.yml up -d
```

## Support

For issues and questions:
- GitHub Issues: https://github.com/globaltypesystem/gts-viewer/issues
- Main README: [../README.md](../README.md)
