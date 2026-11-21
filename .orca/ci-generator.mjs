#!/usr/bin/env node
// Stack-aware CI/CD workflow generator for Orca-Pod.
// Detects project tech stacks (Python, Node/Vue/React/Vite, Go, Rust, Docker Compose)
// including hybrid/monorepo layouts (e.g. backend/ + frontend/), generates executable
// GitHub Actions / Gitea Actions CI workflows with strict exit codes, full-depth zero-SIGPIPE
// isolated test discovery, redact-before-truncate diff sanitization, least-privilege permissions,
// safe YAML/Actions-expression serialization, and a two-job cloud-pre-gated PII-safe intranet
// Self-Hosted Runner CD workflow (preserving existing cd-selfhosted.yml unless --force is passed).
// Zero external dependencies (Node >= 18).

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build",
  ".orca", ".github", ".gitea", ".next", ".nuxt", "target", "vendor", "coverage",
  ".tox", ".mypy_cache", ".pytest_cache",
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
 * Serialize any scalar value safely as a double-quoted YAML 1.2 string.
 */
export function yamlScalar(val) {
  const s = String(val ?? "").replace(/\r?\n/g, " ");
  return JSON.stringify(s);
}

/**
 * Emit an unquoted YAML identifier ONLY when it starts with an ASCII letter and is not a
 * YAML 1.1/1.2 boolean/null keyword. Numeric-only refs like `"123"` or refs with quotes/slashes
 * are ALWAYS quoted via `yamlScalar`.
 */
export function yamlTokenOrQuoted(val) {
  const s = String(val ?? "").trim();
  if (s && /^[A-Za-z][A-Za-z0-9._-]*$/.test(s) && !/^(?:true|false|null|yes|no|on|off|y|n)$/i.test(s)) {
    return s;
  }
  return yamlScalar(s);
}

/**
 * Serialize a string literal safely for GitHub Actions `if:` / `${{ ... }}` expressions:
 * single-quoted `'...'` with embedded single quotes doubled (`''`).
 */
export function ghExprString(val) {
  const s = String(val ?? "").replace(/[\r\n]+/g, " ");
  return `'${s.replace(/'/g, "''")}'`;
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

/**
 * Full-depth recursive Python test file detector (no depth cap, so deeply nested suites like
 * `a/b/c/d/e/unit_test.py` are NEVER missed!).
 */
function hasPythonTestFiles(rootDir) {
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name) || ent.name.startsWith(".")) continue;
      const full = join(dir, ent.name);
      if (ent.isFile()) {
        if ((ent.name.startsWith("test_") && ent.name.endsWith(".py")) || ent.name.endsWith("_test.py")) {
          return true;
        }
      } else if (ent.isDirectory()) {
        if (walk(full)) return true;
      }
    }
    return false;
  };
  return walk(rootDir);
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
  const setupCfg = existsSync(join(abs, "setup.cfg"));
  const pipfile = existsSync(join(abs, "Pipfile"));
  const pytestIni = existsSync(join(abs, "pytest.ini"));
  const toxIni = existsSync(join(abs, "tox.ini"));
  const hasTestFiles = relDir === "." ? false : hasPythonTestFiles(abs);
  const hasRootOnlyPyTests = relDir === "." && !pyproject && !reqTxt && !reqDev && !setupPy && !setupCfg && !pipfile && !pytestIni && !toxIni
    ? (() => {
      try {
        for (const ent of readdirSync(projectDir, { withFileTypes: true })) {
          if (SKIP_DIRS.has(ent.name) || ent.name.startsWith(".")) continue;
          if (/^(?:backend|server|api|apps|packages|services|frontend|web|client|ui)$/.test(ent.name)) continue;
          const full = join(projectDir, ent.name);
          if (ent.isFile() && ((ent.name.startsWith("test_") && ent.name.endsWith(".py")) || ent.name.endsWith("_test.py"))) return true;
          if (ent.isDirectory() && hasPythonTestFiles(full)) return true;
        }
      } catch {}
      return false;
    })()
    : false;

  if (!pyproject && !reqTxt && !reqDev && !setupPy && !setupCfg && !pipfile && !pytestIni && !toxIni && !hasTestFiles && !hasRootOnlyPyTests) {
    return null;
  }

  const pyprojectText = pyproject ? readTextSafe(join(abs, "pyproject.toml")) : "";
  const pyContent = [
    pyprojectText,
    setupCfg ? readTextSafe(join(abs, "setup.cfg")) : "",
    toxIni ? readTextSafe(join(abs, "tox.ini")) : "",
    reqTxt ? readTextSafe(join(abs, "requirements.txt")) : "",
    reqDev ? readTextSafe(join(abs, "requirements-dev.txt")) : "",
  ].join("\n");

  const hasUv = existsSync(join(abs, "uv.lock")) || /\[tool\.uv\]/.test(pyContent);
  const hasUvLock = existsSync(join(abs, "uv.lock"));
  const hasPoetry = existsSync(join(abs, "poetry.lock")) || /\[tool\.poetry\]/.test(pyContent);
  const hasPytest = pytestIni || existsSync(join(abs, "conftest.py")) || /\bpytest\b/i.test(pyContent);
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
    hasSetupPy: setupPy,
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

/**
 * Shared inline Python stdlib `unittest` runner:
 *   - Full-depth walk with ZERO depth cap (identical traversal rules to `find` detection!)
 *   - Loads each discovered `test_*.py` / `*_test.py` file via `importlib.util.spec_from_file_location`
 *     under a unique synthetic module name `_orca_ut_<idx>_<stem>` so same-basename files across
 *     multiple directories (e.g. `dir1/unit_test.py` + `dir2/unit_test.py`) NEVER collide in `sys.modules`!
 *   - Fails closed (`sys.exit(1)`) if 0 test cases are discovered!
 * Note: heredoc body & closing `PY` sit at column 0 of the shell script (10 spaces in YAML).
 */
