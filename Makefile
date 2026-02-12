-include Makefile.env
export

.PHONY: $(wildcard *)

COMPOSE ?= docker compose
COMPOSE_FILE ?= docker-compose.yml
COMPOSE_PROJECT_NAME ?= ahr999-chart
COMPOSE_CMD := $(COMPOSE) --project-name $(COMPOSE_PROJECT_NAME) --file $(COMPOSE_FILE)

## help: show help
help:
	@echo ""
	@echo "Usage:"
	@echo ""
	@sed -n 's/^## //p' Makefile | column -t -s ':' | sed -e 's/^/\t/'
	@echo ""

## dev: run vite dev server in foreground
dev:
	bun run dev

## up: build image and start app container in background
up:
	$(COMPOSE_CMD) up -d --build

## down: stop and remove app container
down:
	$(COMPOSE_CMD) down --remove-orphans

## build: build docker image via docker compose
build:
	$(COMPOSE_CMD) build --pull
