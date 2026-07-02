Part A — Reboot → auto recreate/restart

You're 90% there. restart: unless-stopped already brings every container back on reboot. Two things to decide/harden:

1. Distinction to be clear about: restart-policy restarts the same containers (same image) — it does not pull latest or re-run compose up. That's the safe default (you don't want a surprise redeploy on every reboot). If a container was manually stopped before reboot, it stays down.

2. The one real gap: your stack needs a specific multi-file compose invocation (-f prod -f clickhouse -f local-artifacts -f db-expose --profile selfhosted --profile discovery). Restart-policy preserves it, but if anyone ever runs a plain docker compose up without all the -f files, the discovery bind-mount is lost and it crash-loops. Fix that fragility with a systemd oneshot that reconciles the full stack on boot:

# /etc/systemd/system/projexcloud.service

[Unit]
Requires=docker.service
After=docker.service network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/ec2-user/projexcloud
ExecStart=/home/ec2-user/projexcloud/deploy.sh up
[Install]
WantedBy=multi-user.target
…where deploy.sh encodes the canonical invocation (single source of truth for both boot and manual deploys). systemctl enable projexcloud → on reboot the stack is reconciled to the intended state, override files included. Belt-and-suspenders on top of the restart policy.

---

Part B — Build locally / in CI, then deploy (stop building on the box)

Recommended: build images in GitHub Actions, push to GHCR, prod just pulls. This kills the 10-min on-box builds and the disk bloat (no buildkit cache on the box anymore).

Concrete changes:

1. New workflow .github/workflows/images.yml — on push to main: docker buildx build --platform linux/amd64 --push the 5 images to ghcr.io/srimanta1968/projexcloud-{api-gateway,registry-mcp,postgres-pgvector,portal-workspace,portal-tenant,portal-console}, tagged with the git SHA and latest. (GitHub runners are 4 vCPU/16 GB — builds in a few minutes, free for your repo.)
2. Parameterize images — set image names to the ghcr.io/... prefix and make portals.yml use ${IMAGE_TAG} like prod.yml already does.
3. Bake the discovery artifacts into the image (run the sdk-registry CLI as a CI build step) so the local-artifacts scp/bind-mount hack disappears — one less fragile manual step.
4. Prod deploy becomes (seconds, no build):
   export IMAGE_TAG=<sha> # or 'latest'
   ./deploy.sh up # = docker compose … pull && up -d
5. Migrations still auto-apply on gateway boot, so a new image = migrations run automatically.
6. Registry auth: docker login ghcr.io on the box with a read-only PAT (or make the GHCR packages public — simplest).

Why GHCR over ECR: ECR needs IAM, but your box has no IAM role and your projectx IAM user lacks EC2 perms. GHCR needs only a PAT (or public). If you later attach an IAM role, switch to ECR for fastest pulls + zero egress cost.

▎ A literal "build on my Windows laptop and push" works too (docker buildx build --platform linux/amd64 --push …), but CI is better: avoids the Git-Bash path-mangling you've hit and doesn't tie deploys to your laptop being on.

---

Net deploy flow (target state)

git push main → CI builds + pushes images → on box ./deploy.sh up (pull + up, ~30s) → reboot-safe via restart-policy + the systemd unit.

This removes the two biggest pain points: slow on-box builds and disk-fill from build cache.

Want me to implement it? I'd suggest doing it in this order so each step is verifiable:

1. Add deploy.sh + the projexcloud.service systemd unit on the box (reboot resilience — low risk, immediate).
2. Add the GHCR images.yml workflow + parameterize the compose image tags.
3. Cut over prod to pull-based deploy and confirm, then retire the on-box build path.

Which part should I start with — or do you want all three?

✻ Brewed for 2m 18s

❯ Currently I am using github free account, does the free account support build suggestion you mentioned in Part B

Short answer: yes, GitHub Free supports it — Actions + GHCR both work on a free account. But there are two real quota limits on Free that matter for private repos, and I overstated the runner size earlier. Here's the accurate picture.

What Free gives you

- GitHub Actions: 2,000 CI/CD minutes/month for private repos; unlimited for public repos.
- GHCR (ghcr.io): included free. Public image packages = unlimited storage + transfer. Private packages count against ~500 MB storage + ~1 GB/month transfer on Free.
- Runner spec (correction): the standard ubuntu-latest runner is 2 vCPU / 7 GB RAM / 14 GB disk — not the 4 vCPU/16 GB I said earlier. Bigger runners are a paid add-on. Still better than your 2 vCPU/4 GB box (more RAM), and the image is pushed, not kept.

Where Free will pinch (your repo is private)

1. Actions minutes. A full monorepo image build is minute-hungry — roughly 6 images × ~6–10 min ≈ 40–60 min per push. At 2,000 min/month that's only ~30–45 full builds/month. Fine for a few deploys/week; tight if you build on every commit.
2. GHCR private storage (500 MB). Your images are large (Node + deps, easily 300–600 MB each). Six private images blow past 500 MB immediately → you'd start paying for storage.
3. Runner disk (14 GB). Building 6 large images in one job needs a docker image prune between builds to fit.

How to stay comfortably on Free

Pick based on whether the images can be public (images ≠ source code):

- If images can be public (most pragmatic): push to GHCR as public packages → unlimited free storage/transfer, and minutes only bite if you build on every push. Repo stays private; only the built image is public. Caveat: anyone could pull your compiled app image — fine for many SaaS backends, not if the bundle is sensitive.
- If images must stay private (likely, proprietary): don't lean on GHCR Free storage. Two good options:
  - Build locally, push to a registry (your original "build locally" idea) — uses zero Actions minutes. Build on your laptop with docker buildx build --platform linux/amd64 --push, prod pulls. Registry can be AWS ECR (you're already on AWS; ~$0.10/GB-month — a few dollars for 6 images, and pulls from EC2 are fast/no-egress). ECR needs an IAM credential on the box (you currently have none — a small setup step).
  - Self-hosted runner = unlimited free Actions minutes. Run the GitHub runner on your laptop (or a spare box), it builds + pushes. Removes the minutes limit entirely; you still need a registry for storage.

My recommendation for your situation (private, Free, AWS)

Build locally (or self-hosted runner) → push to ECR → prod pulls. This:

- uses 0 GitHub Actions minutes (dodges the 2,000 cap),
- keeps images private without the GHCR 500 MB problem,
- costs only a few dollars/month in ECR storage,
- still gets you off the slow, disk-filling on-box builds.

The only new setup vs. my earlier plan is giving the EC2 box ECR pull access (attach a small IAM role, or aws ecr get-login-password with an access key). Everything else — deploy.sh, ${IMAGE_TAG} parameterization, the systemd reboot unit, compose pull && up -d — is identical.

If you'd rather avoid AWS IAM entirely and don't mind public images, GHCR-public is the zero-cost, zero-IAM path.

▎ Note: these quota numbers are as of my knowledge cutoff (Jan 2026) — worth a 30-second check on GitHub's current billing page, since limits do change.

Want me to set up the local-build → ECR → prod-pull path (plus the reboot systemd unit)? I'd start with the reboot unit + deploy.sh (no registry needed, immediate value), then wire ECR.
