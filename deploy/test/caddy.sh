#!/usr/bin/env bash
# Runs the Caddy configuration deploy/provision.sh generates in the pinned Caddy image (`pnpm test:deploy`, part of
# `pnpm test`; needs Docker): routing, caching and security headers, and that no card, recovery or feedback secret
# reaches any log, whether in an address, a Referer, a redirect's Location or a 502. Caddy's internal CA stands in for
# Let's Encrypt, and a second Caddy in the same network namespace stands in for the production API server. Then the
# release workflow's smoke tests (deploy/ci/smoke.sh) run against it from the VPS runner image, trusting that CA.
set -euo pipefail

DEPLOY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readonly DEPLOY_DIR
export PRODUCTION_DASHBOARD_DOMAIN=dashboard.example.test PRODUCTION_COUNTER_DOMAIN=counter.example.test
export PRODUCTION_PUBLIC_DOMAIN=card.example.test STAGING_DASHBOARD_DOMAIN=dashboard.staging.example.test
export STAGING_COUNTER_DOMAIN=counter.staging.example.test STAGING_PUBLIC_DOMAIN=card.staging.example.test
# Shaped like the server's 43-character web card secrets and signed feedback tokens (fake values).
readonly CARD_SECRET=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE
readonly FEEDBACK_TOKEN=FbToKeNfBtOkEnFbToKeNfBtOkEnFbToKeN.SiGnAtUrEsIgNaTuRe
readonly REFERRED_SECRET=ReFeRrErReFeRrErReFeRrEr
readonly RECOVERY_TOKEN=ReCoVeRyToKeNrEcOvErYtOkEnReCoVeRyToKeNrEc
readonly NAME=cafe-loyalty-caddy-test-$$
# The release the fake counter build belongs to (smoke.sh checks it).
readonly COMMIT=0123456789abcdef0123456789abcdef01234567
CADDY_IMAGE=$(sed -n 's/^readonly CADDY_IMAGE=//p' "$DEPLOY_DIR/provision.sh")
readonly CADDY_IMAGE

work=$(mktemp -d)
cleanup() {
  docker rm -f "$NAME" "$NAME-api" "$NAME-smoke" >/dev/null 2>&1 || true
  docker network rm "$NAME-net" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

failures=0
check() {
  if [[ $2 == "$3" ]]; then
    echo "ok: $1"
  else
    echo "FAIL: $1: expected [$3], got [$2]" >&2
    failures=$((failures + 1))
  fi
}

mkdir -p "$work/caddy" "$work/api" "$work/web/production/dashboard" "$work/web/production/counter/assets" \
  "$work/web/staging/dashboard" "$work/web/staging/counter"
config=$(bash "$DEPLOY_DIR/provision.sh" caddyfile)
# The internal CA instead of Let's Encrypt; everything else as generated.
printf '%s\n' "${config/admin unix\/\/config\/admin.sock/admin unix//config/admin.sock
	local_certs}" >"$work/caddy/Caddyfile"
echo '<!doctype html><title>dashboard</title>' >"$work/web/production/dashboard/index.html"
echo '<!doctype html><title>counter</title>' >"$work/web/production/counter/index.html"
echo '<!doctype html><title>staging dashboard</title>' >"$work/web/staging/dashboard/index.html"
printf '%s\n' "const CACHE = \"counter-$COMMIT-2026-10-11T10:00:00Z\";" 'self.addEventListener("fetch", () => {});' \
  >"$work/web/production/counter/sw.js"
