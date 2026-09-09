# SmartChat — deploying to a VPS

Everything needed to take a fresh Linux server to a working SmartChat, in order, with the reason
for each step. Follow it top to bottom the first time; §8 onwards is what you come back for.

This is the file `DEPLOYMENT.md` refers to. `DEPLOYMENT.md` is the short version.

---

## 1. What you need before you start

**A server.** 2 vCPU and 4 GB of RAM runs the whole stack comfortably: Postgres, Redis, MinIO,
four Node services, the widget's static files and nginx. 2 GB works but leaves nothing for the
database's cache, and the compose file asks Postgres for 512 MB of shared buffers. **The AI agent
changes this**: its local models want ~5 GB of RAM and every CPU core you can give them (a reply
takes ~4 s on 8 cores of a current AMD EPYC, and scales down with fewer or older cores). 12 vCPU
and 16 GB is what it was measured on. Without that, set `AI_LOCAL_URL=` (empty), skip the `ai`
service, and let the console's fallback provider answer everything. Any current
Debian or Ubuntu LTS is fine. 20 GB of disk to begin with — transcripts and uploaded files are
what grow, so watch the volumes rather than the root filesystem.

**Four DNS records**, all A (and AAAA if you have IPv6) pointing at the server:

| Record | Serves |
| --- | --- |
| `app.example.com` | the dashboard, sign-in, and the public help centre |
| `api.example.com` | the HTTP API |
| `ws.example.com` | the realtime gateway (WebSocket) |
| `cdn.example.com` | `loader.js` and the widget panel |

Four rather than one, and specifically the widget on its own hostname: the widget runs inside
other people's web pages. Serving it from the dashboard's origin would put content those customers
control one same-origin bug away from a signed-in session. Separate origins mean the browser
enforces that boundary rather than us.

**Ports 80 and 443 open**, and nothing else. Postgres, Redis and MinIO are never published to the
host in production — the compose overlay does not map them, and they are reachable only on the
internal Docker network.

**An outbound mail path.** SMTP credentials from whoever sends your mail. Without one the product
still runs, but nobody can verify an email address, accept an invitation, or reset a password.

---

## 2. Prepare the server

```bash
# As root, on a fresh box.
apt update && apt upgrade -y
apt install -y ca-certificates curl git ufw

# Docker, from Docker's own repository rather than the distribution's.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# The firewall. SSH first, or you will lock yourself out.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

Run the application as a user that is not root:

```bash
adduser --disabled-password --gecos "" smartchat
usermod -aG docker smartchat
su - smartchat
```

Everything below runs as that user.

---

## 3. Get the code

```bash
git clone https://github.com/sabbir073/smartChat.git
cd smartChat
git checkout master
```

---

## 4. Write the environment

```bash
cp .env.example .env
chmod 600 .env
```

Then edit `.env`. The values that **must** change are below; anything not listed can stay.

### Generate real secrets

```bash
# Run each of these and paste the output into the matching variable.
openssl rand -hex 32   # VISITOR_TOKEN_SECRET
openssl rand -hex 32   # SETTINGS_ENCRYPTION_KEY
openssl rand -hex 24   # POSTGRES_PASSWORD
openssl rand -hex 24   # REDIS_PASSWORD
openssl rand -hex 24   # S3_SECRET_KEY
openssl rand -hex 24   # METRICS_TOKEN   (optional; see §9)
openssl rand -base64 18 # SUPERADMIN_PASSWORD
```

### The values to set

```ini
NODE_ENV=production
LOG_LEVEL=info

# Use the production overlay, not the development one.
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml

# Your four hostnames.
APP_HOST=app.example.com
API_HOST=api.example.com
WS_HOST=ws.example.com
CDN_HOST=cdn.example.com
CERTBOT_EMAIL=you@example.com

# The same hostnames again, as full URLs — this is what ends up in the browser.
APP_URL=https://app.example.com
API_URL=https://api.example.com
REALTIME_URL=https://ws.example.com
WIDGET_URL=https://cdn.example.com
PUBLIC_KB_URL=https://app.example.com/kb
CORS_DASHBOARD_ORIGINS=https://app.example.com

# Credentials. Paste the generated values; do not keep the ones from .env.example.
POSTGRES_PASSWORD=<generated>
DATABASE_URL=postgresql://smartchat:<generated>@postgres:5432/smartchat?schema=public
REDIS_PASSWORD=<generated>
REDIS_URL=redis://:<generated>@redis:6379/0
VISITOR_TOKEN_SECRET=<generated>
SETTINGS_ENCRYPTION_KEY=<generated>   # encrypts the Stripe keys entered in the console
S3_ACCESS_KEY=smartchat
S3_SECRET_KEY=<generated>
SUPERADMIN_EMAIL=you@example.com
SUPERADMIN_PASSWORD=<generated>

