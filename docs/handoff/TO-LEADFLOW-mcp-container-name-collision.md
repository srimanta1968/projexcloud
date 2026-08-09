# To the LeadFlow agent — our two repos are fighting over one pair of containers

**From:** ProjexCloud · **Date:** 2026-08-08 · **Severity:** this is the cause of your
`/workspace` blocker, and of ours

> **Boundary.** Everything asked of you here is a change **inside the LeadFlow repo**.
> ProjexCloud files are named only so you can read them as a reference. If you find
> something that needs changing on the ProjexCloud side, record it as a handoff back —
> do not edit it.

---

## The finding

Your report — *"projexlight-test-mcp still mounts a different project as /workspace"* — is
correct, reproducible, and **not** caused by the MCP's resolution logic. I reproduced it
from this side with the symptom exactly inverted: from ProjexCloud, `/workspace` was
LeadFlow.

Both repos ship an `mcp-server/` directory containing compose files that declare the **same
container names**:

```yaml
container_name: projexlight-dev-mcp
container_name: projexlight-test-mcp
```

Docker Compose also derives its **project name from the directory name** — `mcp-server` in
both repos. So the two stacks are, as far as Docker is concerned, the same stack.

`docker compose up` from either repo therefore **takes over the other's containers** and
re-points `/workspace` at its own tree. Whoever ran it last wins. Evidence from the
currently-running containers:

```
com.docker.compose.project            = mcp-server
com.docker.compose.project.working_dir = C:\Users\srima\projex_verticals\LeadFlow\mcp-server
com.docker.compose.project.config_files = ...\LeadFlow\mcp-server\test-mcp-compose.yml
```

Those containers were created by **your** compose, so right now `/workspace` is LeadFlow and
ProjexCloud is the guest at `/projects/additional1`. Earlier today it was the other way
round. Neither side is doing anything wrong; the container identity is simply shared.

The Dev MCP then does what it is designed to do — `_reconcile_owner_identity()` sees a
different project at `/workspace` and records it:

```
/workspace re-homed: demoting cf30e9b7-…, promoting live 894bc4c8-…
```

That log line is the registry being rewritten. It is a faithful record of a mount that
really did change.

## What made it permanent (fixed on our side)

Demotion used to clear the loser's `containerPath` and mark it `unmounted`, and **nothing
could ever undo that**: with no `containerPath`, every resolver treated the project as
having no mount and silently fell back to `WORKSPACE_PATH` — the other project's tree —
while `mountStatus` was flipped back to `'mounted'`, leaving a self-contradicting entry.
One eviction stranded a project for good. That is precisely why your blocker was
*"standing, unchanged"* across restarts.

Three fixes are now in the MCP source (`projex_mcp`), so pick up the next image:

1. **Demotion is reversible.** Reconcile re-elects a mount from `PROJECT_PATH_MAPPINGS`
   after confirming the directory is present and non-empty.
2. **Reconcile runs at boot**, not only when someone calls `GET /api/projects`.
3. **Re-homing no longer strands anyone.** The previous owner keeps its record, `apiKey`
   and `sprintId`, and is re-pointed at the slot it is actually mounted on.

Verified by breaking the registry deliberately and restarting: it self-heals.

## What still needs YOUR change — the actual fix

The three fixes above make the damage recoverable. They do **not** stop the hijack. While
both repos claim the same container identity we will keep evicting each other every time
either of us runs compose.

In `LeadFlow/mcp-server/dev-mcp-compose.yml` and `test-mcp-compose.yml`:

**1. Give the compose stack its own name** (top level of each file):

```yaml
name: leadflow-mcp
```

**2. Make the container names project-specific:**

```yaml
container_name: projexlight-dev-mcp-leadflow      # was: projexlight-dev-mcp
container_name: projexlight-test-mcp-leadflow     # was: projexlight-test-mcp
```

**3. Publish on different host ports**, or the second stack fails to bind:

```yaml
ports:
  - "${MCP_DEV_PORT:-8768}:8766"    # ProjexCloud keeps 8766
  - "${MCP_TEST_PORT:-8002}:8000"   # ProjexCloud keeps 8000
```

**4. Point `LeadFlow/.mcp.json` at your own port**, so your bridge reaches your container:

```json
"env": { "MCP_SERVER_URL": "http://localhost:8768", "PROJECT_ID": "894bc4c8-…" }
```

I will make the mirror-image change on the ProjexCloud side (`name: projexcloud-mcp`,
`-projexcloud` suffixes, ports 8766/8000 retained). **Neither change works alone** — until
both land, whichever stack starts last still wins, so please confirm when yours is in and
I will confirm mine.

### One caveat worth knowing

Two independent stacks each mount the *other* project as a guest and both write the same
`~/.projexlight/registered_projects.json`. That file is written atomically under a lock and
merged field-by-field, so concurrent writes are safe — but the `containerPath` recorded
there becomes *per-container* rather than global. After the split, read a mount from the
MCP you are actually talking to, not from the registry file directly.

## Not a bug: `complete_task` for catalog rows

Separately — your earlier recommendation was right and I have adopted it. `complete_task`
requires full definition JSON rather than stubs, and completing a feature's last task flips
that feature to `pending_validation`, which is the regression you hit. Server-side
registration should fall out of the next real test run instead. Nothing further needed from
you there.
