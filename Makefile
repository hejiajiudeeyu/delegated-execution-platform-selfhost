SHELL := /bin/zsh

COMPOSE_FILE ?= docker-compose.yml
COMPOSE ?= docker compose -f $(COMPOSE_FILE)

.PHONY: up down restart logs ps build clean deploy deploy-platform deploy-public-stack deploy-relay deploy-caller deploy-responder deploy-ops deploy-all ops-auth check-deploy-config smoke-platform test test-unit test-integration test-e2e test-e2e-ui test-flow-ui test-compose-smoke test-public-stack-smoke test-local-images-smoke test-published-images-smoke test-compose-smoke-strict test-all test-ci

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

restart: down up

logs:
	$(COMPOSE) logs -f --tail=200

ps:
	$(COMPOSE) ps

build:
	$(COMPOSE) build

clean:
	$(COMPOSE) down -v --remove-orphans

deploy:
	@echo "Deploy shortcut (current profile uses docker compose single-host deployment)."
	$(COMPOSE) up -d --build

deploy-platform:
	docker compose -f deploy/platform/docker-compose.yml up -d --build

deploy-public-stack:
	docker compose -f deploy/public-stack/docker-compose.yml up -d --build

deploy-relay:
	docker compose -f deploy/relay/docker-compose.yml up -d --build

deploy-caller:
	docker compose -f deploy/caller/docker-compose.yml up -d --build

deploy-responder:
	docker compose -f deploy/responder/docker-compose.yml up -d --build

deploy-ops:
	docker compose -f deploy/ops/docker-compose.yml up -d --build

deploy-all:
	docker compose -f deploy/all-in-one/docker-compose.yml up -d --build

ops-auth:
	npm run ops:auth -- $(ARGS)

check-deploy-config:
	npm run test:deploy:config

smoke-platform:
	npm run test:smoke:platform

test:
	npm run test

test-unit:
	npm run test:unit

test-integration:
	npm run test:integration

test-e2e:
	npm run test:e2e

test-e2e-ui:
	npm run test:e2e:ui

test-flow-ui:
	npm run test:flow:dashboard

test-compose-smoke:
	npm run test:compose-smoke

test-public-stack-smoke:
	npm run test:public-stack-smoke

test-local-images-smoke:
	npm run test:local-images-smoke

test-published-images-smoke:
	npm run test:published-images-smoke

test-compose-smoke-strict:
	npm run test:compose-smoke:strict

test-all:
	npm run test:all

test-ci:
	npm run test:ci
