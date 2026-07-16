from __future__ import annotations


def provider_protocol_sandbox_helpers() -> str:
    """Render the provider-only unprivileged Chromium protocol test launcher."""
    return r"""run_provider_protocol_test() {
  local test_name=$1 test_workdir=$2 test_path=$3 test_command=$4
  local test_root command_file launcher_file test_uid test_gid relative_workdir
  local test_status
  case "$test_workdir" in
    "$build_root"/*) relative_workdir=${test_workdir#"$build_root"/} ;;
    *)
      printf 'provider test workdir is outside build root: %s\n' "$test_workdir" >&2
      return 64
      ;;
  esac
  test_uid=$(id -u nobody)
  test_gid=$(id -g nobody)
  test "$test_uid" -ne 0 && test "$test_gid" -ne 0
  test_root=$(mktemp -d /tmp/scriptcat-browser-provider-tests.XXXXXX)
  chmod 0755 "$test_root"
  install -d -m 0755 "$test_root/build"
  install -d -m 0700 -o "$test_uid" -g "$test_gid" \
    "$test_root/home" "$test_root/tmp" "$test_root/runtime"
  command_file="$test_root/command.sh"
  printf '%s' "$test_command" > "$command_file"
  chmod 0555 "$command_file"
  launcher_file="$test_root/launcher.sh"
  cat > "$launcher_file" <<'LAUNCHER'
#!/usr/bin/env bash
set -Eeuo pipefail
mount --bind "${SANDBOX_SOURCE_BUILD_ROOT:?}" "${SANDBOX_TEST_ROOT:?}/build"
cd "$SANDBOX_TEST_ROOT/build/${SANDBOX_RELATIVE_WORKDIR:?}"
exec setpriv --reuid="${SANDBOX_TEST_UID:?}" --regid="${SANDBOX_TEST_GID:?}" \
  --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all \
  env -i PATH="${SANDBOX_TEST_PATH:?}" LANG=en_US.UTF-8 \
  HOME="$SANDBOX_TEST_ROOT/home" TMPDIR="$SANDBOX_TEST_ROOT/tmp" \
  XDG_CACHE_HOME="$SANDBOX_TEST_ROOT/home/.cache" \
  XDG_CONFIG_HOME="$SANDBOX_TEST_ROOT/home/.config" \
  XDG_RUNTIME_DIR="$SANDBOX_TEST_ROOT/runtime" \
  BROWSER_BINARY="$SANDBOX_TEST_ROOT/build/src/src/out/Release/chrome" \
  BROWSER_TESTS_BINARY="$SANDBOX_TEST_ROOT/build/src/src/out/Release/browser_tests" \
  /bin/bash -Eeuo pipefail "${SANDBOX_COMMAND_FILE:?}"
LAUNCHER
  chmod 0555 "$launcher_file"
  if env -i PATH=/usr/bin:/bin LANG=en_US.UTF-8 HOME=/root TMPDIR=/tmp \
    SANDBOX_SOURCE_BUILD_ROOT="$build_root" SANDBOX_TEST_ROOT="$test_root" \
    SANDBOX_TEST_UID="$test_uid" SANDBOX_TEST_GID="$test_gid" \
    SANDBOX_RELATIVE_WORKDIR="$relative_workdir" SANDBOX_TEST_PATH="$test_path" \
    SANDBOX_COMMAND_FILE="$command_file" \
    unshare --mount --propagation private /bin/bash "$launcher_file"; then
    test_status=0
  else
    test_status=$?
  fi
  rm -rf -- "$test_root"
  return "$test_status"
}
"""
