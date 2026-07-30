from __future__ import annotations

import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from scripts.mcp import _activation, install
from scripts.mcp._common import WorkflowError
from scripts.mcp._control import (
    BrokerReleaseHandoff,
    McpInvocation,
)
from scripts.mcp.tests._fixtures import (
    ReleaseFixture,
    clone_release,
    create_release_fixture,
    link_targets,
)

FAKE_HANDOFF = """\
import json
import os
import sys
import time
from pathlib import Path

mode = os.environ["FAKE_HANDOFF_MODE"]
log = Path(os.environ["FAKE_HANDOFF_LOG"])
data_root = Path(os.environ["FAKE_HANDOFF_DATA_ROOT"])

def record(payload):
    with log.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(payload, sort_keys=True) + "\\n")

action = sys.argv[2] if len(sys.argv) > 2 else ""
record({"event": "command", "action": action, "argv": sys.argv[1:]})
if action == "--help":
    if mode == "legacy":
        print("Legacy Chrome DevTools MCP")
    elif mode == "unsupported":
        print("chrome-devtools-mcp shared status")
    else:
        print("chrome-devtools-mcp shared handoff")
    raise SystemExit(0)
if action == "status":
    if mode == "absent":
        print("Shared browser broker is not running.", file=sys.stderr)
        raise SystemExit(1)
    status = {
        "brokerPid": 123,
        "browserCount": 1,
        "clientCount": 0,
        "configDigest": "digest",
        "protocolVersion": 2,
    }
    if mode != "unsupported":
        status["handoffActive"] = False
    print(json.dumps(status))
    raise SystemExit(0)
if action != "handoff":
    raise SystemExit(2)
if mode == "active":
    print("ACTIVE_CLIENTS: Refusing handoff with 1 active client(s).", file=sys.stderr)
    raise SystemExit(1)
if mode == "slow":
    time.sleep(10)
print(json.dumps({
    "state": "ready",
    "status": {
        "brokerPid": 123,
        "browserCount": 0,
        "clientCount": 0,
        "configDigest": "digest",
        "handoffActive": True,
        "protocolVersion": 2,
    },
}), flush=True)
decision = sys.stdin.readline().strip()
record({
    "event": "decision",
    "decision": decision,
    "current": str((data_root / "current").resolve()),
    "journal": (data_root / "activation-journal.json").exists(),
})
if decision == "abort":
    print(json.dumps({"state": "aborted"}))
    raise SystemExit(0)
if mode == "commit-failure":
    print("COMMIT_FAILED: simulated failure", file=sys.stderr)
    raise SystemExit(1)
if decision == "commit":
    print(json.dumps({"state": "committed"}))
    raise SystemExit(0)
raise SystemExit(3)
"""


