from __future__ import annotations

import configparser
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INFRA = ROOT / "infra"


def text(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


class DeployArtifactTests(unittest.TestCase):
    def test_caddy_owns_apex_http_without_touching_ssh(self) -> None:
        caddy = text("infra/files/Caddyfile")
        self.assertIn("http://supervillain.app {", caddy)
        self.assertIn("redir https://supervillain.app{uri} 302", caddy)
        self.assertIn("supervillain.app {", caddy)
        self.assertIn("reverse_proxy @gateway_pipe 127.0.0.1:3001", caddy)
        self.assertIn("reverse_proxy 127.0.0.1:3000", caddy)
        self.assertEqual(caddy.count("import supervillain_access_log"), 4)
        self.assertNotRegex(caddy, r"(?m)^\s*:22\b")

    def test_caddy_redacts_every_capability_shape_and_referer(self) -> None:
        caddy = text("infra/files/Caddyfile")
        self.assertIn("request>uri regexp ^/a/.*$ /a/REDACTED", caddy)
        self.assertIn("request>headers>Referer delete", caddy)
        self.assertNotIn("log_skip", caddy)
        pattern = re.compile(r"^/a/.*$")
        for uri in (
            "/a/token",
            "/a/token/og.png",
            "/a/not-even-valid?from=test",
        ):
            self.assertEqual(pattern.sub("/a/REDACTED", uri), "/a/REDACTED")
        self.assertEqual(pattern.sub("/docs", "/docs"), "/docs")

    def test_web_unit_runs_built_bun_output_and_sends_sigterm(self) -> None:
        unit = text("infra/files/sv-web.service")
        self.assertIn("ExecStart=/opt/bun/bin/bun .output/server/index.mjs", unit)
        self.assertIn("WorkingDirectory=/opt/supervillain/current/web", unit)
        self.assertIn("Environment=HOST=127.0.0.1", unit)
        self.assertIn("Environment=PORT=3000", unit)
        self.assertIn("KillSignal=SIGTERM", unit)
        self.assertIn("KillMode=control-group", unit)
        self.assertIn("TimeoutStopSec=30s", unit)
        self.assertNotIn("ExecStop=", unit)
        self.assertNotIn("ExecStartPre=+", unit)
        self.assertIn("Requires=sv-web-key.service", unit)
        self.assertIn("ReadWritePaths=/var/lib/supervillain/web", unit)
        self.assertIn("ReadOnlyPaths=/etc/supervillain/web-token-key", unit)
        self.assertIn("UMask=0007", unit)
        key_script = text("infra/scripts/ensure-web-token-key")
        self.assertIn("key=/etc/supervillain/web-token-key", key_script)
        key_unit = text("infra/files/sv-web-key.service")
        self.assertIn("ExecStart=/usr/local/libexec/supervillain/ensure-web-token-key", key_unit)
        self.assertIn("ReadWritePaths=/etc/supervillain", key_unit)

    def test_gateway_keeps_public_22_and_loopback_pipe_defaults(self) -> None:
        unit = text("infra/files/sv-gateway.service")
        self.assertIn("--ssh-port 22", unit)
        self.assertIn("--broker-port 3001", unit)
        self.assertIn("--broker-url wss://supervillain.app", unit)
        self.assertNotIn("--bind", unit)
        self.assertIn("SUPERVILLAIN_GATEWAY_TLS=terminated-upstream", unit)
        self.assertIn("AmbientCapabilities=CAP_NET_BIND_SERVICE", unit)
        self.assertIn("KillSignal=SIGTERM", unit)
        self.assertIn("UMask=0007", unit)

    def test_operated_tree_and_separate_token_key_are_provisioned(self) -> None:
        tasks = text("infra/roles/apex/tasks/main.yml")
        for path in (
            "/var/lib/supervillain/gateway",
            "/var/lib/supervillain/web/snapshots",
            "/var/lib/supervillain/web/og",
            "/var/lib/supervillain/litestream",
        ):
            self.assertIn(path, tasks)
        self.assertIn('mode: "3770"', tasks)
        self.assertIn(
            "SUPERVILLAIN_WEB_STATE_ROOT=/var/lib/supervillain/web", tasks
        )
        self.assertIn(
            "SUPERVILLAIN_WEB_TOKEN_KEY_PATH=/etc/supervillain/web-token-key", tasks
        )
        self.assertEqual(tasks.count("SUPERVILLAIN_WEB_"), 2)
        self.assertIn('content: "restrict {{ sv_deploy_authorized_key }}', tasks)
        self.assertIn("line: IPV6=yes", tasks)
        self.assertIn("name: litestream.service", tasks)
        port_vars = text("infra/inventory/group_vars/all.yml")
        self.assertIn("sv_admin_ssh_port: 22022", port_vars)
        sshd = text("infra/files/sshd-supervillain.conf.j2")
        self.assertIn("Port {{ sv_admin_ssh_port }}", sshd)
        self.assertNotIn(
            "/var/lib/supervillain/web-token-key",
            tasks,
            "the reconstruction key must be outside both backup roots",
        )

    def test_litestream_watches_both_store_locations(self) -> None:
        config = text("infra/files/litestream.yml")
        self.assertIn("dir: /var/lib/supervillain", config)
        self.assertIn('pattern: "*.db"', config)
        self.assertIn("recursive: true", config)
        self.assertIn("watch: true", config)
        self.assertIn("${LITESTREAM_REPLICA_URL}/sqlite", config)
        restore = text("infra/scripts/restore-drill")
        self.assertIn('"$replica/gateway/registry.db"', restore)
        self.assertIn('"$replica/web/store.db"', restore)

    def test_restic_stages_full_tree_with_sqlite_safe_copies(self) -> None:
        backup = text("infra/scripts/restic-backup")
        self.assertIn("rsync -a", backup)
        self.assertIn('"$state/" "$stage/var/lib/supervillain/"', backup)
        self.assertIn('"$caddy/" "$stage/var/lib/caddy/"', backup)
        self.assertIn(".backup '$target'", backup)
        self.assertIn("PRAGMA quick_check;", backup)
        self.assertIn("--group-by host,tags", backup)
        self.assertIn("--keep-daily 7", backup)
        self.assertIn("--keep-weekly 4", backup)
        self.assertIn("--keep-monthly 6", backup)
        self.assertIn('if [ -e "$stage/etc/supervillain/web-token-key" ]', backup)
        self.assertNotIn("state=/etc/supervillain", backup)

    def test_one_deploy_playbook_serves_both_components(self) -> None:
        playbook = text("infra/playbooks/deploy.yml")
        self.assertIn("gateway:", playbook)
        self.assertIn("web:", playbook)
        self.assertIn("/releases/{{ sv_release_sha }}/{{ sv_deployable }}", playbook)
        self.assertIn("systemctl restart {{ sv_spec.service }}", playbook)
        self.assertNotIn("systemctl restart sv-*", playbook)
        workflow = text(".github/workflows/deploy.yml")
        self.assertEqual(workflow.count("infra/playbooks/deploy.yml"), 2)
        self.assertIn("cancel-in-progress: false", workflow)
        self.assertIn("environment: production", workflow)

    def test_live_validation_checks_edge_and_app_log_fences(self) -> None:
        validation = text("infra/scripts/validate-live")
        self.assertIn("journalctl", validation)
        self.assertIn("-u sv-web -u caddy", validation)
        self.assertIn("supervillain-access.log", validation)
        self.assertIn("/a/REDACTED", validation)
        self.assertIn("HTTP/[^ ]+ 302", validation)
        self.assertIn('admin_port=$(cat /etc/supervillain/admin-ssh-port)', validation)
        self.assertIn('[ "$capability_status" = 404 ]', validation)

    def test_units_retain_the_hardening_floor(self) -> None:
        for name in (
            "sv-gateway.service",
            "sv-web-key.service",
            "sv-web.service",
            "sv-litestream.service",
            "sv-restic-backup.service",
        ):
            parser = configparser.ConfigParser(interpolation=None, strict=False)
            parser.read_string(text(f"infra/files/{name}"))
            service = parser["Service"]
            self.assertEqual(service.get("NoNewPrivileges"), "true", name)
            self.assertEqual(service.get("ProtectSystem"), "strict", name)
            self.assertEqual(service.get("ProtectHome"), "true", name)
        litestream = text("infra/files/sv-litestream.service")
        self.assertIn("UMask=0007", litestream)


if __name__ == "__main__":
    unittest.main()
