#!/usr/bin/env bash
# resolve-image-digest.sh — resolve the immutable sha256 digest of an image already
# pushed to the registry, given its commit-SHA tag. This is what lets us "promote a
# known-good commit" (ADR-0062): build-images.yml tags every pushed image
# `:<full-sha>` and `:<short-sha>` and those tags live in ACR permanently, so a
# digest can be recovered for ANY past build — independent of the 7/90-day digest
# *artifact* retention on the Build Images run.
#
# Usage:
#   REGISTRY=myacr.azurecr.io ./resolve-image-digest.sh <image_name> <ref>
#     <image_name>  e.g. frontend | temporal-worker
#     <ref>         a commit SHA (full or short) or any existing tag
#
# Requires: the runner is already `docker login`'d to $REGISTRY (the deploy workflows
# log in with ACR_USERNAME/ACR_PASSWORD before calling this), and Docker Buildx
# (imagetools) is available — it is on ubuntu-latest GitHub runners.
#
# Prints the bare digest (sha256:...) to stdout. Non-zero exit + stderr on failure;
# never prints a partial/!ambiguous result.
set -euo pipefail

REGISTRY="${REGISTRY:?REGISTRY required (e.g. myacr.azurecr.io)}"
IMAGE_NAME="${1:?image name required (frontend|temporal-worker)}"
REF="${2:?ref required (commit SHA or tag)}"

REF_IMAGE="${REGISTRY}/${IMAGE_NAME}:${REF}"

# imagetools inspect resolves the registry-side manifest digest without pulling the
# image. We must use `{{json .Manifest}}` and extract the `digest` field, NOT
# `{{.Manifest.Digest}}`: for a SINGLE-manifest image (which is exactly what
# docker/build-push-action produces here) buildx silently ignores the dotted-field
# template and prints its default human block, whereas `{{json .Manifest}}` reliably
# carries the digest for both a single manifest and a multi-arch index (the index
# digest — which is what Helm pins). Verified against a single-manifest image.
MANIFEST_JSON="$(docker buildx imagetools inspect "$REF_IMAGE" --format '{{json .Manifest}}' 2>/dev/null || true)"

# Extract the sha256 digest without a jq dependency (deploy runners and laptops both).
DIGEST="$(printf '%s' "$MANIFEST_JSON" \
  | grep -oE '"digest"[[:space:]]*:[[:space:]]*"sha256:[0-9a-f]{64}"' \
  | grep -oE 'sha256:[0-9a-f]{64}' \
  | head -1)"

if [[ -z "${DIGEST}" || "${DIGEST}" != sha256:* ]]; then
  echo "::error::could not resolve a digest for ${REF_IMAGE} — is the ref a real, pushed build? (raw manifest: '${MANIFEST_JSON:0:200}')" >&2
  exit 1
fi

echo "$DIGEST"
