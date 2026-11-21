#!/usr/bin/env node
// One-Way Door / Merge Danger classifier & verifier for orca-pod (v0.3.0).
// Authoritative 9-category one-way-door guard with fail-closed diff inspection.
// Zero external dependencies: Node builtins + git CLI only.
//
// Standalone CLI:
//   node .orca/merge-danger.mjs --base dev [--dir .] [--artifact .orca/artifacts/EPIC_RELEASE_GATE.md] [--json]

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const ONE_WAY_CATEGORIES = [
  "schema_migration",
  "breaking_api",
  "auth_secrets",
  "billing_pricing",
  "deploy_infra",
  "irreversible_side_effect",
  "feature_removal",
  "major_dependency_upgrade",
  "broad_blast_radius",
];

export const DEFAULT_MERGE_DANGER_THRESHOLDS = {
  maxFiles: 40,
  maxChangedLines: 2500,
  featureRemovalMinDeletedFiles: 3,
  featureRemovalMinDeletedLines: 400,
};

const FILE_RULES = [
  {
    category: "schema_migration",
    label: "Schema / data migration or destructive DB change",
    pathRe: /(?:^|\/)(?:migrations?|alembic|prisma\/migrations|db\/migrate|flyway|liquibase)(?:\/|$)|\.sql$/i,
    patchRe: /^\+(?!\+\+\s).*\b(?:DROP\s+TABLE|DROP\s+COLUMN|ALTER\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM|PRAGMA\s+user_version)\b/im,
  },
  {
    category: "auth_secrets",
    label: "Auth / permissions / RBAC / credentials / secrets",
    pathRe: /(?:^|\/)(?:auth(?:entication|orization|z|n)?|oauth[a-z0-9_-]*|rbac|acl|permissions?|security|secrets?|credentials?|jwt|sso|session|login|password|passwd|(?:auth|access|refresh|api)[_-]?tokens?)(?:[._/-]|$)|\.env(?:\.|$)|\.(?:pem|key|p12|pfx|keystore|jks)$/i,
    patchRe: /^\+(?!\+\+\s).*\b(?:JWT_SECRET|OAUTH_CLIENT_SECRET|PRIVATE_KEY|BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY|RBAC|role_permissions?)\b/im,
  },
  {
    category: "billing_pricing",
    label: "Billing / pricing / payment / subscription",
    pathRe: /(?:^|\/)(?:billing|payment|payments|stripe|pricing|invoice|invoices|subscription|subscriptions|checkout)(?:[._/-]|$)/i,
    patchRe: null,
  },
  {
    category: "deploy_infra",
    label: "Deploy / CI-CD / container / infrastructure",
    pathRe: /(?:^|\/)(?:\.github\/workflows\/|\.gitea\/workflows\/|\.circleci\/|\.gitlab-ci\.ya?ml$|Jenkinsfile$|Dockerfile(?:\.|$)|docker-compose[^/]*\.ya?ml$|terraform\/|pulumi\/|k8s\/|helm\/|infra\/|deploy\/|nginx[^/]*\.conf$|Caddyfile$|Procfile$|fly\.toml$|vercel\.json$|render\.ya?ml$|serverless\.ya?ml$)/i,
    patchRe: null,
  },
  {
    category: "irreversible_side_effect",
    label: "Irreversible external side effect (prod webhook / bulk email / destructive script)",
    pathRe: /(?:^|\/)(?:backfill|purge|wipe|nuke|prod[-_]?migration|bulk[-_]?mail)(?:[._/-]|$)/i,
    patchRe: /^\+(?!\+\+\s).*\b(?:send_bulk_email|purge_production|irreversible_side_effect)\b/im,
  },
];

