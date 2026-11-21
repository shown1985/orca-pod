#!/usr/bin/env node
// Stack-aware CI/CD workflow generator for Orca-Pod.
// Detects project tech stacks (Python, Node/Vue/React/Vite, Go, Rust, Docker Compose)
// including hybrid/monorepo layouts (e.g. backend/ + frontend/), generates executable
// GitHub Actions / Gitea Actions CI workflows with strict exit codes, least-privilege
// permissions, safe YAML scalar serialization & unique job IDs, and optionally generates
// a PII-safe intranet Self-Hosted Runner CD workflow (preserving existing cd-selfhosted.yml
// unless --force is explicitly passed). Zero external dependencies (Node >= 18).

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build",
  ".orca", ".github", ".gitea", ".next", ".nuxt", "target", "vendor", "coverage",
]);

const PROD_COMPOSE_NAMES = [
  "docker-compose.prod.yml",
  "docker-compose.prod.yaml",
  "compose.prod.yml",
  "compose.prod.yaml",
];

const DEV_COMPOSE_NAMES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

const ALL_COMPOSE_NAMES = [...PROD_COMPOSE_NAMES, ...DEV_COMPOSE_NAMES];
const SAFE_SIMPLE_TOKEN_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Serialize any scalar value safely for YAML 1.2 (handles colons, spaces, quotes,
 * brackets, leading special chars, and strips newlines).
 */
export function yamlScalar(val) {
  const s = String(val ?? "").replace(/\r?\n/g, " ");
  return JSON.stringify(s);
}

function yamlTokenOrQuoted(val) {
  const s = String(val ?? "").trim();
  if (s && /^[A-Za-z0-9._-]+$/.test(s) && !/^(?:true|false|null|yes|no|on|off|~)$/i.test(s)) {
    return s;
  }
  return yamlScalar(s);
}

function yamlCommentText(val) {
  return String(val ?? "").replace(/[\r\n]+/g, " ").trim();
}

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

  const pyprojectText = pyproject ? readTextSafe(join(abs, "pyproject.toml")) : "";
  const pyContent = [
    pyprojectText,
    reqTxt ? readTextSafe(join(abs, "requirements.txt")) : "",
    reqDev ? readTextSafe(join(abs, "requirements-dev.txt")) : "",
  ].join("\n");

  const hasUv = existsSync(join(abs, "uv.lock")) || /\[tool\.uv\]/.test(pyContent);
  const hasUvLock = existsSync(join(abs, "uv.lock"));
  const hasPoetry = existsSync(join(abs, "poetry.lock")) || /\[tool\.poetry\]/.test(pyContent);
  const hasPytest = pytestIni || existsSync(join(abs, "tests")) || existsSync(join(abs, "test")) || /\bpytest\b/i.test(pyContent);
  const hasDevExtra = /\[project\.optional-dependencies\][\s\S]*?^\s*dev\s*=/m.test(pyprojectText);
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
    hasUvLock,
    hasPyproject: pyproject,
    hasDevExtra,
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
      existsSync(join(abs, "yarn.lock")) ||
      existsSync(join(projectDir, "pnpm-lock.yaml")) ||
      existsSync(join(projectDir, "yarn.lock")),
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
  let prodComposeFile = null;
  let devComposeFile = null;
  const composeFiles = [];

  for (const name of PROD_COMPOSE_NAMES) {
    if (existsSync(join(projectDir, name))) {
      if (!prodComposeFile) prodComposeFile = name;
      composeFiles.push(name);
    }
  }
  for (const name of DEV_COMPOSE_NAMES) {
    if (existsSync(join(projectDir, name))) {
      if (!devComposeFile) devComposeFile = name;
      composeFiles.push(name);
    }
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
    if (rel !== ".") {
      for (const name of PROD_COMPOSE_NAMES) {
        if (existsSync(join(abs, name))) {
          const p = `${rel}/${name}`;
          if (!prodComposeFile) prodComposeFile = p;
          composeFiles.push(p);
        }
      }
      for (const name of DEV_COMPOSE_NAMES) {
        if (existsSync(join(abs, name))) {
          const p = `${rel}/${name}`;
          if (!devComposeFile) devComposeFile = p;
          composeFiles.push(p);
        }
      }
    }
  }

  // Prioritize docker-compose.prod.yml / compose.prod.yml over dev compose files
  const composeFile = prodComposeFile || devComposeFile || null;
  const cdComposeFile = prodComposeFile || devComposeFile || null;

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
    prodComposeFile,
    devComposeFile,
    cdComposeFile,
    composeFile,
    composeFiles: [...new Set(composeFiles)],
    hasAny: python.length + node.length + go.length + rust.length + dockerfiles.length + (composeFile ? 1 : 0) > 0,
    summary: parts.length ? parts.join(" + ") : "Generic (no stack manifest detected yet)",
  };
}

