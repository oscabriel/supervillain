# Production apex operations

This directory is the repository implementation of the one-box posture from issues #30/#40 and the web deployment in #108. One Hostinger Ubuntu 24.04 x86_64 KVM box answers:

- TCP 22: `sv-gateway` (the player SSH door)
- TCP 80/443: Caddy (canonical redirect, web, and the Host pipe)
- TCP 22022: administrative `sshd`
- loopback 3000: `sv-web`
- loopback 3001: the gateway Host pipe after Caddy terminates TLS

There is no iroh/UDP rule. ADR-0012 removed that transport after #40 was written. There is also no web source change here: #103 owns the store, #104 the publish API, and #106 the app logger fence. This deployment reserves their operated paths and validates that a capability canary appears in neither the Caddy access log nor the app journal.

## Durable layout and backup boundary

```text
/var/lib/supervillain/
  gateway/
    identity.json
    registry.db
    ssh_host_ed25519_key
  web/
    store.db
    snapshots/
    og/
  litestream/                 # local replication metadata

/etc/supervillain/
  web-token-key               # 32 bytes, mode 0600, NOT in either backup
  web.env
  litestream.env
  restic.env
```

Litestream 0.5.15 watches `*.db` recursively under the durable root, so it covers both `gateway/registry.db` and `web/store.db`; each replica keeps the relative path below `${LITESTREAM_REPLICA_URL}/sqlite`. Restic nightly stages the complete durable tree and `/var/lib/caddy`, replacing every live SQLite file with `sqlite3 .backup` output before snapshotting. Retention is 7 daily, 4 weekly, and 6 monthly snapshots. A healthchecks.io success ping is sent only after backup and pruning succeed.

The web token key is deliberately outside `/var/lib/supervillain` and the Caddy cache. A database replica contains seeds and hashes; the separately escrowed key reconstructs tokens. Neither half may enter the other's backup set (ADR-0022).

The deployed `web.env` exposes #103's public configuration contract and nothing more:

```text
SUPERVILLAIN_WEB_STATE_ROOT=/var/lib/supervillain/web
SUPERVILLAIN_WEB_TOKEN_KEY_PATH=/etc/supervillain/web-token-key
```

The application derives `store.db` and `snapshots/` beneath the state root. Litestream therefore continues to replicate `/var/lib/supervillain/web/store.db`. `/var/lib/supervillain/web/og` is an operated future directory; this deployment does not claim the application consumes a separate OG environment variable. The watcher starts safely if the backend DB is absent and picks it up when #103 creates it.

## First provisioning