echo 'console.log("app");' >"$work/web/production/counter/assets/index-AbC123.js"
# The API: the server's signup and feedback redirects, and one API route. Staging's port stays closed (a 502).
cat >"$work/api/Caddyfile" <<EOF
{
	admin off
	auto_https off
}
:3100 {
	redir /join/* /c/$CARD_SECRET?lang=en 303
	redir /f/* /f/$FEEDBACK_TOKEN?lang=en&sent=1 303
	respond /health/ready "{\"status\":\"ready\",\"database\":\"ok\",\"jobQueue\":\"ok\"}" 200
	handle /recover {
		header Referrer-Policy same-origin
		respond 200
	}
	respond /api/cafe 401
	respond /api/* "api" 200
	respond 404
}
EOF
chmod -R a+rX "$work"

docker network create "$NAME-net" >/dev/null
aliases=()
for domain in "$PRODUCTION_DASHBOARD_DOMAIN" "$PRODUCTION_COUNTER_DOMAIN" "$PRODUCTION_PUBLIC_DOMAIN" "$STAGING_DASHBOARD_DOMAIN" \
  "$STAGING_COUNTER_DOMAIN" "$STAGING_PUBLIC_DOMAIN"; do
  aliases+=(--network-alias "$domain")
done
docker run -d --name "$NAME" --network "$NAME-net" "${aliases[@]}" -p 127.0.0.1::443 -v "$work/caddy:/etc/caddy:ro" \
  -v "$work/web/production:/srv/cafe-loyalty/production/web:ro" -v "$work/web/staging:/srv/cafe-loyalty/staging/web:ro" \
  "$CADDY_IMAGE" >/dev/null
docker run -d --name "$NAME-api" --network "container:$NAME" -v "$work/api:/etc/caddy:ro" "$CADDY_IMAGE" >/dev/null
port=$(docker port "$NAME" 443/tcp | head -n 1 | sed 's/.*://')

# The response's status line and headers for https://$1$2 (curl options after the path).
response() {
  local host=$1 path=$2
  shift 2
  curl -sk -o /dev/null -D - --max-time 10 --resolve "$host:$port:127.0.0.1" "$@" "https://$host:$port$path" | tr -d '\r'
}
status() { response "$@" | awk 'NR == 1 { print $2 }'; }
# The value of header $3 (any case) in the response to https://$1$2.
header() { response "$1" "$2" | awk -v name="$3" 'tolower(substr($0, 1, index($0, ":") - 1)) == name { print substr($0, index($0, ":") + 2) }'; }

for _ in $(seq 1 30); do
  [[ $(status "$PRODUCTION_DASHBOARD_DOMAIN" / 2>/dev/null) == 200 ]] && break
  sleep 1
done

csp=$(cat "$DEPLOY_DIR/spa-csp.txt")
dashboard=$PRODUCTION_DASHBOARD_DOMAIN counter=$PRODUCTION_COUNTER_DOMAIN public=$PRODUCTION_PUBLIC_DOMAIN
check "the dashboard serves its app" "$(status "$dashboard" /)" 200
check "every dashboard path is the app" "$(status "$dashboard" /admin)" 200
check "the dashboard sends the shared CSP" "$(header "$dashboard" / content-security-policy)" "$csp"
check "index.html is revalidated" "$(header "$dashboard" / cache-control)" no-cache
check "HSTS" "$(header "$dashboard" / strict-transport-security)" max-age=31536000
check "no referrer by default" "$(header "$dashboard" / referrer-policy)" no-referrer
check "a customer page keeps its own referrer policy" "$(header "$public" /recover referrer-policy)" same-origin
check "a server reply without one gets the default" "$(header "$public" /api/health referrer-policy)" no-referrer
check "the dashboard's /api reaches the server" "$(status "$dashboard" /api/auth/session)" 200
check "the counter's /pair is the app" "$(status "$counter" /pair)" 200
check "the service worker is revalidated" "$(header "$counter" /sw.js cache-control)" no-cache
check "hashed assets are kept for good" "$(header "$counter" /assets/index-AbC123.js cache-control)" \
  "public, max-age=31536000, immutable"
check "a missing asset is a 404" "$(status "$counter" /assets/index-gone.js)" 404
check "a missing asset is not kept" "$(header "$counter" /assets/index-gone.js cache-control)" ""
check "signup redirects to the card" "$(status "$public" /join/abcdef)" 303
check "feedback redirects back to its page" "$(status "$public" "/f/$FEEDBACK_TOKEN")" 303
status "$public" "/c/$CARD_SECRET/offers?lang=en" -H "Referer: https://$public/c/$REFERRED_SECRET" >/dev/null
check "a recovery link reaches the server" "$(status "$public" "/r/$RECOVERY_TOKEN")" 404
check "staging's server being down is a 502" "$(status "$STAGING_PUBLIC_DOMAIN" "/c/$CARD_SECRET")" 502
check "staging is not indexed" "$(header "$STAGING_PUBLIC_DOMAIN" / x-robots-tag)" "noindex, nofollow"

sleep 1
logs=$(docker exec "$NAME" sh -c 'cat /var/log/caddy/*.log' && docker logs "$NAME" 2>&1)
for secret in "$CARD_SECRET" "${FEEDBACK_TOKEN%%.*}" "${FEEDBACK_TOKEN#*.}" "$REFERRED_SECRET" "$RECOVERY_TOKEN"; do
  check "no log holds a secret (${secret:0:6}…)" "$(grep -c -- "$secret" <<<"$logs" || true)" 0
done
check "the redirect to the card was logged, masked" "$(grep -c '"Location":\["/c/\[redacted\]?lang=en"\]' <<<"$logs" || true)" 1
check "the 502 was logged, masked" "$(grep '"logger":"http.log.error' <<<"$logs" | grep -c '/c/\[redacted\]' || true)" 1

# The release workflow's smoke tests, through Caddy and TLS, with its internal CA trusted as Let's Encrypt's is.
# shellcheck source=deploy/test/runner.sh
. "$DEPLOY_DIR/test/runner.sh"
docker run -d --name "$NAME-smoke" --network "$NAME-net" -v "$DEPLOY_DIR:/deploy:ro" "$RUNNER" sleep infinity >/dev/null
docker exec "$NAME" cat /data/caddy/pki/authorities/local/root.crt |
  docker exec -i "$NAME-smoke" sh -c 'cat >/usr/local/share/ca-certificates/caddy-test.crt && update-ca-certificates >/dev/null 2>&1'
smoke() {
  smoke_status=0
  smoke_output=$(docker exec "$NAME-smoke" bash /deploy/ci/smoke.sh "$@" 2>&1) || smoke_status=$?
}
smoke "https://$public" "https://$dashboard" "https://$counter" "$COMMIT"
check "the smoke tests pass on a working environment" "$smoke_status" 0
[[ $smoke_status -eq 0 ]] || echo "$smoke_output" >&2
smoke "https://$public" "https://$dashboard" "https://$counter" "$(printf '9%.0s' {1..40})"
check "they fail when the counter is another release's" "$smoke_status" 1
check "and say so in the workflow" "$([[ $smoke_output == '::error title=Smoke test failed::'*'serves another release'* ]] && echo said)" said
smoke "https://$STAGING_PUBLIC_DOMAIN" "https://$dashboard" "https://$counter"
check "they fail when the server is not ready" "$smoke_status" 1
smoke "https://$public" "https://$dashboard" "https://$public"
check "they fail without the counter's app" "$smoke_status" 1
smoke "https://$public" "https://$STAGING_DASHBOARD_DOMAIN" "https://$counter"
check "they fail when an app's /api does not reach the server" "$smoke_status" 1
check "and say which" "$([[ $smoke_output == *"$STAGING_DASHBOARD_DOMAIN/api/cafe did not answer 401"* ]] && echo said)" said

if ((failures > 0)); then
  echo "caddy test: $failures check(s) failed" >&2
  exit 1
fi
echo "caddy test: all checks passed"
