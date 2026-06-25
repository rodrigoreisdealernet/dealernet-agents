export DOCKER_BUILDKIT=0

COMPOSE_BASE=docker-compose.yml
COMPOSE_DEV=docker-compose.dev.yml
USE_DEV?=0

ifeq ($(USE_DEV),1)
COMPOSE_FILES=$(COMPOSE_BASE) $(COMPOSE_DEV)
else
COMPOSE_FILES=$(COMPOSE_BASE)
endif

COMPOSE_CMD=docker compose $(foreach file,$(COMPOSE_FILES),-f $(file))

.PHONY: up down reset logs logs-temporal logs-frontend

up:
	$(COMPOSE_CMD) up -d

down:
	$(COMPOSE_CMD) down

reset:
	$(COMPOSE_CMD) down -v
	$(COMPOSE_CMD) up -d

logs:
	$(COMPOSE_CMD) logs -f

logs-temporal:
	$(COMPOSE_CMD) logs -f temporal temporal-worker

logs-frontend:
	$(COMPOSE_CMD) logs -f frontend
