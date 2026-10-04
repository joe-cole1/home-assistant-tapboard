#!/usr/bin/env bash
# Build and verify only disposable resources created by this invocation.
set -Eeuo pipefail
set +x
umask 077
# Keep fixed diagnostics visible even when a helper's raw stderr is private.
exec 3>&2

qc_phase="prerequisites"
fail() {
  printf 'Production container check failed: %s\n' "$1" >&2
  exit 1
}
trap 'printf "Production container phase failed: %s (line %s)\n" "$qc_phase" "$LINENO" >&3' ERR

command -v docker >/dev/null 2>&1 || fail "Docker is required; no container proof was run"
command -v node >/dev/null 2>&1 || fail "Node 24 is required"
node -e 'if (!process.versions.node.startsWith("24.")) process.exit(1)' ||
  fail "Node 24 is required"
docker info >/dev/null 2>&1 || fail "a Docker daemon is required"
docker compose version >/dev/null 2>&1 || fail "Docker Compose 2.24 or newer is required"

qc_repository="$(cd "$(dirname "$0")/.." && pwd)"
qc_fixture="$qc_repository/test/fixtures/production-container-smoke.mjs"
qc_private="$(mktemp -d /tmp/tapboard-production-qc.XXXXXXXX)"
qc_project="tapboard-qc-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(12).toString("hex"))')"
qc_image="$qc_project:ci"
qc_volume="$qc_project"_tapboard-data
qc_network="$qc_project"_default
qc_resources_allowed=false
qc_expected_image=""

compose() {
  # Explicit private interpolation/runtime files prevent reading the operator's .env.
  TAPBOARD_IMAGE="$qc_image" \
    TAPBOARD_ENV_FILE="$qc_private/runtime.env" \
    TAPBOARD_PUBLISH_ADDRESS=127.0.0.1 \
    TAPBOARD_PUBLISH_PORT=0 \
    TAPBOARD_EXTERNAL_ORIGIN=http://127.0.0.1:3005 \
    docker compose \
      --env-file "$qc_private/interpolation.env" \
      --project-name "$qc_project" \
      --file "$qc_repository/compose.production.example.yaml" \
      "$@"
}

