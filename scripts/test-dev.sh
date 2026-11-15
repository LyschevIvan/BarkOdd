#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/barkodd-launch.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
unset AUTH_MODE ADMIN_CODE ROOM_CREATION_KEY PUBLIC_URL MEDIA_TRANSPORT TURN_PASSWORD DATA_DIR ADDR PORT APP_HOST DEPLOY || true
export ENV_FILE="$tmp/new.env"
bash "$root/scripts/dev.sh" init >/dev/null
[[ -f "$ENV_FILE" ]] || fail 'init did not create configuration'
code=$(sed -n 's/^ADMIN_CODE=//p' "$ENV_FILE")
[[ ${#code} -eq 64 && "$code" != *[!0-9a-f]* ]] || fail 'init must generate 64 random hex characters'
if command -v python3 >/dev/null; then
  python3 - "$ENV_FILE" <<'PY'
import os, stat, sys
assert stat.S_IMODE(os.stat(sys.argv[1]).st_mode) == 0o600
PY
fi
cp "$ENV_FILE" "$tmp/before.env"
bash "$root/scripts/dev.sh" init >/dev/null
cmp "$ENV_FILE" "$tmp/before.env" || fail 'init overwrote an existing file'
[[ $(bash "$root/scripts/dev.sh" admin-code) == "$code" ]] || fail 'admin-code did not read the saved code'
[[ $(ADMIN_CODE=0123456789abcdef0123456789abcdef bash "$root/scripts/dev.sh" admin-code) == 0123456789abcdef0123456789abcdef ]] || fail 'environment must override file'
printf 'AUTH_MODE=admin_code\nADMIN_CODE=\n' > "$tmp/blank.env"
if ENV_FILE="$tmp/blank.env" bash "$root/scripts/dev.sh" admin-code >"$tmp/out" 2>&1; then fail 'blank code accepted'; fi
grep -q 'ADMIN_CODE' "$tmp/out" || fail 'blank code diagnostic missing'
mkdir "$tmp/tools"
cat > "$tmp/tools/docker" <<'SH'
#!/usr/bin/env bash
if [[ "$*" == 'compose version' ]]; then exit 0; fi
printf '%s\n' "$@" > "$CAPTURE.args"
printf '%s\n' "$TURN_PASSWORD" > "$CAPTURE.password"
printf '%s\n' "${PUBLIC_URL-}" > "$CAPTURE.public"
printf '%s\n' "${AUTH_MODE-}" > "$CAPTURE.auth"
SH
chmod +x "$tmp/tools/docker"
export PATH="$tmp/tools:$PATH" CAPTURE="$tmp/capture"
cat > "$tmp/literal.env" <<'ENV'
AUTH_MODE=none
MEDIA_TRANSPORT=websocket
PUBLIC_URL=https://deployment.example/barkodd/
TURN_PASSWORD='literal $DOLLAR $(touch NEVER_RUN) `touch NEVER_RUN` # text'
ENV
ENV_FILE="$tmp/literal.env" bash "$root/scripts/dev.sh" docker-config >/dev/null
[[ $(cat "$CAPTURE.password") == 'literal $DOLLAR $(touch NEVER_RUN) `touch NEVER_RUN` # text' ]] || fail 'dotenv value was expanded'
[[ ! -e NEVER_RUN ]] || fail 'dotenv executed shell code'
[[ ! -s "$CAPTURE.public" || $(cat "$CAPTURE.public") == '' ]] || fail 'local deploy inherited production PUBLIC_URL'
grep -qx /dev/null "$CAPTURE.args" || fail 'Compose dotenv interpolation not disabled'
grep -qx -- --project-directory "$CAPTURE.args" || fail 'Compose project directory missing'
PUBLIC_URL=http://localhost:9090 ENV_FILE="$tmp/literal.env" bash "$root/scripts/dev.sh" docker-config >/dev/null
[[ $(cat "$CAPTURE.public") == http://localhost:9090 ]] || fail 'explicit PUBLIC_URL override lost'
TURN_PASSWORD='environment $DOLLAR' ENV_FILE="$tmp/literal.env" make -s -C "$root" docker-config >/dev/null
[[ $(cat "$CAPTURE.password") == 'environment $DOLLAR' ]] || fail 'Make changed a literal environment value'
printf 'AUTH_MODE=none\nthis is invalid\n' > "$tmp/bad.env"
if ENV_FILE="$tmp/bad.env" bash "$root/scripts/dev.sh" docker-config >"$tmp/out" 2>&1; then fail 'malformed dotenv accepted'; fi
printf 'AUTH_MODE=none\nPATH=/malicious\n' > "$tmp/bad.env"
if ENV_FILE="$tmp/bad.env" bash "$root/scripts/dev.sh" docker-config >"$tmp/out" 2>&1; then fail 'non-allowlisted dotenv accepted'; fi
printf 'AUTH_MODE=none\nADMIN_CODE="unterminated\n' > "$tmp/bad.env"
if ENV_FILE="$tmp/bad.env" bash "$root/scripts/dev.sh" docker-config >"$tmp/out" 2>&1; then fail 'unclosed dotenv quote accepted'; fi
printf 'Launcher checks passed.\n'
