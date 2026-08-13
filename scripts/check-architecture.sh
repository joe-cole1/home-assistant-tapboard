#!/usr/bin/env bash
set -euo pipefail

# This gate describes the rebuild-initialization construction site. Foundation
# must replace the package/runtime path bans with v2 topology-aware checks, and
# the deployment phase must replace the Docker path bans with content-aware
# v2 deployment checks. See docs/rebuild/ARCHITECTURE-GUARDRAILS.md.

repository_root="$(git rev-parse --show-toplevel)"
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
  .prettierignore
  .prettierrc.json
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
  package.json
  package-lock.json
  eslint.config.js
  Dockerfile
  docker-compose.yml
)

for path in "${forbidden_v1_paths[@]}"; do
  if [[ -e "$path" ]]; then
    report "legacy v1 path is active: $path"
  fi
done

active_repository_files() {
  while IFS= read -r path; do
    [[ -f "$path" ]] && printf '%s\n' "$path"
  done < <(git ls-files --cached --others --exclude-standard)
}

if active_repository_files | grep -Eq '^(v1|v2|legacy)/|^(src|app|server|client|public)/(v1|v2|legacy)/'; then
  while IFS= read -r path; do
    report "parallel or legacy runtime tree is prohibited: $path"
  done < <(active_repository_files | grep -E '^(v1|v2|legacy)/|^(src|app|server|client|public)/(v1|v2|legacy)/')
fi

legacy_import_pattern='(server|dbMigrations|databaseMaintenance|haClient|tapboardProjection|tapPlanning|imageProxy|tapActions)\.(js|ts)'
while IFS= read -r source_file; do
  if grep -En "$legacy_import_pattern" "$source_file" >/dev/null; then
    report "legacy v1 module import/reference in source: $source_file"
  fi
done < <(active_repository_files | grep -E '^(src|app|server|client|public)/.*\.(js|mjs|cjs|ts|mts|cts)$' || true)

while IFS= read -r domain_file; do
  if grep -Ein '(integrations?/|brewfather|home[-_]?assistant|webhook)' "$domain_file" >/dev/null; then
    report "integration-specific dependency in core domain: $domain_file"
  fi
done < <(active_repository_files | grep -E '^src/(domain/|.*/domain/).*\.(js|mjs|cjs|ts|mts|cts)$' || true)

while IFS= read -r browser_file; do
  if grep -En "(from|import\()[[:space:]]*['\"][^'\"]*(src/|server/|infrastructure/)" "$browser_file" >/dev/null; then
    report "browser source imports server/infrastructure source: $browser_file"
  fi
done < <(active_repository_files | grep -E '^(public|client|browser)/.*\.(js|mjs|cjs|ts|mts|cts)$' || true)

while IFS= read -r sql_file; do
  case "$sql_file" in
    */repository.*|*/repositories/*|*/migration.*|*/migrations/*|*/database/*|*/db/*) ;;
    *)
      if grep -Ein '\b(SELECT|INSERT|UPDATE|DELETE[[:space:]]+FROM|CREATE[[:space:]]+TABLE|ALTER[[:space:]]+TABLE|DROP[[:space:]]+TABLE|PRAGMA)\b' "$sql_file" >/dev/null; then
        report "raw SQL outside repository/migration/database ownership: $sql_file"
      fi
      ;;
  esac
done < <(active_repository_files | grep -E '^(src|app|server)/.*\.(js|mjs|cjs|ts|mts|cts)$' || true)

if ((violations > 0)); then
  printf '%d architecture violation(s) found.\n' "$violations" >&2
  exit 1
fi

printf 'Architecture guardrails passed.\n'
