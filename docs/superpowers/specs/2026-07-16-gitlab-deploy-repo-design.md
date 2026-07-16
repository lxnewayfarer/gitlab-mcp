# Deploy repository for gitlab-mcp (mirroring cryptogeon)

**Date:** 2026-07-16
**Status:** Approved design

## Goal

Stand up a GitLab-hosted deploy repository for `gitlab-mcp` that mirrors how
`cryptogeon` is deployed at `trucker.group/trucker.devops`: application source
lives on GitHub, GitHub Actions builds and publishes the Docker image, and a
separate GitLab repository (`trucker.group/trucker.devops/gitlab-mcp`, currently
empty) rolls that image into Kubernetes on Yandex Cloud via a Helm chart driven
by `.gitlab-ci.yml`.

## Reference: how cryptogeon works

Cryptogeon's GitLab repo is a **pure deploy harness** — no application source:

- `.gitlab-ci.yml` — single `deploy` stage, runner tag `docker-19-yandex`,
  includes `.gitlab/k8s/deploy_staging.gitlab-ci.yml`.
- `deploy_staging` job uses the `helm-deployer:v4.0.0` image, decodes a
  base64 kubeconfig from a CI variable, logs into Vault, pulls the app secret
  from Vault, and runs `helm upgrade --install` with `imageTag=$CI_COMMIT_SHA`.
- Helm chart: app Deployment + redis Deployment + Services + Ingress (nginx,
  TLS `wildcard-trucker-group`, host `secure.trucker.group`) + a Secret rendered
  from the Vault payload (`--set-json secret=...`).
- The app image itself is a prebuilt public image (`cupcakearmy/cryptgeon`),
  not built in this repo.

## Architecture

```
GitHub (gitlab-mcp source)
  └─ GitHub Actions: build → push  →  Docker Hub (<org>/gitlab-mcp:TAG)
                                            │  (public image, no pull secret)
GitLab deploy-repo (this new repo)          │
  └─ .gitlab-ci.yml (stage: deploy)          ▼
      helm upgrade --install  ───────────►  k8s (Yandex Cloud, ns trucker-staging)
            │  secrets from Vault            └─ Deployment (app) + Service + Ingress
            └─ DATABASE_URL → external managed PostgreSQL (Yandex Cloud)
```

Key decisions:

- **Separate deploy repository**, structured like cryptogeon. Contents:
  `.gitlab-ci.yml`, `.gitlab/k8s/deploy_staging.gitlab-ci.yml`, `helm/`.
- **Image is NOT built here.** GitHub Actions builds and pushes to public
  Docker Hub. This repo only deploys.
- **No Redis.** The app is Postgres-only (single-instance model per CLAUDE.md).
  The redis Deployment/Service from cryptogeon are dropped entirely, not
  replaced by an in-cluster Postgres.
- **Database is external.** A managed PostgreSQL in Yandex Cloud; the cluster
  runs only the application. `DATABASE_URL` comes from Vault and must point at
  the managed DB (the app refuses to start in production against a localhost DB
  or a weak/known password).
- **Secrets from Vault**, path `trucker/gitlab-mcp/k8s/gitlab-mcp`.

## Image tag flow (the main difference from cryptogeon)

Cryptogeon uses `imageTag=$CI_COMMIT_SHA` because the deploy commit tracked what
was deployed. Here the image is built by GitHub Actions, so the GitLab deploy
commit is unrelated to the image version. Therefore:

- GitHub Actions tags the Docker Hub image with semver (`v1.2.3`), `latest`,
  and `sha-<gitsha>`.
- The deploy repo takes the tag from a CI variable `IMAGE_TAG` (default
  `latest`). Deploying a specific version = run the pipeline with
  `IMAGE_TAG=v1.2.3`.
- `helm upgrade` uses `--set imageTag=${IMAGE_TAG}` (replacing cryptogeon's
  `${CI_COMMIT_SHA}`).
- **Future extension (out of scope for v1):** GitHub Actions triggers the GitLab
  pipeline (pipeline trigger token) with the right `IMAGE_TAG` for full CD.

## Helm chart (changes relative to cryptogeon)

Copy cryptogeon's chart structure and modify:

**Remove:** `deployments/redis.yaml`, `networking/service-redis.yaml`, all redis
values, redis/worker/clock selector-label helpers in `_helpers.tpl`.

