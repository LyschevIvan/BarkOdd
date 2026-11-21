#!/usr/bin/env bash
# Bash 3.2 compatible. Configuration is data: never source or evaluate .env.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
action=${1:-help}
ENV_FILE=${ENV_FILE:-.env}
DEPLOY=${DEPLOY:-local}
public_override=${PUBLIC_URL+x}
keys='AUTH_MODE ADMIN_CODE ROOM_CREATION_KEY MEDIA_TRANSPORT ADDR DATA_DIR PUBLIC_URL APP_HOST TLS_CERT_FILE TLS_KEY_FILE STUN_URLS TURN_URLS TURN_SECRET TURN_USERNAME TURN_PASSWORD PORT'

die() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "нужна команда $1; установите её и повторите запуск."; }
trim() { trimmed=${1#"${1%%[![:space:]]*}"}; trimmed=${trimmed%"${trimmed##*[![:space:]]}"}; }

init_env() {
  if [[ -e "$ENV_FILE" ]]; then
    [[ -f "$ENV_FILE" ]] || die "ENV_FILE должен указывать на обычный файл."
    printf 'Конфигурация уже существует: %s (сохранена без изменений).\n' "$ENV_FILE"
    return
  fi
  need openssl
  local secret temporary
  secret=$(openssl rand -hex 32) || die 'не удалось создать ADMIN_CODE.'
  temporary=$(umask 077; mktemp "${ENV_FILE}.tmp.XXXXXX") || die "не удалось создать $ENV_FILE; проверьте каталог."
  if ! sed "s/^ADMIN_CODE=.*/ADMIN_CODE=$secret/" "$root/.env.example" > "$temporary"; then
    rm -f "$temporary"; die 'не удалось подготовить конфигурацию.'
  fi
  # A hard link creates the destination atomically and cannot replace another file.
  if ! ln "$temporary" "$ENV_FILE" 2>/dev/null; then
    rm -f "$temporary"; die "файл $ENV_FILE уже появился или недоступен; он не изменён."
  fi
  rm -f "$temporary"
  printf 'Создан %s с правами 0600 и случайным ADMIN_CODE. Код: make admin-code ENV_FILE=...\n' "$ENV_FILE"
}

load_env() {
  [[ -f "$ENV_FILE" ]] || return 0
  local explicit=' ' seen=' ' key line value line_number=0 first last
  for key in $keys; do
    if [[ ${!key+x} ]]; then explicit="$explicit$key "; fi
  done
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_number=$((line_number + 1))
    trim "$line"; line=$trimmed
    [[ -z "$line" || ${line:0:1} == '#' ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || die "$ENV_FILE:$line_number: ожидается KEY=value."
    key=${line%%=*}; value=${line#*=}
    case " $keys " in *" $key "*) ;; *) die "$ENV_FILE:$line_number: неподдерживаемая переменная $key." ;; esac
    case "$seen" in *" $key "*) die "$ENV_FILE:$line_number: переменная $key указана дважды." ;; esac
    seen="$seen$key "
    trim "$value"; value=$trimmed
    first=${value:0:1}; last=${value: -1}
    if [[ "$first" == '"' || "$first" == "'" ]]; then
      [[ ${#value} -ge 2 && "$last" == "$first" ]] || die "$ENV_FILE:$line_number: незакрытые кавычки."
      value=${value:1:${#value}-2}
    fi
    case "$explicit" in *" $key "*) continue ;; esac
    export "$key=$value"
  done < "$ENV_FILE"
}

defaults() {
  export AUTH_MODE=${AUTH_MODE:-admin_code} MEDIA_TRANSPORT=${MEDIA_TRANSPORT:-websocket} PORT=${PORT:-8080}
  case "$AUTH_MODE" in none|admin_code|multi_user) ;; *) die 'AUTH_MODE: допустимы none, admin_code, multi_user.' ;; esac
  case "$MEDIA_TRANSPORT" in websocket|webrtc) ;; *) die 'MEDIA_TRANSPORT: допустимы websocket, webrtc.' ;; esac
  [[ "$PORT" =~ ^[0-9]{1,5}$ ]] && ((10#$PORT >= 1 && 10#$PORT <= 65535)) || die 'PORT должен быть числом от 1 до 65535.'
}

check_auth() {
  if [[ -n ${ADMIN_CODE:-} && -n ${ROOM_CREATION_KEY:-} && "$ADMIN_CODE" != "$ROOM_CREATION_KEY" ]]; then
    die 'ADMIN_CODE и ROOM_CREATION_KEY должны совпадать.'
  fi
  local code=${ADMIN_CODE:-${ROOM_CREATION_KEY:-}}
  if [[ "$AUTH_MODE" != none || -n "$code" ]]; then
    [[ "$code" =~ ^[A-Za-z0-9_-]{32,128}$ ]] || die "заполните ADMIN_CODE в $ENV_FILE: 32–128 символов A-Z a-z 0-9 _ -. Сгенерировать: openssl rand -hex 32. Существующий файл не изменён."
  fi
}

local_url() {
  if [[ -z "$public_override" && -n ${PUBLIC_URL:-} ]]; then
    printf 'Локальный запуск: PUBLIC_URL из %s не используется; явное окружение/Make PUBLIC_URL переопределяет это правило.\n' "$ENV_FILE" >&2
    unset PUBLIC_URL
  fi
}

check_go() {
  need go
  local version major minor
  version=$(go env GOVERSION)
  if [[ "$version" =~ ^go([0-9]+)\.([0-9]+) ]]; then
    major=${BASH_REMATCH[1]}; minor=${BASH_REMATCH[2]}
    ((major > 1 || (major == 1 && minor >= 23))) || die 'нужен Go 1.23 или новее.'
  fi
}

check_node() {
  need node; need npm
  local major
  major=$(node -p 'process.versions.node.split(".")[0]')
  [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 20)) || die 'для тестов нужен Node.js 20 или новее.'
}

build() {
  check_go
  mkdir -p bin
  go build -o bin/barkodd ./cmd/barkodd
}

docker_command() {
  case "$DEPLOY" in local|public|macmini) ;; *) die 'DEPLOY: допустимы local, public, macmini.' ;; esac
  need docker
  docker compose version >/dev/null || die 'нужен Docker Compose V2.'
  local args=(compose --env-file /dev/null)
  case "$DEPLOY" in
    local)
      local_url
      args+=(--project-directory "$root" --project-name barkodd-local -f "$root/deploy/compose.local.yaml")
      ;;
    public)
      [[ -n ${APP_HOST:-} ]] || die "задайте APP_HOST в $ENV_FILE для DEPLOY=public."
      args+=(--project-directory "$root" -f "$root/compose.yaml")
      ;;
    macmini)
      [[ -n ${PUBLIC_URL:-} ]] || die "задайте PUBLIC_URL в $ENV_FILE для DEPLOY=macmini."
      local compose_file="$root/deploy/compose.macmini.yaml"
      if [[ ! -f "$compose_file" ]]; then compose_file="$root/deploy/compose.macmini.example.yaml"; fi
      args+=(-f "$compose_file")
      ;;
  esac
  case "$action" in
    docker-up)
      check_auth
      if [[ "$DEPLOY" == macmini ]]; then
        docker network inspect web >/dev/null 2>&1 || die 'для DEPLOY=macmini нужна существующая Docker-сеть web.'
      fi
      exec docker "${args[@]}" up -d --build --wait
      ;;
    docker-down) exec docker "${args[@]}" down ;;
    docker-logs) exec docker "${args[@]}" logs --tail=100 -f ;;
    docker-ps) exec docker "${args[@]}" ps ;;
    docker-config) check_auth; docker "${args[@]}" config --quiet; printf 'Compose-конфигурация корректна: %s.\n' "$DEPLOY" ;;
  esac
}

