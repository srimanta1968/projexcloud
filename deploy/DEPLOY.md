# ProjexCloud — deploy & reboot operations

## Reboot resilience
- Every container is `restart: unless-stopped`, and `docker` + `nginx` are
  boot-enabled, so a reboot brings the whole stack back automatically.
- Belt-and-suspenders: `deploy/systemd/projexcloud.service` reconciles the full
  multi-file Compose stack on boot (so override files + profiles are always
  applied, never a partial `compose up`). Install once on the box:

  ```bash
  sudo cp /home/ec2-user/projexcloud/deploy/systemd/projexcloud.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable projexcloud.service
  sudo systemctl start projexcloud.service   # safe: reconciles, no rebuild
  ```

## Day-to-day (current: images built on the box)
`deploy.sh` is the single source of truth for the Compose invocation:

```bash
./deploy.sh up      # reconcile to desired state (no build)  ← used on boot too
./deploy.sh ps      # status
./deploy.sh logs api-gateway
```

To ship code changes today you still rebuild on the box (slow). The target
state below removes that.

## Target: build off-box, prod only pulls (recommended)
Images are parameterized: `image: ${IMAGE_PREFIX:-projexcloud}/<svc>:${IMAGE_TAG:-local}`.
Defaults reproduce today's local `:local` images, so nothing changes until you
opt in by setting `IMAGE_PREFIX`/`IMAGE_TAG`.

### One-time: AWS ECR (private, cheap, fast from EC2)
1. Attach an IAM role to the instance with ECR pull (e.g. the managed
   `AmazonEC2ContainerRegistryReadOnly`) — or put an access key on the box.
2. From a build host (laptop / self-hosted CI runner) with Docker + AWS creds:

   ```bash
   IMAGE_PREFIX=<acct>.dkr.ecr.us-east-1.amazonaws.com AWS_REGION=us-east-1 \
     IMAGE_TAG=$(git rev-parse --short HEAD) ./scripts/setup/build-and-push.sh
   ```
   (creates the 6 ECR repos on first run, builds linux/amd64, pushes.)

### Each deploy
On the box:
```bash
aws ecr get-login-password --region us-east-1 | docker login --username AWS \
  --password-stdin <acct>.dkr.ecr.us-east-1.amazonaws.com   # if not using the IAM role helper
IMAGE_PREFIX=<acct>.dkr.ecr.us-east-1.amazonaws.com IMAGE_TAG=<sha> ./deploy.sh deploy
```
`deploy` = `pull` then `up -d` (seconds). Gateway migrations auto-apply on boot.

> Put `IMAGE_PREFIX`/`IMAGE_TAG` in `.env.prod` (and `scripts/setup/.env` for
> portals) so the systemd boot reconcile uses the same images.
