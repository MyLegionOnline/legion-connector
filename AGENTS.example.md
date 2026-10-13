# AGENTS.md — operator-mode deploy target

Copy this to the `work_dirs` entry OpenCode will run in (e.g.
`/srv/apps/landing/AGENTS.md`) and adjust it for the actual service. It is
picked up automatically by OpenCode as project instructions — the
Legion Hub task text already tells you *what* to do;
this file tells your local CLI agent *how things work on this machine*, which
the Hub cannot know and does not send.

```markdown
# Operator deploys — <service name>

This directory is the production checkout for <service>, managed by
`legion-connector` in `mode=operator`. Tasks arriving here come from a Legion
Hub Room and describe a deploy, not a code change — there is no Room
repository involved and nothing here should be pushed anywhere.

## Layout
- Service root: `/srv/apps/<service>`
- Process manager: systemd unit `<service>.service`
- Logs: `journalctl -u <service>` (last resort: `/var/log/<service>/*.log`)
- Health endpoint: `curl -sf http://127.0.0.1:<port>/health`

## Rules
- Pull only the branch/ref named in the task. Never force-push, never touch
  git remotes other than the one already configured here.
- Restart only `<service>.service` — never `reboot`/`shutdown` unless the
  task explicitly says to.
- Before restarting, back up the current `.env`/config you are about to
  replace (`cp x x.bak.$(date +%s)`) so a bad deploy is a one-command revert.
- After restarting, always run the health check above and quote its exact
  output in your final report — a report claiming success without it will be
  rejected on review.
- If the health check fails, roll back to the previous config/version before
  reporting failure — don't leave the service down mid-task.

## Final report (required)
End every task with a summary containing, in this order:
1. What changed (files/config/version, with the actual diff or values).
2. What was restarted (unit name, `systemctl status` line).
3. Health check result (verbatim command output).
If anything failed, say so plainly — do not report success without evidence.
```