case "$action" in
  help)
    cat <<'HELP'
BarkOdd — команды запуска

  make init          Создать .env и случайный код (существующий файл сохраняется)
  make run           Запуск из .env, по умолчанию admin_code + websocket
  make run-demo      Общий кабинет без входа (AUTH_MODE=none)
  make run-admin     Общий кабинет с ADMIN_CODE
  make run-multi     Аккаунты пользователей и отдельный администратор
  make admin-code    Показать код администратора из выбранной конфигурации
  make build         Собрать bin/barkodd (Go 1.23+)
  make test          Проверить launcher, Go с -race и JavaScript (Node.js 20+)
  make test-launcher Проверить безопасную загрузку конфигурации
  make vet           Выполнить go vet ./...
  make doctor        Проверить версии локальных инструментов

  make docker-up     Собрать, запустить и дождаться готовности
  make docker-down   Остановить контейнеры, сохранив данные
  make docker-logs   Следить за журналами
  make docker-ps     Статус контейнеров
  make docker-config Проверить Compose без вывода секретов

  DEPLOY=local|public|macmini  Вариант Docker (по умолчанию local)
  ENV_FILE=.env              Файл KEY=value; окружение/Make имеют приоритет
  AUTH_MODE=... MEDIA_TRANSPORT=websocket|webrtc PORT=8080

Пример: make run-multi MEDIA_TRANSPORT=webrtc STUN_URLS=none
Локальные данные: data/local/<AUTH_MODE>; DATA_DIR и ADDR можно переопределить.
Локальные цели игнорируют PUBLIC_URL из файла; явный PUBLIC_URL применяется.
run/docker-up автоматически выполняют init при отсутствии ENV_FILE.
HELP
    ;;
  init) init_env ;;
  build) build ;;
  vet) check_go; exec go vet ./... ;;
  test) check_go; check_node; bash scripts/test-dev.sh; go test -race ./...; npm test ;;
  doctor)
    check_go; go version
    if command -v node >/dev/null 2>&1; then node --version; else printf 'Node.js не найден (нужен только для тестов).\n'; fi
    if command -v docker >/dev/null 2>&1; then docker compose version; else printf 'Docker не найден (нужен только для Docker-целей).\n'; fi
    ;;
  run|run-demo|run-admin|run-multi|admin-code|docker-up|docker-down|docker-logs|docker-ps|docker-config)
    case "$action" in run|run-demo|run-admin|run-multi|docker-up) [[ -f "$ENV_FILE" ]] || init_env ;; esac
    load_env
    case "$action" in run-demo) export AUTH_MODE=none ;; run-admin) export AUTH_MODE=admin_code ;; run-multi) export AUTH_MODE=multi_user ;; esac
    defaults
    case "$action" in
      admin-code)
        check_auth
        [[ -n ${ADMIN_CODE:-${ROOM_CREATION_KEY:-}} ]] || die 'ADMIN_CODE не задан.'
        printf '%s\n' "${ADMIN_CODE:-$ROOM_CREATION_KEY}"
        ;;
      docker-*) docker_command ;;
      *)
        check_auth; local_url
        export ADDR=${ADDR:-127.0.0.1:$PORT} DATA_DIR=${DATA_DIR:-data/local/$AUTH_MODE}
        build
        printf 'BarkOdd: режим %s, транспорт %s; данные: %s\n' "$AUTH_MODE" "$MEDIA_TRANSPORT" "$DATA_DIR"
        exec "$root/bin/barkodd"
        ;;
    esac
    ;;
  *) die "неизвестная команда $action; выполните make help." ;;
esac