const API_ENTRY_RE = /(?:^|\/)(?:openapi|swagger|schema\.json|routes?|endpoints?|api\/|sdk\/|public_api|index\.(?:[cm]?[jt]s|tsx|jsx)$|__init__\.py$|lib\.rs$)/i;
const BREAKING_PATCH_RE = /^\-(?!\-\-\s).*\b(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+|@(?:app|router)\.(?:get|post|put|patch|delete)\s*\(|def\s+(?:api_|route_)|pub\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+)/m;
const DEPS_FILE_RE = /(?:^|\/)(?:package\.json|pyproject\.toml|requirements(?:[-_][^/]*)?\.txt|Cargo\.toml|go\.mod)$/i;

function git(gitDir, args, maxBuffer = 16 * 1024 * 1024) {
  return spawnSync("git", ["-C", gitDir || ".", ...args], { encoding: "utf8", maxBuffer });
}

export function validateMergeDangerConfig(md, die) {
  if (md == null) return;
  if (typeof md !== "object" || Array.isArray(md)) {
    die("defaults: mergeDanger must be an object.");
  }
  const allowed = new Set(Object.keys(DEFAULT_MERGE_DANGER_THRESHOLDS));
  for (const [k, v] of Object.entries(md)) {
    if (!allowed.has(k)) {
      die(`defaults.mergeDanger: unknown key "${k}" (allowed: ${[...allowed].join(", ")}).`);
    }
    if (!Number.isInteger(v) || v <= 0) {
      die(`defaults.mergeDanger.${k} must be a positive integer (got ${JSON.stringify(v)}).`);
    }
  }
}

function detectMajorDepBump(patchText) {
  // Parse per-file diff blocks so changes in different files/sections don't collide falsely.
  const bumps = [];
  const blocks = String(patchText || "").split(/^diff --git /m).slice(1);
  const jsonVerRe = /^([+-])\s*"([^"]+)"\s*:\s*"[\^~>=<]*(\d+)(?:\.\d+)?/;
  const tomlVerRe = /^([+-])\s*([A-Za-z0-9_.-]+)\s*=\s*(?:"[\^~>=<]*(\d+)(?:\.\d+)?|\{[^}]*\bversion\s*=\s*"[\^~>=<]*(\d+)(?:\.\d+)?)/;
  const reqVerRe = /^([+-])\s*([A-Za-z0-9_.-]+)\s*(?:==|>=|~=|<=|>|<)\s*(\d+)(?:\.\d+)?(?:,\s*<\s*(\d+))?/;
  const goModRe = /^([+-])\s*([A-Za-z0-9_./-]+?)(?:\/v(\d+))?\s+v(\d+)\.\d+/;

  for (const block of blocks) {
    const removed = new Map();
    const added = new Map();
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
      let m = jsonVerRe.exec(line);
      if (m) {
        const [, sign, pkg, maj] = m;
        if (pkg.toLowerCase() !== "version") (sign === "-" ? removed : added).set(pkg.toLowerCase(), Number(maj));
        continue;
      }
      m = tomlVerRe.exec(line);
      if (m) {
        const [, sign, pkg, maj1, maj2] = m;
        (sign === "-" ? removed : added).set(pkg.toLowerCase(), Number(maj1 ?? maj2));
        continue;
      }
      m = goModRe.exec(line);
      if (m) {
        const [, sign, modBase, suffixV, semMaj] = m;
        const maj = Number(suffixV ?? semMaj);
        (sign === "-" ? removed : added).set(modBase.toLowerCase(), maj);
        continue;
      }
      m = reqVerRe.exec(line);
      if (m) {
        const [, sign, pkg, maj, upperMaj] = m;
        const val = upperMaj ? `${maj}-lt${upperMaj}` : String(Number(maj));
        (sign === "-" ? removed : added).set(pkg.toLowerCase(), val);
      }
    }
    for (const [pkg, newVal] of added.entries()) {
      if (removed.has(pkg) && String(newVal) !== String(removed.get(pkg))) {
        bumps.push(`${pkg}: v${removed.get(pkg)} -> v${newVal}`);
      }
    }
  }
  return bumps;
}

/**
 * Parse `git diff --name-status -z` output (handles renames/copies with both old & new paths
 * and non-ASCII filenames without C-quoting).
 */
