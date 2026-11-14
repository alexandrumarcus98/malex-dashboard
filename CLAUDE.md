# malex-dashboard — Claude Code Guide

Private monitoring & control dashboard (`dashboard.malex.tech`) hosted off-VPS on Azure for Students, exposing services exclusively via Cloudflare Tunnel + Cloudflare Zero Trust Access.

## Strict Azure for Students Cost Guardrails

Never deviate from these resource settings without user approval:
- **VM SKU:** `Standard_B2ats_v2` (2 vCPU AMD, 1 GiB RAM) — covered by 750 free hrs/mo for 12 months (`B1s` or ARM64 `Standard_B2pts_v2` are also free-tier eligible).
- **OS Disk:** `--os-disk-size-gb 64 --storage-sku Premium_LRS` (`P6` 64 GiB Premium SSD — 2x 64 GiB P6 disks included free for 12 months). **Never** leave Azure's 127 GiB default.
- **Public IPv4:** Use ONE `Standard` SKU Public IP (`~$3.72/mo`, ~$45/yr out of the $100/yr student credit). Needed because Microsoft retired Default Outbound Access in March 2026. If deleting the VM later, explicitly delete its Public IP too.
- **Forbidden resources (cost traps):** Never create an Azure NAT Gateway, Azure Bastion, Load Balancer, App Gateway, or managed SQL/Cosmos unless explicitly requested.
- **NSG firewall:** Keep ports `80` and `443` **closed**. Only allow `22/tcp` SSH from the admin's explicit IP/CIDR (`--ssh-source-cidr`).

## Never

- **Never** commit `.env`, `TUNNEL_TOKEN`, SSH private keys, Beszel agent keys, or SQLite/data snapshots (`data/`).
- **Never** bind `beszel`, `uptime-kuma`, or `homepage` to `0.0.0.0` on the Azure host. Keep host bindings on `127.0.0.1` only; `cloudflared` connects over the Docker bridge network `dashboard-net`.

## Verification Before Committing

```bash
docker compose config --quiet
bash -n scripts/provision-azure.sh scripts/deploy-stack.sh
```