# Object storage. MinIO on this box by default; see §10 to use a hosted service instead.
S3_ENDPOINT=http://minio:9000
S3_PUBLIC_ENDPOINT=https://app.example.com/files   # only if you front MinIO; see §10

# What this deployment calls itself, in email subjects and body copy.
PRODUCT_NAME=Your Product

# Mail.
MAIL_DRIVER=smtp
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<username>
SMTP_PASSWORD=<password>
MAIL_FROM_ADDRESS=support@example.com
MAIL_FROM_NAME=Your Company
# Leave this true for a relay reachable over the internet. See §5a if you are relaying through a
# Postfix on this same machine.
SMTP_TLS_REJECT_UNAUTHORIZED=true

# The dashboard and the API are on different hosts, so the session and CSRF cookies need a
# domain that covers both. Without it sign-in returns 200, the dashboard never sees the session,
# and every attempt bounces back to the sign-in page with no error. Checked at boot.
COOKIE_DOMAIN=.example.com

# Behind the edge proxy, over TLS. Both of these are checked at boot.
TRUST_PROXY=true
COOKIE_SECURE=true
ALLOW_LOCALHOST_ORIGINS=false
AUTO_VERIFY_EMAIL=false
```

### 5a. Relaying through a Postfix on this same machine

A deployment with no third-party mail provider can relay through a Postfix running on the host,
reached from the containers at `host.docker.internal` (the compose overlay already maps it with
`extra_hosts`). Two things about that path are not obvious, and both of them stop mail completely
rather than degrading it.

**The certificate will not verify, and that is expected.** Postfix advertises STARTTLS with the
distribution's self-signed certificate, and nodemailer upgrades opportunistically even on port 25.
Verification then fails with `self-signed certificate` at `CONN`, every email job burns its five
attempts, and nothing is sent — while registration itself still returns success, so the only
symptom is people saying they never got the email. Either give Postfix a real certificate and
verify against its name:

```env
SMTP_HOST=host.docker.internal
SMTP_PORT=25
SMTP_TLS_SERVERNAME=mail.example.com
```

or, for a hop that never leaves this machine, waive verification for it:

```env
SMTP_HOST=host.docker.internal
SMTP_PORT=25
SMTP_TLS_REJECT_UNAUTHORIZED=false
```

`SMTP_TLS_REJECT_UNAUTHORIZED=false` is refused at boot in production unless `SMTP_HOST` is a
loopback, private-range or Docker-gateway address. Setting it for a relay on the internet would
hand every verification link and password reset to anything on the path, so the check exists to
make that impossible rather than merely inadvisable.

**Pin the host-gateway address in the Docker daemon.** `host-gateway` is resolved by the daemon
from the default bridge at startup, and a daemon that starts before `docker0` is up resolves it to
nothing — every container with `extra_hosts` then refuses to start with
`could not parse extra host IP invalid IP`, which reads like a compose-file problem and is not one.
It survives for as long as nobody restarts the daemon, which is to say until an unattended upgrade
does. Say it explicitly in `/etc/docker/daemon.json`:

```json
{ "host-gateway-ip": "172.17.0.1" }
```

then `sudo systemctl restart docker`. Confirm with
`docker run --rm --add-host=host.docker.internal:host-gateway alpine getent hosts host.docker.internal`.

**Postfix must trust the container networks.** `mynetworks` needs the Docker bridge ranges the
containers actually get — `172.17.0.0/16` and `172.18.0.0/16` on a default install — and not a
blanket `172.16.0.0/12`, which on a cloud VM can swallow the VCN's own subnet and turn the host
into an open relay for its neighbours. Confirm with
`docker compose exec api node -e "require('net').connect(25,'host.docker.internal').on('data',d=>{console.log(String(d));process.exit(0)})"`,
which should print Postfix's `220` banner.

Deliverability is a separate matter from delivery: SPF, DKIM and DMARC records, and a PTR record
for the sending IP, decide whether what you send lands in an inbox or a spam folder.

> **The services refuse to start if you get these wrong.** `NODE_ENV=production` turns on a set of
> checks in `packages/config`: any secret still carrying a value from `.env.example` — including
> the database password *inside* `DATABASE_URL` — and any of `COOKIE_SECURE`, `TRUST_PROXY`,
> `ALLOW_LOCALHOST_ORIGINS`, `ALLOW_PRIVATE_WEBHOOK_URLS` or `AUTO_VERIFY_EMAIL` set the wrong way
> stops the boot with a list of what is wrong. Each of those fails *silently* otherwise: a session
> cookie sent over plain HTTP, or a rate limiter that buckets the whole internet under nginx's own
> address, both look completely normal until the day they matter.

---

## 5. Certificates

nginx will not start without certificates, and certbot cannot get certificates without something
answering on port 80. Break the cycle by getting the certificates first, with a throwaway server:

```bash
# Outside the repository on purpose: certbot writes as root, and a git working tree is
# the wrong home for a private key.
sudo mkdir -p /opt/smartchat/tls/letsencrypt /opt/smartchat/tls/acme
sudo chown -R $USER:$USER /opt/smartchat/tls

