#!/usr/bin/env bash
set -euo pipefail

: "${KUBE_CONFIG_B64:?Configure the GitHub environment KUBE_CONFIG_B64 secret}"
: "${KUBE_NAMESPACE:?Set a deployment namespace}"
: "${RELEASE_NAME:?Set a Helm release name}"
: "${DEPLOY_ENVIRONMENT:?Set staging or production}"
[[ "$DEPLOY_ENVIRONMENT" == staging || "$DEPLOY_ENVIRONMENT" == production ]]

# Never print credentials. The runner is ephemeral and the file is owner-readable only.
umask 077
KUBECONFIG=$(mktemp)
export KUBECONFIG
trap 'rm -f "$KUBECONFIG"' EXIT
printf '%s' "$KUBE_CONFIG_B64" | base64 --decode > "$KUBECONFIG"
unset KUBE_CONFIG_B64

bundle=.release/bundle
charts=("$bundle"/platform-*.tgz)
[[ ${#charts[@]} -eq 1 && -f "${charts[0]}" ]] || { echo 'Expected one packaged chart'; exit 1; }
chart="${charts[0]}"
# Capture the last deployed revision, not a failed/pending revision, for smoke-test rollback.
history=$(helm history "$RELEASE_NAME" -n "$KUBE_NAMESPACE" -o json 2>/dev/null || printf '[]')
previous_revision=$(printf '%s' "$history" | node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const releases = JSON.parse(readFileSync(0, "utf8"));
  process.stdout.write(String(releases.filter((release) => release.status === "deployed").at(-1)?.revision ?? ""));
')

helm upgrade --install "$RELEASE_NAME" "$chart" \
  --namespace "$KUBE_NAMESPACE" \
  --reset-values \
  -f "$bundle/$DEPLOY_ENVIRONMENT.yaml" \
  -f "$bundle/images.yaml" \
  --atomic --wait --wait-for-jobs --timeout 5m --history-max 10

# --atomic covers rollout failures, but Helm tests run afterward and need explicit rollback.
if ! helm test "$RELEASE_NAME" --namespace "$KUBE_NAMESPACE" --logs --timeout 2m; then
  if [[ -n "$previous_revision" ]]; then
    helm rollback "$RELEASE_NAME" "$previous_revision" --namespace "$KUBE_NAMESPACE" --wait --timeout 5m
  else
    helm uninstall "$RELEASE_NAME" --namespace "$KUBE_NAMESPACE" --wait --timeout 5m
  fi
  echo 'Release smoke checks failed; the deployment was reverted.' >&2
  exit 1
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    printf 'Deployed **%s** to **%s** in namespace `%s`.\n\n' "$RELEASE_NAME" "$DEPLOY_ENVIRONMENT" "$KUBE_NAMESPACE"
    printf '```json\n'
    cat "$bundle/manifest.json"
    printf '\n```\n'
  } >> "$GITHUB_STEP_SUMMARY"
fi
