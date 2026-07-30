from __future__ import annotations

import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from scripts.mcp import install
from scripts.mcp._common import WorkflowError
from scripts.mcp.tests._fixtures import (
    ReleaseFixture,
    clone_release,
    create_release_fixture,
    link_targets,
)

SHARED_HELP = (
    "Usage:\n"
    "  chrome-devtools-mcp shared [MCP options]\n"
    "  chrome-devtools-mcp shared stop [--force] [MCP options]\n"
)


class InstallHandoffTest(unittest.TestCase):
    def test_install_stops_old_broker_after_materialization_before_switch(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            old, new, data_root, old_installed = prepare_upgrade(root)
            write_config(root)
            observed_stop = False

            def run_control(
                command: tuple[str, ...], **kwargs: object
            ) -> subprocess.CompletedProcess[str]:
                nonlocal observed_stop
                del kwargs
                if command[-1] == "--help":
                    return completed(command, stdout=SHARED_HELP)
                observed_stop = True
                self.assertEqual(
                    command,
                    (
                        "node",
                        str(old_installed / "mcp/bin/chrome-devtools-mcp.js"),
                        "shared",
                        "stop",
                        "--headless",
                        "--user-data-dir=/profile",
                    ),
                )
                self.assertTrue(
                    (data_root / "releases" / new.manifest.build_id).is_dir()
                )
                self.assertEqual((data_root / "current").resolve(), old_installed)
                return completed(command)

            with patch(
                "scripts.mcp._control.subprocess.run",
                side_effect=run_control,
            ):
                run_install(root, data_root, new)

            self.assertTrue(observed_stop)
            self.assertEqual(
                link_targets(data_root),
                (
                    str(data_root / "releases" / new.manifest.build_id),
                    str(old_installed),
                ),
            )
            self.assertEqual(old.manifest.build_id, old_installed.name)

    def test_missing_broker_does_not_block_activation(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            _, new, data_root, _ = prepare_upgrade(root)
            write_config(root)

            with patch(
                "scripts.mcp._control.subprocess.run",
                side_effect=(
                    completed((), stdout=SHARED_HELP),
                    completed(
                        (),
                        returncode=1,
                        stderr="Shared browser broker is not running.\n",
                    ),
                ),
            ):
                run_install(root, data_root, new)

            self.assertEqual(
                (data_root / "current").resolve().name,
                new.manifest.build_id,
            )

    def test_active_clients_abort_before_link_activation(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            _, new, data_root, old_installed = prepare_upgrade(root)
            write_config(root)
            before = link_targets(data_root)

            with (
                patch(
                    "scripts.mcp._control.subprocess.run",
                    side_effect=(
                        completed((), stdout=SHARED_HELP),
                        completed((), returncode=1, stderr="ACTIVE_CLIENTS\n"),
                    ),
                ),
                self.assertRaises(WorkflowError),
            ):
                run_install(root, data_root, new)

            self.assertEqual(link_targets(data_root), before)
            self.assertEqual((data_root / "current").resolve(), old_installed)
            self.assertTrue((data_root / "releases" / new.manifest.build_id).is_dir())

    def test_legacy_runtime_skips_shared_control(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            _, new, data_root, _ = prepare_upgrade(root)
            write_config(root)

            with patch(
                "scripts.mcp._control.subprocess.run",
                return_value=completed((), stdout="Chrome DevTools MCP\n"),
            ) as run_control:
                run_install(root, data_root, new)

            self.assertEqual(run_control.call_count, 1)
            self.assertEqual(
                (data_root / "current").resolve().name,
                new.manifest.build_id,
            )


def prepare_upgrade(
    root: Path,
) -> tuple[ReleaseFixture, ReleaseFixture, Path, Path]:
    old = create_release_fixture(root / "old", payload=b"old\n")
    new = create_release_fixture(root / "new", payload=b"new\n")
    data_root = root / "data"
    releases = data_root / "releases"
    releases.mkdir(parents=True)
    old_installed = clone_release(
        old.release,
        releases / old.manifest.build_id,
    )
    (data_root / "current").symlink_to(old_installed)
    return old, new, data_root, old_installed


def write_config(root: Path) -> None:
    config = root / ".codex" / "config.toml"
    config.parent.mkdir(parents=True)
    config.write_text(
        "[mcp_servers.chrome-devtools-scriptcat]\n"
        'command = "node"\n'
        "args = [\n"
        '  "/configured/current/mcp/bin/chrome-devtools-mcp.js",\n'
        '  "shared",\n'
        '  "--headless",\n'
        '  "--user-data-dir=/profile",\n'
        "]\n",
        encoding="utf-8",
    )


def completed(
    command: tuple[str, ...],
    *,
    returncode: int = 0,
    stdout: str = "",
    stderr: str = "",
) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        args=command,
        returncode=returncode,
        stdout=stdout,
        stderr=stderr,
    )


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
