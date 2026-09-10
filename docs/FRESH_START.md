# Fresh start — from zero to a working pi-workbench

Step-by-step for a new machine or a clean install. Assumes macOS + zsh; adapt paths for your OS.

## 0. Install Pi

Follow the official Pi install, then verify:

```bash
pi --version
```

## 1. Wire Pi to your provider

Set up the provider you use as the cloud primary (auth key, provider config). Verify the model
catalog is visible:

```bash
pi --list-models
```

Note the model ids you get back — you will pin them into the workers in step 4.

## 2. Clone this repo

```bash
git clone https://github.com/<your-user>/pi-workbench.git ~/pi-workbench
```

## 3. Restore the customization

```bash
DEST=~/.pi/agent

mkdir -p "$DEST/agents" "$DEST/extensions" "$DEST/skills"

cp ~/pi-workbench/AGENTS.md "$DEST/AGENTS.md"
cp ~/pi-workbench/settings.json "$DEST/settings.json"

cp ~/pi-workbench/agents/*.md "$DEST/agents/"

cp ~/pi-workbench/extensions/*.ts "$DEST/extensions/"

mkdir -p "$DEST/extensions/plan-mode"
cp ~/pi-workbench/extensions/plan-mode/index.ts ~/pi-workbench/extensions/plan-mode/utils.ts "$DEST/extensions/plan-mode/"

mkdir -p "$DEST/extensions/subagent"
cp ~/pi-workbench/subagent/index.ts ~/pi-workbench/subagent/agents.ts "$DEST/extensions/subagent/"

cp -r skills/*/ "$DEST/skills/"
```

> The last line must remain a glob (`cp -r skills/*/`), not a hand-written loop — a hardcoded
> list drifts when skills are added/renamed. The `check-config-docs.sh` gate enforces this.

## 4. Configure your models

Three files hold model references — fill them with ids from `pi --list-models`:

1. **`~/.pi/agent/settings.json`** — add your `defaultProvider` / `defaultModel`.
2. **`~/.pi/agent/agents/*.md`** — the `miner-*` workers' `model:` field. The tiers stay the
   same; only the model ids change. `repo-builder.md` too.
3. **`~/.pi/agent/workers.json`** — copy `workers.example.json` and fill in:
   - `draft` — a cheap, fast model for prose→structure and small code drafts.
   - `local` — a local model as the offline fallback (optional; omit if you have none).
   - `cloudProvider` — your primary cloud provider id (lets bare ids resolve).

```bash
cp ~/pi-workbench/workers.example.json ~/.pi/agent/workers.json
# then edit the placeholders
```

## 5. API keys

```bash
cp ~/pi-workbench/auth.json.example ~/.pi/agent/auth.json
# substitute your real provider + key
```

Never commit the filled `auth.json` / `workers.json` — both are gitignored.

## 6. Preflight guard (optional but recommended)

A broken extension makes `pi` exit(1) before the session starts, and `pi --version` doesn't catch
it. Source the guard from `~/.zshrc`:

```bash
[ -f "$HOME/pi-workbench/scripts/pi-preflight.zsh" ] && source "$HOME/pi-workbench/scripts/pi-preflight.zsh"
```

## 7. Restart and verify

```bash
# new shell (to pick up the preflight guard), then:
pi
```

In an open session, `/reload` hot-loads extensions, agents and skills. Sanity checks:

- `delegate` (with no model) lists the draft/local workers you configured and cloud escalation.
- `/dispatch <task>` drafts a tiered plan.
- `/plan` enters read-only plan mode.
- `/statusline` toggles the footer.

## Optional: drift gate

`scripts/check-drift.sh` reports (read-only) which git repos have content GitHub does not yet
have. Default scope is direct subdirectories of `$HOME`; override with `DRIFT_BASE` or pass
explicit repo paths.
