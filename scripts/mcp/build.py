#!/usr/bin/env -S uv run python
from __future__ import annotations

import argparse
import json
import logging
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from mcp._common import (
        WorkflowError,
        cli_main,
        exclusive_lock,
        git_output,
        local_build_root,
        repository_root,
        require_clean_main,
        require_commands,
    )
    from mcp._component import materialize_component, read_component
    from mcp._control import load_mcp_invocation
    from mcp._identity import component_build_id
    from mcp._lock import UpstreamLock, load_lock, validate_mcp_submodule
else:
    from ._common import (
        WorkflowError,
        cli_main,
        exclusive_lock,
        git_output,
        local_build_root,
        repository_root,
        require_clean_main,
        require_commands,
    )
    from ._component import materialize_component, read_component
    from ._control import load_mcp_invocation
    from ._identity import component_build_id
    from ._lock import UpstreamLock, load_lock, validate_mcp_submodule

LOCK_PATH = Path("browser/mcp.lock.json")
LOGGER = logging.getLogger("scriptcat.mcp")
SCRIPTCAT_EXTENSION_ID = "mihocogjodhedlmnebhfkiahldphcimj"
MCP_CONFIG_PATH = Path(".codex/config.toml")
SHARED_TEST_MANAGED_SCRIPTCAT_PATH = (
    Path.home() / ".local" / "share" / "scriptcat-extension" / "managed"
)
SHARED_TEST_MANAGED_SCRIPTCAT_MANIFEST_PATH = (
    SHARED_TEST_MANAGED_SCRIPTCAT_PATH / "manifest.json"
)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Build and focus-test the local MCP component.",
        epilog=(
            "Requires a clean main checkout, an initialized clean MCP submodule, "
            "the executable configured by --executable-path in .codex/config.toml, "
            f"and managed ScriptCat at {SHARED_TEST_MANAGED_SCRIPTCAT_PATH}. "
            "Publish ScriptCat with:\n"
            "  uv run --project scripts --python 3.12 python "
            "scripts/scriptcat/publish.py\n\n"
            "The build installs frozen pnpm dependencies, compiles, runs focused "
            "tests, bundles the candidate runtime, and executes the formal shared "
            "browser E2E with a temporary Chromium profile against that exact "
            "candidate. It then smoke-tests the bundled CLI and stores only the "
            "verified component under the local build root. "
            "Relative --lock and --build-root paths resolve from the repository root. "
            f"The default build root is {local_build_root()}. Build progress is "
            "written to stderr; stdout contains only the component build ID for "
            "shell command substitution. No remote build host is contacted; pnpm "
            "may use its configured package registry.\n\nExample:\n  uv run "
            "--project scripts --python 3.12 python scripts/mcp/build.py"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    result.add_argument(
        "--lock",
        type=Path,
        default=LOCK_PATH,
        metavar="PATH",
        help=f"MCP supply-chain lock (default: {LOCK_PATH})",
    )
    result.add_argument(
        "--build-root",
        type=Path,
        default=local_build_root(),
        metavar="PATH",
        help=f"verified component store (default: {local_build_root()})",
    )
    return result


def run(argv: Sequence[str]) -> int:
    arguments = parser().parse_args(argv)
    require_commands("git", "node", "pnpm")
    root = repository_root()
    require_clean_main(root)
    lock = load_lock(resolve(root, arguments.lock))
    validate_mcp_submodule(root, lock)
    build_root = resolve(root, arguments.build_root)
    build_id = component_build_id(lock.digest)
    with exclusive_lock(build_root, ".build.lock"):
        existing = build_root / "builds" / build_id
        if existing.exists() or existing.is_symlink():
            read_component(existing, lock)
            smoke_runtime(existing / "runtime" / "mcp")
            LOGGER.info("reusing verified MCP component: %s", build_id)
        else:
            build_component(root, build_root, lock)
    print(build_id)
    return 0


def build_component(root: Path, build_root: Path, lock: UpstreamLock) -> None:
    checkout = root / "browser" / "chrome-devtools-mcp"
    executable_path = validate_shared_test_prerequisites(root)
    test_environment = (
        os.environ
        | load_mcp_invocation(root / MCP_CONFIG_PATH).env
        | {
            "LC_ALL": "C.UTF-8",
            "LANG": "C.UTF-8",
            "PUPPETEER_EXECUTABLE_PATH": str(executable_path),
        }
    )
    LOGGER.info("installing frozen MCP dependencies")
    run_build_command(
        ("pnpm", "install", "--frozen-lockfile", "--config.node-linker=hoisted"),
        cwd=checkout,
        env=os.environ | {"PUPPETEER_SKIP_DOWNLOAD": "true"},
    )
    LOGGER.info("building MCP sources")
    run_build_command(("pnpm", "build"), cwd=checkout)
    LOGGER.info("running focused MCP tests")
    run_build_command(
        (
            "pnpm",
            "test:no-build",
            "tests/cli.test.ts",
            "tests/shutdown.test.ts",
        ),
        cwd=checkout,
        env=test_environment,
    )
    LOGGER.info("bundling MCP runtime")
    run_build_command(("pnpm", "bundle"), cwd=checkout)
    epoch = int(git_output(checkout, "show", "-s", "--format=%ct", "HEAD"))
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="scriptcat-mcp-build-") as name:
        runtime = Path(name) / "runtime" / "mcp"
        shutil.copytree(checkout / "build" / "src", runtime, copy_function=shutil.copy2)
        shutil.copy2(checkout / "package.json", runtime / "package.json")
        shutil.copy2(checkout / "LICENSE", runtime / "LICENSE")
        smoke_runtime(runtime)
        LOGGER.info("running shared browser E2E against candidate runtime")
        run_build_command(
            (
                "pnpm",
                "test:no-build",
                "tests/shared-browser.test.ts",
            ),
            cwd=checkout,
            env=test_environment
            | {
                "CHROME_DEVTOOLS_MCP_SHARED_TEST_ENTRY_PATH": str(
                    runtime / "bin" / "chrome-devtools-mcp.js"
                ),
                "CHROME_DEVTOOLS_MCP_SHARED_TEST_EXECUTABLE_PATH": str(executable_path),
                "CHROME_DEVTOOLS_MCP_SHARED_TEST_MANAGED_SCRIPTCAT_PATH": str(
                    SHARED_TEST_MANAGED_SCRIPTCAT_PATH
                ),
                "CHROME_DEVTOOLS_MCP_SHARED_TEST_SCRIPTCAT_REPOSITORY_ROOT": str(root),
                "CHROME_DEVTOOLS_MCP_SHARED_TEST_SCRIPTCAT_EXTENSION_ID": (
                    SCRIPTCAT_EXTENSION_ID
                ),
            },
        )
        materialize_component(runtime.parent, build_root / "builds", lock, epoch)


