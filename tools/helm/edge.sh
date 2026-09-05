#!/usr/bin/env bash
set -euo pipefail
: "${KUBE_CONFIG_B64:?Configure the edge environment KUBE_CONFIG_B64 secret}"
: "${DEPLOY_ENVIRONMENT:?Set staging or production}"
[[ "$DEPLOY_ENVIRONMENT" == staging || "$DEPLOY_ENVIRONMENT" == production ]]
namespace="edge-$DEPLOY_ENVIRONMENT"
umask 077
KUBECONFIG=$(mktemp)
export KUBECONFIG
trap 'rm -f "$KUBECONFIG"' EXIT
printf '%s' "$KUBE_CONFIG_B64" | base64 --decode > "$KUBECONFIG"
unset KUBE_CONFIG_B64
helm upgrade --install edge deploy/helm/edge -n "$namespace" \
  -f "deploy/edge/$DEPLOY_ENVIRONMENT.yaml" --atomic --wait --timeout 5m --history-max 10
kubectl wait --for=condition=Programmed gateway/platform-edge -n "$namespace" --timeout=5m