1. Buy the smallest Hostinger KVM VPS in US East, install Ubuntu 24.04 x86_64, and point the apex plus `www` A/AAAA records at it.
2. Add the cloud-init administrative public key. Open the Hostinger browser console, log in, and prove it can recover the box. This is a required manual gate, not a checkbox Ansible can infer.
3. Create a dedicated deploy ed25519 key and keep its private half out of the admin account:

   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/supervillain-deploy -C github-actions-deploy
   cp infra/inventory/production.example.yml infra/inventory/production.yml
   cp infra/secrets/litestream.env.example infra/secrets/litestream.env
   cp infra/secrets/restic.env.example infra/secrets/restic.env
   chmod 0600 infra/secrets/*.env
   set -a
   . infra/secrets/restic.env
   set +a
   restic snapshots >/dev/null 2>&1 || restic init
   ```

   Fill the inventory host/admin user, the deploy **public** key, and every secret placeholder before initializing restic. Configure the Litestream bucket credentials without delete permission and configure provider lifecycle retention, because `retention.enabled` is false.

4. Run the repository-only gate, then bootstrap over the cloud-init SSH port. The explicit boolean records that step 2 really happened:

   ```sh
   sh infra/scripts/validate-local
   ANSIBLE_CONFIG=infra/ansible.cfg ansible-playbook \
     -i infra/inventory/production.yml infra/playbooks/provision.yml \
     -e ansible_port=22 \
     -e sv_break_glass_console_verified=true
   ```

   `ansible_user` in the ignored production inventory is the bootstrap/admin account; it remains the monthly operator account. The play opens and verifies `sv_admin_ssh_port` from `inventory/group_vars/all.yml` before the gateway is ever allowed to own 22. Subsequent operator runs use that same inventory without the port override. The `deploy` account cannot provision the box; its key has OpenSSH `restrict`, and its sudo policy names only the two exact unit restart commands.

5. Run the `Deploy production` workflow with `all`. Then run on the box:

   ```sh
   sudo /usr/local/libexec/supervillain/validate-live supervillain.app
   ```

   This probes the 302, TLS apex, loopback binds, public ports, Caddy redaction, and app-journal redaction.

All host mutation is through `provision.yml` or `deploy.yml`; do not hand-edit the installed copies. A monthly ops pass reruns `provision.yml`, reviews held Caddy/security upgrades, reboots only at a quiet time, and inspects `sv-litestream` and `sv-restic-backup` journals.

## CI deployment and rollback

The protected GitHub `production` environment needs:

- `DEPLOY_HOST`: apex IP or hostname
- `DEPLOY_SSH_KEY`: dedicated deploy private key
- `DEPLOY_KNOWN_HOSTS`: pinned `[host]:<sv_admin_ssh_port>` known-hosts line

Generate the line from the same committed port contract, verify its fingerprint through the Hostinger console, then store it as the secret:

```sh
admin_port=$(awk '$1 == "sv_admin_ssh_port:" { print $2 }' \
  infra/inventory/group_vars/all.yml)
ssh-keyscan -p "$admin_port" "$DEPLOY_HOST"
```

`.github/workflows/deploy.yml` runs on `deploy-*` tags or manually with `gateway`, `web`, or `all`. It builds and smokes before materializing SSH credentials. Both artifacts use the same parameterized playbook and immutable layout:

```text
/opt/supervillain/releases/<git-sha>/gateway/supervillain
/opt/supervillain/releases/<git-sha>/web/.output/...
/opt/supervillain/current/gateway -> the selected gateway release
/opt/supervillain/current/web     -> the selected web release
```

Only the selected unit restarts. In particular, a web deploy never severs live player SSH sessions. A failed health probe restores that component's previous symlink. Five releases per component (current plus four prior) are retained. Rollback is the same deliberate action as deploy: dispatch the workflow from the previous Git SHA and select the affected component.

The web unit runs the built output with `/opt/bun/bin/bun .output/server/index.mjs`. systemd sends ordinary SIGTERM and waits 30 seconds; the load-bearing Nitro shutdown plugin drains and exits zero. Verify the installed behavior without inventing an `ExecStop`:

```sh
before=$(systemctl show -p MainPID --value sv-web)
sudo systemctl restart sv-web
sudo journalctl -u sv-web --since '1 minute ago' --no-pager
systemctl is-active --quiet sv-web
[ "$(systemctl show -p MainPID --value sv-web)" != "$before" ]
```

The repository production-output smoke (`bun run test:web`) is the exact exit-zero SIGTERM assertion and is a deploy gate.

## Precious-key escrow

The gateway SSH host key and web token key are generated once and must survive rebuilds. Encrypt them separately from both backup repositories. From a secure operator shell with a configured GPG recipient:

```sh
umask 077
ESCROW_RECIPIENT='YOUR_GPG_RECIPIENT'
sudo cat /var/lib/supervillain/gateway/ssh_host_ed25519_key |
  gpg --batch --yes --encrypt --recipient "$ESCROW_RECIPIENT" \
    > gateway-ssh-host-key.gpg
sudo cat /etc/supervillain/web-token-key |
  gpg --batch --yes --encrypt --recipient "$ESCROW_RECIPIENT" \
    > web-token-key.gpg
sudo sh -c 'test "$(wc -c </etc/supervillain/web-token-key)" -eq 32'
sha256sum gateway-ssh-host-key.gpg web-token-key.gpg
```

Move the encrypted files and their checksums into the operator password manager, remove the local copies, and perform a decrypt-and-byte-compare on a separate machine. Never paste the plaintext key into an issue, CI log, shell argument, or backup environment file.

## Scratch restore drill (required before claiming verification)

A backup is not verified by config review. On a disposable Ubuntu 24.04 x86_64 box, with copies of the ignored environment files and the encrypted escrow:

1. Provision the scratch box with the same playbook (using its own admin IP; do not move production DNS).
2. Export the Litestream/restic environment and run the non-destructive pull:

   ```sh
   set -a
   . infra/secrets/litestream.env
   . infra/secrets/restic.env
   set +a
   rm -rf /tmp/sv-restore-drill
   infra/scripts/restore-drill /tmp/sv-restore-drill
   ```

3. Stop all consumers and install the restored tree. Restic supplies files and Caddy state; the latest Litestream copies replace the belt-and-braces DBs:

   ```sh
   sudo systemctl stop caddy sv-web sv-gateway sv-litestream
   sudo rsync -a /tmp/sv-restore-drill/restic/var/lib/supervillain/ \
     /var/lib/supervillain/
   sudo rsync -a /tmp/sv-restore-drill/restic/var/lib/caddy/ /var/lib/caddy/
   # Scratch-box numeric UIDs are not a restore contract; reset named owners.
   sudo chown -R sv-gateway:sv-gateway /var/lib/supervillain/gateway
   sudo chown -R sv-web:sv-web /var/lib/supervillain/web
   sudo chown -R sv-litestream:sv-litestream /var/lib/supervillain/litestream
   sudo chown -R caddy:caddy /var/lib/caddy
   sudo install -o sv-gateway -g sv-gateway -m 0660 \
     /tmp/sv-restore-drill/litestream/gateway-registry.db \
     /var/lib/supervillain/gateway/registry.db
   sudo install -o sv-web -g sv-web -m 0660 \
     /tmp/sv-restore-drill/litestream/web-store.db \
     /var/lib/supervillain/web/store.db
   ```

4. Decrypt the two escrow files, install them at their exact paths/modes, and compare the gateway public host-key fingerprint with production's recorded fingerprint:

   ```sh
   umask 077
   gpg --decrypt gateway-ssh-host-key.gpg >/tmp/gateway-host-key
   gpg --decrypt web-token-key.gpg >/tmp/web-token-key
   sudo install -o sv-gateway -g sv-gateway -m 0600 /tmp/gateway-host-key \
     /var/lib/supervillain/gateway/ssh_host_ed25519_key
   sudo install -o sv-web -g sv-web -m 0600 /tmp/web-token-key \
     /etc/supervillain/web-token-key
   sudo ssh-keygen -lf /var/lib/supervillain/gateway/ssh_host_ed25519_key
   sudo sh -c 'test "$(wc -c </etc/supervillain/web-token-key)" -eq 32'
   shred -u /tmp/gateway-host-key /tmp/web-token-key
   ```

5. Add the scratch IP for `supervillain.app` and `www.supervillain.app` to the scratch box's `/etc/hosts`. The restored Caddy cache supplies the still-valid certificate without changing DNS. Start all four units and run `validate-live` locally.
6. Prove kill-and-restore rather than only first restore: stop `sv-web`, `sv-gateway`, and `sv-litestream`; remove **only the two scratch DB files**; run `rm -rf /tmp/sv-restore-drill-kill && infra/scripts/restore-drill /tmp/sv-restore-drill-kill`; install its two Litestream DBs with the same `install` commands from step 3; restart; run `PRAGMA integrity_check` and `validate-live` again.
7. Verify one known room registration, one known artifact page, its OG child, and `publish list` recovery. The last check proves the separately escrowed token key, not merely database reads.
8. Destroy the scratch box and the plaintext restore directory.

Record the date, box, object-store destination, restored transaction/snapshot IDs, host-key fingerprint match, known artifact checks, and failures in a new `.agents/benchmarks/` restore-drill document. Until this checklist has run with live credentials, say **repository artifacts/local gates verified; apex and restore drill not verified**.
