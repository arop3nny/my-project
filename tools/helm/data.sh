#!/usr/bin/env bash
set -euo pipefail
: "${KUBE_CONFIG_B64:?Configure the data environment KUBE_CONFIG_B64 secret}"
: "${DEPLOY_ENVIRONMENT:?Set staging or production}"
[[ "$DEPLOY_ENVIRONMENT" == staging || "$DEPLOY_ENVIRONMENT" == production ]]
namespace="platform-$DEPLOY_ENVIRONMENT"
umask 077
KUBECONFIG=$(mktemp)
export KUBECONFIG
trap 'rm -f "$KUBECONFIG"' EXIT
printf '%s' "$KUBE_CONFIG_B64" | base64 --decode > "$KUBECONFIG"
unset KUBE_CONFIG_B64
helm upgrade --install data deploy/helm/data -n "$namespace" \
  -f "deploy/data/$DEPLOY_ENVIRONMENT.yaml" --wait --timeout 15m --history-max 10
kubectl wait --for=condition=Ready cluster.postgresql.cnpg.io/platform-db -n "$namespace" --timeout=15m
# Managed roles reconcile after database bootstrap; migrations need this role first.
kubectl wait --for='jsonpath={.status.managedRolesStatus.byStatus.reconciled[?(@=="platform_runtime")]}=platform_runtime' \
  cluster.postgresql.cnpg.io/platform-db -n "$namespace" --timeout=5m
kubectl wait --for='jsonpath={.status.managedRolesStatus.byStatus.reconciled[?(@=="platform_worker")]}=platform_worker' \
  cluster.postgresql.cnpg.io/platform-db -n "$namespace" --timeout=5m