function parseNameStatusZ(stdout) {
  const tokens = String(stdout || "").split("\0");
  const files = [];
  let deletedFiles = 0;
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = tokens[i++] || "";
      const newPath = tokens[i++] || "";
      if (oldPath || newPath) files.push({ status, path: newPath, oldPath });
    } else {
      const p = tokens[i++] || "";
      if (p) {
        files.push({ status, path: p, oldPath: null });
        if (status.startsWith("D")) deletedFiles++;
      }
    }
  }
  return { files, deletedFiles };
}

function failClosed(baseRef, headRef, reason) {
  return {
    door: "one-way",
    triggers: ["uncertain_diff"],
    reasons: [reason],
    stats: { filesChanged: 0, insertions: 0, deletions: 0, deletedFiles: 0 },
    baseRef,
    headRef,
    uncertain: true,
  };
}

/**
 * Resolve merge-danger classification from real git diff between `baseRef` and `headRef`.
 * Fail-closed on ANY git diff / buffer / ref resolution failure.
 */
export function classifyMergeDanger(gitDir, baseRef, opts = {}) {
  const thresholds = { ...DEFAULT_MERGE_DANGER_THRESHOLDS, ...(opts.thresholds || {}) };
  const headRef = opts.headRef || "HEAD";

  // Test-only mock hook (strictly gated behind ORCA_TEST_MODE=1).
  if (process.env.ORCA_TEST_MODE === "1" && process.env.ORCA_MERGE_DANGER_MOCK) {
    try {
      const mocked = JSON.parse(process.env.ORCA_MERGE_DANGER_MOCK);
      const triggers = Array.isArray(mocked.triggers) ? mocked.triggers : [];
      const door = mocked.door === "one-way" || triggers.length > 0 ? "one-way" : "two-way";
      return {
        door,
        triggers,
        reasons: Array.isArray(mocked.reasons) ? mocked.reasons : triggers.map((t) => `mock trigger: ${t}`),
        stats: mocked.stats || { filesChanged: 0, insertions: 0, deletions: 0, deletedFiles: 0 },
        baseRef,
        headRef,
        uncertain: Boolean(mocked.uncertain),
      };
    } catch {
      return failClosed(baseRef, headRef, "invalid ORCA_MERGE_DANGER_MOCK JSON — fail-closed to one-way door");
    }
  }

  const inGit = git(gitDir, ["rev-parse", "--is-inside-work-tree"]);
  if (inGit.error || inGit.status !== 0) {
    return failClosed(baseRef, headRef, `cannot inspect git diff in ${gitDir || "."} (not a git worktree) — fail-closed to one-way door`);
  }

  let resolvedBase = baseRef;
  const checkBase = git(gitDir, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  if (checkBase.error || checkBase.status !== 0) {
    const checkOrigin = git(gitDir, ["rev-parse", "--verify", "--quiet", `origin/${baseRef}^{commit}`]);
    if (!checkOrigin.error && checkOrigin.status === 0) {
      resolvedBase = `origin/${baseRef}`;
    } else {
      return failClosed(baseRef, headRef, `base ref "${baseRef}" cannot be resolved in git — fail-closed to one-way door`);
    }
  }

  const range = `${resolvedBase}...${headRef}`;
  const nsRes = git(gitDir, ["diff", "--name-status", "-z", range]);
  const numRes = git(gitDir, ["diff", "--numstat", "-z", range]);
  if (nsRes.error || nsRes.status !== 0 || numRes.error || numRes.status !== 0) {
    return failClosed(resolvedBase, headRef, `git diff ${range} failed (${nsRes.error?.code || numRes.error?.code || nsRes.stderr || "exit!=0"}) — fail-closed to one-way door`);
  }

  const { files, deletedFiles } = parseNameStatusZ(nsRes.stdout);

  // Parse --numstat -z: entries are "<ins>\t<del>\t<path>\0" or for renames "<ins>\t<del>\t\0<old>\0<new>\0"
  let insertions = 0;
  let deletions = 0;
  const numTokens = String(numRes.stdout || "").split("\0");
  for (let i = 0; i < numTokens.length; i++) {
    const tok = numTokens[i];
    if (!tok) continue;
    const parts = tok.split("\t");
    if (parts.length >= 2 && (/^\d+$/.test(parts[0]) || parts[0] === "-")) {
      if (/^\d+$/.test(parts[0])) insertions += Number(parts[0]);
      if (/^\d+$/.test(parts[1])) deletions += Number(parts[1]);
      if (parts.length === 3 && parts[2] === "") i += 2; // skip old\0new for rename
    }
  }

  const triggers = new Set();
  const reasons = [];
  const addTrigger = (cat, reason) => {
    triggers.add(cat);
    reasons.push(`[${cat}] ${reason}`);
  };

  // Path-based checks on BOTH new path and old path (catches renames out of sensitive dirs)
  for (const f of files) {
    const pathsToCheck = f.oldPath ? [f.oldPath, f.path] : [f.path];
    for (const p of pathsToCheck) {
      for (const rule of FILE_RULES) {
        if (rule.pathRe.test(p)) {
          addTrigger(rule.category, `${rule.label}: ${p}`);
        }
      }
    }
  }

  // Patch-content checks — FAIL CLOSED on ENOBUFS or diff error!
  if (files.length > 0) {
    const patchRes = git(gitDir, ["diff", "-U0", range]);
    if (patchRes.error || patchRes.status !== 0) {
      addTrigger("uncertain_diff", `git diff -U0 ${range} failed (${patchRes.error?.code || "exit!=0"}) — fail-closed to one-way door`);
    } else {
      const patchText = patchRes.stdout || "";
      for (const rule of FILE_RULES) {
        if (rule.patchRe && rule.patchRe.test(patchText)) {
          addTrigger(rule.category, `${rule.label} matched in diff content`);
        }
      }
      // Breaking public API / library entrypoint check
      const apiFiles = files.filter((f) => API_ENTRY_RE.test(f.path) || (f.oldPath && API_ENTRY_RE.test(f.oldPath)));
      if (apiFiles.length) {
        const apiPaths = [...new Set(apiFiles.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])))];
        const apiPatch = git(gitDir, ["diff", "-U0", range, "--", ...apiPaths]);
        if (apiPatch.error || apiPatch.status !== 0) {
          addTrigger("uncertain_diff", `API diff inspection failed (${apiPatch.error?.code || "exit!=0"})`);
        } else if (BREAKING_PATCH_RE.test(apiPatch.stdout || "")) {
          addTrigger("breaking_api", `removed/altered public API or entrypoint signature in ${apiPaths.slice(0, 5).join(", ")}`);
        }
      }
      // Major dependency upgrade check
      const depFiles = files.filter((f) => DEPS_FILE_RE.test(f.path));
      if (depFiles.length) {
        const depPatch = git(gitDir, ["diff", "-U0", range, "--", ...depFiles.map((f) => f.path)]);
        if (depPatch.error || depPatch.status !== 0) {
          addTrigger("uncertain_diff", `dependency diff inspection failed (${depPatch.error?.code || "exit!=0"})`);
        } else {
          const bumps = detectMajorDepBump(depPatch.stdout || "");
          if (bumps.length) {
            addTrigger("major_dependency_upgrade", `major dependency change: ${bumps.slice(0, 5).join(", ")}`);
          }
        }
      }
    }
  }

  // Feature removal check
  if (deletedFiles >= thresholds.featureRemovalMinDeletedFiles && deletions >= thresholds.featureRemovalMinDeletedLines) {
    addTrigger("feature_removal", `removed ${deletedFiles} files and ${deletions} lines`);
  }

  // Broad blast radius check
  const changedLines = insertions + deletions;
  if (files.length > thresholds.maxFiles || changedLines > thresholds.maxChangedLines) {
    addTrigger(
      "broad_blast_radius",
      `broad diff (${files.length} files, ${changedLines} changed lines; thresholds: ${thresholds.maxFiles} files / ${thresholds.maxChangedLines} lines)`
    );
  }

  const triggerList = [...triggers];
  return {
    door: triggerList.length > 0 ? "one-way" : "two-way",
    triggers: triggerList,
    reasons,
    stats: { filesChanged: files.length, insertions, deletions, deletedFiles },
    baseRef: resolvedBase,
    headRef,
    uncertain: triggerList.includes("uncertain_diff"),
  };
}

