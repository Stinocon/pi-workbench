# pi-preflight.zsh — pre-launch guard for `pi`.
#
# Source this from ~/.zshrc so that running `pi` first parse-checks the LIVE
# extensions (~/.pi/agent/extensions) with jiti. A broken extension makes `pi`
# exit(1) at startup (verified: pi aborts before session_start on an extension
# load failure), and `pi --version`/`--list-models` do NOT catch it — so the
# check must happen before launch, in the shell.
#
# Behavior:
#   - parse error   -> block, point at `command pi -ne`
#   - check broken  -> warn and start pi anyway (never block on the guard itself)
#   - clean         -> start pi
#
# `command pi "$@"` runs the real binary, bypassing this function (functions
# take precedence over PATH binaries in zsh).

pi() {
  # Self-locate the checker next to this script (works wherever the repo is cloned).
  local check="${0:A:h}/check-extensions.cjs"
  if [ -f "$check" ] && command -v node >/dev/null 2>&1; then
    node "$check" -q "$HOME/.pi/agent/extensions"
    case $? in
      1) echo "pi: extension parse error (above) — fix it, or run 'command pi -ne' to start without extensions." >&2
         return 1 ;;
      2) echo "pi: preflight check unavailable (jiti not found) — starting without it." >&2 ;;
    esac
  fi
  command pi "$@"
}