function renderUnittestFallbackLines(callIndent = "", envPrefix = "") {
  return [
    `${callIndent}${envPrefix}python3 - <<'PY'`,
    `import json, os, subprocess, sys`,
    `SKIP = {".git", ".venv", "venv", "node_modules", "__pycache__", "build", "dist", ".tox", ".mypy_cache", ".pytest_cache", ".orca"}`,
    `ROOT_SUBPROJECTS = {"backend", "server", "api", "frontend", "web", "client", "ui"}`,
    `prune_root = os.environ.get("ORCA_PY_ROOT_PRUNE") == "1"`,
    `cwd_abs = os.path.abspath(".")`,
    `dir_to_files = {}`,
    `for root, dirs, files in os.walk("."):`,
    `    rel_root = os.path.normpath(root)`,
    `    dirs[:] = sorted(`,
    `        d for d in dirs`,
    `        if d not in SKIP`,
    `        and not d.startswith(".")`,
    `        and not (prune_root and rel_root == "." and d in ROOT_SUBPROJECTS)`,
    `    )`,
    `    matched = sorted({`,
    `        f for f in files`,
    `        if (f.startswith("test_") and f.endswith(".py")) or f.endswith("_test.py")`,
    `    })`,
    `    if matched:`,
    `        dir_to_files[os.path.abspath(root)] = matched`,
    `if not dir_to_files:`,
    `    sys.stderr.write("ERROR: Expected Python test files, but none were found during walk!\\n")`,
    `    sys.exit(1)`,
    `def compute_top_dir(tdir):`,
    `    if not os.path.isfile(os.path.join(tdir, "__init__.py")):`,
    `        return tdir`,
    `    cur = tdir`,
    `    while os.path.isfile(os.path.join(cur, "__init__.py")) and os.path.basename(cur).isidentifier():`,
    `        parent = os.path.dirname(cur)`,
    `        if parent == cur:`,
    `            break`,
    `        if cur == cwd_abs:`,
    `            return parent`,
    `        cur = parent`,
    `    return cur`,
    `CHILD_CODE = r"""`,
    `import importlib, json, os, sys, unittest`,
    `tdir, top_dir, cwd_abs, files_json = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]`,
    `tdir_real = os.path.realpath(tdir)`,
    `top_real = os.path.realpath(top_dir)`,
    `cwd_real = os.path.realpath(cwd_abs)`,
    `files = json.loads(files_json)`,
    `sys.path[:] = [p for p in sys.path if os.path.realpath(p or ".") not in (top_real, cwd_real)]`,
    `sys.path.insert(0, top_dir)`,
    `if cwd_real != top_real:`,
    `    sys.path.append(cwd_abs)`,
    `loader = unittest.TestLoader()`,
    `suite = unittest.TestSuite()`,
    `for fname in files:`,
    `    expected_real = os.path.realpath(os.path.join(tdir, fname))`,
    `    stem = os.path.splitext(fname)[0]`,
    `    if tdir_real == top_real:`,
    `        mod_name = stem`,
    `    else:`,
    `        rel = os.path.relpath(os.path.join(tdir, stem), top_dir)`,
    `        mod_name = rel.replace(os.sep, ".")`,
    `    mod = importlib.import_module(mod_name)`,
    `    actual_real = os.path.realpath(getattr(mod, "__file__", "") or "")`,
    `    if actual_real != expected_real:`,
    `        sys.stderr.write(f"ERROR: Python test module shadowing detected for {mod_name}: loaded {actual_real}, expected {expected_real}!\\n")`,
    `        sys.exit(1)`,
    `    suite.addTests(loader.loadTestsFromModule(mod))`,
    `if suite.countTestCases() == 0:`,
    `    sys.stderr.write(f"ERROR: Python test files matched in {tdir}, but unittest discovered 0 test cases!\\n")`,
    `    sys.exit(1)`,
    `res = unittest.TextTestRunner(verbosity=1).run(suite)`,
    `sys.exit(0 if res.wasSuccessful() else 1)`,
    `"""`,
    `overall_rc = 0`,
    `for tdir in sorted(dir_to_files.keys()):`,
    `    top_dir = compute_top_dir(tdir)`,
    `    proc = subprocess.run([sys.executable, "-c", CHILD_CODE, tdir, top_dir, cwd_abs, json.dumps(dir_to_files[tdir])])`,
    `    if proc.returncode != 0:`,
    `        overall_rc = 1`,
    `sys.exit(overall_rc)`,
    `PY`,
  ];
}

function renderPytestRunLines(indent = "", runPrefix = "") {
  const runner = runPrefix ? `${runPrefix}pytest` : `python3 -m pytest`;
  return [
    `${indent}if ${runner} --help 2>&1 | grep -q -- '--import-mode'; then`,
    `${indent}  ${runner} --import-mode=importlib -q`,
    `${indent}else`,
    `${indent}  ${runner} -q`,
    `${indent}fi`,
  ];
}

