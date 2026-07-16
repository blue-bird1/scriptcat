from __future__ import annotations

from .._common import shell_quote
from ._lock import ProviderLock


def chromium_patch_preparation_script(lock: ProviderLock) -> tuple[str, str]:
    """Render the provider-owned Chromium patch activation helpers."""
    command = (
        'activate_chromium_patch "$build_root/src/src" '
        f"{shell_quote(lock.chromium.source)} {shell_quote(lock.chromium.commit)} "
        f'"$checkout"/{shell_quote(lock.chromium_patch.path.as_posix())} '
        f"{shell_quote(lock.chromium_patch.sha256)}"
    )
    helpers = r"""ensure_source_checkout() {
  local destination="$1" source="$2"
  if [ ! -d "$destination/.git" ]; then
    if [ -e "$destination" ] && \
      [ -n "$(find "$destination" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
      printf 'refusing to replace unknown non-empty source destination: %s\n' \
        "$destination" >&2
      exit 76
    fi
    git clone --filter=blob:none "$source" "$destination"
  fi
}

activate_chromium_patch() {
  local destination="$1" source="$2" base="$3" patches="$4" expected_sha="$5"
  local -a patch_names=() patch_files=()
  local patch_name patch_file actual_sha
  test -d "$patches" && test -f "$patches/series"
  mapfile -t patch_names < <(sed -e '/^[[:space:]]*#/d' \
    -e '/^[[:space:]]*$/d' "$patches/series")
  test "${#patch_names[@]}" -gt 0
  for patch_name in "${patch_names[@]}"; do
    case "$patch_name" in
      *.patch) ;;
      *)
        printf 'invalid Chromium patch series entry: %s\n' "$patch_name" >&2
        return 1
        ;;
    esac
    test "$patch_name" = "${patch_name##*/}" || return 1
    patch_file="$patches/$patch_name"
    test -f "$patch_file" && test ! -L "$patch_file" || return 1
    patch_files+=("$patch_file")
  done
  test "$(find "$patches" -maxdepth 1 -type f -name '*.patch' | wc -l)" \
    -eq "${#patch_files[@]}"
  actual_sha=$(cat "${patch_files[@]}" | sha256sum | awk '{print $1}')
  test "$actual_sha" = "$expected_sha"
  git -C "$destination" fetch --depth=1 "$source" "$base"
  git -C "$destination" checkout --detach "$base"
  git -C "$destination" reset --hard "$base"
  git -C "$destination" clean -ffd
  git -C "$destination" apply --index "${patch_files[@]}"
  GIT_AUTHOR_NAME='ScriptCat browser provider' \
  GIT_AUTHOR_EMAIL='scriptcat-browser@localhost' \
  GIT_AUTHOR_DATE='1970-01-01T00:00:00+0000' \
  GIT_COMMITTER_NAME='ScriptCat browser provider' \
  GIT_COMMITTER_EMAIL='scriptcat-browser@localhost' \
  GIT_COMMITTER_DATE='1970-01-01T00:00:00+0000' \
    git -C "$destination" commit -m 'ScriptCat browser provider Chromium patch stack'
}
"""
    return helpers, command
