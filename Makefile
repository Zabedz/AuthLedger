ENV_FILE := .env

define with_env
	set -a && . ./$(ENV_FILE) && set +a &&
endef

.PHONY: setup up down dev migrate migrate-down codegen test lint typecheck

setup:
	cp -n .env.example .env || true
	npm install
	npm run build -w shared

up:
	docker compose up -d --wait db mailpit

down:
	docker compose down

dev: up
	npm run build -w shared
	$(with_env) npm run dev

migrate:
	$(with_env) npm run migrate:up -w api

migrate-down:
	$(with_env) npm run migrate:down -w api

codegen:
	$(with_env) npm run codegen -w api

test:
	npm run build -w shared
	npm test

lint:
	npm run lint

typecheck:
	npm run build -w shared
	npm run typecheck