# A bare nginx on :80 that serves only the ACME challenge directory.
docker run --rm -d --name acme -p 80:80 \
  -v "/opt/smartchat/tls/acme:/usr/share/nginx/html" \
  nginx:1.27-alpine

docker run --rm \
  -v "/opt/smartchat/tls/letsencrypt:/etc/letsencrypt" \
  -v "/opt/smartchat/tls/acme:/var/www/certbot" \
  certbot/certbot certonly --webroot -w /var/www/certbot \
  --non-interactive --agree-tos --email you@example.com \
  -d app.example.com -d api.example.com -d ws.example.com -d cdn.example.com

docker stop acme
```

Confirm all four are there — the edge will not start otherwise:

```bash
ls /opt/smartchat/tls/letsencrypt/live/
```

**Renewal.** Let's Encrypt certificates last 90 days. Add a cron entry as the `smartchat` user:

```bash
crontab -e
```

```cron
# Renew if within 30 days of expiry, then reload nginx so it picks up the new file.
# Twice daily at a random-ish minute, as Let's Encrypt asks.
17 3,15 * * * cd /home/smartchat/smartChat && docker compose --profile certs run --rm certbot renew --webroot -w /var/www/certbot --quiet && docker compose exec -T edge nginx -s reload
```

`certbot renew` is a no-op until a certificate is close to expiring, so running it twice a day
costs nothing and means a failed renewal has many chances to succeed before anything breaks.

---

## 6. First boot

```bash
# Build the images. Ten to fifteen minutes on a 2 vCPU box.
docker compose build

# Bring up the data layer first and let it become healthy.
docker compose up -d postgres redis minio minio-init
docker compose ps          # wait for postgres, redis and minio to read "healthy"

# Create the schema. A one-shot container that exits; the application services never
# migrate on boot, because a rolling deploy would have several of them racing.
docker compose run --rm migrate

# Create the platform administrator. Reads SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD from
# your .env, and refuses to run with the values .env.example ships.
docker compose run --rm -w /app/packages/database api ./node_modules/.bin/tsx prisma/seed.ts

# Everything else.
docker compose up -d
docker compose ps          # every service should read "healthy"
```

> With `NODE_ENV=production` the seed creates **only** the platform administrator. The demo
> account and demo website it creates locally are development fixtures — two users with a password
> published in this repository — and it skips them here rather than relying on you to delete them
> afterwards. It also refuses to start if `SUPERADMIN_EMAIL` or `SUPERADMIN_PASSWORD` is still the
> value from `.env.example`, or if the password is shorter than twelve characters.

### Visitor country data

Agents see a flag and a country beside each visitor. It comes from a table this deployment builds
itself, from the five regional internet registries' daily allocation files (ARIN, RIPE NCC, APNIC,
LACNIC, AFRINIC) — no vendor database, no API key, no per-lookup call. The worker fetches the five
files over https from `ftp.arin.net`, `ftp.ripe.net`, `ftp.apnic.net`, `ftp.lacnic.net` and
`ftp.afrinic.net`, so outbound access to those hosts is needed; ~40MB a day.

The worker queues the first load on its first start when the table is empty, and rebuilds daily at
05:30 UTC. The load is all-or-nothing: if any registry cannot be fetched, yesterday's data stays
and the console's Health tab says which registry failed. The same tab has a **Rebuild now** button.
Until the first load completes — a minute or two — visitors show without a country.

Country only. An IP address identifies a network, not a person, and a visitor on a VPN or a
corporate proxy shows the network's country. Nothing can do better than that, and this makes no
claim to.

### Payments

Plans, invoices and card payments run through Stripe, and every Stripe setting is entered in the
console rather than the environment - the only variable involved is `SETTINGS_ENCRYPTION_KEY`,
which encrypts the keys you paste. New accounts start on the free plan with no card; nothing
needs Stripe until somebody chooses a paid plan.

To switch it on: console → **Billing** → paste the publishable and secret keys (test keys first),
Save, **Test connection**. In Stripe, add a webhook endpoint for the URL the console shows
(`https://api.<your host>/api/v1/billing/webhooks/stripe`) with `checkout.session.completed`,
`customer.subscription.*` and `invoice.*`, and paste its signing secret. Then **Sync with Stripe**
so each priced plan gets its Stripe product and prices, and enable Stripe's customer portal so
"Manage payment method" has somewhere to go. `docs/BILLING.md` has the whole model, the lock
rules and what each webhook does.

