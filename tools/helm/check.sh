#!/usr/bin/env bash
set -euo pipefail

chart=deploy/helm/platform
helm lint "$chart" --strict
for environment in staging production; do
  helm lint "$chart" --strict -f "deploy/environments/$environment.yaml"
  helm template platform "$chart" -f "deploy/environments/$environment.yaml" > /dev/null
done
# Exercise digest precedence and the optional HPA branch as well.
digest="sha256:$(printf 'a%.0s' {1..64})"
rendered=$(mktemp)
trap 'rm -f "$rendered"' EXIT
helm template platform "$chart" \
  --set "frontend.image.digest=$digest" \
  --set "backend.image.digest=$digest" \
  --set backend.autoscaling.enabled=true > "$rendered"
grep -q "acme-frontend@$digest" "$rendered"
grep -q 'kind: HorizontalPodAutoscaler' "$rendered"
if helm template platform "$chart" --set backend.image.digest=latest > /dev/null 2>&1; then
  echo 'Chart unexpectedly accepted a mutable tag in the digest field' >&2
  exit 1
fi
echo 'Helm lint, environment renders, HPA, and digest validation passed.'

for environment in staging production; do
  helm lint deploy/helm/identity --strict -f "deploy/identity/$environment.yaml"
  helm template identity deploy/helm/identity -f "deploy/identity/$environment.yaml" --set realm.import=true > "$rendered"
  grep -q 'kind: Keycloak' "$rendered"
  grep -q 'kind: Cluster' "$rendered"
  grep -q 'oidc-audience-mapper' "$rendered"
  if grep -q '\${APP_ORIGIN}' "$rendered"; then
    echo 'Unresolved realm redirect URI placeholder' >&2
    exit 1
  fi
done
echo 'Identity cluster and realm bootstrap renders passed.'
for environment in staging production; do
  helm lint deploy/helm/data --strict -f "deploy/data/$environment.yaml"
  helm template data deploy/helm/data -f "deploy/data/$environment.yaml" > /dev/null
done
echo 'Application database chart renders passed.'
for environment in staging production; do
  helm lint deploy/helm/edge --strict -f "deploy/edge/$environment.yaml"
  helm template edge deploy/helm/edge -f "deploy/edge/$environment.yaml" > "$rendered"
  grep -q 'kind: Gateway' "$rendered"
  grep -q 'kind: EnvoyProxy' "$rendered"
done
echo 'Gateway renders passed.'
node tools/helm/validate.mjs

for environment in staging production; do
  helm lint deploy/helm/observability --strict -f "deploy/observability/$environment.yaml"
  helm template observability deploy/helm/observability -n "observability-$environment" -f "deploy/observability/$environment.yaml" > /dev/null
done

for environment in staging production; do
  helm lint deploy/helm/messaging --strict -f "deploy/messaging/$environment.yaml"
  helm template messaging deploy/helm/messaging -n "platform-$environment" -f "deploy/messaging/$environment.yaml" > /dev/null
done