cleanup() {
  local qc_result=$?
  trap - EXIT ERR INT TERM
  set +e
  if [[ "$qc_resources_allowed" == true ]]; then
    # The random project was checked absent before creation. Match its label
    # again before deleting any container, named volume, or network.
    while IFS= read -r qc_owned_container; do
      [[ -n "$qc_owned_container" ]] || continue
      if [[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$qc_owned_container" 2>/dev/null)" == "$qc_project" ]]; then
        docker rm --force "$qc_owned_container" >/dev/null 2>&1
      fi
    done < <(docker ps --all --filter "label=com.docker.compose.project=$qc_project" --format '{{.ID}}' 2>/dev/null)
    if [[ "$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$qc_volume" 2>/dev/null)" == "$qc_project" ]]; then
      docker volume rm "$qc_volume" >/dev/null 2>&1
    fi
    if [[ "$(docker network inspect --format '{{index .Labels "com.docker.compose.project"}}' "$qc_network" 2>/dev/null)" == "$qc_project" ]]; then
      docker network rm "$qc_network" >/dev/null 2>&1
    fi
    if [[ -n "$qc_expected_image" && "$(docker image inspect --format '{{.Id}}' "$qc_image" 2>/dev/null)" == "$qc_expected_image" ]]; then
      docker image rm "$qc_image" >/dev/null 2>&1
    fi
  fi
  rm -rf -- "$qc_private"
  exit "$qc_result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ -z "$(docker ps --all --filter "label=com.docker.compose.project=$qc_project" --format '{{.ID}}')" ]] ||
  fail "disposable project collision"
! docker volume inspect "$qc_volume" >/dev/null 2>&1 || fail "disposable volume collision"
! docker network inspect "$qc_network" >/dev/null 2>&1 || fail "disposable network collision"
! docker image inspect "$qc_image" >/dev/null 2>&1 || fail "disposable image collision"
qc_resources_allowed=true

qc_phase="compose-contract-and-build"
node "$qc_fixture" prepare "$qc_repository" "$qc_private"
compose config --quiet >"$qc_private/config.log" 2>&1
compose build --pull tapboard >"$qc_private/build.log" 2>&1
qc_expected_image="$(docker image inspect --format '{{.Id}}' "$qc_image")"
[[ "$qc_expected_image" == sha256:* ]] || fail "new image was not produced"
docker image inspect "$qc_image" >"$qc_private/image.json"
printf 'Built disposable production image: %s\n' "$qc_expected_image"

wait_healthy() {
  local qc_health
  for ((qc_attempt = 0; qc_attempt < 90; qc_attempt++)); do
    qc_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$qc_container" 2>/dev/null || true)"
    if [[ "$qc_health" == healthy ]]; then
      return
    fi
    [[ "$(docker inspect --format '{{.State.Running}}' "$qc_container" 2>/dev/null || true)" == true ]] ||
      fail "disposable application stopped before healthy"
    sleep 1
  done
  fail "disposable application did not become healthy"
}

inspect_container() {
  docker inspect "$qc_container" >"$qc_private/container.json"
  node "$qc_fixture" inspect "$qc_private" "$qc_expected_image"
  local qc_mapping qc_port
  qc_mapping="$(docker port "$qc_container" 3005/tcp)"
  [[ "$qc_mapping" == 127.0.0.1:* && "$qc_mapping" != *$'\n'* ]] ||
    fail "unexpected published address"
  qc_port="$(printf '%s' "$qc_mapping" | cut -d: -f2)"
  [[ "$qc_port" =~ ^[0-9]+$ ]] || fail "unexpected published port"
  node "$qc_fixture" published "http://127.0.0.1:$qc_port"
}

install_fixture() {
  # Write through the unprivileged process into its writable tmpfs. Docker's
  # archive-copy API can reject extraction when the container root is read-only.
  docker exec --interactive "$qc_container" sh -c 'umask 077; cat > /tmp/production-container-smoke.mjs' \
    <"$qc_fixture" >"$qc_private/copy.log" 2>&1
}

exercise() {
  docker exec --interactive "$qc_container" node /tmp/production-container-smoke.mjs "$1" \
    <"$qc_private/credentials.json"
}

save_tokens_and_logs() {
  docker exec "$qc_container" cat /tmp/production-smoke-tokens.json \
    >"$qc_private/$1.tokens.json" 2>"$qc_private/copy.log"
  docker logs "$qc_container" >"$qc_private/$1.log" 2>&1
}

stop_gracefully() {
  local qc_started=$SECONDS
  compose stop --timeout 15 tapboard >"$qc_private/stop.log" 2>&1
  [[ "$(docker inspect --format '{{.State.ExitCode}}' "$qc_container")" == 0 ]] ||
    fail "SIGTERM did not exit successfully"
  [[ "$(docker inspect --format '{{.State.OOMKilled}}' "$qc_container")" == false ]] ||
    fail "container was killed by memory pressure"
  ((SECONDS - qc_started <= 15)) || fail "SIGTERM exceeded the stop budget"
  docker logs "$qc_container" >"$qc_private/$1.log" 2>&1
  node "$qc_fixture" scan-logs "$qc_private"
}

qc_phase="fresh-runtime-and-operator-pin"
compose up --detach --no-build --pull never tapboard >"$qc_private/up.log" 2>&1
qc_container="$(compose ps --quiet tapboard)"
[[ -n "$qc_container" ]] || fail "disposable container was not created"
qc_first_container="$qc_container"
wait_healthy
inspect_container
install_fixture
exercise preflight
# A generated PIN travels only over stdin to the real operator command.
node "$qc_fixture" pin "$qc_private" |
  docker exec --interactive "$qc_container" node src/operator/reset-pin.ts >"$qc_private/operator.log" 2>&1
exercise create
save_tokens_and_logs fresh
stop_gracefully fresh-stopped
printf 'Verified source hashes, schema 23, SSR, hardening, stdin PIN, and created domain state.\n'

qc_phase="restart-persistence"
compose start tapboard >"$qc_private/start.log" 2>&1
qc_container="$(compose ps --quiet tapboard)"
[[ "$qc_container" == "$qc_first_container" ]] || fail "restart unexpectedly replaced the container"
wait_healthy
inspect_container
install_fixture
exercise restart
save_tokens_and_logs restarted
stop_gracefully restarted-stopped
printf 'Verified domain state survives a graceful stop and restart.\n'

qc_phase="recreate-persistence-and-degraded-integration"
node "$qc_fixture" replace-key "$qc_private"
compose up --detach --no-build --pull never --force-recreate tapboard >"$qc_private/recreate.log" 2>&1
qc_container="$(compose ps --quiet tapboard)"
[[ -n "$qc_container" && "$qc_container" != "$qc_first_container" ]] ||
  fail "recreate did not produce a replacement container"
wait_healthy
inspect_container
install_fixture
exercise degraded
save_tokens_and_logs recreated
stop_gracefully recreated-stopped
node "$qc_fixture" scan-logs "$qc_private"
printf 'Verified recreation preserves state, degraded fake integration stays locally healthy, and SIGTERM exits 0.\n'
printf 'Production container acceptance passed for the image built by this invocation.\n'