**`deployments/app.yaml`** — single app Deployment:
- `replicas: 1`, image `<dockerhub-org>/gitlab-mcp:${imageTag}`.
- containerPort `3000`.
- `envFrom` the Vault-rendered secret (same pattern as cryptogeon).
- Migrations: handled by the existing `docker/entrypoint.sh`, which runs
  `npx prisma migrate deploy` on start (Prisma advisory lock serializes replica
  startups). No separate initContainer or Helm-hook Job — the single-instance
  model makes the entrypoint sufficient.
- `readinessProbe` and `livenessProbe`: `GET /healthz` on port 3000.
- Keep cryptogeon's securityContext (non-root, drop ALL caps).
- No `imagePullSecrets` (public Docker Hub image).

**`values.yaml`** — rename `cryptgeon*` → `gitlabmcp*`; image
`<org>/gitlab-mcp`; `containerPort: 3000`; `servicePort: 80`;
`appUrl: gitlab-mcp.trucker.group`; `tlssecretname: wildcard-trucker-group`;
drop all redis blocks.

**`_helpers.tpl`** — rename template namespace `cryptgeon.*` → `gitlabmcp.*`;
drop redis/worker/clock/exporter helpers; keep name/fullname/chart/labels/
selectorLabels/app.selectorLabels.

**`ingress.yaml` / `service.yaml` / `configuration/secret.yaml`** — carried over
almost verbatim (nginx Ingress + TLS + Vault-rendered Opaque Secret). Service is
ClusterIP `:80` → `:3000`.

## `.gitlab-ci.yml` / `deploy_staging.gitlab-ci.yml`

Copy cryptogeon's CI:
- `RUNNER_TAG: docker-19-yandex`, default tag.
- Single `deploy` stage, include the staging deploy file.
- `deploy_staging`: image `helm-deployer:v4.0.0`, decode
  `KUBECONFIG_STAGING_BASE64`, Vault login (`vault_role_id`/`vault_secret_id`),
  pull secret from `trucker/gitlab-mcp/k8s/gitlab-mcp`, `helm upgrade --install`
  with `imageTag=${IMAGE_TAG}`, `appUrl`, `env` label.
- Job variables: `K8S_NAME: gitlab-mcp-stage`, `NAMESPACE: trucker-staging`,
  `HELM_VALUES_FILE: values.yaml`, `APPLICATION_URL: gitlab-mcp.trucker.group`,
  `LABEL_ENV: staging`, `KUBECONFIG: kubeconfig-deployer-staging`.
- `environment: { name: staging, url: https://$APPLICATION_URL }`.

## Verification

Deploy-repo has no app runtime to drive; verify the infrastructure:
- `helm lint helm/` passes.
- `helm template helm/ -f helm/values.yaml` renders with no errors, no leftover
  `cryptgeon.*` names, and no redis objects in the output.
- CI pipeline starts and `helm upgrade --install` reaches the cluster (first
  real deploy done manually).
- Post-deploy smoke: `GET https://gitlab-mcp.trucker.group/healthz` → 200; pod
  `Running`; migrations visible in logs.

## External dependencies (must exist outside this repo)

Checklist, not code tasks:
1. GitHub Actions workflow building/pushing `<org>/gitlab-mcp` to public Docker Hub.
2. Vault secret `trucker/gitlab-mcp/k8s/gitlab-mcp` with env keys: `DATABASE_URL`
   (managed PG), `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET`, `ENCRYPTION_KEY`,
   `GITLAB_BASE_URL`, `GITLAB_SCOPES`, `GITLAB_REDIRECT_URI=https://gitlab-mcp.trucker.group/auth/callback`,
   `PUBLIC_BASE_URL=https://gitlab-mcp.trucker.group`, `NODE_ENV=production`,
   `SESSION_TTL_HOURS`, etc. (NOT the `POSTGRES_*` compose-only vars).
3. GitLab CI variables: `KUBECONFIG_STAGING_BASE64`, `vault_role_id`,
   `vault_secret_id`, `IMAGE_TAG` (optional, default `latest`).
4. Managed PostgreSQL in Yandex Cloud, reachable from the cluster.
5. GitLab OAuth app with redirect URI `https://gitlab-mcp.trucker.group/auth/callback`.
6. DNS `gitlab-mcp.trucker.group` → ingress; wildcard TLS `wildcard-trucker-group`
   already present in the cluster.

## Out of scope (v1)

- Automated GitHub→GitLab pipeline trigger (manual/push-triggered deploy for now).
- Production environment (staging only, mirroring cryptogeon).
- In-cluster database, backups, HPA, multi-replica rollout.
