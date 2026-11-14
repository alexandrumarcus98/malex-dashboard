#!/usr/bin/env python3
"""Create/update the Cloudflare Tunnel, DNS CNAMEs, and Access policies via CLI."""

import base64
import json
import os
import secrets
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT_DIR / ".env"

ZONE_NAME = "malex.tech"
TUNNEL_NAME = "malex-dashboard"
HOST_ROUTES = [
    ("dashboard.malex.tech", "http://homepage:3000"),
    ("metrics.malex.tech", "http://beszel:8090"),
    ("status.malex.tech", "http://uptime-kuma:3001"),
]


def load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        values[k.strip()] = v.strip().strip('"').strip("'")
    return values


def upsert_env_var(path: Path, key: str, value: str) -> None:
    lines = path.read_text().splitlines() if path.exists() else []
    replaced = False
    new_lines: list[str] = []
    for line in lines:
        if line.startswith(f"{key}="):
            new_lines.append(f"{key}={value}")
            replaced = True
        else:
            new_lines.append(line)
    if not replaced:
        if new_lines and new_lines[-1] != "":
            new_lines.append("")
        new_lines.append(f"{key}={value}")
    path.write_text("\n".join(new_lines) + "\n")
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def cf_request(token: str, method: str, endpoint: str, body: dict | None = None) -> dict:
    url = f"https://api.cloudflare.com/client/v4{endpoint}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        raw_err = exc.read().decode(errors="replace")
        raise RuntimeError(f"{method} {endpoint} failed ({exc.code}): {raw_err}") from exc
    if not payload.get("success"):
        raise RuntimeError(f"{method} {endpoint} API error: {payload.get('errors')}")
    return payload


def main() -> int:
    file_env = load_env(ENV_PATH)
    token = os.environ.get("CF_API_TOKEN") or file_env.get("CF_API_TOKEN", "")
    access_email = os.environ.get("CF_ACCESS_EMAIL") or file_env.get("CF_ACCESS_EMAIL", "")

    if not token:
        print("Error: set CF_API_TOKEN in .env or environment.", file=sys.stderr)
        return 1

    zones = cf_request(token, "GET", f"/zones?name={urllib.parse.quote(ZONE_NAME)}")["result"]
    if not zones:
        print(f"Error: zone {ZONE_NAME} not found for this token.", file=sys.stderr)
        return 1

    zone_id = zones[0]["id"]
    account_id = zones[0]["account"]["id"]
    print(f"Zone {ZONE_NAME}: {zone_id} (account {account_id})")

    tunnels = cf_request(
        token,
        "GET",
        f"/accounts/{account_id}/cfd_tunnel?name={urllib.parse.quote(TUNNEL_NAME)}&is_deleted=false",
    )["result"]

    if tunnels:
        tunnel_id = tunnels[0]["id"]
        print(f"Reusing existing tunnel '{TUNNEL_NAME}': {tunnel_id}")
    else:
        secret = base64.b64encode(secrets.token_bytes(32)).decode()
        created = cf_request(
            token,
            "POST",
            f"/accounts/{account_id}/cfd_tunnel",
            {"name": TUNNEL_NAME, "tunnel_secret": secret, "config_src": "cloudflare"},
        )["result"]
        tunnel_id = created["id"]
        print(f"Created tunnel '{TUNNEL_NAME}': {tunnel_id}")

    tunnel_token = cf_request(
        token, "GET", f"/accounts/{account_id}/cfd_tunnel/{tunnel_id}/token"
    )["result"]
    upsert_env_var(ENV_PATH, "TUNNEL_TOKEN", tunnel_token)
    print(f"Saved TUNNEL_TOKEN into {ENV_PATH.name} (chmod 600).")

    ingress = [{"hostname": host, "service": svc} for host, svc in HOST_ROUTES]
    ingress.append({"service": "http_status:404"})
    cf_request(
        token,
        "PUT",
        f"/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations",
        {"config": {"ingress": ingress}},
    )
    print("Updated remote tunnel ingress rules:")
    for host, svc in HOST_ROUTES:
        print(f"  https://{host} -> {svc}")

    cname_target = f"{tunnel_id}.cfargotunnel.com"
    for host, _ in HOST_ROUTES:
        existing = cf_request(
            token,
            "GET",
            f"/zones/{zone_id}/dns_records?name={urllib.parse.quote(host)}",
        )["result"]
        record_body = {
            "type": "CNAME",
            "name": host,
            "content": cname_target,
            "proxied": True,
            "ttl": 1,
        }
        if existing:
            rec = existing[0]
            cf_request(token, "PUT", f"/zones/{zone_id}/dns_records/{rec['id']}", record_body)
            print(f"Updated DNS CNAME: {host} -> {cname_target}")
        else:
            cf_request(token, "POST", f"/zones/{zone_id}/dns_records", record_body)
            print(f"Created DNS CNAME: {host} -> {cname_target}")

    if not access_email:
        print(
            "\nNote: CF_ACCESS_EMAIL is not set; skipped creating Cloudflare Access login policies.\n"
            "Set CF_ACCESS_EMAIL=you@example.com in .env and re-run to lock these URLs."
        )
        return 0

    try:
        existing_apps = cf_request(token, "GET", f"/accounts/{account_id}/access/apps")["result"]
    except RuntimeError as exc:
        print(
            "\nCould not read Cloudflare Access apps (if you haven't opened Cloudflare Zero Trust "
            f"once in the dashboard to pick your free team name, do that first):\n  {exc}",
            file=sys.stderr,
        )
        return 1

    apps_by_domain = {app.get("domain"): app for app in existing_apps}
    for host, _ in HOST_ROUTES:
        app = apps_by_domain.get(host)
        if not app:
            app = cf_request(
                token,
                "POST",
                f"/accounts/{account_id}/access/apps",
                {
                    "name": host,
                    "domain": host,
                    "type": "self_hosted",
                    "session_duration": "24h",
                },
            )["result"]
            print(f"Created Access App: {host}")
        else:
            print(f"Access App already exists: {host}")

        policies = cf_request(
            token, "GET", f"/accounts/{account_id}/access/apps/{app['id']}/policies"
        )["result"]
        has_email = any(
            inc.get("email", {}).get("email") == access_email
            for pol in policies
            for inc in pol.get("include", [])
        )
        if not has_email:
            cf_request(
                token,
                "POST",
                f"/accounts/{account_id}/access/apps/{app['id']}/policies",
                {
                    "name": f"Allow {access_email}",
                    "decision": "allow",
                    "include": [{"email": {"email": access_email}}],
                },
            )
            print(f"  Added Access email policy for {access_email}")

    print("\nCloudflare setup complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