function normalizeMarker(raw) {
  let s = String(raw || "").trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+)/, "").trim();
  } while (s !== prev);
  if ((s.startsWith("**") && s.endsWith("**")) || (s.startsWith("__") && s.endsWith("__"))) {
    s = s.slice(2, -2).trim();
  }
  return s;
}

export function parseDoorDeclaration(text) {
  let declaredDoor = null;
  let mergeStatus = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const cleaned = normalizeMarker(raw);
    const dm = /^(?:\*\*|__)?Door(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*`?(one-way|two-way)`?\b/i.exec(cleaned);
    if (dm) declaredDoor = dm[1].toLowerCase();
    const mm = /^(?:\*\*|__)?Merge-Status(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*`?([A-Za-z0-9_-]+)`?/i.exec(cleaned);
    if (mm) mergeStatus = mm[1].toUpperCase();
  }
  return { declaredDoor, mergeStatus };
}

function revParseQuiet(gitDir, ref) {
  if (!gitDir || !ref) return null;
  const r = git(gitDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return (!r.error && r.status === 0) ? (r.stdout || "").trim() : null;
}

/**
 * Snapshot local + origin targetBranch SHAs BEFORE the release step runs.
 */
function lsRemoteBranchSha(gitDir, targetBranch) {
  if (!gitDir || !targetBranch) return { hasOrigin: false, sha: null, error: null };
  const urlRes = git(gitDir, ["remote", "get-url", "origin"]);
  if (urlRes.error || urlRes.status !== 0 || !(urlRes.stdout || "").trim()) {
    return { hasOrigin: false, sha: null, error: null };
  }
  const ls = spawnSync("git", ["-C", gitDir, "ls-remote", "--heads", "origin", `refs/heads/${targetBranch}`], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (ls.error || ls.status !== 0) {
    return { hasOrigin: true, sha: null, error: ls.error?.message || (ls.stderr || "ls-remote failed").trim() };
  }
  const firstLine = (ls.stdout || "").split(/\r?\n/).find(Boolean);
  const sha = firstLine ? firstLine.split(/\s+/)[0] : null;
  return { hasOrigin: true, sha: sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null, error: null };
}

export function snapshotTargetRefs(gitDir, targetBranch) {
  const remote = lsRemoteBranchSha(gitDir, targetBranch);
  return {
    localSha: revParseQuiet(gitDir, targetBranch),
    originSha: revParseQuiet(gitDir, `origin/${targetBranch}`),
    remoteSha: remote.sha,
    remoteError: remote.error,
    hasOrigin: remote.hasOrigin,
    headSha: revParseQuiet(gitDir, "HEAD"),
  };
}

function mergeClassifications(a, b) {
  if (!b) return a;
  if (!a) return b;
  const triggers = [...new Set([...(a.triggers || []), ...(b.triggers || [])])];
  const reasons = [...new Set([...(a.reasons || []), ...(b.reasons || [])])];
  return {
    ...a,
    door: (a.door === "one-way" || b.door === "one-way" || triggers.length > 0) ? "one-way" : "two-way",
    triggers,
    reasons,
    uncertain: Boolean(a.uncertain || b.uncertain),
  };
}

/**
 * Verify release artifact & git state against pinned pre-step baseline (prevents rogue
 * merge / squash / rebase / branch-f from collapsing diff to empty two-way!).
 */
export function verifyMergeDangerGate({
  text,
  gitDir,
  targetBranch,
  allowOneWayMerge = false,
  preStepTargetSha = null,
  preStepOriginTargetSha = null,
  preStepRemoteTargetSha = null,
  preStepRemoteError = null,
  preStepHasOrigin = false,
  preStepHeadSha = null,
  thresholds = null,
} = {}) {
  // F2 FIX: Always run ALL THREE ref checks (local, origin-tracking, live remote) without short-circuiting,
  // carry snapshot remoteError forward, and fail-closed on any deleted or locally-unfetched moved commit!
  const movedRefs = [];
  let remoteUnverifiable = preStepRemoteError || null;
  if (gitDir) {
    const localNow = revParseQuiet(gitDir, targetBranch);
    if (preStepTargetSha && localNow !== preStepTargetSha) {
      movedRefs.push({ ref: targetBranch, before: preStepTargetSha, after: localNow });
    }
    const originNow = revParseQuiet(gitDir, `origin/${targetBranch}`);
    if (preStepOriginTargetSha && originNow !== preStepOriginTargetSha) {
      movedRefs.push({ ref: `origin/${targetBranch}`, before: preStepOriginTargetSha, after: originNow });
    }
    if (preStepRemoteTargetSha || preStepHasOrigin) {
      const remNow = lsRemoteBranchSha(gitDir, targetBranch);
      if (remNow.error) {
        remoteUnverifiable = remoteUnverifiable || remNow.error;
      } else if (preStepRemoteTargetSha && remNow.sha !== preStepRemoteTargetSha) {
        movedRefs.push({ ref: `remote:origin/${targetBranch}`, before: preStepRemoteTargetSha, after: remNow.sha });
      }
    }
  }
  const targetRefMoved = movedRefs[0] || null;

  const pinnedBase = preStepTargetSha || preStepOriginTargetSha || targetBranch;
  let classification = classifyMergeDanger(gitDir, pinnedBase, { thresholds });
  if (preStepHeadSha && gitDir) {
    const curHead = revParseQuiet(gitDir, "HEAD");
    if (curHead !== preStepHeadSha) {
      const preCls = classifyMergeDanger(gitDir, pinnedBase, { headRef: preStepHeadSha, thresholds });
      classification = mergeClassifications(classification, preCls);
    }
  }
  for (const mv of movedRefs) {
    if (!mv.after || !gitDir || !revParseQuiet(gitDir, mv.after)) {
      classification = mergeClassifications(
        classification,
        failClosed(pinnedBase, mv.after || "∅", `target ref "${mv.ref}" moved to deleted or unfetched commit (${(mv.after ?? "∅").slice(0, 8)}) — fail-closed to one-way door`)
      );
    } else {
      const movedCls = classifyMergeDanger(gitDir, pinnedBase, { headRef: mv.after, thresholds });
      classification = mergeClassifications(classification, movedCls);
    }
  }
  if (remoteUnverifiable) {
    classification = mergeClassifications(classification, failClosed(pinnedBase, "HEAD", `cannot verify remote origin/${targetBranch} (${remoteUnverifiable}) — fail-closed to one-way door`));
  }
  const { declaredDoor, mergeStatus } = parseDoorDeclaration(text);

  if (classification.door === "one-way") {
    // F1 FIX: Check unauthorized targetRefMoved FIRST so a lying "Door: two-way"
    // or "Merge-Status: MERGED" artifact NEVER masks a rogue target-branch mutation.
    if (!allowOneWayMerge && targetRefMoved) {
      return {
        ok: false,
        door: "one-way",
        pendingHumanMerge: false,
        classification,
        declaredDoor,
        mergeStatus,
        targetRefMoved,
        movedRefs,
        reason: `one-way door violation (${classification.triggers.join(", ")}): target ref "${targetRefMoved.ref}" moved from ${(targetRefMoved.before ?? "∅").slice(0, 8)} to ${(targetRefMoved.after ?? "∅").slice(0, 8)} without --allow-one-way-merge`,
      };
    }
    if (declaredDoor === "two-way") {
      return {
        ok: false,
        door: "one-way",
        pendingHumanMerge: false,
        classification,
        declaredDoor,
        mergeStatus,
        targetRefMoved,
        movedRefs,
        reason: `merge-danger contradiction: artifact declared "Door: two-way" but diff against ${pinnedBase.slice(0, 12)} triggered one-way door (${classification.triggers.join(", ")})`,
      };
    }

    if (!allowOneWayMerge) {
      if (mergeStatus === "MERGED") {
        return {
          ok: false,
          door: "one-way",
          pendingHumanMerge: false,
          classification,
          declaredDoor,
          mergeStatus,
          targetRefMoved,
          movedRefs,
          reason: `one-way door violation (${classification.triggers.join(", ")}): artifact reports Merge-Status: MERGED without --allow-one-way-merge authorization`,
        };
      }
      if (declaredDoor !== "one-way" || mergeStatus !== "PENDING_HUMAN_MERGE") {
        return {
          ok: false,
          door: "one-way",
          pendingHumanMerge: false,
          classification,
          declaredDoor,
          mergeStatus,
          targetRefMoved,
          movedRefs,
          reason: `one-way door detected (${classification.triggers.join(", ")}): release report must explicitly record "Door: one-way" and "Merge-Status: PENDING_HUMAN_MERGE" and leave PR open for human approval`,
        };
      }

      return {
        ok: true,
        door: "one-way",
        pendingHumanMerge: true,
        classification,
        declaredDoor,
        mergeStatus,
        targetRefMoved,
        movedRefs,
        reason: null,
      };
    }
  }

  return {
    ok: true,
    door: classification.door,
    pendingHumanMerge: declaredDoor === "one-way" && mergeStatus === "PENDING_HUMAN_MERGE",
    classification,
    declaredDoor,
    mergeStatus,
    targetRefMoved,
    movedRefs,
    reason: null,
  };
}

export function formatMergeDangerPromptBlock(classification, targetBranch, allowOneWayMerge = false) {
  if (!classification) return "(merge-danger pre-check unavailable)";
  const lines = [
    `Door Classification: ${classification.door.toUpperCase()} (base=${classification.baseRef}, files=${classification.stats.filesChanged}, +${classification.stats.insertions}/-${classification.stats.deletions})`,
  ];
  if (classification.triggers.length) {
    lines.push(`Triggered One-Way Categories: ${classification.triggers.join(", ")}`);
    for (const r of classification.reasons.slice(0, 8)) lines.push(`  - ${r}`);
  } else {
    lines.push("Triggered One-Way Categories: none (two-way safe diff)");
  }
  if (classification.door === "one-way" && !allowOneWayMerge) {
    lines.push(
      `HARD POLICY: ONE-WAY DOOR DETECTED — you MUST open/update the PR targeting "${targetBranch}" and STOP without merging. ` +
      `Record "Door: one-way" and "Merge-Status: PENDING_HUMAN_MERGE" in {out}, list exact human merge instructions, and end with "VERDICT: PASS".`
    );
  } else {
    lines.push(
      `POLICY: ${classification.door === "one-way" ? "One-way door explicitly authorized by human (--allow-one-way-merge)." : "Two-way door — authorized to merge once all gates and CI are green."} ` +
      `Record "Door: ${classification.door}" and "Merge-Status: MERGED" (or "PENDING_HUMAN_MERGE" if PR-only/CI pending) in {out}.`
    );
  }
  return lines.join("\n");
}

// --- Standalone CLI ---
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const base = get("--base") || "dev";
  const dir = get("--dir") || process.cwd();
  const artifact = get("--artifact");
  const allowOneWay = args.includes("--allow-one-way-merge");
  const asJson = args.includes("--json");

  let result;
  if (artifact) {
    if (!existsSync(artifact)) {
      console.error(`[merge-danger] ERROR: artifact not found: ${artifact}`);
      process.exit(1);
    }
    result = verifyMergeDangerGate({
      text: readFileSync(artifact, "utf8"),
      gitDir: dir,
      targetBranch: base,
      allowOneWayMerge: allowOneWay,
    });
  } else {
    const cls = classifyMergeDanger(dir, base);
    result = { ok: true, door: cls.door, pendingHumanMerge: cls.door === "one-way" && !allowOneWay, classification: cls };
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[merge-danger] door=${result.door} ok=${result.ok} triggers=${result.classification.triggers.join(",") || "none"}`);
    if (result.reason) console.error(`[merge-danger] FAIL: ${result.reason}`);
  }
  process.exit(result.ok ? 0 : 1);
}
