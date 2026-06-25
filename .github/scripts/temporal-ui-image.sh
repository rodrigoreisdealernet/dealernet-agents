#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
values_file="charts/app/values.yaml"

write_output() {
  local line="$1"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "$line" >> "$GITHUB_OUTPUT"
  else
    echo "$line"
  fi
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "${mode} mode: ${name} is required" >&2
    exit 1
  fi
}

load_temporal_ui_image() {
  mapfile -t image_lines < <(VALUES_FILE="$values_file" python - <<'PY'
import os
from pathlib import Path

values_path = Path(os.environ["VALUES_FILE"])
lines = values_path.read_text().splitlines()

in_temporal_ui = False
in_image = False
repository = ""
tag = ""

for line in lines:
    if line.startswith("temporalUi:"):
        in_temporal_ui = True
        in_image = False
        continue
    if in_temporal_ui and line and not line.startswith("  "):
        break
    if in_temporal_ui and line.startswith("  image:"):
        in_image = True
        continue
    if in_temporal_ui and in_image and line and not line.startswith("    "):
        in_image = False
    if in_temporal_ui and in_image:
        stripped = line.strip()
        if stripped.startswith("repository:"):
            repository = stripped.split(":", 1)[1].strip().strip('"')
        elif stripped.startswith("tag:"):
            tag = stripped.split(":", 1)[1].strip().strip('"')

if not repository or not tag:
    raise SystemExit("Unable to resolve temporalUi.image.repository/tag from charts/app/values.yaml")

print(repository)
print(tag)
PY
  )

  if [[ "${#image_lines[@]}" -ne 2 ]]; then
    echo "Unable to resolve Temporal UI image metadata from ${values_file}" >&2
    exit 1
  fi

  IMAGE_REPOSITORY="${image_lines[0]}"
  IMAGE_TAG="${image_lines[1]}"
  local registry="${REGISTRY:?}"
  SOURCE_REF="docker.io/${IMAGE_REPOSITORY}:${IMAGE_TAG}"
  TARGET_REF="${registry}/${IMAGE_REPOSITORY}:${IMAGE_TAG}"
}

docker_login() {
  local registry="$1"
  local username="$2"
  local secret_value="$3"
  echo "$secret_value" | docker login "$registry" --username "$username" --password-stdin >/dev/null
}

case "$mode" in
  resolve)
    require_env REGISTRY
    load_temporal_ui_image
    write_output "repository=${IMAGE_REPOSITORY}"
    write_output "tag=${IMAGE_TAG}"
    write_output "source_ref=${SOURCE_REF}"
    write_output "target_ref=${TARGET_REF}"
    ;;

  validate)
    require_env REGISTRY
    require_env REGISTRY_USERNAME
    require_env REGISTRY_PASSWORD
    load_temporal_ui_image
    docker_login "$REGISTRY" "$REGISTRY_USERNAME" "$REGISTRY_PASSWORD"
    if ! docker buildx imagetools inspect "$TARGET_REF" >/dev/null 2>&1; then
      echo "::error::Temporal UI image is not mirrored into ${REGISTRY}: ${TARGET_REF}. Run the 'Mirror Temporal UI image' workflow before merging a chart tag bump." >&2
      exit 1
    fi
    echo "Validated mirrored Temporal UI image: ${TARGET_REF}"
    ;;

  mirror)
    require_env REGISTRY
    require_env REGISTRY_USERNAME
    require_env REGISTRY_PASSWORD
    load_temporal_ui_image
    docker_login "$REGISTRY" "$REGISTRY_USERNAME" "$REGISTRY_PASSWORD"
    if [[ -n "${SOURCE_REGISTRY_USERNAME:-}" && -n "${SOURCE_REGISTRY_PASSWORD:-}" ]]; then
      docker_login "docker.io" "$SOURCE_REGISTRY_USERNAME" "$SOURCE_REGISTRY_PASSWORD"
    fi
    if docker buildx imagetools inspect "$TARGET_REF" >/dev/null 2>&1; then
      echo "Temporal UI image already mirrored: ${TARGET_REF}"
      exit 0
    fi
    docker buildx imagetools create --tag "$TARGET_REF" "$SOURCE_REF"
    docker buildx imagetools inspect "$TARGET_REF" >/dev/null
    echo "Mirrored Temporal UI image: ${SOURCE_REF} -> ${TARGET_REF}"
    ;;

  *)
    echo "Usage: $0 {resolve|validate|mirror}" >&2
    exit 1
    ;;
esac
