#!/usr/bin/env node
// Stack-aware CI/CD workflow generator for Orca-Pod.
// Detects project tech stacks (Python, Node/Vue/React/Vite, Go, Rust, Docker Compose)
// including hybrid/monorepo layouts (e.g. backend/ + frontend/), generates executable
// GitHub Actions / Gitea Actions CI workflows, and optionally generates a private/intranet
// Self-Hosted Runner CD workflow (outbound HTTPS polling, zero public SSH, automated
// post-deploy health check). Zero external dependencies (Node >= 18).

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build",
  ".orca", ".github", ".gitea", ".next", ".nuxt", "target", "vendor", "coverage",
]);

function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function readTextSafe(p) {
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

function candidateDirs(projectDir) {
  const dirs = ["."];
  try {
    for (const name of readdirSync(projectDir).sort()) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const full = join(projectDir, name);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch { continue; }
      dirs.push(name);
      // One extra level for common monorepo roots like apps/* or packages/* or services/*
      if (/^(?:apps|packages|services)$/.test(name)) {
        try {
          for (const sub of readdirSync(full).sort()) {
            if (SKIP_DIRS.has(sub) || sub.startsWith(".")) continue;
            const subFull = join(full, sub);
            try {
              if (statSync(subFull).isDirectory()) dirs.push(join(name, sub).replace(/\\/g, "/"));
            } catch {}
          }
        } catch {}
      }
    }
  } catch {}
  return dirs;
}