function renderPythonJob(py, idx, usedJobIds) {
  const jobId = allocateJobId("verify-python", py.dir, idx, usedJobIds);
  const wd = renderWorkingDirDefaults(py.dir);
  const label = py.dir === "." ? "Verify Python" : `Verify Python (${py.dir})`;

  const installLines = ["set -euo pipefail"];
  if (py.packageManager === "uv") {
    installLines.push(
      "python3 -m pip install uv",
      py.hasUvLock ? "uv sync --frozen" : "uv sync"
    );
  } else if (py.packageManager === "poetry") {
    installLines.push("python3 -m pip install poetry", "poetry install --no-interaction");
  } else {
    installLines.push("python3 -m pip install --upgrade pip");
    if (py.hasRequirements) installLines.push("python3 -m pip install -r requirements.txt");
    if (py.hasRequirementsDev) installLines.push("python3 -m pip install -r requirements-dev.txt");
    if ((py.hasPyproject || py.hasSetupPy) && !py.hasRequirements) {
      installLines.push(py.hasDevExtra ? "python3 -m pip install -e '.[dev]'" : "python3 -m pip install -e .");
    }
    if (py.hasPytest && !py.hasRequirementsDev) {
      installLines.push("if ! python3 -c \"import pytest\" >/dev/null 2>&1; then python3 -m pip install pytest; fi");
    }
  }

  const runPrefix = py.packageManager === "uv" ? "uv run " : py.packageManager === "poetry" ? "poetry run " : "";
  const pruneExpr = py.dir === "."
    ? "\\( -name '.git' -o -name '.venv' -o -name 'venv' -o -name 'node_modules' -o -name '__pycache__' -o -name 'build' -o -name 'dist' -o -name '.tox' -o -name '.mypy_cache' -o -name '.pytest_cache' -o -name '.orca' -o -path './backend' -o -path './server' -o -path './api' -o -path './frontend' -o -path './web' -o -path './client' -o -path './ui' \\)"
    : "\\( -name '.git' -o -name '.venv' -o -name 'venv' -o -name 'node_modules' -o -name '__pycache__' -o -name 'build' -o -name 'dist' -o -name '.tox' -o -name '.mypy_cache' -o -name '.pytest_cache' -o -name '.orca' \\)";
  const envPrune = py.dir === "." ? "ORCA_PY_ROOT_PRUNE=1 " : "";

  const testLines = ["set -euo pipefail"];
  if (py.hasRuff) testLines.push(`${runPrefix}ruff check .`);
  else if (py.hasFlake8) testLines.push(`${runPrefix}flake8 .`);
  if (py.hasPytest) {
    testLines.push(...renderPytestRunLines("", runPrefix));
  } else {
    testLines.push(
      `first_py_test="$(find . ${pruneExpr} -prune -o -type f \\( -name 'test_*.py' -o -name '*_test.py' \\) -print -quit)"`,
      "if [ -n \"$first_py_test\" ]; then",
      "  if python3 -c \"import pytest\" >/dev/null 2>&1; then",
      ...renderPytestRunLines("    ", runPrefix),
      "  else",
      ...renderUnittestFallbackLines("    ", envPrune),
      "  fi",
      "else",
      "  python3 -m compileall -q .",
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
  const pyUnittestLines = renderUnittestFallbackLines("          ", 'ORCA_PY_ROOT_PRUNE="$is_root_dir" ').map((l) => `          ${l}`);
  const pytestGenericLines18 = renderPytestRunLines("                  ", "");
  const pytestGenericLines20 = renderPytestRunLines("                    ", "");
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
    `            if [ ! -d "$dir" ]; then continue; fi`,
    `            first_dir_py_test=""`,
    `            if [ "$dir" = "." ]; then`,
    `              first_dir_py_test="$(find . \\( -name '.git' -o -name '.venv' -o -name 'venv' -o -name 'node_modules' -o -name '__pycache__' -o -name 'build' -o -name 'dist' -o -name '.tox' -o -name '.mypy_cache' -o -name '.pytest_cache' -o -name '.orca' -o -path './backend' -o -path './server' -o -path './api' -o -path './frontend' -o -path './web' -o -path './client' -o -path './ui' \\) -prune -o -type f \\( -name 'test_*.py' -o -name '*_test.py' \\) -print -quit)"`,
    `            else`,
    `              first_dir_py_test="$(find "$dir" \\( -name '.git' -o -name '.venv' -o -name 'venv' -o -name 'node_modules' -o -name '__pycache__' -o -name 'build' -o -name 'dist' -o -name '.tox' -o -name '.mypy_cache' -o -name '.pytest_cache' -o -name '.orca' \\) -prune -o -type f \\( -name 'test_*.py' -o -name '*_test.py' \\) -print -quit)"`,
    `            fi`,
    `            if [ -f "$dir/pyproject.toml" ] || [ -f "$dir/requirements.txt" ] || [ -f "$dir/requirements-dev.txt" ] || [ -f "$dir/setup.py" ] || [ -f "$dir/setup.cfg" ] || [ -f "$dir/Pipfile" ] || [ -f "$dir/pytest.ini" ] || [ -f "$dir/tox.ini" ] || [ -n "$first_dir_py_test" ]; then`,
    `              echo "=== Python verify: $dir ==="`,
    `              (`,
    `                cd "$dir"`,
    `                if [ -f requirements.txt ] || [ -f requirements-dev.txt ] || [ -f pyproject.toml ] || [ -f setup.py ]; then`,
    `                  python3 -m pip install --upgrade pip`,
    `                fi`,
    `                if [ -f requirements.txt ]; then`,
    `                  python3 -m pip install -r requirements.txt`,
    `                fi`,
    `                if [ -f requirements-dev.txt ]; then`,
    `                  python3 -m pip install -r requirements-dev.txt`,
    `                elif [ -f pyproject.toml ] || [ -f setup.py ]; then`,
    `                  python3 -m pip install -e .`,
    `                fi`,
    `                is_root_dir=0`,
    `                if [ "$dir" = "." ]; then`,
    `                  is_root_dir=1`,
    `                  first_py_test="$(find . \\( -name '.git' -o -name '.venv' -o -name 'venv' -o -name 'node_modules' -o -name '__pycache__' -o -name 'build' -o -name 'dist' -o -name '.tox' -o -name '.mypy_cache' -o -name '.pytest_cache' -o -name '.orca' -o -path './backend' -o -path './server' -o -path './api' -o -path './frontend' -o -path './web' -o -path './client' -o -path './ui' \\) -prune -o -type f \\( -name 'test_*.py' -o -name '*_test.py' \\) -print -quit)"`,
    `                else`,
    `                  first_py_test="$(find . \\( -name '.git' -o -name '.venv' -o -name 'venv' -o -name 'node_modules' -o -name '__pycache__' -o -name 'build' -o -name 'dist' -o -name '.tox' -o -name '.mypy_cache' -o -name '.pytest_cache' -o -name '.orca' \\) -prune -o -type f \\( -name 'test_*.py' -o -name '*_test.py' \\) -print -quit)"`,
    `                fi`,
    `                wants_pytest=0`,
    `                if [ -f pytest.ini ] || [ -f conftest.py ] || grep -qi "pytest" pyproject.toml setup.cfg tox.ini requirements*.txt 2>/dev/null; then`,
    `                  wants_pytest=1`,
    `                fi`,
    `                if [ "$wants_pytest" -eq 1 ]; then`,
    `                  if ! python3 -c "import pytest" >/dev/null 2>&1; then`,
    `                    python3 -m pip install pytest`,
    `                  fi`,
    ...pytestGenericLines18,
    `                elif [ -n "$first_py_test" ]; then`,
    `                  if python3 -c "import pytest" >/dev/null 2>&1; then`,
    ...pytestGenericLines20,
    `                  else`,
    ...pyUnittestLines,
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

  // P1-09: Redact on FULL rawDiff BEFORE truncating to 40,000 chars, support escaped quotes
  // inside JSON strings, and drop any incomplete trailing partial line at the slice boundary!
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
    `          const secretKeys = "api[_-]?key|apikey|tokenhub[_-]?api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|client[_-]?secret|webhook[_-]?secret|private[_-]?key|secret|password|passwd|pwd|token|gh[_-]?token|gitea[_-]?token|github[_-]?token|cookie|set-cookie|authorization";`,
    `          let rawDiff = "";`,
    `          try {`,
    `            rawDiff = execSync(`,
    `              \`git diff "\${process.env.BASE_SHA}...\${process.env.HEAD_SHA}" -- . ':(exclude)*.lock' ':(exclude)package-lock.json' ':(exclude)*.pem' ':(exclude)*.key' ':(exclude).env*'\`,`,
    `              { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }`,
    `            );`,
    `          } catch (diffErr) {`,
    `            const exitCode = (diffErr && typeof diffErr.status === "number") ? diffErr.status : "unknown";`,
    `            console.error(\`[tokenhub] git diff failed (exit=\${exitCode}); raw diff output suppressed to protect secrets.\`);`,
    `            process.exit(0);`,
    `          }`,
    `          const redactedFull = rawDiff`,
    `            .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[REDACTED_PRIVATE_KEY]")`,
    `            .replace(/(\\b[a-z][a-z0-9+.-]*:\\/\\/)([^\\/\\s:@]+:[^\\/\\s@]+)@/gi, "$1[REDACTED]:[REDACTED]@")`,
    `            .replace(/([?&](?:api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|auth|secret|client[_-]?secret|password|passwd|pwd|key|sig|signature)=)([^&\\s"'#]+)/gi, "$1[REDACTED]")`,
    `            .replace(new RegExp(\`(["'])(\${secretKeys})\\\\1(\\\\s*:\\\\s*)"(?:\\\\\\\\.|[^"\\\\\\\\\\\\r\\\\n])*"\`, "gi"), '$1$2$1$3"[REDACTED]"')`,
    `            .replace(new RegExp(\`(["'])(\${secretKeys})\\\\1(\\\\s*:\\\\s*)'(?:\\\\\\\\.|[^'\\\\\\\\\\\\r\\\\n])*'\`, "gi"), "$1$2$1$3'[REDACTED]'")`,
    `            .replace(new RegExp(\`(["'])(\${secretKeys})\\\\1(\\\\s*:\\\\s*)(["'])(?:\\\\\\\\.|(?!\\\\4)[^\\\\r\\\\n])*$\`, "gim"), "$1$2$1$3$4[REDACTED]$4")`,
    `            .replace(/\\b((?:Authorization\\s*[:=]\\s*["']?)?(?:Bearer|Basic|token))\\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")`,
    `            .replace(/\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{4,}\\b/g, "[REDACTED_JWT]")`,
    `            .replace(/\\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\\b/g, "[REDACTED_TOKEN]")`,
    `            .replace(new RegExp(\`\\\\b(\${secretKeys})(\\\\s*[:=]\\\\s*)(["'])(?:\\\\\\\\.|(?!\\\\3)[^\\\\\\\\\\\\r\\\\n])*\\\\3\`, "gi"), "$1$2$3[REDACTED]$3")`,
    `            .replace(new RegExp(\`\\\\b(\${secretKeys})(\\\\s*[:=]\\\\s*)(?!\\\\[REDACTED)([^\\\\s"',;}{\\\\r\\\\n]+)\`, "gi"), "$1$2[REDACTED]")`,
    `            .replace(/\\b(?!git@[A-Za-z0-9.-]+:)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b(?![:/])/g, "[REDACTED_EMAIL]");`,
    `          let diff = redactedFull;`,
    `          if (diff.length > 40000) {`,
    `            const cut = diff.slice(0, 40000);`,
    `            const nl = cut.lastIndexOf("\\n");`,
    `            diff = nl > 0 ? cut.slice(0, nl + 1) : cut;`,
    `          }`,
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

/**
 * P1-11: Structured Docker Compose `ps --all --format json` & runtime revision verifier:
 *   - Propagates non-zero exit codes from BOTH `docker compose config --services` AND `docker compose ps`!
 *   - Rejects `Health == "starting"` or `"unhealthy"` (requires `Health == "healthy"` whenever a healthcheck exists)!
 *   - Requires `ORCA_DEPLOY_SHA` to be non-empty AND verified against live container label/env
 *     (`io.orca-pod.deploy-sha` or `ORCA_DEPLOY_SHA` via `Labels` or `docker inspect`)!
 */
function renderComposeStateVerifyFunc() {
  return [
    `          verify_compose_state() {`,
    `            local phase="$1"`,
    `            if [ -z "\${ORCA_DEPLOY_SHA:-}" ]; then`,
    `              echo "::error::[$phase] Missing ORCA_DEPLOY_SHA for live runtime revision verification!" >&2`,
    `              return 1`,
    `            fi`,
    `            local cfg_services=""`,
    `            local cfg_rc=0`,
    `            cfg_services="$(docker compose -f "$COMPOSE_FILE" config --services)" || cfg_rc=$?`,
    `            if [ "$cfg_rc" -ne 0 ]; then`,
    `              return "$cfg_rc"`,
    `            fi`,
    `            local ps_json=""`,
    `            local ps_rc=0`,
    `            ps_json="$(docker compose -f "$COMPOSE_FILE" ps --all --format json)" || ps_rc=$?`,
    `            if [ "$ps_rc" -ne 0 ]; then`,
    `              return "$ps_rc"`,
    `            fi`,
    `            PS_JSON="$ps_json" CFG_SERVICES="$cfg_services" REQUIRED_SERVICE="\${SERVICE_NAME:-}" ONESHOT_SERVICES="\${DEPLOY_ONESHOT_SERVICES:-}" EXPECTED_REV="$ORCA_DEPLOY_SHA" PHASE="$phase" python3 - <<'PY'`,
    `          import json, os, re, subprocess, sys`,
    `          raw = (os.environ.get("PS_JSON") or "").strip()`,
    `          phase = os.environ.get("PHASE") or "check"`,
    `          req_svc = (os.environ.get("REQUIRED_SERVICE") or "").strip()`,
    `          expected_rev = (os.environ.get("EXPECTED_REV") or "").strip()`,
    `          cfg_svcs = [s.strip() for s in (os.environ.get("CFG_SERVICES") or "").splitlines() if s.strip()]`,
    `          oneshot_explicit = {s.strip().lower() for s in re.split(r"[,\\s]+", os.environ.get("ONESHOT_SERVICES") or "") if s.strip()}`,
    `          oneshot_re = re.compile(r"^(?:.*[-_])?(?:migrate|migrations|migration|db-migrate|init|db-init|seed|setup|bootstrap)(?:[-_].*)?$", re.I)`,
    `          if not expected_rev:`,
    `              sys.stderr.write(f"::error::[{phase}] Missing expected deploy revision!\\n")`,
    `              sys.exit(1)`,
    `          if not raw:`,
    `              sys.stderr.write(f"::error::[{phase}] docker compose ps returned empty output!\\n")`,
    `              sys.exit(1)`,
    `          try:`,
    `              if raw.startswith("["):`,
    `                  items = json.loads(raw)`,
    `              else:`,
    `                  items = [json.loads(line) for line in raw.splitlines() if line.strip()]`,
    `          except Exception as exc:`,
    `              sys.stderr.write(f"::error::[{phase}] Invalid JSON from docker compose ps: {exc}\\n")`,
    `              sys.exit(1)`,
    `          if not isinstance(items, list) or len(items) == 0:`,
    `              sys.stderr.write(f"::error::[{phase}] No containers reported by docker compose ps!\\n")`,
    `              sys.exit(1)`,
    `          def is_oneshot(name):`,
    `              low = name.lower()`,
    `              if req_svc and low == req_svc.lower():`,
    `                  return False`,
    `              return low in oneshot_explicit or bool(oneshot_re.match(low))`,
    `          inspect_cache = {}`,
    `          def inspect_container(c):`,
    `              cid = str(c.get("ID") or c.get("Name") or c.get("Container") or "").strip()`,
    `              if not cid:`,
    `                  return {}`,
    `              if cid in inspect_cache:`,
    `                  return inspect_cache[cid]`,
    `              insp = subprocess.run(["docker", "inspect", "--format", "{{json .}}", cid], capture_output=True, text=True)`,
    `              if insp.returncode != 0:`,
    `                  sys.stderr.write(f"::error::[{phase}] docker inspect failed for container '{cid}' (exit={insp.returncode})!\\n")`,
    `                  sys.exit(insp.returncode if 1 <= insp.returncode <= 255 else 1)`,
    `              raw_out = (insp.stdout or "").strip()`,
    `              if not raw_out:`,
    `                  sys.stderr.write(f"::error::[{phase}] docker inspect returned empty output for container '{cid}'!\\n")`,
    `                  sys.exit(1)`,
    `              try:`,
    `                  parsed = json.loads(raw_out)`,
    `                  if isinstance(parsed, list):`,
    `                      if not parsed:`,
    `                          sys.stderr.write(f"::error::[{phase}] docker inspect returned empty array for container '{cid}'!\\n")`,
    `                          sys.exit(1)`,
    `                      parsed = parsed[0]`,
    `                  if not isinstance(parsed, dict):`,
    `                      sys.stderr.write(f"::error::[{phase}] docker inspect returned non-object metadata for container '{cid}'!\\n")`,
    `                      sys.exit(1)`,
    `              except Exception as exc:`,
    `                  sys.stderr.write(f"::error::[{phase}] Invalid JSON from docker inspect for '{cid}': {exc}\\n")`,
    `                  sys.exit(1)`,
    `              inspect_cache[cid] = parsed`,
    `              return parsed`,
    `          def extract_container_rev(c):`,
    `              labels_raw = c.get("Labels")`,
    `              if isinstance(labels_raw, dict):`,
    `                  v = labels_raw.get("io.orca-pod.deploy-sha") or labels_raw.get("org.opencontainers.image.revision")`,
    `                  if v: return str(v).strip()`,
    `              elif isinstance(labels_raw, str) and labels_raw:`,
    `                  for kv in labels_raw.split(","):`,
    `                      if "=" in kv:`,
    `                          k, val = kv.split("=", 1)`,
    `                          if k.strip() in ("io.orca-pod.deploy-sha", "org.opencontainers.image.revision") and val.strip():`,
    `                              return val.strip()`,
    `              info = inspect_container(c)`,
    `              cfg = info.get("Config") if isinstance(info.get("Config"), dict) else (info if isinstance(info.get("Labels"), dict) or isinstance(info.get("Env"), list) else {})`,
    `              lbls = cfg.get("Labels") or {}`,
    `              if isinstance(lbls, dict) and lbls.get("io.orca-pod.deploy-sha"):`,
    `                  return str(lbls["io.orca-pod.deploy-sha"]).strip()`,
    `              for env_entry in (cfg.get("Env") or []):`,
    `                  if isinstance(env_entry, str) and env_entry.startswith("ORCA_DEPLOY_SHA="):`,
    `                      return env_entry.split("=", 1)[1].strip()`,
    `              return None`,
    `          def resolve_live_container_state(c, ps_state, ps_exit_code, ps_health):`,
    `              info = inspect_container(c)`,
    `              cfg = info.get("Config") if isinstance(info.get("Config"), dict) else (info if isinstance(info.get("Healthcheck"), dict) else {})`,
    `              hc = cfg.get("Healthcheck")`,
    `              declared = False`,
    `              if isinstance(hc, dict):`,
    `                  test_cmd = hc.get("Test")`,
    `                  if isinstance(test_cmd, list) and len(test_cmd) > 0 and test_cmd != ["NONE"]:`,
    `                      declared = True`,
    `                  elif isinstance(test_cmd, str) and test_cmd.strip() and test_cmd.strip().upper() != "NONE":`,
    `                      declared = True`,
    `              st_obj = info.get("State") if isinstance(info.get("State"), dict) else {}`,
    `              # P1-11: Fresh docker inspect running/status/exitCode ALWAYS overrides stale compose ps snapshot!`,
    `              eff_state = ps_state`,
    `              if isinstance(st_obj.get("Status"), str) and st_obj.get("Status").strip():`,
    `                  eff_state = st_obj["Status"].strip().lower()`,
    `              elif isinstance(st_obj.get("Running"), bool):`,
    `                  eff_state = "running" if st_obj["Running"] else ("exited" if ps_state == "running" or not ps_state else ps_state)`,
    `              if st_obj.get("Running") is False and eff_state == "running":`,
    `                  eff_state = "exited"`,
    `              eff_exit = ps_exit_code`,
    `              if "ExitCode" in st_obj and st_obj.get("ExitCode") is not None:`,
    `                  try:`,
    `                      eff_exit = int(st_obj["ExitCode"])`,
    `                  except Exception:`,
    `                      eff_exit = -1`,
    `              st_health = st_obj.get("Health") if isinstance(st_obj.get("Health"), dict) else None`,
    `              if st_health is not None:`,
    `                  declared = True`,
    `                  eff_health = str(st_health.get("Status") or "").strip().lower()`,
    `              else:`,
    `                  eff_health = ps_health`,
    `                  if eff_health:`,
    `                      declared = True`,
    `              return eff_state, eff_exit, declared, eff_health`,
    `          running_svcs = set()`,
    `          completed_oneshots = set()`,
    `          for c in items:`,
    `              if not isinstance(c, dict):`,
    `                  continue`,
    `              svc = str(c.get("Service") or c.get("Name") or "unknown").strip()`,
    `              state = str(c.get("State") or "").strip().lower()`,
    `              status_txt = str(c.get("Status") or "").strip()`,
    `              health = str(c.get("Health") or "").strip().lower()`,
    `              exit_code = c.get("ExitCode")`,
    `              if exit_code is None:`,
    `                  m = re.search(r"Exited \\((\\d+)\\)", status_txt, re.I)`,
    `                  if m:`,
    `                      exit_code = int(m.group(1))`,
    `              else:`,
    `                  try:`,
    `                      exit_code = int(exit_code)`,
    `                  except Exception:`,
    `                      exit_code = -1`,
    `              if not state and status_txt:`,
    `                  state = "exited" if status_txt.lower().startswith("exited") else ("running" if status_txt.lower().startswith("up") else status_txt.lower())`,
    `              state, exit_code, has_hc, eff_health = resolve_live_container_state(c, state, exit_code, health)`,
    `              if is_oneshot(svc):`,
    `                  if state == "running":`,
    `                      if has_hc and eff_health != "healthy":`,
    `                          sys.stderr.write(f"::error::[{phase}] Service '{svc}' declares a healthcheck and status is '{eff_health or 'empty'}' (must be 'healthy')!\\n")`,
    `                          sys.exit(1)`,
    `                      running_svcs.add(svc)`,
    `                  elif state == "exited" and exit_code == 0:`,
    `                      completed_oneshots.add(svc)`,
    `                  else:`,
    `                      sys.stderr.write(f"::error::[{phase}] One-shot task service '{svc}' failed (state={state}, exitCode={exit_code})!\\n")`,
    `                      sys.exit(1)`,
    `              else:`,
    `                  if state != "running":`,
    `                      sys.stderr.write(f"::error::[{phase}] Long-running service '{svc}' is not running (state={state}, exitCode={exit_code})!\\n")`,
    `                      sys.exit(1)`,
    `                  if has_hc and eff_health != "healthy":`,
    `                      sys.stderr.write(f"::error::[{phase}] Long-running service '{svc}' declares a healthcheck and status is '{eff_health or 'empty'}' (must be 'healthy')!\\n")`,
    `                      sys.exit(1)`,
    `                  running_svcs.add(svc)`,,
    `              actual_rev = extract_container_rev(c)`,
    `              if actual_rev != expected_rev:`,
    `                  sys.stderr.write(f"::error::[{phase}] Container for service '{svc}' revision mismatch (got={actual_rev or 'missing'}, expected={expected_rev})!\\n")`,
    `                  sys.exit(1)`,
    `          if len(running_svcs) == 0:`,
    `              sys.stderr.write(f"::error::[{phase}] Zero long-running services are in running state!\\n")`,
    `              sys.exit(1)`,
    `          if req_svc and req_svc not in running_svcs:`,
    `              sys.stderr.write(f"::error::[{phase}] Required target service '{req_svc}' is not running (running={sorted(running_svcs)})!\\n")`,
    `              sys.exit(1)`,
    `          for decl in cfg_svcs:`,
    `              if is_oneshot(decl):`,
    `                  if decl not in completed_oneshots and decl not in running_svcs:`,
    `                      sys.stderr.write(f"::error::[{phase}] Declared one-shot service '{decl}' missing from compose state!\\n")`,
    `                      sys.exit(1)`,
    `              elif decl not in running_svcs:`,
    `                  sys.stderr.write(f"::error::[{phase}] Declared service '{decl}' is not running!\\n")`,
    `                  sys.exit(1)`,
    `          PY`,
    `          }`,
  ];
}

export function renderSelfHostedCdWorkflow(detection, {
  deployBranch = "main",
  runnerLabels = ["self-hosted", "linux"],
  healthUrl = "http://127.0.0.1:8000/health",
  deployDir = "",
  serviceName = "",
  ciWorkflowName = "CI & PR Verification",
} = {}) {
  const composeFile = detection?.cdComposeFile || detection?.composeFile || null;
  const labelsYaml = `[${runnerLabels.map(yamlTokenOrQuoted).join(", ")}]`;
  const branchYaml = yamlTokenOrQuoted(deployBranch);
  const exprBranch = ghExprString(deployBranch);
  const exprFullRef = ghExprString(`refs/heads/${deployBranch}`);
  const cdEnterLines = deployDir ? [`          cd "$DEPLOY_DIR"`] : [];

  const deployStep = composeFile
    ? [
      `      - name: ${yamlScalar(`Deploy with Docker Compose (${composeFile})`)}`,
      `        env:`,
      `          COMPOSE_FILE: ${yamlScalar(composeFile)}`,
      `          ORCA_DEPLOY_SHA: \${{ needs.verify-deploy-source.outputs.deploy_sha }}`,
      ...(deployDir ? [`          DEPLOY_DIR: ${yamlScalar(deployDir)}`] : []),
      `        run: |`,
      `          set -euo pipefail`,
      ...cdEnterLines,
      ...(SAFE_SIMPLE_TOKEN_RE.test(composeFile) ? [`          COMPOSE_FILE="${composeFile}"`] : []),
      `          echo "Building & starting services via $COMPOSE_FILE (rev=\${ORCA_DEPLOY_SHA:0:12}) ..."`,
      `          declared_svcs="$(docker compose -f "$COMPOSE_FILE" config --services)"`,
      `          COMPOSE_SVCS="$declared_svcs" DEPLOY_SHA="$ORCA_DEPLOY_SHA" python3 - <<'PY' > .orca-compose-rev.yml`,
      `          import json, os, sys`,
      `          svcs = [s.strip() for s in (os.environ.get("COMPOSE_SVCS") or "").splitlines() if s.strip()]`,
      `          sha = (os.environ.get("DEPLOY_SHA") or "").strip()`,
      `          if not svcs or not sha:`,
      `              sys.exit(1)`,
      `          doc = {"services": {s: {"labels": {"io.orca-pod.deploy-sha": sha}, "environment": {"ORCA_DEPLOY_SHA": sha}} for s in svcs}}`,
      `          print(json.dumps(doc, indent=2))`,
      `          PY`,
      `          trap 'rm -f .orca-compose-rev.yml' EXIT`,
      `          docker compose -f "$COMPOSE_FILE" -f .orca-compose-rev.yml up -d --build --remove-orphans --wait --wait-timeout 120`,
      `          docker compose -f "$COMPOSE_FILE" ps`,
    ]
    : [
      `      - name: Run intranet deploy hook`,
      `        env:`,
      `          ORCA_DEPLOY_SHA: \${{ needs.verify-deploy-source.outputs.deploy_sha }}`,
      ...(deployDir ? [`          DEPLOY_DIR: ${yamlScalar(deployDir)}`] : []),
      ...(serviceName ? [`          SERVICE_NAME: ${yamlScalar(serviceName)}`] : []),
      `        run: |`,
      `          set -euo pipefail`,
      ...cdEnterLines,
      `          if [ -x ./scripts/deploy.sh ]; then`,
      `            ORCA_DEPLOY_SHA="$ORCA_DEPLOY_SHA" ./scripts/deploy.sh`,
      ...(serviceName
        ? [
          `          elif command -v systemctl >/dev/null 2>&1 && [ -n "\${SERVICE_NAME:-}" ]; then`,
          `            sudo systemctl restart "$SERVICE_NAME"`,
          `            systemctl is-active --quiet "$SERVICE_NAME"`,
        ]
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
    ...(serviceName ? [`          SERVICE_NAME: ${yamlScalar(serviceName)}`] : []),
    `          ORCA_DEPLOY_SHA: \${{ needs.verify-deploy-source.outputs.deploy_sha }}`,
    `          DEFAULT_HEALTHCHECK_URL: ${yamlScalar(healthUrl)}`,
    `          HEALTHCHECK_URL: \${{ vars.DEPLOY_HEALTHCHECK_URL }}`,
    `          DEPLOY_ONESHOT_SERVICES: \${{ vars.DEPLOY_ONESHOT_SERVICES }}`,
    `          HEALTHCHECK_RETRIES: \${{ vars.DEPLOY_HEALTHCHECK_RETRIES || '15' }}`,
    `          HEALTHCHECK_INTERVAL: \${{ vars.DEPLOY_HEALTHCHECK_INTERVAL || '4' }}`,
    `        run: |`,
    `          set -euo pipefail`,
    ...cdEnterLines,
    `          if [ -z "\${ORCA_DEPLOY_SHA:-}" ]; then`,
    `            echo "::error::Missing ORCA_DEPLOY_SHA for post-deploy runtime verification!"`,
    `            exit 1`,
    `          fi`,
    `          TARGET_URL="\${HEALTHCHECK_URL:-$DEFAULT_HEALTHCHECK_URL}"`,
    ...(composeFile
      ? [
        ...renderComposeStateVerifyFunc(),
        `          echo "Verifying Docker Compose service states, healthchecks & deployed revision (without dumping raw application logs)..."`,
        `          pre_rc=0`,
        `          for i in $(seq 1 "$HEALTHCHECK_RETRIES"); do`,
        `            pre_rc=0`,
        `            verify_compose_state "pre-http" && break || pre_rc=$?`,
        `            if [ "$pre_rc" -ne 1 ] || [ "$i" -eq "$HEALTHCHECK_RETRIES" ]; then`,
        `              break`,
        `            fi`,
        `            sleep "$HEALTHCHECK_INTERVAL"`,
        `          done`,
        `          if [ "$pre_rc" -ne 0 ]; then`,
        `            docker compose -f "$COMPOSE_FILE" ps --all || true`,
        `            exit "$pre_rc"`,
        `          fi`,
      ]
      : []),
    `          echo "Probing configured health endpoint (retries=$HEALTHCHECK_RETRIES, interval=\${HEALTHCHECK_INTERVAL}s)..."`,
    `          ok=0`,
    `          for i in $(seq 1 "$HEALTHCHECK_RETRIES"); do`,
    `            resp_body_file="$(mktemp)"`,
    `            curl_rc=0`,
    `            http_code="$(curl -fsS --max-time 5 -o "$resp_body_file" -w "%{http_code}" "$TARGET_URL" 2>/dev/null)" || curl_rc=$?`,
    `            resp_body="$(cat "$resp_body_file" 2>/dev/null || true)"`,
    `            rm -f "$resp_body_file"`,
    `            if [ "$curl_rc" -eq 0 ] && printf '%s' "$http_code" | grep -Eq '^2[0-9]{2}$'; then`,
    ...(composeFile
      ? [
        `              echo "Health check PASSED on attempt $i/$HEALTHCHECK_RETRIES (HTTP $http_code)"`,
        `              ok=1`,
        `              break`,
      ]
      : [
        `              if printf '%s' "$resp_body" | grep -Fq "$ORCA_DEPLOY_SHA"; then`,
        `                echo "Health check & runtime revision PASSED on attempt $i/$HEALTHCHECK_RETRIES (HTTP $http_code)"`,
        `                ok=1`,
        `                break`,
        `              fi`,
      ]),
    `            fi`,
    `            echo "Attempt $i/$HEALTHCHECK_RETRIES not ready yet; sleeping \${HEALTHCHECK_INTERVAL}s..."`,
    `            sleep "$HEALTHCHECK_INTERVAL"`,
    `          done`,
    `          if [ "$ok" -ne 1 ]; then`,
    `            echo "::error::Post-deploy health check FAILED after $HEALTHCHECK_RETRIES attempts. Health URL and raw container logs are omitted to protect intranet PII/secrets — inspect on intranet host."`,
    ...(composeFile ? [`            docker compose -f "$COMPOSE_FILE" ps --all || true`] : []),
    `            exit 1`,
    `          fi`,
    ...(composeFile
      ? [
        `          post_rc=0`,
        `          verify_compose_state "post-http" || post_rc=$?`,
        `          if [ "$post_rc" -ne 0 ]; then`,
        `            echo "::error::Service state degraded immediately after HTTP probe! Inspect logs directly on intranet host."`,
        `            docker compose -f "$COMPOSE_FILE" ps --all || true`,
        `            exit "$post_rc"`,
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
    `# Architecture: Two-stage provenance gate — Job 1 ('verify-deploy-source') runs on GitHub-hosted`,
    `# ubuntu-latest to verify exact push ref & live deployable SHA BEFORE allocating any intranet`,
    `# self-hosted runner; Job 2 ('deploy-intranet') pulls via OUTBOUND HTTPS (443) only — ZERO public SSH.`,
    `# Security/PII: Container stdout logs and raw health URLs are NEVER printed to cloud Actions logs.`,
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
    `  verify-deploy-source:`,
    `    name: "Verify Deploy Provenance & Live Branch Tip (Cloud Pre-Gate)"`,
    `    runs-on: ubuntu-latest`,
    `    if: >-`,
    `      (github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_repository.full_name == github.repository && github.event.workflow_run.head_branch == ${exprBranch} && github.event.workflow_run.head_sha != '') ||`,
    `      (github.event_name == 'workflow_dispatch' && github.ref_type == 'branch' && github.ref == ${exprFullRef} && github.sha != '')`,
    `    outputs:`,
    `      verified: \${{ steps.gate.outputs.verified }}`,
    `      deploy_sha: \${{ steps.gate.outputs.deploy_sha }}`,
    `      deploy_ref: \${{ steps.gate.outputs.deploy_ref }}`,
    `    steps:`,
    `      - name: Checkout target branch tip`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          ref: ${yamlScalar(`refs/heads/${deployBranch}`)}`,
    `          fetch-depth: 0`,
    `          persist-credentials: false`,
    ``,
    `      - name: Verify CI gate & allowed target branch`,
    `        id: gate`,
    `        env:`,
    `          DEPLOY_BRANCH: ${yamlScalar(deployBranch)}`,
    `          EXPECTED_FULL_REF: ${yamlScalar(`refs/heads/${deployBranch}`)}`,
    `          EVENT_NAME: \${{ github.event_name }}`,
    `          ACTUAL_REF: \${{ github.ref }}`,
    `          ACTUAL_REF_TYPE: \${{ github.ref_type }}`,
    `          THIS_REPO: \${{ github.repository }}`,
    `          CI_CONCLUSION: \${{ github.event.workflow_run.conclusion }}`,
    `          WR_EVENT: \${{ github.event.workflow_run.event }}`,
    `          WR_HEAD_REPO: \${{ github.event.workflow_run.head_repository.full_name }}`,
    `          WR_HEAD_BRANCH: \${{ github.event.workflow_run.head_branch }}`,
    `          WR_HEAD_SHA: \${{ github.event.workflow_run.head_sha }}`,
    `          DISPATCH_SHA: \${{ github.sha }}`,
    `        run: |`,
    `          set -euo pipefail`,
    `          CANDIDATE_SHA=""`,
    `          if [ "$EVENT_NAME" = "workflow_run" ]; then`,
    `            if [ "$CI_CONCLUSION" != "success" ]; then`,
    `              echo "::error::Refusing deploy because upstream CI conclusion=$CI_CONCLUSION"`,
    `              exit 1`,
    `            fi`,
    `            if [ "$WR_EVENT" != "push" ]; then`,
    `              echo "::error::Refusing deploy from non-push workflow_run event ($WR_EVENT)!"`,
    `              exit 1`,
    `            fi`,
    `            if [ -z "$THIS_REPO" ] || [ "$WR_HEAD_REPO" != "$THIS_REPO" ]; then`,
    `              echo "::error::Refusing deploy from foreign/fork repository ($WR_HEAD_REPO != $THIS_REPO)!"`,
    `              exit 1`,
    `            fi`,
    `            if [ "$WR_HEAD_BRANCH" != "$DEPLOY_BRANCH" ]; then`,
    `              echo "::error::Refusing deploy from branch '$WR_HEAD_BRANCH' (expected '$DEPLOY_BRANCH')!"`,
    `              exit 1`,
    `            fi`,
    `            if ! printf '%s' "$WR_HEAD_SHA" | grep -Eq '^[0-9a-f]{40}$'; then`,
    `              echo "::error::Missing or invalid 40-char workflow_run.head_sha!"`,
    `              exit 1`,
    `            fi`,
    `            CANDIDATE_SHA="$WR_HEAD_SHA"`,
    `          elif [ "$EVENT_NAME" = "workflow_dispatch" ]; then`,
    `            if [ -n "$ACTUAL_REF_TYPE" ] && [ "$ACTUAL_REF_TYPE" != "branch" ]; then`,
    `              echo "::error::Manual deploy requires ref_type=branch (got '$ACTUAL_REF_TYPE')!"`,
    `              exit 1`,
    `            fi`,
    `            if [ "$ACTUAL_REF" != "$EXPECTED_FULL_REF" ]; then`,
    `              echo "::error::Manual deploy only permitted from $EXPECTED_FULL_REF (got '$ACTUAL_REF')!"`,
    `              exit 1`,
    `            fi`,
    `            if ! printf '%s' "$DISPATCH_SHA" | grep -Eq '^[0-9a-f]{40}$'; then`,
    `              echo "::error::Missing or invalid 40-char github.sha!"`,
    `              exit 1`,
    `            fi`,
    `            CANDIDATE_SHA="$DISPATCH_SHA"`,
    `          else`,
    `            echo "::error::Unsupported trigger event '$EVENT_NAME'!"`,
    `            exit 1`,
    `          fi`,
    `          REMOTE_BRANCH_SHA="$(git rev-parse --verify --quiet "refs/remotes/origin/$DEPLOY_BRANCH^{commit}" || true)"`,
    `          if [ -z "$REMOTE_BRANCH_SHA" ]; then`,
    `            echo "::error::Could not resolve refs/remotes/origin/$DEPLOY_BRANCH in pre-gate checkout!"`,
    `            exit 1`,
    `          fi`,
    `          if [ "$CANDIDATE_SHA" != "$REMOTE_BRANCH_SHA" ]; then`,
    `            echo "::error::Refusing stale/superseded or off-branch revision ($CANDIDATE_SHA != origin/$DEPLOY_BRANCH @ $REMOTE_BRANCH_SHA)!"`,
    `            exit 1`,
    `          fi`,
    `          if [ -n "\${GITHUB_OUTPUT:-}" ]; then`,
    `            {`,
    `              echo "verified=true"`,
    `              echo "deploy_sha=$CANDIDATE_SHA"`,
    `              echo "deploy_ref=$EXPECTED_FULL_REF"`,
    `            } >> "$GITHUB_OUTPUT"`,
    `          fi`,
    ``,
    `  deploy-intranet:`,
    `    name: "Deploy to Private/Intranet Host"`,
    `    needs: verify-deploy-source`,
    `    if: >-`,
    `      needs.verify-deploy-source.result == 'success' &&`,
    `      needs.verify-deploy-source.outputs.verified == 'true' &&`,
    `      needs.verify-deploy-source.outputs.deploy_sha != '' &&`,
    `      needs.verify-deploy-source.outputs.deploy_ref == ${exprFullRef}`,
    `    runs-on: ${labelsYaml}`,
    `    timeout-minutes: 20`,
    `    steps:`,
    `      - name: Checkout verified revision`,
    `        uses: actions/checkout@v4`,
    `        with:`,
    `          ref: \${{ needs.verify-deploy-source.outputs.deploy_sha }}`,
    `          fetch-depth: 0`,
    `          persist-credentials: false`,
    ``,
    `      - name: Verify checked-out commit matches live target branch tip`,
    `        env:`,
    `          DEPLOY_BRANCH: ${yamlScalar(deployBranch)}`,
    `          EXPECTED_SHA: \${{ needs.verify-deploy-source.outputs.deploy_sha }}`,
    `        run: |`,
    `          set -euo pipefail`,
    `          if ! printf '%s' "$EXPECTED_SHA" | grep -Eq '^[0-9a-f]{40}$'; then`,
    `            echo "::error::Invalid verified EXPECTED_SHA!"`,
    `            exit 1`,
    `          fi`,
    `          ACTUAL_HEAD="$(git rev-parse HEAD)"`,
    `          if [ "$ACTUAL_HEAD" != "$EXPECTED_SHA" ]; then`,
    `            echo "::error::Checked-out HEAD ($ACTUAL_HEAD) does not match expected verified SHA ($EXPECTED_SHA)!"`,
    `            exit 1`,
    `          fi`,
    `          REMOTE_BRANCH_SHA="$(git rev-parse --verify --quiet "refs/remotes/origin/$DEPLOY_BRANCH^{commit}" || true)"`,
    `          if [ -z "$REMOTE_BRANCH_SHA" ]; then`,
    `            echo "::error::Could not resolve refs/remotes/origin/$DEPLOY_BRANCH in checkout!"`,
    `            exit 1`,
    `          fi`,
    `          if [ "$ACTUAL_HEAD" != "$REMOTE_BRANCH_SHA" ]; then`,
    `            echo "::error::Refusing stale/superseded or unmerged revision ($ACTUAL_HEAD != origin/$DEPLOY_BRANCH @ $REMOTE_BRANCH_SHA)!"`,
    `            exit 1`,
    `          fi`,
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
