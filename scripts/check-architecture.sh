#!/usr/bin/env bash
set -euo pipefail

# Foundation topology gate. Issue #85 permits one coherent development-only
# container set; issue #81 permits one exact, content-checked production image
# and its matching deny-by-default build-context policy.
# See docs/rebuild/ARCHITECTURE-GUARDRAILS.md.

if [[ -n "${TAPBOARD_ARCHITECTURE_ROOT:-}" ]]; then
  repository_root="$TAPBOARD_ARCHITECTURE_ROOT"
else
  repository_root="$(git rev-parse --show-toplevel)"
fi

if [[ ! -d "$repository_root" ]]; then
  printf 'architecture check root is not a directory: %s\n' "$repository_root" >&2
  exit 2
fi

cd "$repository_root"

violations=0

report() {
  printf 'architecture violation: %s\n' "$1" >&2
  violations=$((violations + 1))
}

required_rebuild_files=(
  docs/rebuild/TARGET.md
  docs/rebuild/ARCHITECTURE-DECISIONS.md
  docs/rebuild/V1-REUSE-CRITERIA.md
  docs/rebuild/ARCHITECTURE-FREEZE.md
  docs/rebuild/ARCHITECTURE-GUARDRAILS.md
  docs/rebuild/STATUS.md
  docs/rebuild/v1-reuse-manifest.json
)

for path in "${required_rebuild_files[@]}"; do
  if [[ ! -f "$path" ]]; then
    report "required rebuild record is missing: $path"
  fi
done

forbidden_v1_paths=(
  .dockerignore
  .github/dependabot.yml
  .github/workflows/ci.yml
  eslint.config.js
  src/brewStory.js
  src/brewfatherCache.js
  src/brewfatherClient.js
  src/brewfatherSync.js
  src/server.js
  src/db.js
  src/dbMigrations.js
  src/databaseMaintenance.js
  src/displayUpdateCoalescer.js
  src/draftHealth.js
  src/fillGraphic.js
  src/haClient.js
  src/httpSecurity.js
  src/tapboardProjection.js
  src/tapPlanning.js
  src/imageProxy.js
  src/kegForecast.js
  src/kegLifecycle.js
  src/lifecycleExperience.js
  src/pourDetector.js
  src/sensoryEngine.js
  src/sensoryMappings.js
  src/sseHub.js
  src/tapActions.js
  src/tapboardEvents.js
  src/validation.js
  src/server.ts
  src/dbMigrations.ts
  src/databaseMaintenance.ts
  src/haClient.ts
  src/tapboardProjection.ts
  src/tapPlanning.ts
  src/imageProxy.ts
  src/tapActions.ts
  public/app.js
  public/autosave.js
  public/brewStory.js
  public/cardPresentation.js
  public/displayPreferences.js
  public/domBuilders.js
  public/freshness.js
  public/graphics.js
  public/index.html
  public/liveUpdates.js
  public/phase3Ui.js
  public/styles.css
  public/taproomStatus.js
  public/tickerScroll.js
  scripts/db-maintenance.js
  home-assistant/README.md
  home-assistant/packages/brewfather_tapboard.yaml
  home-assistant/packages/tapboard.yaml
  home-assistant/packages/tapboard_helpers.yaml
  docker-compose.yml
)

for path in "${forbidden_v1_paths[@]}"; do
  if [[ -e "$path" ]]; then
    report "legacy v1 path is active: $path"
  fi
done

allowed_development_container_paths=(
  Dockerfile.dev
  Dockerfile.dev.dockerignore
  compose.dev.yaml
)

development_container_count=0
for path in "${allowed_development_container_paths[@]}"; do
  if [[ -e "$path" ]]; then
    development_container_count=$((development_container_count + 1))
  fi
done

