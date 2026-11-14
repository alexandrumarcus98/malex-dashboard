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

1. Activate **Azure for Students** and create a scoped **Cloudflare API Token** (`Cloudflare Tunnel: Edit`, `Access: Apps and Policies: Edit`, `Zone DNS: Edit` for `malex.tech`). If you have never opened **Zero Trust** in Cloudflare before, click it once in the sidebar to initialize your free `$0` team name.
2. Copy `.env.example` to `.env` (`chmod 600`) and set `CF_API_TOKEN` and `CF_ACCESS_EMAIL`.
3. Run Cloudflare setup + Azure provisioning + deploy via CLI:
   ```bash
   ./scripts/setup-cloudflare.py
   az login --use-device-code
   ./scripts/provision-azure.sh
   ./scripts/deploy-stack.sh <PUBLIC_IP>
   ```
4. Open `https://metrics.malex.tech` to initialize Beszel and copy the agent command onto your Hetzner VPS and local machines.

