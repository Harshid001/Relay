# Deploying Relay to Oracle Cloud + Cloudflare

Production topology on a **single Oracle Cloud Always Free ARM VM**:

```
Internet ─> Cloudflare (DNS, proxy, TLS) ─> OCI VM
                                            ├─ Caddy  :80/:443  (auto-TLS, reverse proxy)
                                            ├─ Relay  :3000     (Docker, internal)
                                            └─ Mongo  :27017    (Docker, internal)
Nightly cron: mongodump ─> Cloudflare R2 (backups)
```

> **Note:** R2 is object storage — it hosts *backups*, not the live database.
> MongoDB runs in Docker on the VM (replica set, transactions work like Atlas).
> If you later want a managed DB, point `MONGODB_URI` at Atlas and delete the
> mongo services.

---

## 1 · Create the OCI VM (Always Free)

1. Console → Compute → Instances → Create.
2. Shape: **Ampere A1 (ARM)**, **2 OCPU / 12 GB** (free tier allows 4/24 total).
3. OS: **Ubuntu 22.04+ (aarch64)**.
4. Add your SSH key. Create, note the **Public IP**.
5. In the instance's **VCN → Security List**, add ingress rules:
   - TCP **80** and **443** from `0.0.0.0/0`
   - **Nothing else** (especially not 27017 or 3000).

## 2 · Cloudflare DNS

1. Add your domain (or use an existing zone).
2. **A record**: `relay.yourdomain.com` → VM public IP.
   - Start with **DNS only** (grey cloud) for the simplest TLS path.
   - Orange-cloud proxy also works: traffic is then protected/accelerated by
     Cloudflare, and Caddy still terminates TLS. With proxy on, set SSL/TLS
     mode to **Full (strict)**.
3. Optional (only if you enable the DNS-01 challenge in the Caddyfile):
   create an API token (Zone → DNS → Edit) and put it in `.env.prod` as
   `CF_DNS_API_TOKEN`.

## 3 · Prepare the VM

```bash
ssh ubuntu@<VM_PUBLIC_IP>

# Docker + awscli (for R2 backups)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
sudo apt-get update && sudo apt-get install -y awscli
# Re-login so the docker group applies:
exit
```

OCI ships Ubuntu images with iptables rules in `/etc/iptables/rules.v4` that
**ignore** the cloud security list — close the loop on the host firewall too:

```bash
# Confirm 80/443 pass; everything else stays closed.
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 4 · Ship the code

```bash
# From your machine (or git clone on the VM):
rsync -av --exclude node_modules --exclude dist --exclude data \
  ./relay/ ubuntu@<VM_PUBLIC_IP>:/opt/relay/
```

## 5 · Configure and start

```bash
cd /opt/relay
cp .env.prod.example .env.prod
chmod 600 .env.prod
nano .env.prod        # DOMAIN, ADMIN_TOKEN, bootstrap admin, Resend keys...

docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f docker-compose.prod.yml logs -f app   # wait for "listening"
```

First start: Caddy obtains a certificate for `$DOMAIN`, Mongo initializes as
a single-node replica set, the app connects, seeds nothing (`SEED_DEMO=false`),
and bootstraps the admin account from `BOOTSTRAP_ADMIN_*`.

**Verify:**

```bash
curl -s https://relay.yourdomain.com/api/health
# {"status":"ok","mode":"demo"...}   (mode=live when CODEBUDDY_LIVE=true)
```

Then open `https://relay.yourdomain.com` → landing page, `/app` → sign in with
the bootstrap admin.

## 6 · Nightly backups to Cloudflare R2

1. Cloudflare dashboard → **R2** → Create bucket `relay-backups`.
2. R2 → **Manage API tokens** → create token with Object Read+Write scoped to
   the bucket. Note the Access Key ID, Secret, and the S3 endpoint
   (`https://<accountid>.r2.cloudflarestorage.com`).
3. On the VM:

```bash
cat > /opt/relay/.env.r2 <<'EOF'
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
R2_BUCKET=relay-backups
MONGODB_DB=relay
EOF
chmod 600 /opt/relay/.env.r2
chmod +x /opt/relay/scripts/backup-r2.sh /opt/relay/scripts/restore-r2.sh

# Test once:
/opt/relay/scripts/backup-r2.sh

# Schedule nightly 03:00:
( crontab -l 2>/dev/null; echo '0 3 * * * /opt/relay/scripts/backup-r2.sh >> /var/log/relay-backup.log 2>&1' ) | crontab -
```

4. In the R2 bucket settings, add a **lifecycle rule**: prefix `mongo/`,
   expire after 30 days — backups prune themselves.

**Restore** (also see `scripts/restore-r2.sh`):

```bash
/opt/relay/scripts/restore-r2.sh                 # latest backup
/opt/relay/scripts/restore-r2.sh mongo/relay-2026-09-22_030000.archive.gz
```

## 7 · Operations runbook

```bash
cd /opt/relay

# Status / logs
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f app

# Deploy a new version
rsync (or git pull) …
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

# Restart cleanly
docker compose -f docker-compose.prod.yml restart app

# Mongo shell
docker compose -f docker-compose.prod.yml exec mongo mongosh relay
```

## 8 · Hardening checklist (do these before sharing the URL)

- [ ] `ADMIN_TOKEN` is a fresh `openssl rand -hex 32`
- [ ] `BOOTSTRAP_ADMIN_PASSWORD` is unique and 12+ chars
- [ ] `SEED_DEMO=false` (no sample conversations in production)
- [ ] `DOMAIN` is set (the compose file adds it to `ALLOWED_HOSTS`) — without
      it every public request gets `403 Forbidden host`
- [ ] VM security list exposes **only** 80/443
- [ ] `https://yourdomain/api/health` returns `status:"ok"`
- [ ] First login works, then invite real agents via Settings
- [ ] Test a backup **and** a restore once
- [ ] Resend: verify your sending domain, then set `NOTIFY_FROM_EMAIL`
- [ ] Optional: Cloudflare Access in front of `/app` for IP-independent 2FA
- [ ] Optional: swap DNS-01 challenge on so certs renew even behind strict proxies

## Free-tier budget

| Resource | Always Free allowance | This deployment |
|---|---|---|
| Ampere A1 ARM | 4 OCPU / 24 GB RAM | 2 OCPU / 12 GB |
| Boot volume | 200 GB total | ~50 GB |
| Egress | 10 TB/mo | support traffic, well under |
| Cloudflare DNS/proxy | free plan | free |
| R2 | 10 GB storage + 1M Class-A ops/mo | nightly ~1 MB dumps, free |