if ((development_container_count > 0 && development_container_count < ${#allowed_development_container_paths[@]})); then
  report "[development-container] development container files must be present as one coherent set: Dockerfile.dev, Dockerfile.dev.dockerignore, compose.dev.yaml"
fi

# Only top-level container/deployment filenames are considered here. Content
# beneath docs/ or fixtures is reference material and is intentionally ignored.
for path in ./*; do
  [[ -f "$path" ]] || continue
  path="${path#./}"

  case "$path" in
    Dockerfile.dev|Dockerfile.dev.dockerignore|compose.dev.yaml|compose.production.example.yaml)
      ;;
    # These canonical v1 paths retain their existing legacy-path diagnostics.
    Dockerfile|Dockerfile.dockerignore|.dockerignore|docker-compose.yml)
      ;;
    # Keep the exact Dockerfile.dev.dockerignore exception above ahead of this
    # broad top-level variant check.
    Dockerfile*|compose*.yaml|compose*.yml|docker-compose*.yaml|docker-compose*.yml)
      report "[deployment-scope] unapproved top-level container/deployment path: $path"
      ;;
  esac
done

production_dockerfile="Dockerfile"
production_dockerignore="Dockerfile.dockerignore"

if [[ -e "$production_dockerfile" || -e "$production_dockerignore" ]]; then
  if [[ ! -f "$production_dockerfile" || ! -f "$production_dockerignore" ]]; then
    report "[production-container] Dockerfile and Dockerfile.dockerignore must be present as one coherent set"
  fi
fi

if [[ -f "$production_dockerfile" ]]; then
  production_from_pattern='^[[:space:]]*FROM[[:space:]]+node:24-bookworm-slim@sha256:[0-9a-f]{64}([[:space:]]+AS[[:space:]]+builder)?[[:space:]]*$'
  production_from_count="$(grep -Ec '^[[:space:]]*FROM[[:space:]]+' "$production_dockerfile" || true)"

  if [[ "$production_from_count" != "2" ]] ||
    grep -E '^[[:space:]]*FROM[[:space:]]+' "$production_dockerfile" |
      grep -Ev "$production_from_pattern" >/dev/null; then
    report "[production-container] Dockerfile must use exactly two pinned Node 24 bookworm-slim stages"
  fi
  if ! grep -Eq '^[[:space:]]*FROM[[:space:]]+node:24-bookworm-slim@sha256:[0-9a-f]{64}[[:space:]]+AS[[:space:]]+builder[[:space:]]*$' "$production_dockerfile"; then
    report "[production-container] Dockerfile must have a pinned builder stage"
  fi
  if ! grep -Eq '^[[:space:]]*COPY[[:space:]]+--from=builder([[:space:]]|$)' "$production_dockerfile"; then
    report "[production-container] Dockerfile runtime must copy dependencies from the builder stage"
  fi
  if ! grep -Eq '^[[:space:]]*USER[[:space:]]+node[[:space:]]*$' "$production_dockerfile"; then
    report "[production-container] Dockerfile must run as USER node"
  fi
  if grep -Eq '^[[:space:]]*USER[[:space:]]+root([[:space:]]|$)' "$production_dockerfile"; then
    report "[production-container] Dockerfile must not switch to root at runtime"
  fi
  if ! grep -Eq 'npm[[:space:]]+ci[[:space:]]+--omit=dev([[:space:]]|$)' "$production_dockerfile"; then
    report "[production-container] Dockerfile builder must install production dependencies with npm ci --omit=dev"
  fi
  if ! grep -Eq '^[[:space:]]*CMD[[:space:]]+\["node",[[:space:]]*"src/main\.ts"\][[:space:]]*$' "$production_dockerfile"; then
    report "[production-container] Dockerfile must run the v2 src/main.ts entrypoint"
  fi
  if grep -Eq '^[[:space:]]*ENTRYPOINT([[:space:]]|$)' "$production_dockerfile"; then
    report "[production-container] Dockerfile must not add a legacy ENTRYPOINT"
  fi
  if grep -Eq '^[[:space:]]*ADD([[:space:]]|$)' "$production_dockerfile"; then
    report "[production-container] Dockerfile must use explicit COPY instructions and no ADD"
  fi
  production_copy_pattern='^[[:space:]]*COPY[[:space:]]+(--from=builder[[:space:]]+--chown=node:node[[:space:]]+/app/node_modules[[:space:]]+\./node_modules|--chown=node:node[[:space:]]+package\.json[[:space:]]+package-lock\.json[[:space:]]+\./|package\.json[[:space:]]+package-lock\.json[[:space:]]+\./|--chown=node:node[[:space:]]+(src|views|public)/[[:space:]]+\./(src|views|public)/)[[:space:]]*$'
  invalid_copy_lines="$(grep -E '^[[:space:]]*COPY[[:space:]]+' "$production_dockerfile" | grep -Ev "$production_copy_pattern" || true)"
  if [[ -n "$invalid_copy_lines" ]]; then
    report "[production-container] Dockerfile COPY sources must be explicit and limited to package metadata, builder dependencies, src, views, and public"
  fi
  if grep -Eiq '^[[:space:]]*(ARG|ENV)[[:space:]].*(SECRET|TOKEN|PASSWORD|PIN|CREDENTIAL|PRIVATE[_-]?KEY|API[_-]?KEY)' "$production_dockerfile" ||
    grep -Eiq '(^|[[:space:]])(TAPBOARD_SECRET_KEY|[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PIN|CREDENTIAL|PRIVATE[_-]?KEY|API[_-]?KEY))[[:space:]]*=' "$production_dockerfile"; then
    report "[production-container] Dockerfile must not declare secret defaults or secret build arguments"
  fi
  if grep -Eiq '^FROM[[:space:]]+node:(1[0-9]|20|21|22|23)([-@[:space:]]|$)' "$production_dockerfile"; then
    report "[production-container] Dockerfile must not use a legacy Node runtime"
  fi
  if grep -Eiq 'BACKUP_DIR|/app/backups|home[-_ ]?assistant|brewfather|HA_URL|HA_TOKEN|BREWFATHER|telemetry' "$production_dockerfile"; then
    report "[production-container] Dockerfile must not contain backup or Home Assistant/telemetry paths"
  fi
  if grep -Eq '^[[:space:]]*VOLUME([[:space:]]|$)' "$production_dockerfile"; then
    report "[production-container] Dockerfile must leave volume ownership to Compose"
  fi
  if ! grep -Fq 'wget --no-verbose --tries=1 --spider' "$production_dockerfile" ||
    ! grep -Fq '${TAPBOARD_PORT:-${PORT:-3005}}/healthz' "$production_dockerfile"; then
    report "[production-container] Dockerfile healthcheck must use wget and TAPBOARD_PORT, PORT, then 3005"
  fi
fi

if [[ -f "$production_dockerignore" ]]; then
  required_context_patterns=(
    '*'
    '!Dockerfile'
    '!Dockerfile.dockerignore'
    '!package.json'
    '!package-lock.json'
    '!src/'
    '!src/**'
    '!views/'
    '!views/**'
    '!public/'
    '!public/**'
    '.env*'
    '**/.env*'
    '**/.env.*'
    '**/*credentials*'
    '**/*private-key*'
    '**/*private_key*'
    '**/*.pem'
    '**/*.key'
    '**/*.sqlite'
    '**/*.sqlite3'
    '**/*.db'
    '**/*.db-*'
    '**/*.log'
    '**/data'
    '**/data/**'
    '**/backups'
    '**/backups/**'
    '**/node_modules'
    '**/node_modules/**'
  )
  for pattern in "${required_context_patterns[@]}"; do
    if ! grep -Fqx -- "$pattern" "$production_dockerignore"; then
      report "[production-container] Dockerfile.dockerignore is missing required pattern: $pattern"
    fi
  done

  exclusions_started=0
  while IFS= read -r pattern; do
    case "$pattern" in
      '!'Dockerfile|'!'Dockerfile.dockerignore|'!'package.json|'!'package-lock.json|'!'src/|'!'src/**|'!'views/|'!'views/**|'!'public/|'!'public/**)
        if ((exclusions_started)); then
          report "[production-container] Dockerfile.dockerignore allowlist entries must precede final exclusions: $pattern"
        fi
        ;;
      # The final deny rules cover secrets and mutable/runtime state. They are
      # intentionally recognized separately so allowlist additions after them
      # cannot weaken the build-context boundary.
      .env*|'**/.env*'|'**/.env.*'|'**/*credentials*'|'**/*private-key*'|'**/*private_key*'|'**/*.pem'|'**/*.key'|'**/*.sqlite'|'**/*.sqlite3'|'**/*.db'|'**/*.db-*'|'**/*.log'|'**/data'|'**/data/**'|'**/backups'|'**/backups/**'|'**/node_modules'|'**/node_modules/**')
        exclusions_started=1
        ;;
      '!'*)
        report "[production-container] Dockerfile.dockerignore allowlist contains an unapproved path: $pattern"
        ;;
      *)
        ;;
    esac
  done < <(grep -Ev '^[[:space:]]*(#|$)' "$production_dockerignore" || true)
fi

if [[ -f compose.production.example.yaml ]]; then
  if [[ ! -f "$production_dockerfile" || ! -f "$production_dockerignore" ]]; then
    report "[production-example] compose.production.example.yaml requires the coherent production Dockerfile pair"
  fi

  # Freeze the reviewed deployment content, ignoring only blank/comment lines
  # and trailing whitespace. Unlike keyword checks, this also rejects duplicate
  # YAML keys, extra writable mounts, privilege overrides, and secret defaults.
  approved_production_compose="$(cat <<'YAML'
services:
  tapboard:
    image: ${TAPBOARD_IMAGE:-tapboard:local}
    build:
      context: .
      dockerfile: Dockerfile
    pull_policy: never
    env_file:
      - path: ${TAPBOARD_ENV_FILE:-.env}
        required: false
    environment:
      NODE_ENV: production
      TAPBOARD_HOST: 0.0.0.0
      TAPBOARD_PORT: "3005"
      TAPBOARD_DATABASE_PATH: /app/data/tapboard-v2.sqlite3
      TAPBOARD_EXTERNAL_ORIGIN: ${TAPBOARD_EXTERNAL_ORIGIN:-http://127.0.0.1:3005}
      TAPBOARD_SHUTDOWN_GRACE_MS: "5000"
    ports:
      - "${TAPBOARD_PUBLISH_ADDRESS:-127.0.0.1}:${TAPBOARD_PUBLISH_PORT:-3005}:3005"
    user: "1000:1000"
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=16m,mode=1777
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    init: true
    stop_signal: SIGTERM
    stop_grace_period: 15s
    restart: unless-stopped
    volumes:
      - tapboard-data:/app/data
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - >-
          fetch("http://127.0.0.1:3005/healthz", { signal: AbortSignal.timeout(2500) })
          .then((response) => process.exit(response.status === 200 ? 0 : 1))
          .catch(() => process.exit(1))
      interval: 5s
      timeout: 3s
      start_period: 5s
      retries: 12
volumes:
  tapboard-data:
YAML
  )"
  actual_production_compose="$(sed -E '/^[[:space:]]*(#|$)/d; s/[[:space:]]+$//' compose.production.example.yaml)"
  if [[ "$actual_production_compose" != "$approved_production_compose" ]]; then
    report "[production-example] compose.production.example.yaml must match the approved production build, canonical paths, exposure knobs, and hardening contract"
  fi
fi

legacy_v1_module_basenames=()
for path in "${forbidden_v1_paths[@]}"; do
  if [[ "$path" =~ ^src/([^/]+)\.js$ ]]; then
    legacy_v1_module_basenames+=("${BASH_REMATCH[1]}")
  fi
done

active_repository_files() {
  if [[ -z "${TAPBOARD_ARCHITECTURE_ROOT:-}" ]]; then
    while IFS= read -r path; do
      [[ -f "$path" ]] && printf '%s\n' "$path"
    done < <(git ls-files --cached --others --exclude-standard)
    return
  fi

  find . -type f \
    -not -path './.git/*' \
    -not -path './node_modules/*' \
    -not -path './data/*' \
    -not -path './backups/*' \
    -print | sed 's#^\./##' | LC_ALL=C sort
}

import_specifiers() {
  grep -Eo "(from|import)[[:space:]]*(\()?[[:space:]]*['\"][^'\"]+['\"]" "$1" |
    sed -E "s/^(from|import)[[:space:]]*(\()?[[:space:]]*['\"]//; s/['\"]$//"
}

if active_repository_files | grep -Eq '^(v1|v2|legacy)/|^(src|app|server|client|public)/(v1|v2|legacy)/'; then
  while IFS= read -r path; do
    report "[shadow-runtime] parallel or legacy runtime tree is prohibited: $path"
  done < <(active_repository_files | grep -E '^(v1|v2|legacy)/|^(src|app|server|client|public)/(v1|v2|legacy)/')
fi

while IFS= read -r source_file; do
  while IFS= read -r specifier; do
    if [[ "$specifier" =~ (^|/)(v1|legacy)/ ]]; then
      report "[legacy-import] legacy v1 module import in source: $source_file"
      break
    fi

    module_path="${specifier%%[?#]*}"
    case "$module_path" in
      ./*|../*)
        normalized_module_path="$(realpath -m --relative-to=. -- "$(dirname "$source_file")/$module_path")"
        ;;
      src/*|/src/*)
        normalized_module_path="${module_path#/}"
        ;;
      *)
        normalized_module_path=""
        ;;
    esac

    if [[ "$normalized_module_path" == "src/infrastructure/http/server.ts" ||
      "$normalized_module_path" == "src/shared/validation.ts" ]]; then
      continue
    fi

    module_basename="$module_path"
    module_basename="${module_basename##*/}"
    if [[ "$module_basename" =~ ^(.+)\.(mjs|cjs|js|mts|cts|ts)$ ]]; then
      module_basename="${BASH_REMATCH[1]}"
    fi

    for legacy_basename in "${legacy_v1_module_basenames[@]}"; do
      if [[ "$module_basename" == "$legacy_basename" ]]; then
        report "[legacy-import] legacy v1 module import in source: $source_file"
        break 2
      fi
    done
  done < <(import_specifiers "$source_file" || true)
done < <(active_repository_files | grep -E '^(src|app|server|client|public)/.*\.(js|mjs|cjs|ts|mts|cts)$' || true)

while IFS= read -r domain_file; do
  if grep -Ein "(from|import)[[:space:]]*(\()?[[:space:]]*['\"][^'\"]*(integrations?/|brewfather|home[-_]?assistant|webhook)" "$domain_file" >/dev/null; then
    report "[domain-integration] integration-specific import in domain source: $domain_file"
  fi
done < <(active_repository_files | grep -E '^src/(core/|domain/|features/[^/]+/domain/).*\.(js|mjs|cjs|ts|mts|cts)$' || true)

while IFS= read -r activity_file; do
  if grep -Ein "(from|import)[[:space:]]*(\()?[[:space:]]*['\"][^'\"]*/(events|outbox)/" "$activity_file" >/dev/null; then
    report "[activity-outbox] Activity must not depend on events or outbox: $activity_file"
  fi
done < <(active_repository_files | grep -E '^src/features/activity/.*\.(js|mjs|cjs|ts|mts|cts)$' || true)

while IFS= read -r crypto_file; do
  if [[ "$crypto_file" == "src/features/secrets/crypto.ts" ]]; then
    continue
  fi
  if grep -En '\b(createCipheriv|createDecipheriv)\b' "$crypto_file" >/dev/null; then
    report "[secret-crypto] integration-secret encryption is outside its centralized owner: $crypto_file"
  fi
done < <(active_repository_files | grep -E '^src/.*\.(js|mjs|cjs|ts|mts|cts)$' || true)

while IFS= read -r browser_file; do
  while IFS= read -r import_expression; do
    specifier="$(sed -E "s/^(from|import)[[:space:]]*(\\()?[[:space:]]*['\"]//; s/['\"]$//" <<<"$import_expression")"

    case "$specifier" in
      ./*|../*)
        normalized_specifier="$(realpath -m --relative-to=. -- "$(dirname "$browser_file")/$specifier")"
        ;;
      src/*|server/*|/src/*|/server/*)
        normalized_specifier="${specifier#/}"
        ;;
      *)
        continue
        ;;
    esac

    if [[ "$normalized_specifier" =~ ^src/(application|main|config)\.([cm]?[jt]s)$ ||
      "$normalized_specifier" =~ ^src/infrastructure/ ||
      "$normalized_specifier" =~ ^(src/)?server/ ]]; then
      report "[browser-server] browser source imports server/infrastructure source: $browser_file"
      break
    fi
  done < <(import_specifiers "$browser_file" || true)
done < <(active_repository_files | grep -E '^((public|client|browser)/|src/(public|client|browser|presentation/browser|features/[^/]+/(public|client|browser))/).*\.(js|mjs|cjs|ts|mts|cts)$' || true)

while IFS= read -r sql_file; do
  if grep -Eq '^src/infrastructure/database/(connection|migrations)\.ts$|^src/features/[^/]+/repository\.ts$|^src/features/[^/]+/repositories/[^/]+\.ts$' <<<"$sql_file"; then
    continue
  fi

  # Requiring SQL whitespace after standalone keywords avoids treating common
  # JavaScript methods such as cryptographic `.update(...)` as SQL.
  if grep -Ein '\b(SELECT|INSERT|UPDATE|PRAGMA)[[:space:]]+|\bDELETE[[:space:]]+FROM\b|\b(CREATE|ALTER|DROP)[[:space:]]+TABLE\b' "$sql_file" >/dev/null; then
    report "[sql-ownership] raw SQL outside approved database ownership: $sql_file"
  fi
done < <(active_repository_files | grep -E '^(src|app|server)/.*\.(js|mjs|cjs|ts|mts|cts)$' || true)

while IFS= read -r database_file; do
  if [[ "$database_file" == "src/infrastructure/database/connection.ts" ]]; then
    continue
  fi

  if grep -En "better-sqlite3|new[[:space:]]+Database[[:space:]]*\(" "$database_file" >/dev/null; then
    report "[sqlite-boundary] better-sqlite3 access or construction outside connection boundary: $database_file"
  fi
done < <(active_repository_files | grep -E '^src/.*\.(js|mjs|cjs|ts|mts|cts)$' || true)

if ((violations > 0)); then
  printf '%d architecture violation(s) found.\n' "$violations" >&2
  exit 1
fi

printf 'Architecture guardrails passed.\n'
