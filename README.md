# malex-dashboard

Private off-VPS monitoring & status center for `malex.tech`, `media.malex.tech`, Hetzner VPS, seedbox, and local machines. Runs on **Azure for Students** and publishes only through **Cloudflare Tunnel + Cloudflare Zero Trust Access**.

## Stack

* **Beszel (`beszel`)** — Lightweight server/container metrics hub (`http://beszel:8090`)
* **Uptime Kuma (`uptime-kuma`)** — Endpoint uptime monitors & Discord alerts (`http://uptime-kuma:3001`)
* **Homepage (`homepage`)** — Unified landing portal at `https://dashboard.malex.tech` (`http://homepage:3000`)
* **Cloudflared (`cloudflared`)** — Outbound Cloudflare Tunnel (zero open HTTP/HTTPS ports on Azure)

## Cost Guardrails (Azure for Students)

* **VM:** `Standard_B2ats_v2` (2 vCPU AMD, 1 GiB RAM) — 750 hrs/mo free for first 12 months
* **OS Disk:** `64 GiB` `Premium_LRS` (`P6`) — 2× 64 GiB P6 disks free for first 12 months
* **Public IP:** 1× Standard Static IPv4 (~`$3.72/mo` out of `$100/yr` credit; required since Azure retired Default Outbound Access in March 2026)
* **Swap:** `2 GiB` `/swapfile` provisioned automatically via [`azure/cloud-init.yaml`](azure/cloud-init.yaml)

## Quickstart

1. Activate **Azure for Students** and install **Azure CLI (`az`)** (`uv tool install azure-cli` or run from Azure Cloud Shell / Home PC).
2. Create a Cloudflare Zero Trust Tunnel named `malex-dashboard` and protect `dashboard.malex.tech`, `metrics.malex.tech`, and `status.malex.tech` with **Cloudflare Access** (email / GitHub login).
3. Copy `.env.example` to `.env` (`chmod 600`) and paste `TUNNEL_TOKEN=...`.
4. Provision the VM and deploy the stack:
   ```bash
   az login
   ./scripts/provision-azure.sh
   ./scripts/deploy-stack.sh <PUBLIC_IP>
   ```
5. In Cloudflare Zero Trust Tunnel -> **Public Hostnames**, add:
   * `dashboard.malex.tech` -> `HTTP` -> `homepage:3000`
   * `metrics.malex.tech` -> `HTTP` -> `beszel:8090`
   * `status.malex.tech` -> `HTTP` -> `uptime-kuma:3001`
6. Open `https://metrics.malex.tech` to initialize Beszel and copy the agent command onto your Hetzner VPS and local machines.