export function allocateJobId(prefix, relDir, idx, usedJobIds = new Set()) {
  let base = prefix;
  if (relDir !== ".") {
    const slug = String(relDir || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "");
    base = `${prefix}-${slug || idx}`;
  }
  let candidate = base;
  let suffix = 2;
  while (usedJobIds.has(candidate)) {
    candidate = `${base}-${suffix++}`;
  }
  usedJobIds.add(candidate);
  return candidate;
}

function renderWorkingDirDefaults(dir) {
  if (!dir || dir === ".") return "";
  return `\n    defaults:\n      run:\n        working-directory: ${yamlScalar(dir)}`;
}

function renderPythonJob(py, idx, usedJobIds) {
  const jobId = allocateJobId("verify-python", py.dir, idx, usedJobIds);
  const wd = renderWorkingDirDefaults(py.dir);
  const label = py.dir === "." ? "Verify Python" : `Verify Python (${py.dir})`;

  // Never swallow dependency install failures!
  const installLines = ["set -euo pipefail"];
  if (py.packageManager === "uv") {
    installLines.push(
      "python -m pip install uv",
      py.hasUvLock ? "uv sync --frozen" : "uv sync"
    );
  } else if (py.packageManager === "poetry") {
    installLines.push("python -m pip install poetry", "poetry install --no-interaction");
  } else {
    installLines.push("python -m pip install --upgrade pip");
    if (py.hasRequirements) installLines.push("python -m pip install -r requirements.txt");
    if (py.hasRequirementsDev) installLines.push("python -m pip install -r requirements-dev.txt");
    if (py.hasPyproject && !py.hasRequirements) {
      installLines.push(py.hasDevExtra ? "python -m pip install -e '.[dev]'" : "python -m pip install -e .");
    }
    if (py.hasPytest && !py.hasRequirementsDev) {
      installLines.push("if ! python -c \"import pytest\" >/dev/null 2>&1; then python -m pip install pytest; fi");
    }
  }

  const runPrefix = py.packageManager === "uv" ? "uv run " : py.packageManager === "poetry" ? "poetry run " : "";
  // Never swallow pytest or unittest failures with `|| compileall` or `|| true`!
  const testLines = ["set -euo pipefail"];
  if (py.hasRuff) testLines.push(`${runPrefix}ruff check .`);
  else if (py.hasFlake8) testLines.push(`${runPrefix}flake8 .`);
  if (py.hasPytest) {
    testLines.push(`${runPrefix}pytest -q`);
  } else {
    testLines.push(
      "python -m compileall -q .",
      "if find . -maxdepth 4 \\( -name 'test_*.py' -o -name '*_test.py' \\) | grep -q .; then",
      "  python -m unittest discover -q",
      "fi"
    );
  }

  const yaml = [
    `  ${jobId}:`,
    `    name: ${yamlScalar(label)}`,
    `    runs-on: ubuntu-latest${wd}`,
    `    steps:`,
    `      - name: Checkout repository`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          fetch-depth: 0`,
    `          persist-credentials: false`,
    ``,
    `      - name: Setup Python ${py.pythonVersion}`,
    `        uses: actions/setup-python@v5`,
    `        with:`,
    `          python-version: ${yamlScalar(py.pythonVersion)}`,
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

function renderNodeJob(nd, idx, usedJobIds) {
  const jobId = allocateJobId("verify-node", nd.dir, idx, usedJobIds);
  const wd = renderWorkingDirDefaults(nd.dir);
  const label = nd.dir === "." ? "Verify Node" : `Verify Node (${nd.dir})`;
  const pm = nd.packageManager;

  const setupExtra = (pm === "pnpm" || pm === "yarn")
    ? [
      ``,
      `      - name: Enable Corepack (${pm})`,
      `        run: corepack enable`,
    ]
    : [];

  const installCmd = pm === "pnpm"
    ? (nd.hasLockfile ? "pnpm install --frozen-lockfile" : "pnpm install")
    : pm === "yarn"
      ? (nd.hasLockfile ? "yarn install --frozen-lockfile" : "yarn install")
      : pm === "bun"
        ? "bun install"
        : (nd.hasLockfile ? "npm ci" : "npm install");

  const runCmd = (script) => pm === "pnpm" ? `pnpm run ${script}` : pm === "yarn" ? `yarn ${script}` : pm === "bun" ? `bun run ${script}` : `npm run ${script}`;
  const testLines = ["set -euo pipefail"];
  if (nd.scripts.lint) testLines.push(runCmd("lint"));
  if (nd.scripts.typecheck) testLines.push(runCmd(nd.scripts.typecheckName || "typecheck"));
  if (nd.scripts.test) testLines.push(pm === "npm" ? "npm test" : runCmd("test"));
  if (nd.scripts.build) testLines.push(runCmd("build"));
  if (testLines.length === 1) {
    testLines.push(`${pm} run --if-present lint`, `${pm} run --if-present typecheck`, `${pm} test --if-present`, `${pm} run --if-present build`);
  }

  const yaml = [
    `  ${jobId}:`,
    `    name: ${yamlScalar(label)}`,
    `    runs-on: ubuntu-latest${wd}`,
    `    steps:`,
    `      - name: Checkout repository`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          fetch-depth: 0`,
    `          persist-credentials: false`,
    ``,
    `      - name: Setup Node.js ${nd.nodeVersion}`,
    `        uses: actions/setup-node@v4`,
    `        with:`,
    `          node-version: ${yamlScalar(nd.nodeVersion)}`,
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

function renderGoJob(g, idx, usedJobIds) {
  const jobId = allocateJobId("verify-go", g.dir, idx, usedJobIds);
  const wd = renderWorkingDirDefaults(g.dir);
  const label = g.dir === "." ? "Verify Go" : `Verify Go (${g.dir})`;
  const yaml = [
    `  ${jobId}:`,
    `    name: ${yamlScalar(label)}`,
    `    runs-on: ubuntu-latest${wd}`,
    `    steps:`,
    `      - name: Checkout repository`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          persist-credentials: false`,
    `      - name: Setup Go ${g.goVersion}`,
    `        uses: actions/setup-go@v5`,
    `        with:`,
    `          go-version: ${yamlScalar(g.goVersion)}`,
    `      - name: Vet & Test`,
    `        run: |`,
    `          set -euo pipefail`,
    `          go vet ./...`,
    `          go test -race ./...`,
  ].join("\n");
  return { jobId, yaml };
}

function renderRustJob(rs, idx, usedJobIds) {
  const jobId = allocateJobId("verify-rust", rs.dir, idx, usedJobIds);
  const wd = renderWorkingDirDefaults(rs.dir);
  const label = rs.dir === "." ? "Verify Rust" : `Verify Rust (${rs.dir})`;
  const yaml = [
    `  ${jobId}:`,
    `    name: ${yamlScalar(label)}`,
    `    runs-on: ubuntu-latest${wd}`,
    `    steps:`,
    `      - name: Checkout repository`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          persist-credentials: false`,
    `      - name: Clippy & Test`,
    `        run: |`,
    `          set -euo pipefail`,
    `          cargo clippy --all-targets -- -D warnings`,
    `          cargo test`,
  ].join("\n");
  return { jobId, yaml };
}

function renderDockerJob(detection, usedJobIds) {
  const jobId = allocateJobId("verify-docker", ".", 0, usedJobIds);
  const steps = [
    `      - name: Checkout repository`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          persist-credentials: false`,
  ];
  const composeTargets = detection.composeFiles?.length
    ? detection.composeFiles
    : (detection.composeFile ? [detection.composeFile] : []);

  for (const cf of composeTargets) {
    const runLine = SAFE_SIMPLE_TOKEN_RE.test(cf)
      ? `docker compose -f "${cf}" config --quiet`
      : `docker compose -f "$COMPOSE_FILE" config --quiet`;
    steps.push(
      ``,
      `      - name: ${yamlScalar(`Validate Docker Compose schema (${cf})`)}`,
      `        env:`,
      `          COMPOSE_FILE: ${yamlScalar(cf)}`,
      `        run: ${runLine}`
    );
  }
  for (const df of detection.dockerfiles) {
    const ctx = dirname(df) === "." ? "." : dirname(df);
    steps.push(
      ``,
      `      - name: ${yamlScalar(`Validate Dockerfile build (${df})`)}`,
      `        env:`,
      `          DOCKERFILE_PATH: ${yamlScalar(df)}`,
      `          DOCKER_CONTEXT: ${yamlScalar(ctx)}`,
      `        run: docker build --file "$DOCKERFILE_PATH" "$DOCKER_CONTEXT"`
    );
  }
  const yaml = [
    `  ${jobId}:`,
    `    name: "Verify Docker / Compose"`,
    `    runs-on: ubuntu-latest`,
    `    steps:`,
    ...steps,
  ].join("\n");
  return { jobId, yaml };
}

export function renderGenericAutoDetectJob(usedJobIds = new Set()) {
  const jobId = allocateJobId("verify", ".", 0, usedJobIds);
  const yaml = [
    `  ${jobId}:`,
    `    name: "Auto-Detect Stack Verification (Python / Node / Go / Rust / Docker)"`,
    `    runs-on: ubuntu-latest`,
    `    steps:`,
    `      - name: Checkout repository`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          fetch-depth: 0`,
    `          persist-credentials: false`,
    ``,
    `      - name: Setup Node.js 22`,
    `        uses: actions/setup-node@v4`,
    `        with:`,
    `          node-version: "22"`,
    ``,
    `      - name: Setup Python 3.12`,
    `        uses: actions/setup-python@v5`,
    `        with:`,
    `          python-version: "3.12"`,
    ``,
    `      - name: Setup Go (when go.mod exists)`,
    `        if: hashFiles('**/go.mod') != ''`,
    `        uses: actions/setup-go@v5`,
    `        with:`,
    `          go-version: "1.22"`,
    ``,
    `      - name: Verify Node.js projects (root / frontend)`,
    `        run: |`,
    `          set -euo pipefail`,
    `          for dir in . frontend web client ui; do`,
    `            if [ -f "$dir/package.json" ]; then`,
    `              echo "=== Node verify: $dir ==="`,
    `              (`,
    `                cd "$dir"`,
    `                if [ -f pnpm-lock.yaml ]; then`,
    `                  corepack enable`,
    `                  pnpm install --frozen-lockfile`,
    `                  pnpm run --if-present lint`,
    `                  pnpm run --if-present typecheck`,
    `                  pnpm test --if-present`,
    `                  pnpm run --if-present build`,
    `                elif [ -f yarn.lock ]; then`,
    `                  corepack enable`,
    `                  yarn install --frozen-lockfile`,
    `                  yarn run --if-present lint`,
    `                  yarn run --if-present typecheck`,
    `                  yarn test --if-present`,
    `                  yarn run --if-present build`,
    `                elif [ -f package-lock.json ]; then`,
    `                  npm ci`,
    `                  npm run --if-present lint`,
    `                  npm run --if-present typecheck`,
    `                  npm test --if-present`,
    `                  npm run --if-present build`,
    `                else`,
    `                  npm install`,
    `                  npm run --if-present lint`,
    `                  npm run --if-present typecheck`,
    `                  npm test --if-present`,
    `                  npm run --if-present build`,
    `                fi`,
    `              )`,
    `            fi`,
    `          done`,
    ``,
    `      - name: Verify Python projects (root / backend)`,
    `        run: |`,
    `          set -euo pipefail`,
    `          for dir in . backend server api; do`,
    `            if [ -f "$dir/pyproject.toml" ] || [ -f "$dir/requirements.txt" ]; then`,
    `              echo "=== Python verify: $dir ==="`,
    `              (`,
    `                cd "$dir"`,
    `                python3 -m pip install --upgrade pip`,
    `                if [ -f requirements.txt ]; then`,
    `                  python3 -m pip install -r requirements.txt`,
    `                fi`,
    `                if [ -f requirements-dev.txt ]; then`,
    `                  python3 -m pip install -r requirements-dev.txt`,
    `                elif [ -f pyproject.toml ]; then`,
    `                  python3 -m pip install -e .`,
    `                fi`,
    `                has_py_tests=0`,
    `                if [ -f pytest.ini ] || [ -d tests ] || [ -d test ] || find . -maxdepth 3 \\( -name 'test_*.py' -o -name '*_test.py' \\) | grep -q .; then`,
    `                  has_py_tests=1`,
    `                fi`,
    `                if python3 -c "import pytest" >/dev/null 2>&1 && { [ "$has_py_tests" -eq 1 ] || grep -qi "pytest" pyproject.toml requirements*.txt 2>/dev/null; }; then`,
    `                  python3 -m pytest -q`,
    `                elif [ "$has_py_tests" -eq 1 ]; then`,
    `                  if grep -qi "pytest" pyproject.toml requirements*.txt 2>/dev/null; then`,
    `                    python3 -m pip install pytest`,
    `                    python3 -m pytest -q`,
    `                  else`,
    `                    python3 -m unittest discover -q`,
    `                  fi`,
    `                else`,
    `                  echo "No Python test suite configured in $dir; running compileall syntax check"`,
    `                  python3 -m compileall -q .`,
    `                fi`,
    `              )`,
    `            fi`,
    `          done`,
    ``,
    `      - name: Verify Go projects (if present)`,
    `        run: |`,
    `          set -euo pipefail`,
    `          for dir in . backend server cmd; do`,
    `            if [ -f "$dir/go.mod" ]; then`,
    `              echo "=== Go verify: $dir ==="`,
    `              (cd "$dir" && go vet ./... && go test ./...)`,
    `            fi`,
    `          done`,
    ``,
    `      - name: Verify Rust projects (if present)`,
    `        run: |`,
    `          set -euo pipefail`,
    `          for dir in . backend server; do`,
    `            if [ -f "$dir/Cargo.toml" ]; then`,
    `              echo "=== Rust verify: $dir ==="`,
    `              (cd "$dir" && cargo check --all-targets && cargo test)`,
    `            fi`,
    `          done`,
    ``,
    `      - name: Validate Docker Compose (if present)`,
    `        run: |`,
    `          set -euo pipefail`,
    `          for f in ${ALL_COMPOSE_NAMES.join(" ")}; do`,
    `            if [ -f "$f" ]; then docker compose -f "$f" config --quiet; fi`,
    `          done`,
  ].join("\n");
  return { jobId, yaml };
}

function renderTokenHubJob(needsIds, platform = "github", usedJobIds = new Set()) {
  const jobId = allocateJobId("tokenhub-pr-review", ".", 0, usedJobIds);
  const needsLine = needsIds.length === 1
    ? `    needs: ${needsIds[0]}`
    : `    needs: [${needsIds.join(", ")}]`;

  const envExtra = platform === "gitea"
    ? [
      `          GITEA_TOKEN: \${{ secrets.GITEA_TOKEN || github.token }}`,
      `          GITEA_API_URL: \${{ github.api_url }}`,
      `          GITHUB_REPOSITORY: \${{ github.repository }}`,
      `          PR_NUMBER: \${{ github.event.pull_request.number }}`,
    ]
    : [
      `          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}`,
      `          PR_NUMBER: \${{ github.event.pull_request.number }}`,
    ];

  const commentLines = platform === "gitea"
    ? [
      `            const giteaApi = (process.env.GITEA_API_URL || "").replace(/\\/+$/, "");`,
      `            const giteaToken = process.env.GITEA_TOKEN || "";`,
      `            const repoFullName = process.env.GITHUB_REPOSITORY || "";`,
      `            const prNum = process.env.PR_NUMBER || "";`,
      `            if (giteaApi && giteaToken && repoFullName && prNum) {`,
      `              const postResp = await fetch(`,
      `                \`\${giteaApi}/repos/\${repoFullName}/issues/\${prNum}/comments\`,`,
      `                {`,
      `                  method: "POST",`,
      `                  headers: {`,
      `                    "Content-Type": "application/json",`,
      `                    "Authorization": \`token \${giteaToken}\`,`,
      `                  },`,
      `                  body: JSON.stringify({ body }),`,
      `                }`,
      `              );`,
      `              if (postResp.ok) {`,
      `                console.log(\`[tokenhub-gitea] posted PR risk summary comment to PR #\${prNum} (HTTP \${postResp.status})\`);`,
      `              } else {`,
      `                console.error(\`[tokenhub-gitea] PR comment API failed: HTTP \${postResp.status}\`);`,
      `              }`,
      `            } else {`,
      `              console.log("[tokenhub-gitea] skipped PR comment API call (missing GITEA_API_URL, GITEA_TOKEN, or PR_NUMBER).");`,
      `            }`,
    ]
    : [
      `            require("node:fs").writeFileSync("/tmp/pr-summary.md", body);`,
      `            execSync(\`gh pr comment "\${process.env.PR_NUMBER}" --body-file /tmp/pr-summary.md\`, { stdio: "inherit" });`,
    ];

  return [
    `  ${jobId}:`,
    `    name: "Headless PR Risk Summary (TokenHub API)"`,
    `    if: github.event_name == 'pull_request'`,
    `    runs-on: ubuntu-latest`,
    needsLine,
    `    permissions:`,
    `      contents: read`,
    `      pull-requests: write`,
    `    steps:`,
    `      - name: Checkout PR branch`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          fetch-depth: 0`,
    `          persist-credentials: false`,
    ``,
    `      - name: Generate Chinese PR Risk Summary via TokenHub API`,
    `        env:`,
    `          TOKENHUB_API_KEY: \${{ secrets.TOKENHUB_API_KEY }}`,
    `          TOKENHUB_BASE_URL: \${{ secrets.TOKENHUB_BASE_URL || 'https://api.tokenhub.tencent.com/v1' }}`,
    `          TOKENHUB_MODEL: \${{ vars.TOKENHUB_REVIEW_MODEL || 'DeepSeek-V4.1-Flash-1017' }}`,
    `          BASE_SHA: \${{ github.event.pull_request.base.sha }}`,
    `          HEAD_SHA: \${{ github.event.pull_request.head.sha }}`,
    ...envExtra,
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
    `          const rawDiff = execSync(`,
    `            \`git diff "\${process.env.BASE_SHA}...\${process.env.HEAD_SHA}" -- . ':(exclude)*.lock' ':(exclude)package-lock.json' ':(exclude)*.pem' ':(exclude).env*'\`,`,
    `            { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }`,
    `          ).slice(0, 40000);`,
    `          const diff = rawDiff`,
    `            .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[REDACTED_PRIVATE_KEY]")`,
    `            .replace(/\\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{16})\\b/g, "[REDACTED_TOKEN]");`,
    `          if (!diff.trim()) process.exit(0);`,
    `          (async () => {`,
    `            const resp = await fetch(\`\${baseUrl}/chat/completions\`, {`,
    `              method: "POST",`,
    `              headers: { "Content-Type": "application/json", "Authorization": \`Bearer \${apiKey}\` },`,
    `              body: JSON.stringify({`,
    `                model,`,
    `                temperature: 0.2,`,
    `                messages: [`,
    `                  { role: "system", content: "你是无头 CI PR 风险审查助手。请用简洁中文输出：1) 变更概述；2) 潜在风险点（按高/中/低标注）；3) 合并前人工确认建议。控制在 300 字以内，切勿回显任何密钥或邮箱。" },`,
    `                  { role: "user", content: \`请审查以下 Pull Request Diff：\\n\\n\${diff}\` }`,
    `                ]`,
    `              })`,
    `            });`,
    `            if (!resp.ok) { console.error(\`TokenHub API error: HTTP \${resp.status}\`); process.exit(0); }`,
    `            const data = await resp.json();`,
    `            const summary = data?.choices?.[0]?.message?.content?.trim();`,
    `            if (!summary) process.exit(0);`,
    `            const body = \`### 🤖 TokenHub CI 风险摘要（\\\`\${model}\\\`）\\n\\n\${summary}\\n\\n> 注：本摘要由无头 CI 自动生成，最终合并需人工确认。\`;`,
    ...commentLines,
    `          })().catch((e) => console.error("TokenHub review skipped:", e.message));`,
    `          EOF`,
  ].join("\n");
}

export function renderCiWorkflow(detection, {
  platform = "github",
  branches = ["main", "master", "dev"],
  includeTokenHub = true,
} = {}) {
  const usedJobIds = new Set();
  const jobs = [];
  detection.python.forEach((py, i) => jobs.push(renderPythonJob(py, i, usedJobIds)));
  detection.node.forEach((nd, i) => jobs.push(renderNodeJob(nd, i, usedJobIds)));
  detection.go.forEach((g, i) => jobs.push(renderGoJob(g, i, usedJobIds)));
  detection.rust.forEach((rs, i) => jobs.push(renderRustJob(rs, i, usedJobIds)));
  if (detection.composeFile || detection.composeFiles?.length || detection.dockerfiles.length) {
    jobs.push(renderDockerJob(detection, usedJobIds));
  }
  if (!jobs.length) {
    jobs.push(renderGenericAutoDetectJob(usedJobIds));
  }

  const jobIds = jobs.map((j) => j.jobId);
  const branchesYaml = `[${branches.map(yamlTokenOrQuoted).join(", ")}]`;
  const header = [
    `# Generated by orca-pod ci-generator (stack: ${yamlCommentText(detection.summary)})`,
    `name: CI & PR Verification`,
    ``,
    `on:`,
    `  pull_request:`,
    `    branches: ${branchesYaml}`,
    `  push:`,
    `    branches: ${branchesYaml}`,
    ``,
    `permissions:`,
    `  contents: read`,
    ``,
    `jobs:`,
  ].join("\n");

  const bodyParts = jobs.map((j) => j.yaml);
  if (includeTokenHub) {
    bodyParts.push(renderTokenHubJob(jobIds, platform, usedJobIds));
  }
  return `${header}\n${bodyParts.join("\n\n")}\n`;
}

export function renderSelfHostedCdWorkflow(detection, {
  deployBranch = "main",
  runnerLabels = ["self-hosted", "linux"],
  healthUrl = "http://127.0.0.1:8000/health",
  deployDir = "",
  serviceName = "",
  ciWorkflowName = "CI & PR Verification",
} = {}) {
  // Prioritize docker-compose.prod.yml / compose.prod.yml over dev compose files
  const composeFile = detection?.cdComposeFile || detection?.composeFile || null;
  const labelsYaml = `[${runnerLabels.map(yamlTokenOrQuoted).join(", ")}]`;
  const branchYaml = yamlTokenOrQuoted(deployBranch);
  const cdEnterLines = deployDir ? [`          cd "$DEPLOY_DIR"`] : [];

  const deployStep = composeFile
    ? [
      `      - name: ${yamlScalar(`Deploy with Docker Compose (${composeFile})`)}`,
      `        env:`,
      `          COMPOSE_FILE: ${yamlScalar(composeFile)}`,
      ...(deployDir ? [`          DEPLOY_DIR: ${yamlScalar(deployDir)}`] : []),
      `        run: |`,
      `          set -euo pipefail`,
      ...cdEnterLines,
      ...(SAFE_SIMPLE_TOKEN_RE.test(composeFile) ? [`          COMPOSE_FILE="${composeFile}"`] : []),
      `          echo "Building & starting services via $COMPOSE_FILE ..."`,
      `          docker compose -f "$COMPOSE_FILE" up -d --build --remove-orphans --wait --wait-timeout 120`,
      `          docker compose -f "$COMPOSE_FILE" ps`,
    ]
    : [
      `      - name: Run intranet deploy hook`,
      `        env:`,
      ...(deployDir ? [`          DEPLOY_DIR: ${yamlScalar(deployDir)}`] : []),
      ...(serviceName ? [`          SERVICE_NAME: ${yamlScalar(serviceName)}`] : []),
      `        run: |`,
      `          set -euo pipefail`,
      ...cdEnterLines,
      `          if [ -x ./scripts/deploy.sh ]; then`,
      `            ./scripts/deploy.sh`,
      ...(serviceName
        ? [`          elif command -v systemctl >/dev/null 2>&1 && [ -n "\${SERVICE_NAME:-}" ]; then`, `            sudo systemctl restart "$SERVICE_NAME"`]
        : []),
      `          else`,
      `            echo "::error::No docker-compose file or executable ./scripts/deploy.sh found."`,
      `            exit 1`,
      `          fi`,
    ];

  const healthCheckStep = [
    `      - name: Post-deploy automated health check (PII-safe)`,
    `        env:`,
    ...(composeFile ? [`          COMPOSE_FILE: ${yamlScalar(composeFile)}`] : []),
    ...(deployDir ? [`          DEPLOY_DIR: ${yamlScalar(deployDir)}`] : []),
    `          DEFAULT_HEALTHCHECK_URL: ${yamlScalar(healthUrl)}`,
    `          HEALTHCHECK_URL: \${{ vars.DEPLOY_HEALTHCHECK_URL }}`,
    `          HEALTHCHECK_RETRIES: \${{ vars.DEPLOY_HEALTHCHECK_RETRIES || '15' }}`,
    `          HEALTHCHECK_INTERVAL: \${{ vars.DEPLOY_HEALTHCHECK_INTERVAL || '4' }}`,
    `        run: |`,
    `          set -euo pipefail`,
    ...cdEnterLines,
    `          TARGET_URL="\${HEALTHCHECK_URL:-$DEFAULT_HEALTHCHECK_URL}"`,
    ...(composeFile
      ? [
        `          echo "Verifying Docker Compose container status (without dumping raw application logs)..."`,
        `          running_out="$(docker compose -f "$COMPOSE_FILE" ps --status running --format json)"`,
        `          if [ -z "$running_out" ]; then`,
        `            echo "::error::No running containers reported by docker compose ps!"`,
        `            docker compose -f "$COMPOSE_FILE" ps --all`,
        `            exit 1`,
        `          fi`,
        `          unhealthy_out="$(docker compose -f "$COMPOSE_FILE" ps --status exited --status dead --status restarting --format json)"`,
        `          if [ -n "$unhealthy_out" ]; then`,
        `            echo "::error::One or more containers exited or are crash-looping! Raw container logs are omitted to protect intranet PII/secrets — inspect directly on host."`,
        `            docker compose -f "$COMPOSE_FILE" ps --all`,
        `            exit 1`,
        `          fi`,
      ]
      : []),
    `          echo "Probing $TARGET_URL (retries=$HEALTHCHECK_RETRIES, interval=\${HEALTHCHECK_INTERVAL}s)..."`,
    `          ok=0`,
    `          for i in $(seq 1 "$HEALTHCHECK_RETRIES"); do`,
    `            if curl -fsS --max-time 5 "$TARGET_URL" >/dev/null 2>&1; then`,
    `              echo "Health check PASSED on attempt $i/$HEALTHCHECK_RETRIES"`,
    `              ok=1`,
    `              break`,
    `            fi`,
    `            echo "Attempt $i/$HEALTHCHECK_RETRIES not ready yet; sleeping \${HEALTHCHECK_INTERVAL}s..."`,
    `            sleep "$HEALTHCHECK_INTERVAL"`,
    `          done`,
    `          if [ "$ok" -ne 1 ]; then`,
    `            echo "::error::Post-deploy health check FAILED for $TARGET_URL. Raw container logs are intentionally NOT printed to GitHub Actions to protect PII/secrets — inspect on intranet host."`,
    ...(composeFile ? [`            docker compose -f "$COMPOSE_FILE" ps --all || true`] : []),
    `            exit 1`,
    `          fi`,
    ...(composeFile
      ? [
        `          post_exited="$(docker compose -f "$COMPOSE_FILE" ps --status exited --status dead --status restarting --format json)"`,
        `          if [ -n "$post_exited" ]; then`,
        `            echo "::error::Container exited immediately after HTTP probe! Inspect logs directly on intranet host."`,
        `            docker compose -f "$COMPOSE_FILE" ps --all`,
        `            exit 1`,
        `          fi`,
      ]
      : []),
  ];

  const workdirStep = deployDir
    ? [
      `      - name: ${yamlScalar(`Sync checkout to deploy directory (${deployDir})`)}`,
      `        env:`,
      `          DEPLOY_DIR: ${yamlScalar(deployDir)}`,
      `        run: |`,
      `          set -euo pipefail`,
      `          mkdir -p "$DEPLOY_DIR"`,
      `          rsync -a --delete --exclude '.git' --exclude '.env' --exclude '.env.*' ./ "$DEPLOY_DIR/"`,
    ]
    : [];

  return [
    `# Generated by orca-pod ci-generator — Intranet Self-Hosted Runner CD`,
    `# Architecture: Self-Hosted Runner runs inside your private/home intranet and pulls`,
    `# jobs via OUTBOUND HTTPS (443) only — ZERO public SSH / port forwarding required.`,
    `# Security/PII: Container stdout logs are NEVER uploaded to cloud Actions logs.`,
    `# Setup on intranet host: Repo Settings -> Actions -> Runners -> New self-hosted runner.`,
    `name: CD — Intranet Self-Hosted Deploy`,
    ``,
    `on:`,
    `  workflow_run:`,
    `    workflows: [${yamlScalar(ciWorkflowName)}]`,
    `    types: [completed]`,
    `    branches: [${branchYaml}]`,
    `  workflow_dispatch:`,
    `    inputs:`,
    `      reason:`,
    `        description: "Manual deploy note"`,
    `        required: false`,
    `        default: "manual trigger"`,
    ``,
    `permissions:`,
    `  contents: read`,
    ``,
    `concurrency:`,
    `  group: ${yamlScalar(`cd-intranet-${deployBranch}`)}`,
    `  cancel-in-progress: false`,
    ``,
    `jobs:`,
    `  deploy-intranet:`,
    `    name: "Deploy to Private/Intranet Host"`,
    `    if: >-`,
    `      (github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success') ||`,
    `      (github.event_name == 'workflow_dispatch' && github.ref_name == ${yamlScalar(deployBranch).replace(/"/g, "'")})`,
    `    runs-on: ${labelsYaml}`,
    `    timeout-minutes: 20`,
    `    steps:`,
    `      - name: Verify CI gate & allowed target branch`,
    `        env:`,
    `          DEPLOY_BRANCH: ${yamlScalar(deployBranch)}`,
    `          EVENT_NAME: \${{ github.event_name }}`,
    `          REF_NAME: \${{ github.ref_name }}`,
    `          CI_CONCLUSION: \${{ github.event.workflow_run.conclusion }}`,
    `        run: |`,
    `          set -euo pipefail`,
    `          if [ "$EVENT_NAME" = "workflow_run" ] && [ "$CI_CONCLUSION" != "success" ]; then`,
    `            echo "::error::Refusing deploy because upstream CI conclusion=$CI_CONCLUSION"`,
    `            exit 1`,
    `          fi`,
    `          if [ "$EVENT_NAME" = "workflow_dispatch" ] && [ "$REF_NAME" != "$DEPLOY_BRANCH" ]; then`,
    `            echo "::error::Manual deploy only permitted from $DEPLOY_BRANCH (got $REF_NAME)"`,
    `            exit 1`,
    `          fi`,
    ``,
    `      - name: Checkout verified revision`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          ref: \${{ github.event.workflow_run.head_sha || github.sha }}`,
    `          persist-credentials: false`,
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
  force = false,
  forceCd = undefined,
  branches = ["main", "master", "dev"],
  deployBranch = "main",
  runnerLabels = ["self-hosted", "linux"],
  healthUrl = "http://127.0.0.1:8000/health",
  deployDir = "",
  serviceName = "",
  includeTokenHub = true,
} = {}) {
  const detection = detectProjectStacks(projectDir);
  const written = [];
  const skipped = [];

  // Preserve hand-hardened `.github/workflows/cd-selfhosted.yml` by default unless
  // explicit `forceCd: true` (or `force: true` when `forceCd` is omitted) is passed!
  const allowOverwriteCi = Boolean(force);
  const allowOverwriteCd = forceCd !== undefined ? Boolean(forceCd) : Boolean(force);

  const emit = (relPath, content, allowOverwrite) => {
    const abs = join(projectDir, relPath);
    if (existsSync(abs) && !allowOverwrite) {
      skipped.push(relPath);
      return;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    written.push(relPath);
  };

  if (writeGithubCi) {
    emit(".github/workflows/ci-release.yml", renderCiWorkflow(detection, { platform: "github", branches, includeTokenHub }), allowOverwriteCi);
  }
  if (writeGiteaCi) {
    emit(".gitea/workflows/ci-release.yml", renderCiWorkflow(detection, { platform: "gitea", branches, includeTokenHub }), allowOverwriteCi);
  }
  if (writeSelfHostedCd) {
    emit(
      ".github/workflows/cd-selfhosted.yml",
      renderSelfHostedCdWorkflow(detection, { deployBranch, runnerLabels, healthUrl, deployDir, serviceName }),
      allowOverwriteCd
    );
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
  const forceFlag = args.includes("--force");
  const selfHostedCd = args.includes("--self-hosted-cd");
  const gitea = args.includes("--gitea");
  const healthUrl = getFlag("--health-url", "http://127.0.0.1:8000/health");
  const deployBranch = getFlag("--deploy-branch", "main");
  const deployDir = getFlag("--deploy-dir", "");
  const serviceName = getFlag("--service-name", "");
  const labelsRaw = getFlag("--runner-labels", "self-hosted,linux");
  const runnerLabels = labelsRaw.split(",").map((s) => s.trim()).filter(Boolean);

  if (!doWrite) {
    const detection = detectProjectStacks(projectDir);
    if (asJson) console.log(JSON.stringify(detection, null, 2));
    else {
      console.log(`[orca-ci] Project: ${detection.projectDir}`);
      console.log(`[orca-ci] Detected stack: ${detection.summary}`);
      console.log(`[orca-ci] Run with --write [--self-hosted-cd] [--force] to generate workflow YAML(s).`);
    }
    process.exit(0);
  }

  const res = generateCiCdFiles(projectDir, {
    writeGithubCi: true,
    writeGiteaCi: gitea,
    writeSelfHostedCd: selfHostedCd,
    force: true,
    forceCd: forceFlag,
    deployBranch,
    runnerLabels,
    healthUrl,
    deployDir,
    serviceName,
  });
  if (asJson) console.log(JSON.stringify(res, null, 2));
  else {
    console.log(`[orca-ci] Detected stack: ${res.detection.summary}`);
    for (const f of res.written) console.log(`[orca-ci] wrote ${f}`);
    for (const f of res.skipped) console.log(`[orca-ci] kept existing ${f} (pass --force to overwrite)`);
  }
  process.exit(0);
}
