#!/usr/bin/env bash
set -euo pipefail

# Foundation topology gate. Issue #85 permits one coherent development-only
# container set; production Docker and Compose paths remain reserved for #81.
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
  .env.example
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
  Dockerfile
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
    Dockerfile.dev|Dockerfile.dev.dockerignore|compose.dev.yaml)
      ;;
    # These canonical v1 paths retain their existing legacy-path diagnostics.
    Dockerfile|.dockerignore|docker-compose.yml)
      ;;
    # Keep the exact Dockerfile.dev.dockerignore exception above ahead of this
    # broad top-level variant check.
    Dockerfile*|compose*.yaml|compose*.yml|docker-compose*.yaml|docker-compose*.yml)
      report "[deployment-scope] unapproved top-level container/deployment path: $path"
      ;;
  esac
done

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
