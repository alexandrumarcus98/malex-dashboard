#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "${ROOT_DIR}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${ROOT_DIR}/.env"
  set +a
fi

LOCATION="${AZURE_LOCATION:-germanywestcentral}"
RG="${AZURE_RG:-rg-malex-dashboard}"
VM_NAME="${AZURE_VM_NAME:-malex-dashboard}"
ADMIN_USER="${AZURE_ADMIN_USER:-azureuser}"
VM_SIZE="Standard_B2ats_v2"
IMAGE="Canonical:ubuntu-24_04-lts:server:latest"
NSG_NAME="nsg-${VM_NAME}"
PIP_NAME="pip-${VM_NAME}"

MY_IP="${SSH_SOURCE_IP:-$(curl -fsS https://ifconfig.me)}"
SSH_CIDR="${MY_IP}/32"

echo "Checking active Azure subscription..."
SUB_NAME="$(az account show --query name -o tsv)"
SUB_ID="$(az account show --query id -o tsv)"
echo "Subscription: ${SUB_NAME} (${SUB_ID})"

echo "Checking ${VM_SIZE} availability in ${LOCATION}..."
SKU_MATCH="$(az vm list-skus --location "${LOCATION}" --size "${VM_SIZE}" --query "[0].restrictions[0].reasonCode" -o tsv 2>/dev/null || true)"
if [ -n "${SKU_MATCH}" ] && [ "${SKU_MATCH}" != "None" ]; then
  echo "WARNING: ${VM_SIZE} has restriction (${SKU_MATCH}) in ${LOCATION}."
  echo "Try setting AZURE_LOCATION=westeurope or AZURE_LOCATION=northeurope and re-running."
  exit 1
fi

echo "Creating resource group ${RG} in ${LOCATION}..."
az group create --name "${RG}" --location "${LOCATION}" -o table

echo "Creating locked-down NSG ${NSG_NAME} (SSH allowed only from ${SSH_CIDR}; ports 80/443 closed)..."
az network nsg create --resource-group "${RG}" --name "${NSG_NAME}" -o none
az network nsg rule create \
  --resource-group "${RG}" \
  --nsg-name "${NSG_NAME}" \
  --name allow-admin-ssh \
  --priority 100 \
  --access Allow \
  --protocol Tcp \
  --direction Inbound \
  --source-address-prefixes "${SSH_CIDR}" \
  --destination-port-ranges 22 \
  -o none

echo "Creating Standard Static Public IP ${PIP_NAME} (required for outbound internet after DOA retirement)..."
az network public-ip create \
  --resource-group "${RG}" \
  --name "${PIP_NAME}" \
  --sku Standard \
  --allocation-method Static \
  -o none

echo "Creating ${VM_NAME} (${VM_SIZE}, 64 GiB P6 Premium_LRS)..."
az vm create \
  --resource-group "${RG}" \
  --name "${VM_NAME}" \
  --location "${LOCATION}" \
  --image "${IMAGE}" \
  --size "${VM_SIZE}" \
  --os-disk-size-gb 64 \
  --storage-sku Premium_LRS \
  --public-ip-address "${PIP_NAME}" \
  --nsg "${NSG_NAME}" \
  --admin-username "${ADMIN_USER}" \
  --generate-ssh-keys \
  --custom-data "${ROOT_DIR}/azure/cloud-init.yaml" \
  -o table

PUBLIC_IP="$(az network public-ip show --resource-group "${RG}" --name "${PIP_NAME}" --query ipAddress -o tsv)"

echo "Creating monthly budget alerts (non-fatal if subscription type restricts CLI budgets)..."
START_DATE="$(date -u +%Y-%m-01)"
END_DATE="$(date -u -d '+12 months' +%Y-%m-01 2>/dev/null || date -u +%Y-12-31)"
az consumption budget create \
  --budget-name "${VM_NAME}-monthly-guard" \
  --category cost \
  --amount 10 \
  --time-grain monthly \
  --start-date "${START_DATE}" \
  --end-date "${END_DATE}" \
  --resource-group "${RG}" \
  -o none 2>/dev/null || echo "Note: Set your cost alert directly in Azure Portal -> Cost Management -> Budgets."

echo ""
echo "VM provisioned at ${PUBLIC_IP}."
echo "Next:"
echo "  1. Fill TUNNEL_TOKEN in ${ROOT_DIR}/.env"
echo "  2. Run: ${ROOT_DIR}/scripts/deploy-stack.sh ${PUBLIC_IP}"
