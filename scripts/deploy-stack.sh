#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <AZURE_VM_IP>"
  exit 1
fi

VM_IP="$1"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_USER="${AZURE_ADMIN_USER:-azureuser}"

if [ ! -f "${ROOT_DIR}/.env" ]; then
  echo "Missing ${ROOT_DIR}/.env (copy .env.example and set TUNNEL_TOKEN first)."
  exit 1
fi

# shellcheck disable=SC1091
. "${ROOT_DIR}/.env"
if [ -z "${TUNNEL_TOKEN:-}" ]; then
  echo "TUNNEL_TOKEN in ${ROOT_DIR}/.env is empty."
  exit 1
fi

echo "Waiting for cloud-init on ${ADMIN_USER}@${VM_IP}..."
ssh -o StrictHostKeyChecking=accept-new "${ADMIN_USER}@${VM_IP}" "cloud-init status --wait"

echo "Uploading Compose stack, Homepage config, and runtime .env..."
TMP_ENV="$(mktemp)"
trap 'rm -f "${TMP_ENV}"' EXIT
{
  printf 'TUNNEL_TOKEN=%s\n' "${TUNNEL_TOKEN}"
  printf 'HOMEPAGE_ALLOWED_HOSTS=%s\n' "${HOMEPAGE_ALLOWED_HOSTS:-dashboard.malex.tech}"
  printf 'BESZEL_APP_URL=%s\n' "${BESZEL_APP_URL:-https://metrics.malex.tech}"
} > "${TMP_ENV}"
chmod 600 "${TMP_ENV}"

scp "${ROOT_DIR}/docker-compose.yml" "${ADMIN_USER}@${VM_IP}:/opt/dashboard/docker-compose.yml"
scp "${TMP_ENV}" "${ADMIN_USER}@${VM_IP}:/opt/dashboard/.env"
scp -r "${ROOT_DIR}/homepage/config/." "${ADMIN_USER}@${VM_IP}:/opt/dashboard/homepage/config/"

echo "Starting dashboard containers..."
ssh "${ADMIN_USER}@${VM_IP}" "chmod 600 /opt/dashboard/.env && cd /opt/dashboard && docker compose up -d && docker compose ps"

echo ""
echo "Stack is running. Configure your Cloudflare Zero Trust Tunnel Public Hostnames:"
echo "  dashboard.malex.tech -> http://homepage:3000"
echo "  metrics.malex.tech   -> http://beszel:8090"
echo "  status.malex.tech    -> http://uptime-kuma:3001"

