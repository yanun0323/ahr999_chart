-include Makefile.env
export

.PHONY: $(wildcard *)

DEV_PID_FILE := .run/dev.pid
DEV_LOG_FILE := .run/dev.log
DEV_PORT ?= 5173
DEV_MATCH := $(CURDIR)/node_modules/.bin/vite

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

## up: start vite dev server in background
up:
	@mkdir -p .run
	@if pgrep -f "$(DEV_MATCH)" >/dev/null 2>&1; then \
		echo "dev server is already running (pid=$$(pgrep -f "$(DEV_MATCH)" | head -n 1), port=$(DEV_PORT))"; \
		exit 0; \
	fi
	@if lsof -tiTCP:$(DEV_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "port $(DEV_PORT) is already in use; stop the existing process first"; \
		lsof -tiTCP:$(DEV_PORT) -sTCP:LISTEN | head -n 1 | sed 's/^/pid=/' ; \
		exit 1; \
	fi
	@nohup bun run dev -- --host 0.0.0.0 --port $(DEV_PORT) --strictPort >"$(DEV_LOG_FILE)" 2>&1 < /dev/null &
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		pid="$$(lsof -tiTCP:$(DEV_PORT) -sTCP:LISTEN | head -n 1)"; \
		if [ -n "$$pid" ] && pgrep -f "$(DEV_MATCH)" >/dev/null 2>&1; then \
			echo "$$pid" >"$(DEV_PID_FILE)"; \
			echo "dev server started (pid=$$pid, port=$(DEV_PORT))"; \
			echo "log: $(DEV_LOG_FILE)"; \
			exit 0; \
		fi; \
		sleep 1; \
	done; \
	echo "failed to start dev server, check log: $(DEV_LOG_FILE)"; \
	rm -f "$(DEV_PID_FILE)"; \
	exit 1

## down: stop background dev server started by make up
down:
	@if ! pgrep -f "$(DEV_MATCH)" >/dev/null 2>&1; then \
		echo "dev server is not running"; \
	else \
		pids="$$(pgrep -f "$(DEV_MATCH)")"; \
		kill $$pids; \
		sleep 1; \
		remaining="$$(pgrep -f "$(DEV_MATCH)" || true)"; \
		if [ -n "$$remaining" ]; then \
			kill -9 $$remaining; \
		fi; \
		echo "dev server stopped (port=$(DEV_PORT))"; \
		rm -f "$(DEV_PID_FILE)"; \
	fi

## build: build production assets
build:
	bun run build
