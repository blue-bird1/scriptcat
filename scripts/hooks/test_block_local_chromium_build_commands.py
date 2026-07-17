from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

HOOK_PATH = Path(__file__).with_name("block-local-chromium-build-commands.py")
SPEC = importlib.util.spec_from_file_location("chromium_build_guard", HOOK_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load Chromium build guard from {HOOK_PATH}")
BUILD_GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD_GUARD)

REMOTE_WRAPPER = (
    "uv run --project scripts --python 3.12 python scripts/remote/provider/build.py"
)
READ_ONLY_COMMANDS = (
    "gclient revinfo",
    "gclient status",
    "gn desc out/Release //chrome",
    "gn args out/Release --list",
    "ninja -C out/Release -t targets",
    "ninja -n -t targets",
    "ninja -t targets --dry-run",
    "autoninja -C out/Release -n chrome",
)
FORBIDDEN_COMMANDS = (
    "gclient sync",
    "gn --root . gen out/Release",
    "gn clean out/Release",
    "gn args out/Release",
    "ninja -C out/Release chrome",
    "ninja -n -t recompact",
    "ninja -t recompact -n",
    "ninja --dry-run -t restat",
    "ninja -t restat --dry-run",
    "env -C out/Release ninja chrome",
    "env --chdir=out/Release ninja chrome",
    "nice -n 10 ninja -C out/Release chrome",
    "time -p ninja -C out/Release chrome",
    "ssh build-host 'ninja -C out/Release chrome'",
    'ssh -p 22 build-host "gn gen out/Release"',
    "bash -s <<'SCRIPT'\nninja -C out/Release chrome\nSCRIPT",
    "ssh build-host bash -s <<'SCRIPT'\nninja -C out/Release chrome\nSCRIPT",
)


class ChromiumBuildGuardTests(unittest.TestCase):
    def test_allows_remote_wrapper(self) -> None:
        self.assertFalse(BUILD_GUARD.is_blocked(REMOTE_WRAPPER))

    def test_allows_read_only_checks(self) -> None:
        for command in READ_ONLY_COMMANDS:
            with self.subTest(command=command):
                self.assertFalse(BUILD_GUARD.is_blocked(command))

    def test_blocks_local_and_bare_ssh_builds(self) -> None:
        for command in FORBIDDEN_COMMANDS:
            with self.subTest(command=command):
                self.assertTrue(BUILD_GUARD.is_blocked(command))

    def test_blocks_unparseable_shell_input(self) -> None:
        self.assertTrue(BUILD_GUARD.is_blocked("ninja '"))


if __name__ == "__main__":
    unittest.main()
