#!/usr/bin/env bash
# Run once with an administrator context after reviewing the pinned operator versions.
set -euo pipefail
kubectl apply -f deploy/bootstrap/namespaces.yaml
kubectl apply --server-side -k deploy/identity/operators/postgres
kubectl rollout status deployment/cnpg-controller-manager -n cnpg-system --timeout=5m
for environment in staging production; do
  kubectl apply --server-side -k "deploy/identity/operators/$environment"
  kubectl rollout status deployment/keycloak-operator -n "identity-$environment" --timeout=5m
  kubectl apply -n "platform-$environment" -f deploy/bootstrap/rbac.yaml
  kubectl apply -n "platform-$environment" -f deploy/data/rbac.yaml
  kubectl apply -n "platform-$environment" -f deploy/messaging/rbac.yaml
  kubectl apply -n "identity-$environment" -f deploy/identity/rbac.yaml
  kubectl apply -n "edge-$environment" -f deploy/edge/rbac.yaml
  kubectl apply -n "observability-$environment" -f deploy/observability/rbac.yaml
done
helm upgrade --install envoy-gateway oci://docker.io/envoyproxy/gateway-helm \
  --version v1.9.1 -n envoy-gateway-system --create-namespace --wait --timeout 5m
kubectl apply -f deploy/edge/gatewayclass.yaml
helm upgrade --install strimzi oci://quay.io/strimzi-helm/strimzi-kafka-operator \
  --version 1.2.0 -n strimzi-system --create-namespace \
  --set 'watchNamespaces={platform-staging,platform-production}' --wait --timeout 5m
