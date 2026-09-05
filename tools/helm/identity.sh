#!/usr/bin/env bash
set -euo pipefail
: "${KUBE_CONFIG_B64:?Configure the identity environment KUBE_CONFIG_B64 secret}"
: "${DEPLOY_ENVIRONMENT:?Set staging or production}"
[[ "$DEPLOY_ENVIRONMENT" == staging || "$DEPLOY_ENVIRONMENT" == production ]]
namespace="identity-$DEPLOY_ENVIRONMENT"
umask 077
KUBECONFIG=$(mktemp)
export KUBECONFIG
trap 'rm -f "$KUBECONFIG"' EXIT
printf '%s' "$KUBE_CONFIG_B64" | base64 --decode > "$KUBECONFIG"
unset KUBE_CONFIG_B64

chart=deploy/helm/identity
values="deploy/identity/$DEPLOY_ENVIRONMENT.yaml"
helm lint "$chart" --strict -f "$values"
# Stateful identity/database upgrades need explicit recovery, not an automatic image rollback.
helm upgrade --install identity "$chart" -n "$namespace" -f "$values" --wait --timeout 15m --history-max 10
kubectl wait --for=condition=Ready cluster.postgresql.cnpg.io/keycloak-db -n "$namespace" --timeout=15m
kubectl wait --for=condition=Ready keycloak/keycloak -n "$namespace" --timeout=15m

if [[ "${BOOTSTRAP_REALM:-false}" == true ]]; then
  helm template identity "$chart" -n "$namespace" -f "$values" \
    --set realm.import=true --show-only templates/realm-import.yaml | kubectl apply -n "$namespace" -f -
  kubectl wait --for=condition=Done keycloakrealmimport/platform-realm -n "$namespace" --timeout=10m
  kubectl delete keycloakrealmimport/platform-realm -n "$namespace"
fi