class InstallHandoffTest(unittest.TestCase):
    def test_install_commits_handoff_after_link_switch(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            old, new, data_root, old_installed, log = prepare_upgrade(root)
            write_config(root, data_root, log, mode="running")

            run_install(root, data_root, new)

            records = read_log(log)
            self.assertEqual(
                [
                    record["action"]
                    for record in records
                    if record["event"] == "command"
                ],
                ["--help", "status", "handoff"],
            )
            decision = next(
                record for record in records if record["event"] == "decision"
            )
            self.assertEqual(decision["decision"], "commit")
            self.assertEqual(
                decision["current"],
                str(data_root / "releases" / new.manifest.build_id),
            )
            self.assertTrue(decision["journal"])
            self.assertEqual(
                link_targets(data_root),
                (
                    str(data_root / "releases" / new.manifest.build_id),
                    str(old_installed),
                ),
            )
            self.assertEqual(old.manifest.build_id, old_installed.name)
            self.assertFalse((data_root / "activation-journal.json").exists())

    def test_missing_broker_does_not_block_activation(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            _, new, data_root, _, log = prepare_upgrade(root)
            write_config(root, data_root, log, mode="absent")

            run_install(root, data_root, new)

            self.assertEqual(
                [
                    record["action"]
                    for record in read_log(log)
                    if record["event"] == "command"
                ],
                ["--help", "status"],
            )
            self.assertEqual(
                (data_root / "current").resolve().name,
                new.manifest.build_id,
            )

    def test_true_legacy_runtime_skips_shared_control(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            _, new, data_root, _, log = prepare_upgrade(root)
            write_config(root, data_root, log, mode="legacy")

            run_install(root, data_root, new)

            self.assertEqual(
                [
                    record["action"]
                    for record in read_log(log)
                    if record["event"] == "command"
                ],
                ["--help"],
            )
            self.assertEqual(
                (data_root / "current").resolve().name,
                new.manifest.build_id,
            )

    def test_running_shared_runtime_without_handoff_aborts(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            _, new, data_root, old_installed, log = prepare_upgrade(root)
            write_config(root, data_root, log, mode="unsupported")

            with self.assertRaisesRegex(WorkflowError, "does not support atomic"):
                run_install(root, data_root, new)

            self.assertEqual((data_root / "current").resolve(), old_installed)
            self.assertTrue((data_root / "releases" / new.manifest.build_id).is_dir())
            self.assertEqual(
                [
                    record["action"]
                    for record in read_log(log)
                    if record["event"] == "command"
                ],
                ["--help", "status"],
            )

    def test_active_clients_abort_before_link_activation(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            _, new, data_root, old_installed, log = prepare_upgrade(root)
            write_config(root, data_root, log, mode="active")

            with self.assertRaisesRegex(WorkflowError, "ACTIVE_CLIENTS"):
                run_install(root, data_root, new)

            self.assertEqual((data_root / "current").resolve(), old_installed)
            self.assertFalse((data_root / "activation-journal.json").exists())

    def test_link_failure_aborts_handoff_and_restores_links(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            _, new, data_root, old_installed, log = prepare_upgrade(root)
            write_config(root, data_root, log, mode="running")
            real_replace = _activation.replace_symlink

            def fail_current(path: Path, target: str) -> None:
                if path.name == "current":
                    raise OSError("simulated link failure")
                real_replace(path, target)

            with (
                patch.object(_activation, "replace_symlink", side_effect=fail_current),
                self.assertRaisesRegex(OSError, "simulated link failure"),
            ):
                run_install(root, data_root, new)

            decision = next(
                record for record in read_log(log) if record["event"] == "decision"
            )
            self.assertEqual(decision["decision"], "abort")
            self.assertEqual((data_root / "current").resolve(), old_installed)
            self.assertFalse((data_root / "activation-journal.json").exists())

    def test_commit_failure_restores_links_without_stop_fallback(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            _, new, data_root, old_installed, log = prepare_upgrade(root)
            write_config(root, data_root, log, mode="commit-failure")

            with self.assertRaisesRegex(WorkflowError, "COMMIT_FAILED"):
                run_install(root, data_root, new)

            decision = next(
                record for record in read_log(log) if record["event"] == "decision"
            )
            self.assertEqual(decision["decision"], "commit")
            self.assertEqual((data_root / "current").resolve(), old_installed)
            self.assertFalse((data_root / "activation-journal.json").exists())
            self.assertFalse(
                any(record.get("action") == "stop" for record in read_log(log))
            )

    def test_ready_timeout_terminates_handoff_child(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            _, _, data_root, old_installed, log = prepare_upgrade(root)
            write_config(root, data_root, log, mode="slow")
            invocation = McpInvocation(
                command=sys.executable,
                args=(
                    str(old_installed / "mcp/bin/chrome-devtools-mcp.js"),
                    "shared",
                    "--headless",
                ),
                env={
                    "FAKE_HANDOFF_MODE": "slow",
                    "FAKE_HANDOFF_LOG": str(log),
                    "FAKE_HANDOFF_DATA_ROOT": str(data_root),
                },
                shared_index=1,
            )

            with (
                self.assertRaisesRegex(WorkflowError, "timed out"),
                BrokerReleaseHandoff(
                    invocation,
                    old_installed / "mcp/bin/chrome-devtools-mcp.js",
                    timeout_seconds=0.05,
                ),
            ):
                self.fail("slow handoff must not become ready")


def prepare_upgrade(
    root: Path,
) -> tuple[ReleaseFixture, ReleaseFixture, Path, Path, Path]:
    old = create_release_fixture(root / "old", payload=b"old\n")
    new = create_release_fixture(root / "new", payload=b"new\n")
    data_root = root / "data"
    releases = data_root / "releases"
    releases.mkdir(parents=True)
    old_installed = clone_release(
        old.release,
        releases / old.manifest.build_id,
    )
    entry = old_installed / "mcp/bin/chrome-devtools-mcp.js"
    entry.write_text(FAKE_HANDOFF, encoding="utf-8")
    (data_root / "current").symlink_to(old_installed)
    return old, new, data_root, old_installed, root / "handoff.jsonl"


def write_config(
    root: Path,
    data_root: Path,
    log: Path,
    *,
    mode: str,
) -> None:
    config = root / ".codex" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text(
        "[mcp_servers.chrome-devtools-scriptcat]\n"
        f"command = {json.dumps(sys.executable)}\n"
        "env = { "
        f"FAKE_HANDOFF_MODE = {json.dumps(mode)}, "
        f"FAKE_HANDOFF_LOG = {json.dumps(str(log))}, "
        f"FAKE_HANDOFF_DATA_ROOT = {json.dumps(str(data_root))} "
        "}\n"
        "args = [\n"
        '  "/configured/current/mcp/bin/chrome-devtools-mcp.js",\n'
        '  "shared",\n'
        '  "--headless",\n'
        '  "--user-data-dir=/profile",\n'
        "]\n",
        encoding="utf-8",
    )


def read_log(path: Path) -> list[dict[str, object]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line
    ]


def run_install(root: Path, data_root: Path, fixture: ReleaseFixture) -> None:
    with (
        patch.object(install, "repository_root", return_value=root),
        redirect_stdout(StringIO()),
    ):
        install.run(
            [
                str(fixture.archive),
                "--lock",
                str(fixture.lock),
                "--build-id",
                fixture.manifest.build_id,
                "--archive-sha256",
                fixture.archive_digest,
                "--data-root",
                str(data_root),
            ]
        )


if __name__ == "__main__":
    unittest.main()
