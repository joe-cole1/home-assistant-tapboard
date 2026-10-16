#!/usr/bin/env bash
set -euo pipefail

# Living architecture rules; architecture.md ("Architecture enforcement")
# describes each one. The checker reports the violated rule and path.

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

while IFS= read -r sql_file; do
  if grep -Eq '^src/infrastructure/database/(connection|migrations)\.ts$|^src/features/[^/]+/repository\.ts$|^src/features/[^/]+/repositories/[^/]+\.ts$' <<<"$sql_file"; then
    continue
  fi

  # Requiring SQL whitespace after standalone keywords avoids treating common
  # JavaScript methods such as cryptographic `.update(...)` as SQL.
  if grep -Ein '\b(SELECT|INSERT|UPDATE|PRAGMA)[[:space:]]+|\bDELETE[[:space:]]+FROM\b|\b(CREATE|ALTER|DROP)[[:space:]]+TABLE\b' "$sql_file" >/dev/null; then
    report "[sql-ownership] raw SQL outside approved database ownership: $sql_file"
  fi
done < <(active_repository_files | grep -E '^src/.*\.(js|mjs|cjs|ts|mts|cts)$' || true)

while IFS= read -r database_file; do
  if [[ "$database_file" == "src/infrastructure/database/connection.ts" ]]; then
    continue
  fi

  if grep -En "better-sqlite3|new[[:space:]]+Database[[:space:]]*\(" "$database_file" >/dev/null; then
    report "[sqlite-boundary] better-sqlite3 access or construction outside connection boundary: $database_file"
  fi
done < <(active_repository_files | grep -E '^src/.*\.(js|mjs|cjs|ts|mts|cts)$' || true)

while IFS= read -r browser_file; do
  while IFS= read -r specifier; do
    case "$specifier" in
      ./*|../*)
        normalized_specifier="$(realpath -m --relative-to=. -- "$(dirname "$browser_file")/$specifier")"
        ;;
      src/*|/src/*)
        normalized_specifier="${specifier#/}"
        ;;
      *)
        continue
        ;;
    esac

    if [[ "$normalized_specifier" =~ ^src/(application|main|config)\.([cm]?[jt]s)$ ||
      "$normalized_specifier" =~ ^src/infrastructure/ ]]; then
      report "[browser-server] browser source imports server/infrastructure source: $browser_file"
      break
    fi
  done < <(import_specifiers "$browser_file" || true)
done < <(active_repository_files | grep -E '^public/.*\.(js|mjs|cjs|ts|mts|cts)$' || true)

while IFS= read -r crypto_file; do
  if [[ "$crypto_file" == "src/features/secrets/crypto.ts" ]]; then
    continue
  fi
  if grep -En '\b(createCipheriv|createDecipheriv)\b' "$crypto_file" >/dev/null; then
    report "[secret-crypto] integration-secret encryption is outside its centralized owner: $crypto_file"
  fi
done < <(active_repository_files | grep -E '^src/.*\.(js|mjs|cjs|ts|mts|cts)$' || true)

while IFS= read -r activity_file; do
  if grep -Ein "(from|import)[[:space:]]*(\()?[[:space:]]*['\"][^'\"]*/(events|outbox)/" "$activity_file" >/dev/null; then
    report "[activity-outbox] Activity must not depend on events or outbox: $activity_file"
  fi
done < <(active_repository_files | grep -E '^src/features/activity/.*\.(js|mjs|cjs|ts|mts|cts)$' || true)

if ((violations > 0)); then
  printf '%d architecture violation(s) found.\n' "$violations" >&2
  exit 1
fi

printf 'Architecture guardrails passed.\n'
