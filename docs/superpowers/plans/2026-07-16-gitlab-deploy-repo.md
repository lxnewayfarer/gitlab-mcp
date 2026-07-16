# GitLab Deploy Repo for gitlab-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the empty GitLab repo `trucker.group/trucker.devops/gitlab-mcp` with a Helm chart + `.gitlab-ci.yml` that rolls the public Docker Hub `gitlab-mcp` image into Kubernetes on Yandex Cloud, mirroring how `cryptogeon` is deployed.

**Architecture:** A pure deploy harness (no app source). `.gitlab-ci.yml` runs a single `deploy` stage on the `docker-19-yandex` runner using the `helm-deployer` image; it decodes a kubeconfig, pulls the app secret from Vault, and runs `helm upgrade --install`. The Helm chart has one app Deployment (port 3000, migrations via the image's own entrypoint, probes on `/healthz`), a Service, an Ingress, and a Vault-rendered Secret. No Redis; PostgreSQL is external/managed.

**Tech Stack:** Helm 3, Kubernetes, GitLab CI, Vault, nginx-ingress. Chart authored/validated locally; `helm` is run via the `alpine/helm` Docker image (no local helm binary).

## Global Constraints

- Work happens in the **separate empty repo clone** at
  `/tmp/claude-1000/-home-lxne-WORK-trucker-gitlab-mcp/b9dad545-b2b8-446a-b5c7-d11142245151/scratchpad/gitlab-mcp-deploy`
  (remote: `git@trucker.gitlab.yandexcloud.net:trucker.group/trucker.devops/gitlab-mcp.git`). NOT the app repo.
- Reference chart to copy from:
  `/tmp/claude-1000/-home-lxne-WORK-trucker-gitlab-mcp/b9dad545-b2b8-446a-b5c7-d11142245151/scratchpad/cryptogeon`.
- **No Redis** anywhere. **No `imagePullSecrets`** (public Docker Hub image).
- App container port: `3000`. Service port: `80`. Health path: `/healthz`.
- Helm template namespace: `gitlabmcp.*` (renamed from `cryptgeon.*`). No leftover `cryptgeon`/`cryptgeon` strings.
- Deploy target: namespace `trucker-staging`, release `gitlab-mcp-stage`, host `gitlab-mcp.trucker.group`, TLS secret `wildcard-trucker-group`.
- Image: `<DOCKERHUB_ORG>/gitlab-mcp`, tag from CI var `IMAGE_TAG` (default `latest`). `<DOCKERHUB_ORG>` is a placeholder to be confirmed before first real deploy; use literal `DOCKERHUB_ORG` in files until then.
- Migrations are handled by the image's `docker/entrypoint.sh` (`prisma migrate deploy` on start) — the chart adds NO migration Job/initContainer.
- Verify Helm with: `docker run --rm -v "$PWD":/apps -w /apps alpine/helm:3.16.2 <helm-args>`.
- Commit in the deploy repo clone, not the app repo.

---

### Task 1: Repo skeleton + Chart.yaml + values.yaml + helpers

**Files (all under the deploy repo clone `.../scratchpad/gitlab-mcp-deploy`):**
- Create: `helm/Chart.yaml`
- Create: `helm/values.yaml`
- Create: `helm/templates/_helpers.tpl`
- Create: `helm/.helmignore`
- Create: `.gitignore`

**Interfaces:**
- Produces: chart name `gitlab-mcp`; template helpers `gitlabmcp.name`, `gitlabmcp.fullname`, `gitlabmcp.chart`, `gitlabmcp.labels`, `gitlabmcp.selectorLabels`, `gitlabmcp.app.selectorLabels`. values keys consumed by later tasks: `.Values.nameSpace`, `.Values.appUrl`, `.Values.tlssecretname`, `.Values.containerPort`, `.Values.servicePort`, `.Values.image`, `.Values.imageTag`, `.Values.replicasCount.app`, `.Values.resources.app`, `.Values.timestamp`, `.Values.ingress.annotations.basic`, `.Values.secret`.

- [ ] **Step 1: Create `helm/Chart.yaml`**

```yaml
apiVersion: v2
name: gitlab-mcp
version: 1.0.0
description: A Helm chart for gitlab-mcp — MCP server for GitLab (OAuth per-user)
type: application
sources:
  - https://trucker.gitlab.yandexcloud.net/trucker.group/trucker.devops/gitlab-mcp
```

- [ ] **Step 2: Create `helm/values.yaml`**

```yaml
nameSpace: trucker-staging
tlssecretname: wildcard-trucker-group
appUrl: gitlab-mcp.trucker.group

containerPort: 3000
servicePort: 80

# Overridden per-deploy from CI: imageTag from $IMAGE_TAG.
image: DOCKERHUB_ORG/gitlab-mcp
imageTag: latest

# Set from CI to force pod restarts on redeploy.
timestamp: "0"

replicasCount:
  app: 1

labels:
  env: staging
  owner: arch-team
  project: trucker
  servicename: gitlab-mcp
  servicetype: app
  sla: none
  k8sapp: gitlab-mcp

resources:
  app:
    requests:
      memory: "128Mi"
      cpu: "50m"
    limits:
      memory: "512Mi"
      cpu: "500m"

ingress:
  enabled: true
  annotations:
    basic:
      nginx.ingress.kubernetes.io/proxy-body-size: 32m
      nginx.ingress.kubernetes.io/proxy-read-timeout: "360"

# Rendered from Vault via `helm --set-json secret=...` at deploy time.
# Keys become env vars in the app container (see configuration/secret.yaml).
secret: {}
```

- [ ] **Step 3: Create `helm/templates/_helpers.tpl`**

```
{{/*
Expand the name of the chart.
*/}}
{{- define "gitlabmcp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "gitlabmcp.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart name and version for the chart label.
*/}}
{{- define "gitlabmcp.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "gitlabmcp.labels" -}}
helm.sh/chart: {{ include "gitlabmcp.chart" . }}
{{ include "gitlabmcp.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "gitlabmcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "gitlabmcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
{{- define "gitlabmcp.app.selectorLabels" -}}
{{ include "gitlabmcp.selectorLabels" . }}
app.kubernetes.io/component: app
{{- end }}
```

- [ ] **Step 4: Create `helm/.helmignore`**

```
.DS_Store
.git/
.gitignore
*.tmproj
.idea/
*.swp
*.bak
```

- [ ] **Step 5: Create `.gitignore`**

```
kubeconfig-*
*.local
.DS_Store
```

- [ ] **Step 6: Verify chart parses (lint runs even before templates exist)**

Run:
```bash
cd /tmp/claude-1000/-home-lxne-WORK-trucker-gitlab-mcp/b9dad545-b2b8-446a-b5c7-d11142245151/scratchpad/gitlab-mcp-deploy
docker run --rm -v "$PWD":/apps -w /apps alpine/helm:3.16.2 lint helm
```
Expected: output contains `1 chart(s) linted, 0 chart(s) failed` (an `[INFO]` about no templates directory contents is fine; no `[ERROR]`).

- [ ] **Step 7: Commit**

```bash
cd /tmp/claude-1000/-home-lxne-WORK-trucker-gitlab-mcp/b9dad545-b2b8-446a-b5c7-d11142245151/scratchpad/gitlab-mcp-deploy
git add helm/Chart.yaml helm/values.yaml helm/templates/_helpers.tpl helm/.helmignore .gitignore
git commit -m "chore(helm): chart skeleton, values, helpers for gitlab-mcp"
```

---

### Task 2: App Deployment template

**Files:**
- Create: `helm/templates/deployments/app.yaml` (in the deploy repo clone)

**Interfaces:**
- Consumes: helpers and values from Task 1 (`gitlabmcp.fullname`, `gitlabmcp.labels`, `gitlabmcp.app.selectorLabels`, `.Values.replicasCount.app`, `.Values.image`, `.Values.imageTag`, `.Values.containerPort`, `.Values.resources.app`, `.Values.timestamp`).
- Produces: a Deployment named `{{ include "gitlabmcp.fullname" . }}` selecting `gitlabmcp.app.selectorLabels`; consumes a Secret named `{{ .Release.Name }}-secrets` (created in Task 4).

- [ ] **Step 1: Create `helm/templates/deployments/app.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "gitlabmcp.fullname" . }}
  namespace: {{ .Values.nameSpace }}
  labels:
    {{- include "gitlabmcp.labels" . | nindent 4 }}
    app.kubernetes.io/component: app
spec:
  replicas: {{ .Values.replicasCount.app }}
  selector:
    matchLabels:
      {{- include "gitlabmcp.app.selectorLabels" . | nindent 6 }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  template:
    metadata:
      labels:
        {{- include "gitlabmcp.app.selectorLabels" . | nindent 8 }}
    spec:
      containers:
        - name: app
          image: {{ .Values.image }}:{{ .Values.imageTag }}
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: {{ .Values.containerPort }}
              name: "app"
          resources:
          {{- toYaml .Values.resources.app | nindent 12 }}
          env:
          - name: DEPLOY_TIMESTAMP
            value: "{{ .Values.timestamp }}"
          - name: K8S_POD_NAME
            valueFrom:
              fieldRef:
                fieldPath: metadata.name
          envFrom:
          - secretRef:
              name: {{ .Release.Name }}-secrets
          readinessProbe:
            httpGet:
              path: /healthz
              port: {{ .Values.containerPort }}
            initialDelaySeconds: 5
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /healthz
              port: {{ .Values.containerPort }}
            initialDelaySeconds: 15
            periodSeconds: 20
            timeoutSeconds: 3
            failureThreshold: 3
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
            runAsNonRoot: true
            runAsUser: 999
            runAsGroup: 999
```

Note: no `imagePullSecrets` (public image); no redis; migrations run in the image entrypoint, not here.

- [ ] **Step 2: Verify it renders**

Run:
```bash
cd /tmp/claude-1000/-home-lxne-WORK-trucker-gitlab-mcp/b9dad545-b2b8-446a-b5c7-d11142245151/scratchpad/gitlab-mcp-deploy
docker run --rm -v "$PWD":/apps -w /apps alpine/helm:3.16.2 \
  template gitlab-mcp-stage helm --show-only templates/deployments/app.yaml \
  --set image=DOCKERHUB_ORG/gitlab-mcp --set imageTag=latest
```
Expected: valid Deployment YAML printed; `image: DOCKERHUB_ORG/gitlab-mcp:latest`; `readinessProbe`/`livenessProbe` with `path: /healthz`; NO `imagePullSecrets`; no template errors.

- [ ] **Step 3: Commit**

```bash
cd /tmp/claude-1000/-home-lxne-WORK-trucker-gitlab-mcp/b9dad545-b2b8-446a-b5c7-d11142245151/scratchpad/gitlab-mcp-deploy
git add helm/templates/deployments/app.yaml
git commit -m "feat(helm): app Deployment with /healthz probes, no redis"
```

---

### Task 3: Service + Ingress templates

**Files:**
- Create: `helm/templates/networking/service.yaml`
- Create: `helm/templates/networking/ingress.yaml`

**Interfaces:**
- Consumes: `gitlabmcp.labels`, `gitlabmcp.app.selectorLabels`, `.Values.nameSpace`, `.Values.servicePort`, `.Values.containerPort`, `.Values.appUrl`, `.Values.tlssecretname`, `.Values.ingress.annotations.basic`.
- Produces: Service named `{{ .Release.Name }}` on port `{{ .Values.servicePort }}`; Ingress routing host `appUrl` → that Service.

- [ ] **Step 1: Create `helm/templates/networking/service.yaml`**

```yaml
kind: Service
apiVersion: v1
metadata:
  name: {{ .Release.Name }}
  labels:
    {{- include "gitlabmcp.labels" . | nindent 4 }}
  namespace: {{ .Values.nameSpace }}
spec:
  selector:
    {{- include "gitlabmcp.app.selectorLabels" . | nindent 4 }}
  ports:
    - port: {{ .Values.servicePort }}
      protocol: TCP
      targetPort: {{ .Values.containerPort }}
      name: app
```

- [ ] **Step 2: Create `helm/templates/networking/ingress.yaml`**

```yaml
{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    {{- with .Values.ingress.annotations.basic }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  name: {{ .Release.Name }}
  namespace: {{ .Values.nameSpace }}
  labels:
    {{- include "gitlabmcp.labels" . | nindent 4 }}
spec:
  ingressClassName: nginx
  rules:
  - host: {{ .Values.appUrl }}
    http:
      paths:
        - path: /
          pathType: ImplementationSpecific
          backend:
            service:
              name: {{ .Release.Name }}
              port:
                number: {{ .Values.servicePort }}
  tls:
  - hosts:
    - {{ .Values.appUrl }}
    secretName: {{ .Values.tlssecretname }}
{{- end }}
```

- [ ] **Step 3: Verify both render**

Run:
```bash
cd /tmp/claude-1000/-home-lxne-WORK-trucker-gitlab-mcp/b9dad545-b2b8-446a-b5c7-d11142245151/scratchpad/gitlab-mcp-deploy
docker run --rm -v "$PWD":/apps -w /apps alpine/helm:3.16.2 \
  template gitlab-mcp-stage helm --show-only templates/networking/service.yaml --show-only templates/networking/ingress.yaml
```
Expected: a Service (`targetPort: 3000`, `port: 80`) and an Ingress (`host: gitlab-mcp.trucker.group`, `secretName: wildcard-trucker-group`, `ingressClassName: nginx`); no errors.

- [ ] **Step 4: Commit**

```bash
cd /tmp/claude-1000/-home-lxne-WORK-trucker-gitlab-mcp/b9dad545-b2b8-446a-b5c7-d11142245151/scratchpad/gitlab-mcp-deploy
git add helm/templates/networking/service.yaml helm/templates/networking/ingress.yaml
git commit -m "feat(helm): Service and nginx Ingress with TLS"
```

---

### Task 4: Secret template (Vault-rendered)

**Files:**
- Create: `helm/templates/configuration/secret.yaml`

**Interfaces:**
- Consumes: `.Values.secret` (a map of env-var name → plaintext value, injected via `--set-json secret=...`), `gitlabmcp.labels`, `.Values.nameSpace`.
- Produces: Secret named `{{ .Release.Name }}-secrets` consumed by the Deployment's `envFrom` (Task 2).

- [ ] **Step 1: Create `helm/templates/configuration/secret.yaml`**

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: {{ .Release.Name }}-secrets
  namespace: {{ .Values.nameSpace }}
  labels:
    {{- include "gitlabmcp.labels" . | nindent 4 }}
type: Opaque
data:
  {{- range $key, $value := .Values.secret }}
  {{ $key }}: {{ $value | toString | b64enc }}
  {{- end }}
```

- [ ] **Step 2: Verify it renders with a sample secret**

Run:
```bash
cd /tmp/claude-1000/-home-lxne-WORK-trucker-gitlab-mcp/b9dad545-b2b8-446a-b5c7-d11142245151/scratchpad/gitlab-mcp-deploy
docker run --rm -v "$PWD":/apps -w /apps alpine/helm:3.16.2 \
  template gitlab-mcp-stage helm --show-only templates/configuration/secret.yaml \
  --set-json 'secret={"DATABASE_URL":"postgresql://u:p@db:5432/x","ENCRYPTION_KEY":"deadbeef"}'
```
Expected: a Secret named `gitlab-mcp-stage-secrets` with two base64 `data` entries; no errors.

- [ ] **Step 3: Verify the whole chart lints and full-templates cleanly**

Run:
```bash
cd /tmp/claude-1000/-home-lxne-WORK-trucker-gitlab-mcp/b9dad545-b2b8-446a-b5c7-d11142245151/scratchpad/gitlab-mcp-deploy
docker run --rm -v "$PWD":/apps -w /apps alpine/helm:3.16.2 lint helm
docker run --rm -v "$PWD":/apps -w /apps alpine/helm:3.16.2 \
  template gitlab-mcp-stage helm \
  --set-json 'secret={"DATABASE_URL":"postgresql://u:p@db:5432/x"}' | grep -c 'kind:'
```
Expected: `0 chart(s) failed`; the `grep -c 'kind:'` prints `4` (Deployment, Service, Ingress, Secret). No occurrence of `cryptgeon`/`cryptgeon`/`redis` anywhere — confirm with:
```bash
docker run --rm -v "$PWD":/apps -w /apps alpine/helm:3.16.2 template gitlab-mcp-stage helm --set-json 'secret={"X":"y"}' | grep -iE 'cryptgeon|redis' || echo "clean"
```
Expected: prints `clean`.

- [ ] **Step 4: Commit**

```bash
cd /tmp/claude-1000/-home-lxne-WORK-trucker-gitlab-mcp/b9dad545-b2b8-446a-b5c7-d11142245151/scratchpad/gitlab-mcp-deploy
git add helm/templates/configuration/secret.yaml
git commit -m "feat(helm): Vault-rendered Opaque Secret for app env"
```

---

### Task 5: GitLab CI (`.gitlab-ci.yml` + staging deploy job)

**Files:**
- Create: `.gitlab-ci.yml`
- Create: `.gitlab/k8s/deploy_staging.gitlab-ci.yml`

**Interfaces:**
- Consumes: the `helm/` chart from Tasks 1-4; CI variables `KUBECONFIG_STAGING_BASE64`, `vault_role_id`, `vault_secret_id`, and optional `IMAGE_TAG`.
- Produces: a `deploy_staging` job that runs `helm upgrade --install gitlab-mcp-stage ./helm`.

- [ ] **Step 1: Create `.gitlab-ci.yml`**

```yaml
variables:
  RUNNER_TAG: docker-19-yandex
  IMAGE_TAG: latest

default:
  tags:
    - $RUNNER_TAG

stages:
  - deploy

include:
  - local: .gitlab/k8s/deploy_staging.gitlab-ci.yml
```

- [ ] **Step 2: Create `.gitlab/k8s/deploy_staging.gitlab-ci.yml`**

```yaml
deploy_staging:
  image: trucker.gitlab.yandexcloud.net:5050/trucker.group/trucker.devops/helm-deployer:v4.0.0
  stage: deploy
  before_script:
    - echo $KUBECONFIG_STAGING_BASE64 | base64 -d > ./kubeconfig-deployer-staging
  script:
    - export VAULT_TOKEN=$(vault write -field=token auth/trucker-app-auth/login role_id=${vault_role_id} secret_id=${vault_secret_id})
    - export SECRET=$(vault kv get -mount=trucker -format=json gitlab-mcp/k8s/gitlab-mcp | jq -r '.data.data')
    - echo "Deploying ${K8S_NAME} to ${NAMESPACE} at ${APPLICATION_URL}"
    - helm --kubeconfig=${KUBECONFIG}
      --namespace ${NAMESPACE} upgrade
      --values ./helm/${HELM_VALUES_FILE}
      --install ${K8S_NAME} ./helm
      --set timestamp=$(date +%s)
      --set imageTag=${IMAGE_TAG}
      --set appUrl="${APPLICATION_URL}"
      --set labels.env="${LABEL_ENV}"
      --set-json secret="$SECRET"
  variables:
    K8S_NAME: gitlab-mcp-stage
    NAMESPACE: trucker-staging
    HELM_VALUES_FILE: values.yaml
    APPLICATION_URL: gitlab-mcp.trucker.group
    LABEL_ENV: staging
    KUBECONFIG: kubeconfig-deployer-staging
  environment:
    name: staging
    url: https://$APPLICATION_URL
```

Note: kept structurally identical to cryptogeon's job, minus the second (TMS) kubeconfig which cryptogeon decoded but never used; `imageTag` comes from `${IMAGE_TAG}` instead of `${CI_COMMIT_SHA}`; Vault path is `gitlab-mcp/k8s/gitlab-mcp`.

- [ ] **Step 3: Validate CI YAML is well-formed**

Run:
```bash
cd /tmp/claude-1000/-home-lxne-WORK-trucker-gitlab-mcp/b9dad545-b2b8-446a-b5c7-d11142245151/scratchpad/gitlab-mcp-deploy
docker run --rm -v "$PWD":/w -w /w mikefarah/yq:4 eval '.stages' .gitlab-ci.yml
docker run --rm -v "$PWD":/w -w /w mikefarah/yq:4 eval '.deploy_staging.variables.K8S_NAME' .gitlab/k8s/deploy_staging.gitlab-ci.yml
```
Expected: first prints a list containing `deploy`; second prints `gitlab-mcp-stage`. No YAML parse error.

- [ ] **Step 4: Commit**

```bash
cd /tmp/claude-1000/-home-lxne-WORK-trucker-gitlab-mcp/b9dad545-b2b8-446a-b5c7-d11142245151/scratchpad/gitlab-mcp-deploy
git add .gitlab-ci.yml .gitlab/k8s/deploy_staging.gitlab-ci.yml
git commit -m "ci: staging deploy job (helm-deployer, vault, helm upgrade)"
```

---

### Task 6: README + push to GitLab

**Files:**
- Create: `README.md` (in the deploy repo clone)

**Interfaces:**
- Consumes: everything above.
- Produces: the populated `main` branch pushed to `origin` (GitLab).

- [ ] **Step 1: Create `README.md`**

````markdown
# gitlab-mcp — deploy

Infrastructure and Helm chart to deploy [gitlab-mcp](https://github.com/DOCKERHUB_ORG/gitlab-mcp)
(an MCP server for GitLab) to Kubernetes on Yandex Cloud. Mirrors the
`cryptogeon` deploy layout.

The application source lives on GitHub; GitHub Actions builds and pushes the
Docker image to public Docker Hub (`DOCKERHUB_ORG/gitlab-mcp`). This repo only
rolls a given image tag into the cluster.

## Layout

- `.gitlab-ci.yml` — single `deploy` stage.
- `.gitlab/k8s/deploy_staging.gitlab-ci.yml` — staging deploy job (Vault + Helm).
- `helm/` — chart: app Deployment, Service, Ingress, Vault-rendered Secret.

## Deploying

Run the pipeline. To deploy a specific version, set the `IMAGE_TAG` pipeline
variable (default `latest`), e.g. `IMAGE_TAG=v1.2.3`.

Migrations run automatically on container start (`prisma migrate deploy` in the
image entrypoint). PostgreSQL is external (managed).

## Required configuration

**GitLab CI variables:** `KUBECONFIG_STAGING_BASE64`, `vault_role_id`,
`vault_secret_id`, optional `IMAGE_TAG`.

**Vault** (`trucker` mount, path `gitlab-mcp/k8s/gitlab-mcp`) — keys become
container env vars: `DATABASE_URL` (managed PG), `GITLAB_CLIENT_ID`,
`GITLAB_CLIENT_SECRET`, `ENCRYPTION_KEY`, `GITLAB_BASE_URL`, `GITLAB_SCOPES`,
`GITLAB_REDIRECT_URI=https://gitlab-mcp.trucker.group/auth/callback`,
`PUBLIC_BASE_URL=https://gitlab-mcp.trucker.group`, `NODE_ENV=production`,
`SESSION_TTL_HOURS`.

**External:** managed PostgreSQL reachable from the cluster; GitLab OAuth app
with redirect URI `https://gitlab-mcp.trucker.group/auth/callback`; DNS
`gitlab-mcp.trucker.group` → ingress; TLS secret `wildcard-trucker-group`
present in `trucker-staging`.
````

- [ ] **Step 2: Commit**

```bash
cd /tmp/claude-1000/-home-lxne-WORK-trucker-gitlab-mcp/b9dad545-b2b8-446a-b5c7-d11142245151/scratchpad/gitlab-mcp-deploy
git add README.md
git commit -m "docs: deploy repo README"
```

- [ ] **Step 3: Final full-chart sanity check**

Run:
```bash
cd /tmp/claude-1000/-home-lxne-WORK-trucker-gitlab-mcp/b9dad545-b2b8-446a-b5c7-d11142245151/scratchpad/gitlab-mcp-deploy
docker run --rm -v "$PWD":/apps -w /apps alpine/helm:3.16.2 lint helm
docker run --rm -v "$PWD":/apps -w /apps alpine/helm:3.16.2 template gitlab-mcp-stage helm --set-json 'secret={"DATABASE_URL":"x"}' | grep -iE 'cryptgeon|redis' || echo "clean"
```
Expected: `0 chart(s) failed`; prints `clean`.

- [ ] **Step 4: Push to GitLab**

```bash
cd /tmp/claude-1000/-home-lxne-WORK-trucker-gitlab-mcp/b9dad545-b2b8-446a-b5c7-d11142245151/scratchpad/gitlab-mcp-deploy
GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new" git push -u origin main
```
Expected: branch `main` created on the remote; subsequent `git log origin/main` shows the 6 commits.

---

## Post-implementation (manual, human-in-the-loop — NOT automated by this plan)

These require live infrastructure and human confirmation; do not script them:
1. Confirm/replace `DOCKERHUB_ORG` with the real Docker Hub org in `helm/values.yaml` and `README.md`.
2. Ensure GitHub Actions publishes `DOCKERHUB_ORG/gitlab-mcp` to Docker Hub.
3. Populate Vault path `trucker/gitlab-mcp/k8s/gitlab-mcp` and GitLab CI variables.
4. Run the pipeline; then smoke-test `GET https://gitlab-mcp.trucker.group/healthz` → 200 and check pod logs for a successful `prisma migrate deploy`.