### The AI agent

The `ai` service (Ollama) comes up with the rest of the stack and, on its first boot, downloads
the two models named in `.env` (`AI_CHAT_MODEL`, `AI_EMBED_MODEL`; ~3.5 GB) onto the
`ollama_models` volume before it reports healthy — `docker compose logs -f ai` shows the pull.
Nothing else is needed for local answering. Postgres is built from
`infrastructure/docker/postgres.Dockerfile` (the Alpine image plus pgvector), so the first deploy
with the AI agent rebuilds and recreates the database container: `docker compose build postgres
&& docker compose up -d postgres`, then `migrate` as usual. The data volume is untouched.

The `renderer` service (Chromium behind one endpoint, from `infrastructure/renderer`) reads
websites that are empty until their JavaScript runs. It needs `AI_RENDERER_TOKEN` in `.env` - a
shared secret between the worker and the renderer, any long random string
(`openssl rand -hex 32`) - and its image is built with the rest (`docker compose build renderer`;
the base image is ~2 GB on first pull). Set `AI_RENDERER_URL=` (empty) to run without it; such
pages are then skipped.

The fallback provider is optional and entered in the console → **AI**: choose OpenAI, DeepSeek or Anthropic,
paste the key (sealed with `SETTINGS_ENCRYPTION_KEY`, like Stripe's), **Test fallback**. The
worker starts using it within thirty seconds. `docs/AI_AGENT.md` has the routing rules, the
contract the model is held to, and what the privacy page needs to say.

---

## 7. Check it actually works

Not "the containers are up" — that is not the same thing.

```bash
# From the server: each service answers its own readiness probe.
docker compose exec api      wget -qO- http://127.0.0.1:3001/ready
docker compose exec realtime wget -qO- http://127.0.0.1:3002/ready
docker compose exec worker   wget -qO- http://127.0.0.1:3005/ready

# From your laptop: TLS, and the right certificate on each name.
for h in app api ws cdn; do
  echo "--- $h"
  curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' "https://$h.example.com/"
done

# The API answers in its own envelope, and says nothing about itself.
curl -sS https://api.example.com/api/v1/does-not-exist
# {"success":false,"error":{"code":"NOT_FOUND","message":"Not found", ...}}

# The health endpoints are NOT reachable from outside. This must be 404.
curl -sS -o /dev/null -w '%{http_code}\n' https://api.example.com/health

# An unknown hostname is hung up on rather than served the dashboard.
curl -sSk -o /dev/null -w '%{http_code}\n' --resolve nope.example.com:443:<server-ip> \
  https://nope.example.com/    # expect a connection reset, not a page
```

Then the real test: open `https://app.example.com`, create an account, add a website, copy the
snippet onto a page somewhere, and have a conversation with yourself in another browser. Nothing
below the surface is proven until a message has gone visitor → agent → visitor over a socket.

The full end-to-end suites can also be pointed at the deployment:

```bash
API_URL=https://api.example.com node scripts/qa-error-surface.mjs
```

---

## 8. Releasing a new version

```bash
cd /home/smartchat/smartChat
git pull origin master

# 1. Back up first, and confirm the file exists. Not optional — see §11.
./infrastructure/backup/backup.sh

# 2. Build the new images.
docker compose build

# 3. Migrate. Forward-only and additive; see DEPLOYMENT.md §4 for the rollback rules.
docker compose run --rm migrate

# 4. Swap the containers.
docker compose up -d

# 5. Confirm.
docker compose ps
docker compose exec api wget -qO- http://127.0.0.1:3001/ready
```

There is a short gap while each container restarts. For a deployment where that matters, run two
replicas of `api` and `web` behind the edge and restart them one at a time — the application is
stateless apart from Postgres and Redis, so nothing else has to change.

---

## 9. Logs, metrics and what to watch

```bash
docker compose logs -f api            # follow one service
docker compose logs --tail=200 worker # recent history
docker compose ps                     # health at a glance
```

Logs are structured JSON carrying a request id, and are capped at 20 MB × 5 files per service by
the production overlay, so they cannot fill the disk.

`/metrics` is Prometheus-compatible and **off unless `METRICS_TOKEN` is set** — with no token it
returns 404 and does not exist. That is deliberate: an open metrics endpoint tells a stranger how
many customers you have and whether your queues are backing up, and "we forgot to set a token" is
a far more common mistake than "we forgot to enable metrics". nginx refuses `/health`, `/ready`
and `/metrics` from outside regardless.

Worth an alert if you have somewhere to send one: `pendingWebhookDeliveries` and `queuedEmails`
climbing without falling means the worker is not running.

---

## 10. Object storage

MinIO on the same box is the default and is genuinely fine for a single-server deployment — the
data lives in the `minio_data` volume and is included in §11's backup.

Two things to know. First, uploaded files go to and come from browsers over **signed URLs pointing
at `S3_PUBLIC_ENDPOINT`**, so that hostname has to be reachable from a browser. The edge already
serves it for you: set `S3_PUBLIC_ENDPOINT=https://<CDN_HOST>/files` and the `/files/` path on the
CDN host is proxied to MinIO, with the prefix stripped, CORS answered for the app host, and the
body limit sized for `UPLOAD_MAX_BYTES`. (The signature is made over the path MinIO sees, without
the prefix, so nothing about the proxy has to be configured on the MinIO side.)

Second, if you would rather not run it: any S3-compatible service works. Set `S3_ENDPOINT`,
`S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY` and `S3_SECRET_KEY`, set
`S3_FORCE_PATH_STYLE=false` for AWS, and remove `minio` and `minio-init` from the compose command.
Nothing in the application knows the difference.

---

## 11. Backups

`docs/BACKUPS.md` has the full procedure. The short version, and the part that matters:

```bash
# Nightly, as the smartchat user.
crontab -e
```

```cron
30 2 * * * cd /home/smartchat/smartChat && ./infrastructure/backup/backup.sh >> /home/smartchat/backup.log 2>&1
```

Then **copy the backups off this server** — to object storage, another host, anywhere that is not
the disk you are protecting against losing. A backup that lives only on the machine it backs up is
not a backup.

And the rule this project holds to: *a backup that has never been restored is not considered
reliable.* `node scripts/restore-rehearsal.mjs` restores a real backup into a scratch database and
checks the data came back. Run it after any change to the schema, and on a schedule.

```bash
./infrastructure/backup/restore.sh <backup-file>   # the real thing, when you need it
```

---

## 12. When something is wrong

`docs/TROUBLESHOOTING.md` covers the application. The deployment-specific ones:

**A service restarts in a loop.** `docker compose logs <service>`. A configuration problem prints
`[config]` and a list of exactly what is wrong — that is the boot check from §4, and it is telling
you the truth.

**nginx will not start.** Almost always a missing certificate. `ls /opt/smartchat/tls/letsencrypt/live/`
should show all four hostnames. `docker compose exec edge nginx -t` checks the config itself.

**Signing in spins forever and says nothing.** The password was right — the browser kept the
session on the API's host and the dashboard cannot see it. `COOKIE_DOMAIN` has to cover both
`APP_URL` and `API_URL` (`.example.com` covers `example.com` and `api.example.com`). Production
refuses to start without it now, so this only appears on a deployment predating that check.

**The dashboard loads but nothing happens.** Open the browser console. A blocked request usually
means `API_URL` or `CORS_DASHBOARD_ORIGINS` does not match the hostname you actually browsed to.

**The widget does not appear on a customer's site.** The property's domain list is enforced: the
site's hostname has to be on it. A refused origin is deliberately indistinguishable from an unknown
property, so check the property's settings rather than the response.

**No email arrives.** `docker compose logs worker | grep smtp` first: the worker says at boot
whether the relay is reachable, and names the reason when it is not. Then
`docker compose logs worker` — every message is queued, so a per-message failure is a row and a
log line rather than a silence. `self-signed certificate` at `CONN` means the relay's certificate
did not verify; see §5a. Otherwise check the SMTP credentials and whether your provider requires
the `MAIL_FROM_ADDRESS` domain to be verified.

**Out of disk.** `docker system df`, then `docker image prune -a`. Old images from previous
releases are usually most of it.
