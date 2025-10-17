.PHONY: help docker-build docker-up docker-down docker-logs docker-restart docker-clean

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# Docker commands
docker-build: ## Build Docker images
	docker-compose -f docker/docker-compose.yml build

docker-up: ## Start Docker services
	docker-compose -f docker/docker-compose.yml up -d

docker-down: ## Stop Docker services
	docker-compose -f docker/docker-compose.yml down

docker-logs: ## View Docker logs
	docker-compose -f docker/docker-compose.yml logs -f

docker-restart: ## Restart Docker services
	docker-compose -f docker/docker-compose.yml restart

docker-clean: ## Remove Docker containers, images, and volumes
	docker-compose -f docker/docker-compose.yml down -v
	docker system prune -f

docker-rebuild: ## Rebuild and restart Docker services
	docker-compose -f docker/docker-compose.yml down
	docker-compose -f docker/docker-compose.yml build --no-cache
	docker-compose -f docker/docker-compose.yml up -d

docker-status: ## Show Docker service status
	docker-compose -f docker/docker-compose.yml ps

# Development commands
dev-web: ## Start web app in development mode
	npm run dev:web

dev-server: ## Start server in development mode
	npm run dev:server

dev-electron: ## Start Electron app in development mode
	npm run dev:electron

# Build commands
build: ## Build all packages
	npm install
	npm run build

build-vscode: build ## Build vscode plugin
	npm run package:vscode

# Utility commands
clean: ## Clean node_modules and build artifacts
	npm run clean

health: ## Check server health
	@curl -s http://localhost:7806/health || echo "Server not responding"
