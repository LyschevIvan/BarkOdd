.DEFAULT_GOAL := help
SHELL := /bin/bash

# Export explicit Make/environment settings; leave unset values for the .env loader.
CONFIG_KEYS := ENV_FILE DEPLOY PORT AUTH_MODE ADMIN_CODE ROOM_CREATION_KEY MEDIA_TRANSPORT ADDR DATA_DIR PUBLIC_URL APP_HOST TLS_CERT_FILE TLS_KEY_FILE STUN_URLS TURN_URLS TURN_SECRET TURN_USERNAME TURN_PASSWORD
$(foreach key,$(CONFIG_KEYS),$(if $(filter undefined,$(origin $(key))),,$(eval export $(key))))

.PHONY: help init run run-demo run-admin run-multi admin-code build test test-launcher vet doctor docker-up docker-down docker-logs docker-ps docker-config
help init run run-demo run-admin run-multi admin-code build test vet doctor docker-up docker-down docker-logs docker-ps docker-config:
	@bash scripts/dev.sh $@

test-launcher:
	@bash scripts/test-dev.sh
