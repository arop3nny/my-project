#!/usr/bin/env bash
set -euo pipefail
: "${KUBE_CONFIG_B64:?Configure the observability environment KUBE_CONFIG_B64 secret}"
: "${DEPLOY_ENVIRONMENT:?Set staging or production}"
[[ "$DEPLOY_ENVIRONMENT" == staging || "$DEPLOY_ENVIRONMENT" == production ]]
namespace="observability-$DEPLOY_ENVIRONMENT"
umask 077
KUBECONFIG=$(mktemp)
export KUBECONFIG
trap 'rm -f "$KUBECONFIG"' EXIT
printf '%s' "$KUBE_CONFIG_B64" | base64 --decode > "$KUBECONFIG"
unset KUBE_CONFIG_B64
helm upgrade --install observability deploy/helm/observability -n "$namespace" \
  -f "deploy/observability/$DEPLOY_ENVIRONMENT.yaml" --wait --timeout 15m --history-max 10
kubectl rollout status statefulset/otel-collector -n "$namespace" --timeout=5m
