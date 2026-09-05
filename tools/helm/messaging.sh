#!/usr/bin/env bash
set -euo pipefail
: "${KUBE_CONFIG_B64:?Configure the messaging environment KUBE_CONFIG_B64 secret}"
: "${DEPLOY_ENVIRONMENT:?Set staging or production}"
[[ "$DEPLOY_ENVIRONMENT" == staging || "$DEPLOY_ENVIRONMENT" == production ]]
namespace="platform-$DEPLOY_ENVIRONMENT"
umask 077
KUBECONFIG=$(mktemp)
export KUBECONFIG
trap 'rm -f "$KUBECONFIG"' EXIT
printf '%s' "$KUBE_CONFIG_B64" | base64 --decode > "$KUBECONFIG"
unset KUBE_CONFIG_B64
helm upgrade --install messaging deploy/helm/messaging -n "$namespace" \
  -f "deploy/messaging/$DEPLOY_ENVIRONMENT.yaml" --wait --timeout 20m --history-max 10
kubectl wait --for=condition=Ready kafka/platform-kafka -n "$namespace" --timeout=20m
kubectl wait --for=condition=Ready kafkauser/platform-worker -n "$namespace" --timeout=5m
kubectl wait --for=condition=Ready kafkatopic/platform.events.v1 kafkatopic/platform.events.dlq.v1 -n "$namespace" --timeout=5m