def configured_browser_executable(root: Path) -> Path:
    invocation = load_mcp_invocation(root / MCP_CONFIG_PATH)
    arguments = invocation.args[invocation.shared_index + 1 :]
    paths = []
    for index, argument in enumerate(arguments):
        if argument.startswith("--executable-path="):
            paths.append(argument.removeprefix("--executable-path="))
        elif argument == "--executable-path" and index + 1 < len(arguments):
            paths.append(arguments[index + 1])
    if len(paths) != 1 or not paths[0] or paths[0].startswith("--"):
        raise WorkflowError("MCP config must select one browser with --executable-path")
    return resolve(root, Path(paths[0]))


def validate_shared_test_prerequisites(root: Path) -> Path:
    if not root.is_dir():
        raise WorkflowError(f"ScriptCat repository root is unavailable: {root}")
    executable_path = configured_browser_executable(root)
    if not executable_path.is_file() or not os.access(executable_path, os.X_OK):
        raise WorkflowError(
            f"configured browser executable is unavailable: {executable_path}"
        )
    if not SHARED_TEST_MANAGED_SCRIPTCAT_PATH.is_dir():
        raise WorkflowError(
            "managed ScriptCat directory is unavailable: "
            f"{SHARED_TEST_MANAGED_SCRIPTCAT_PATH}"
        )
    require_json_object(
        SHARED_TEST_MANAGED_SCRIPTCAT_MANIFEST_PATH,
        "managed ScriptCat manifest",
    )
    return executable_path


def require_json_object(path: Path, label: str) -> None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WorkflowError(f"{label} is unavailable or invalid: {path}") from error
    if not isinstance(payload, dict):
        raise WorkflowError(f"{label} must contain a JSON object: {path}")


def run_build_command(
    command: Sequence[str],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
) -> None:
    try:
        subprocess.run(
            command,
            cwd=cwd,
            env=env,
            check=True,
            text=True,
            stdout=sys.stderr,
            stderr=sys.stderr,
        )
    except OSError as error:
        raise WorkflowError(f"{shlex.join(command)}: {error}") from error
    except subprocess.CalledProcessError as error:
        raise WorkflowError(
            f"{shlex.join(command)}: exited with status {error.returncode}"
        ) from error


def smoke_runtime(runtime: Path) -> None:
    LOGGER.info("smoke-testing bundled MCP CLI: %s", runtime)
    run_build_command(
        ("node", str(runtime / "bin" / "chrome-devtools-mcp.js"), "--help"),
        cwd=runtime,
    )
    run_build_command(
        (
            "node",
            str(runtime / "bin" / "chrome-devtools-mcp.js"),
            "shared",
            "--help",
        ),
        cwd=runtime,
    )


def resolve(root: Path, path: Path) -> Path:
    expanded = path.expanduser()
    return expanded if expanded.is_absolute() else root / expanded


if __name__ == "__main__":
    raise SystemExit(cli_main(run))