function detectPythonInDir(projectDir, relDir) {
  const abs = relDir === "." ? projectDir : join(projectDir, relDir);
  const pyproject = existsSync(join(abs, "pyproject.toml"));
  const reqTxt = existsSync(join(abs, "requirements.txt"));
  const reqDev = existsSync(join(abs, "requirements-dev.txt"));
  const setupPy = existsSync(join(abs, "setup.py"));
  const pipfile = existsSync(join(abs, "Pipfile"));
  const pytestIni = existsSync(join(abs, "pytest.ini"));
  if (!pyproject && !reqTxt && !setupPy && !pipfile && !pytestIni) return null;

  const pyContent = [
    pyproject ? readTextSafe(join(abs, "pyproject.toml")) : "",
    reqTxt ? readTextSafe(join(abs, "requirements.txt")) : "",
    reqDev ? readTextSafe(join(abs, "requirements-dev.txt")) : "",
  ].join("\n");

  const hasUv = existsSync(join(abs, "uv.lock")) || /\[tool\.uv\]/.test(pyContent);
  const hasPoetry = existsSync(join(abs, "poetry.lock")) || /\[tool\.poetry\]/.test(pyContent);
  const hasPytest = pytestIni || existsSync(join(abs, "tests")) || existsSync(join(abs, "test")) || /\bpytest\b/i.test(pyContent);
  const hasRuff = existsSync(join(abs, "ruff.toml")) || existsSync(join(abs, ".ruff.toml")) || /\bruff\b/i.test(pyContent);
  const hasFlake8 = existsSync(join(abs, ".flake8")) || /\bflake8\b/i.test(pyContent);
  const hasFastapi = /\bfastapi\b/i.test(pyContent);
  const hasFlask = /\bflask\b/i.test(pyContent);
  const hasDjango = existsSync(join(abs, "manage.py")) || /\bdjango\b/i.test(pyContent);

  const verMatch = pyContent.match(/requires-python\s*=\s*["'][^"']*?(3\.\d+)/);
  const pythonVersion = verMatch ? verMatch[1] : "3.12";

  return {
    type: "python",
    dir: relDir,
    packageManager: hasUv ? "uv" : hasPoetry ? "poetry" : "pip",
    pythonVersion,
    hasPyproject: pyproject,
    hasRequirements: reqTxt,
    hasRequirementsDev: reqDev,
    hasPytest,
    hasRuff,
    hasFlake8,
    frameworks: [hasFastapi && "fastapi", hasFlask && "flask", hasDjango && "django"].filter(Boolean),
  };
}

function detectNodeInDir(projectDir, relDir) {
  const abs = relDir === "." ? projectDir : join(projectDir, relDir);
  const pkgPath = join(abs, "package.json");
  if (!existsSync(pkgPath)) return null;
  const pkg = readJsonSafe(pkgPath);
  if (!pkg || typeof pkg !== "object") return null;

  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};

  let packageManager = "npm";
  if (existsSync(join(abs, "pnpm-lock.yaml")) || existsSync(join(projectDir, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (existsSync(join(abs, "yarn.lock")) || existsSync(join(projectDir, "yarn.lock"))) packageManager = "yarn";
  else if (existsSync(join(abs, "bun.lockb")) || existsSync(join(abs, "bun.lock"))) packageManager = "bun";

  const frameworks = [
    deps.vue && "vue",
    deps.vite && "vite",
    deps.react && "react",
    deps.next && "next",
    deps.nuxt && "nuxt",
    deps.svelte && "svelte",
    deps.typescript && "typescript",
    deps.vitest && "vitest",
    deps.jest && "jest",
  ].filter(Boolean);

  return {
    type: "node",
    dir: relDir,
    name: pkg.name || relDir,
    packageManager,
    nodeVersion: "22",
    hasLockfile:
      existsSync(join(abs, "package-lock.json")) ||
      existsSync(join(abs, "pnpm-lock.yaml")) ||
      existsSync(join(abs, "yarn.lock")),
    scripts: {
      lint: Boolean(scripts.lint),
      typecheck: Boolean(scripts.typecheck || scripts["type-check"]),
      typecheckName: scripts.typecheck ? "typecheck" : (scripts["type-check"] ? "type-check" : null),
      test: Boolean(scripts.test && !/no test specified/i.test(String(scripts.test))),
      build: Boolean(scripts.build),
    },
    frameworks,
  };
}

function detectGoInDir(projectDir, relDir) {
  const abs = relDir === "." ? projectDir : join(projectDir, relDir);
  const modPath = join(abs, "go.mod");
  if (!existsSync(modPath)) return null;
  const content = readTextSafe(modPath);
  const verMatch = content.match(/^go\s+(\d+\.\d+)/m);
  return { type: "go", dir: relDir, goVersion: verMatch ? verMatch[1] : "1.22" };
}

function detectRustInDir(projectDir, relDir) {
  const abs = relDir === "." ? projectDir : join(projectDir, relDir);
  if (!existsSync(join(abs, "Cargo.toml"))) return null;
  return { type: "rust", dir: relDir };
}

export function detectProjectStacks(projectDir = process.cwd()) {
  const dirs = candidateDirs(projectDir);
  const python = [];
  const node = [];
  const go = [];
  const rust = [];
  const dockerfiles = [];
  let composeFile = null;

  for (const name of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    if (existsSync(join(projectDir, name))) { composeFile = name; break; }
  }

  for (const rel of dirs) {
    const abs = rel === "." ? projectDir : join(projectDir, rel);
    const py = detectPythonInDir(projectDir, rel);
    if (py) python.push(py);
    const nd = detectNodeInDir(projectDir, rel);
    if (nd) node.push(nd);
    const g = detectGoInDir(projectDir, rel);
    if (g) go.push(g);
    const rs = detectRustInDir(projectDir, rel);
    if (rs) rust.push(rs);
    if (existsSync(join(abs, "Dockerfile"))) {
      dockerfiles.push(rel === "." ? "Dockerfile" : `${rel}/Dockerfile`);
    }
    if (!composeFile && rel !== ".") {
      for (const name of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
        if (existsSync(join(abs, name))) { composeFile = `${rel}/${name}`; break; }
      }
    }
  }

  const parts = [];
  for (const p of python) parts.push(`Python(${p.dir === "." ? "root" : p.dir}${p.frameworks.length ? ":" + p.frameworks.join("+") : ""})`);
  for (const n of node) parts.push(`Node/${n.packageManager}(${n.dir === "." ? "root" : n.dir}${n.frameworks.length ? ":" + n.frameworks.slice(0, 3).join("+") : ""})`);
  for (const g of go) parts.push(`Go(${g.dir === "." ? "root" : g.dir})`);
  for (const r of rust) parts.push(`Rust(${r.dir === "." ? "root" : r.dir})`);
  if (composeFile) parts.push(`DockerCompose(${composeFile})`);
  else if (dockerfiles.length) parts.push(`Docker(${dockerfiles.join(",")})`);

  return {
    projectDir: resolve(projectDir),
    python,
    node,
    go,
    rust,
    dockerfiles,
    composeFile,
    hasAny: python.length + node.length + go.length + rust.length + dockerfiles.length + (composeFile ? 1 : 0) > 0,
    summary: parts.length ? parts.join(" + ") : "Generic (no stack manifest detected yet)",
  };
}

function safeJobId(prefix, relDir, idx) {
  if (relDir === ".") return prefix;
  const slug = relDir.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${prefix}-${slug || idx}`;
}

function renderPythonJob(py, idx) {
  const jobId = safeJobId("verify-python", py.dir, idx);
  const wd = py.dir === "." ? "" : `\n    defaults:\n      run:\n        working-directory: ${py.dir}`;
  const label = py.dir === "." ? "Python" : `Python (${py.dir})`;

  const installLines = [];
  if (py.packageManager === "uv") {
    installLines.push("pip install uv", "uv sync --frozen || uv sync");
  } else if (py.packageManager === "poetry") {
    installLines.push("pip install poetry", "poetry install --no-interaction");
  } else {
    installLines.push("python -m pip install --upgrade pip");
    if (py.hasRequirements) installLines.push("pip install -r requirements.txt");
    if (py.hasRequirementsDev) installLines.push("pip install -r requirements-dev.txt");
    if (py.hasPyproject && !py.hasRequirements) installLines.push("pip install -e '.[dev]' || pip install -e .");
    if (py.hasPytest && !py.hasRequirementsDev) installLines.push("python -c 'import pytest' 2>/dev/null || pip install pytest");
  }

  const runPrefix = py.packageManager === "uv" ? "uv run " : py.packageManager === "poetry" ? "poetry run " : "";
  const testLines = [];
  if (py.hasRuff) testLines.push(`${runPrefix}ruff check .`);
  else if (py.hasFlake8) testLines.push(`${runPrefix}flake8 .`);
  if (py.hasPytest) testLines.push(`${runPrefix}pytest -q`);
  else testLines.push("python -m compileall -q .", "python -m unittest discover -q || true");

  const yaml = [
    `  ${jobId}:`,
    `    name: Verify ${label}`,
    `    runs-on: ubuntu-latest${wd}`,
    `    steps:`,
    `      - name: Checkout repository`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          fetch-depth: 0`,
    ``,
    `      - name: Setup Python ${py.pythonVersion}`,
    `        uses: actions/setup-python@v5`,
    `        with:`,
    `          python-version: "${py.pythonVersion}"`,
    `          cache: "pip"`,
    ``,
    `      - name: Install Python dependencies`,
    `        run: |`,
    ...installLines.map((l) => `          ${l}`),
    ``,
    `      - name: Run Python lint & tests`,
    `        run: |`,
    ...testLines.map((l) => `          ${l}`),
  ].join("\n");

  return { jobId, yaml };
}

function renderNodeJob(nd, idx) {
  const jobId = safeJobId("verify-node", nd.dir, idx);
  const wd = nd.dir === "." ? "" : `\n    defaults:\n      run:\n        working-directory: ${nd.dir}`;
  const label = nd.dir === "." ? "Node" : `Node (${nd.dir})`;
  const pm = nd.packageManager;

  const setupExtra = pm === "pnpm"
    ? [
      ``,
      `      - name: Enable pnpm`,
      `        run: corepack enable`,
    ]
    : [];

  const installCmd = pm === "pnpm"
    ? "pnpm install --frozen-lockfile || pnpm install"
    : pm === "yarn"
      ? "yarn install --frozen-lockfile || yarn install"
      : pm === "bun"
        ? "bun install"
        : (nd.hasLockfile ? "npm ci" : "npm install");

  const runCmd = (script) => pm === "pnpm" ? `pnpm run ${script}` : pm === "yarn" ? `yarn ${script}` : pm === "bun" ? `bun run ${script}` : `npm run ${script}`;
  const testLines = [];
  if (nd.scripts.lint) testLines.push(runCmd("lint"));
  if (nd.scripts.typecheck) testLines.push(runCmd(nd.scripts.typecheckName || "typecheck"));
  if (nd.scripts.test) testLines.push(pm === "npm" ? "npm test" : runCmd("test"));
  if (nd.scripts.build) testLines.push(runCmd("build"));
  if (!testLines.length) {
    testLines.push(`${pm} run --if-present lint`, `${pm} run --if-present typecheck`, `${pm} test --if-present`, `${pm} run --if-present build`);
  }

  const yaml = [
    `  ${jobId}:`,
    `    name: Verify ${label}`,
    `    runs-on: ubuntu-latest${wd}`,
    `    steps:`,
    `      - name: Checkout repository`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          fetch-depth: 0`,
    ``,
    `      - name: Setup Node.js ${nd.nodeVersion}`,
    `        uses: actions/setup-node@v4`,
    `        with:`,
    `          node-version: "${nd.nodeVersion}"`,
    ...setupExtra,
    ``,
    `      - name: Install dependencies`,
    `        run: ${installCmd}`,
    ``,
    `      - name: Run lint / typecheck / test / build`,
    `        run: |`,
    ...testLines.map((l) => `          ${l}`),
  ].join("\n");

  return { jobId, yaml };
}

function renderGoJob(g, idx) {
  const jobId = safeJobId("verify-go", g.dir, idx);
  const wd = g.dir === "." ? "" : `\n    defaults:\n      run:\n        working-directory: ${g.dir}`;
  const yaml = [
    `  ${jobId}:`,
    `    name: Verify Go${g.dir === "." ? "" : ` (${g.dir})`}`,
    `    runs-on: ubuntu-latest${wd}`,
    `    steps:`,
    `      - uses: actions/checkout@v4`,
    `      - uses: actions/setup-go@v5`,
    `        with:`,
    `          go-version: "${g.goVersion}"`,
    `      - name: Vet & Test`,
    `        run: |`,
    `          go vet ./...`,
    `          go test -race ./...`,
  ].join("\n");
  return { jobId, yaml };
}

function renderRustJob(rs, idx) {
  const jobId = safeJobId("verify-rust", rs.dir, idx);
  const wd = rs.dir === "." ? "" : `\n    defaults:\n      run:\n        working-directory: ${rs.dir}`;
  const yaml = [
    `  ${jobId}:`,
    `    name: Verify Rust${rs.dir === "." ? "" : ` (${rs.dir})`}`,
    `    runs-on: ubuntu-latest${wd}`,
    `    steps:`,
    `      - uses: actions/checkout@v4`,
    `      - name: Clippy & Test`,
    `        run: |`,
    `          cargo clippy --all-targets -- -D warnings`,
    `          cargo test`,
  ].join("\n");
  return { jobId, yaml };
}

function renderDockerJob(detection) {
  const steps = [
    `      - name: Checkout repository`,
    `        uses: actions/checkout@v4`,
  ];
  if (detection.composeFile) {
    steps.push(
      ``,
      `      - name: Validate Docker Compose schema (${detection.composeFile})`,
      `        run: docker compose -f "${detection.composeFile}" config --quiet`
    );
  }
  for (const df of detection.dockerfiles) {
    const ctx = dirname(df) === "." ? "." : dirname(df);
    steps.push(
      ``,
      `      - name: Validate Dockerfile build (${df})`,
      `        run: docker build --file "${df}" "${ctx}"`
    );
  }
  const yaml = [
    `  verify-docker:`,
    `    name: Verify Docker / Compose`,
    `    runs-on: ubuntu-latest`,
    `    steps:`,
    ...steps,
  ].join("\n");
  return { jobId: "verify-docker", yaml };
}

function renderGenericAutoDetectJob() {
  const yaml = [
    `  verify:`,
    `    name: Auto-Detect Stack Verification (Python / Node / Go / Rust / Docker)`,
    `    runs-on: ubuntu-latest`,
    `    steps:`,
    `      - name: Checkout repository`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          fetch-depth: 0`,
    ``,
    `      - name: Verify Node.js projects (root / frontend)`,
    `        run: |`,
    `          for dir in . frontend web client ui; do`,
    `            if [ -f "$dir/package.json" ]; then`,
    `              echo "=== Node verify: $dir ==="`,
    `              (cd "$dir" && ( [ -f pnpm-lock.yaml ] && corepack enable && pnpm install --frozen-lockfile || ([ -f package-lock.json ] && npm ci || npm install) ) && npm run --if-present lint && npm run --if-present typecheck && npm test --if-present && npm run --if-present build)`,
    `            fi`,
    `          done`,
    ``,
    `      - name: Verify Python projects (root / backend)`,
    `        run: |`,
    `          for dir in . backend server api; do`,
    `            if [ -f "$dir/pyproject.toml" ] || [ -f "$dir/requirements.txt" ]; then`,
    `              echo "=== Python verify: $dir ==="`,
    `              (cd "$dir" && python3 -m pip install --upgrade pip && ([ -f requirements.txt ] && pip install -r requirements.txt || true) && ([ -f requirements-dev.txt ] && pip install -r requirements-dev.txt || true) && (python3 -c 'import pytest' 2>/dev/null && pytest -q || python3 -m compileall -q .))`,
    `            fi`,
    `          done`,
    ``,
    `      - name: Validate Docker Compose (if present)`,
    `        run: |`,
    `          for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do`,
    `            if [ -f "$f" ]; then docker compose -f "$f" config --quiet; fi`,
    `          done`,
  ].join("\n");
  return { jobId: "verify", yaml };
}

function renderTokenHubJob(needsIds, platform = "github") {
  const needsLine = needsIds.length === 1
    ? `    needs: ${needsIds[0]}`
    : `    needs: [${needsIds.join(", ")}]`;
  const commentStep = platform === "gitea"
    ? `            // For Gitea, post comment via API if GITEA_TOKEN is available; otherwise log summary\n            console.log(body);`
    : `            require("node:fs").writeFileSync("/tmp/pr-summary.md", body);\n            execSync(\`gh pr comment "\${process.env.PR_NUMBER}" --body-file /tmp/pr-summary.md\`, { stdio: "inherit" });`;

  return [
    `  tokenhub-pr-review:`,
    `    name: Headless PR Risk Summary (TokenHub API)`,
    `    if: github.event_name == 'pull_request'`,
    `    runs-on: ubuntu-latest`,
    needsLine,
    `    steps:`,
    `      - name: Checkout PR branch`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          fetch-depth: 0`,
    ``,
    `      - name: Generate Chinese PR Risk Summary via TokenHub API`,
    `        env:`,
    `          TOKENHUB_API_KEY: \${{ secrets.TOKENHUB_API_KEY }}`,
    `          TOKENHUB_BASE_URL: \${{ secrets.TOKENHUB_BASE_URL || 'https://api.tokenhub.tencent.com/v1' }}`,
    `          TOKENHUB_MODEL: \${{ vars.TOKENHUB_REVIEW_MODEL || 'DeepSeek-V4.1-Flash-1017' }}`,
    `          BASE_SHA: \${{ github.event.pull_request.base.sha }}`,
    `          HEAD_SHA: \${{ github.event.pull_request.head.sha }}`,
    `          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}`,
    `          PR_NUMBER: \${{ github.event.pull_request.number }}`,
    `        run: |`,
    `          if [ -z "$TOKENHUB_API_KEY" ]; then`,
    `            echo "::notice::TOKENHUB_API_KEY 未配置，跳过无头 PR 风险摘要。"`,
    `            exit 0`,
    `          fi`,
    `          node - <<'EOF'`,
    `          const { execSync } = require("node:child_process");`,
    `          const apiKey = process.env.TOKENHUB_API_KEY;`,
    `          const baseUrl = process.env.TOKENHUB_BASE_URL.replace(/\\/+$/, "");`,
    `          const model = process.env.TOKENHUB_MODEL;`,
    `          const diff = execSync(`,
    `            \`git diff "\${process.env.BASE_SHA}...\${process.env.HEAD_SHA}" -- . ':(exclude)*.lock' ':(exclude)package-lock.json'\`,`,
    `            { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }`,
    `          ).slice(0, 40000);`,
    `          if (!diff.trim()) process.exit(0);`,
    `          (async () => {`,
    `            const resp = await fetch(\`\${baseUrl}/chat/completions\`, {`,
    `              method: "POST",`,
    `              headers: { "Content-Type": "application/json", "Authorization": \`Bearer \${apiKey}\` },`,
    `              body: JSON.stringify({`,
    `                model,`,
    `                temperature: 0.2,`,
    `                messages: [`,
    `                  { role: "system", content: "你是无头 CI PR 风险审查助手。请用简洁中文输出：1) 变更概述；2) 潜在风险点（按高/中/低标注）；3) 合并前人工确认建议。控制在 300 字以内。" },`,
    `                  { role: "user", content: \`请审查以下 Pull Request Diff：\\n\\n\${diff}\` }`,
    `                ]`,
    `              })`,
    `            });`,
    `            if (!resp.ok) { console.error(\`TokenHub API error: HTTP \${resp.status}\`); process.exit(0); }`,
    `            const data = await resp.json();`,
    `            const summary = data?.choices?.[0]?.message?.content?.trim();`,
    `            if (!summary) process.exit(0);`,
    `            const body = \`### 🤖 TokenHub CI 风险摘要（\\\`\${model}\\\`）\\n\\n\${summary}\\n\\n> 注：本摘要由无头 CI 自动生成，最终合并需人工确认。\`;`,
    commentStep,
    `          })().catch((e) => console.error("TokenHub review skipped:", e.message));`,
    `          EOF`,
  ].join("\n");
}

export function renderCiWorkflow(detection, {
  platform = "github",
  branches = ["main", "master", "dev"],
  includeTokenHub = true,
} = {}) {
  const jobs = [];
  detection.python.forEach((py, i) => jobs.push(renderPythonJob(py, i)));
  detection.node.forEach((nd, i) => jobs.push(renderNodeJob(nd, i)));
  detection.go.forEach((g, i) => jobs.push(renderGoJob(g, i)));
  detection.rust.forEach((rs, i) => jobs.push(renderRustJob(rs, i)));
  if (detection.composeFile || detection.dockerfiles.length) {
    jobs.push(renderDockerJob(detection));
  }
  if (!jobs.length) {
    jobs.push(renderGenericAutoDetectJob());
  }

  const jobIds = jobs.map((j) => j.jobId);
  const header = [
    `# Generated by orca-pod ci-generator (stack: ${detection.summary})`,
    `name: CI & PR Verification`,
    ``,
    `on:`,
    `  pull_request:`,
    `    branches: [${branches.join(", ")}]`,
    `  push:`,
    `    branches: [${branches.join(", ")}]`,
    ``,
    `permissions:`,
    `  contents: read`,
    `  pull-requests: write`,
    ``,
    `jobs:`,
  ].join("\n");

  const bodyParts = jobs.map((j) => j.yaml);
  if (includeTokenHub) {
    bodyParts.push(renderTokenHubJob(jobIds, platform));
  }
  return `${header}\n${bodyParts.join("\n\n")}\n`;
}

export function renderSelfHostedCdWorkflow(detection, {
  deployBranch = "main",
  runnerLabels = ["self-hosted", "linux"],
  healthUrl = "http://127.0.0.1:8000/health",
  deployDir = "",
  serviceName = "",
} = {}) {
  const composeFile = detection?.composeFile || null;
  const labelsYaml = `[${runnerLabels.join(", ")}]`;

  const deployStep = composeFile
    ? [
      `      - name: Deploy with Docker Compose (${composeFile})`,
      `        run: |`,
      `          set -euo pipefail`,
      `          COMPOSE_FILE="${composeFile}"`,
      `          echo "Building & starting services via $COMPOSE_FILE ..."`,
      `          docker compose -f "$COMPOSE_FILE" up -d --build --remove-orphans`,
      `          docker compose -f "$COMPOSE_FILE" ps`,
    ]
    : [
      `      - name: Run intranet deploy hook`,
      `        run: |`,
      `          set -euo pipefail`,
      `          if [ -x ./scripts/deploy.sh ]; then`,
      `            ./scripts/deploy.sh`,
      ...(serviceName
        ? [`          elif command -v systemctl >/dev/null 2>&1; then`, `            sudo systemctl restart "${serviceName}"`]
        : []),
      `          else`,
      `            echo "::error::No docker-compose.yml or executable ./scripts/deploy.sh found."`,
      `            exit 1`,
      `          fi`,
    ];

  const healthCheckStep = [
    `      - name: Post-deploy automated health check`,
    `        env:`,
    `          HEALTHCHECK_URL: \${{ vars.DEPLOY_HEALTHCHECK_URL || '${healthUrl}' }}`,
    `          HEALTHCHECK_RETRIES: \${{ vars.DEPLOY_HEALTHCHECK_RETRIES || '15' }}`,
    `          HEALTHCHECK_INTERVAL: \${{ vars.DEPLOY_HEALTHCHECK_INTERVAL || '4' }}`,
    `        run: |`,
    `          set -euo pipefail`,
    ...(composeFile
      ? [
        `          echo "Checking container states..."`,
        `          if docker compose -f "${composeFile}" ps --status exited --status dead --format json 2>/dev/null | grep -q '"State"'; then`,
        `            echo "::error::One or more containers exited unexpectedly!"`,
        `            docker compose -f "${composeFile}" logs --tail=80`,
        `            exit 1`,
        `          fi`,
      ]
      : []),
    `          echo "Probing $HEALTHCHECK_URL (retries=$HEALTHCHECK_RETRIES, interval=\${HEALTHCHECK_INTERVAL}s)..."`,
    `          ok=0`,
    `          for i in $(seq 1 "$HEALTHCHECK_RETRIES"); do`,
    `            if curl -fsS --max-time 5 "$HEALTHCHECK_URL" >/dev/null 2>&1; then`,
    `              echo "Health check PASSED on attempt $i/$HEALTHCHECK_RETRIES"`,
    `              ok=1`,
    `              break`,
    `            fi`,
    `            echo "Attempt $i/$HEALTHCHECK_RETRIES not ready yet; sleeping \${HEALTHCHECK_INTERVAL}s..."`,
    `            sleep "$HEALTHCHECK_INTERVAL"`,
    `          done`,
    `          if [ "$ok" -ne 1 ]; then`,
    `            echo "::error::Post-deploy health check FAILED for $HEALTHCHECK_URL"`,
    ...(composeFile ? [`            docker compose -f "${composeFile}" logs --tail=100 || true`] : []),
    `            exit 1`,
    `          fi`,
  ];

  const workdirStep = deployDir
    ? [
      `      - name: Sync checkout to deploy directory (${deployDir})`,
      `        run: |`,
      `          mkdir -p "${deployDir}"`,
      `          rsync -a --delete --exclude '.git' --exclude '.env' ./ "${deployDir}/"`,
    ]
    : [];

  return [
    `# Generated by orca-pod ci-generator — Intranet Self-Hosted Runner CD`,
    `# Architecture: Self-Hosted Runner runs inside your private/home intranet and pulls`,
    `# jobs via OUTBOUND HTTPS (443) only — ZERO public SSH / port forwarding required.`,
    `# Setup on intranet host: Repo Settings -> Actions -> Runners -> New self-hosted runner.`,
    `name: CD — Intranet Self-Hosted Deploy`,
    ``,
    `on:`,
    `  push:`,
    `    branches: [${deployBranch}]`,
    `  workflow_dispatch:`,
    `    inputs:`,
    `      reason:`,
    `        description: "Manual deploy note"`,
    `        required: false`,
    `        default: "manual trigger"`,
    ``,
    `concurrency:`,
    `  group: cd-intranet-\${{ github.ref }}`,
    `  cancel-in-progress: false`,
    ``,
    `jobs:`,
    `  deploy-intranet:`,
    `    name: Deploy to Private/Intranet Host`,
    `    runs-on: ${labelsYaml}`,
    `    timeout-minutes: 20`,
    `    steps:`,
    `      - name: Checkout target revision`,
    `        uses: actions/checkout@v4`,
    ...(workdirStep.length ? ["", ...workdirStep] : []),
    ``,
    ...deployStep,
    ``,
    ...healthCheckStep,
    ``,
  ].join("\n");
}

export function generateCiCdFiles(projectDir = process.cwd(), {
  writeGithubCi = true,
  writeGiteaCi = false,
  writeSelfHostedCd = false,
  force = true,
  branches = ["main", "master", "dev"],
  deployBranch = "main",
  runnerLabels = ["self-hosted", "linux"],
  healthUrl = "http://127.0.0.1:8000/health",
  includeTokenHub = true,
} = {}) {
  const detection = detectProjectStacks(projectDir);
  const written = [];
  const skipped = [];

  const emit = (relPath, content) => {
    const abs = join(projectDir, relPath);
    if (existsSync(abs) && !force) {
      skipped.push(relPath);
      return;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    written.push(relPath);
  };

  if (writeGithubCi) {
    emit(".github/workflows/ci-release.yml", renderCiWorkflow(detection, { platform: "github", branches, includeTokenHub }));
  }
  if (writeGiteaCi) {
    emit(".gitea/workflows/ci-release.yml", renderCiWorkflow(detection, { platform: "gitea", branches, includeTokenHub }));
  }
  if (writeSelfHostedCd) {
    emit(".github/workflows/cd-selfhosted.yml", renderSelfHostedCdWorkflow(detection, { deployBranch, runnerLabels, healthUrl }));
  }

  return { detection, written, skipped };
}

// --- Standalone CLI ---
const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const getFlag = (name, def = null) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  const projectDir = resolve(getFlag("--dir", process.cwd()));
  const asJson = args.includes("--json");
  const doWrite = args.includes("--write");
  const selfHostedCd = args.includes("--self-hosted-cd");
  const gitea = args.includes("--gitea");
  const healthUrl = getFlag("--health-url", "http://127.0.0.1:8000/health");
  const deployBranch = getFlag("--deploy-branch", "main");
  const labelsRaw = getFlag("--runner-labels", "self-hosted,linux");
  const runnerLabels = labelsRaw.split(",").map((s) => s.trim()).filter(Boolean);

  if (!doWrite) {
    const detection = detectProjectStacks(projectDir);
    if (asJson) console.log(JSON.stringify(detection, null, 2));
    else {
      console.log(`[orca-ci] Project: ${detection.projectDir}`);
      console.log(`[orca-ci] Detected stack: ${detection.summary}`);
      console.log(`[orca-ci] Run with --write [--self-hosted-cd] to generate workflow YAML(s).`);
    }
    process.exit(0);
  }

  const res = generateCiCdFiles(projectDir, {
    writeGithubCi: true,
    writeGiteaCi: gitea,
    writeSelfHostedCd: selfHostedCd,
    force: true,
    deployBranch,
    runnerLabels,
    healthUrl,
  });
  if (asJson) console.log(JSON.stringify(res, null, 2));
  else {
    console.log(`[orca-ci] Detected stack: ${res.detection.summary}`);
    for (const f of res.written) console.log(`[orca-ci] wrote ${f}`);
  }
  process.exit(0);
}
