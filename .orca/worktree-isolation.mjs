// worktree-isolation.mjs — Per-step isolated Git/Orca Worktree orchestration for orca-pod.
//
// Zero external dependencies (Node builtins only).

import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import {
  assertSafePathFromRoot,
  copyFileAtomicNoFollow,
  extractWriterAttestedDispatchIds,
  readFileNoFollow,
  resolveTrustedWalkRoot,
  verifySafePathFromRoot,
  writeFileAtomicNoFollow,
} from "./gate-verify.mjs";

export const WORKTREES_MANIFEST = "WORKTREES.json";
export const DISPATCH_GATE_CLAIMS_FILE = ".dispatch-gate-claims.json";
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";
const O_NOFOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK_FLAG = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;

function samePath(a, b) {
  if (!a || !b) return false;
  const ra = resolve(a);
  const rb = resolve(b);
  return CASE_INSENSITIVE_FS ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

export function validateIsolationConfig(step, die) {
  if (step.isolatedWorktree !== undefined && typeof step.isolatedWorktree !== "boolean") {
    die(`step "${step.id}": isolatedWorktree must be a boolean.`);
  }
  if (step.branchPrefix !== undefined) {
    if (typeof step.branchPrefix !== "string" || !step.branchPrefix.trim() || /\s/.test(step.branchPrefix)) {
      die(`step "${step.id}": branchPrefix must be a non-empty string with no whitespace.`);
    }
  }
}

export function slugifyPart(text, maxLen = 18) {
  return String(text || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "") || "task";
}

function shortHash(text, len = 8) {
  return createHash("sha256").update(String(text || "")).digest("hex").slice(0, len);
}

function gitIn(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return !r.error && r.status === 0 ? (r.stdout || "").trim() : null;
}

export function gitHeadIn(dir) {
  return gitIn(dir, ["rev-parse", "HEAD"]);
}

export function gitBranchIn(dir) {
  return gitIn(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/**
 * Check whether an isolated worktree has uncommitted changes outside engine-managed
 * artifact paths. Must be called AFTER restoreAgentConfig so temporary harness
 * files never cause false-positive dirty states.
 */
export function gitDirtyIn(dir, artDirRel = ".orca/artifacts") {
  const relClean = String(artDirRel || ".orca/artifacts").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const out = gitIn(dir, ["status", "--porcelain", "--", ".", `:!${relClean}`]);
  if (out == null) return null;
  return out.length > 0;
}

function lstatSafe(p) {
  try { return lstatSync(p); } catch { return null; }
}

/**
 * Add engine-managed artifact paths to the worktree's local git exclude file
 * so workers running `git status` or `git add` never accidentally see or commit
 * synced artifacts or temporary manifests.
 */
function ensureLocalGitExclude(stepWtDir, artDirRel) {
  const relClean = String(artDirRel || ".orca/artifacts").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const excludeRel = gitIn(stepWtDir, ["rev-parse", "--git-path", "info/exclude"]);
  if (!excludeRel) return;
  const excludePath = resolve(stepWtDir, excludeRel);
  try {
    const parentDir = dirname(excludePath);
    const parentLst = lstatSafe(parentDir);
    if (parentLst && parentLst.isSymbolicLink()) return;
    mkdirSync(parentDir, { recursive: true });
    const exLst = lstatSafe(excludePath);
    if (exLst && (exLst.isSymbolicLink() || exLst.isDirectory())) return;
    let existing = "";
    if (exLst) {
      if (!exLst.isFile()) return;
      const rfd = openSync(excludePath, constants.O_RDONLY | O_NOFOLLOW_FLAG | O_NONBLOCK_FLAG);
      try {
        if (!fstatSync(rfd).isFile()) return;
        existing = readFileSync(rfd, "utf8");
      } finally {
        try { closeSync(rfd); } catch {}
      }
    }
    const lines = existing.split(/\r?\n/);
    const wanted = [`${relClean}/`, ".orca-agent-config-manifest.json", ".orca-agent-config.json"];
    const toAdd = wanted.filter((w) => !lines.includes(w));
    if (toAdd.length) {
      const base = existing ? existing.replace(/\r?\n?$/, "\n") : "";
      const outBuf = Buffer.from(base + "# orca-pod engine-managed paths\n" + toAdd.join("\n") + "\n", "utf8");
      const wfd = openSync(excludePath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW_FLAG | O_NONBLOCK_FLAG, 0o644);
      try {
        if (!fstatSync(wfd).isFile()) return;
        let off = 0;
        while (off < outBuf.length) {
          off += writeSync(wfd, outBuf, off, outBuf.length - off);
        }
      } finally {
        try { closeSync(wfd); } catch {}
      }
    }
  } catch { /* best-effort inside non-git test fixtures */ }
}

function emptyWorktreesManifest() {
  return {
    runId: null,
    integrationWorktree: null,
    integrationBranch: null,
    baseCommit: null,
    verifiedContractCommit: null,
    mergedAfterContract: false,
    tasks: {},
  };
}

export function readWorktreesManifest(artDir, wtRootDir = null) {
  const walkRoot = resolveTrustedWalkRoot(artDir, null, wtRootDir);
  const p = join(artDir, WORKTREES_MANIFEST);
  if (!verifySafePathFromRoot(walkRoot, artDir, p).ok) return emptyWorktreesManifest();
  if (!existsSync(p)) return emptyWorktreesManifest();
  try {
    const { text } = readFileNoFollow(walkRoot, artDir, p, { encoding: "utf8", label: "[worktree-isolation]" });
    const parsed = JSON.parse(text);
    return {
      runId: parsed.runId ?? null,
      integrationWorktree: parsed.integrationWorktree ?? null,
      integrationBranch: parsed.integrationBranch ?? null,
      baseCommit: parsed.baseCommit ?? null,
      verifiedContractCommit: parsed.verifiedContractCommit ?? null,
      mergedAfterContract: Boolean(parsed.mergedAfterContract),
      tasks: parsed.tasks && typeof parsed.tasks === "object" ? parsed.tasks : {},
    };
  } catch {
    return emptyWorktreesManifest();
  }
}

export function writeWorktreesManifest(artDir, manifest, wtRootDir = null) {
  const walkRoot = resolveTrustedWalkRoot(artDir, null, wtRootDir);
  const target = join(artDir, WORKTREES_MANIFEST);
  writeFileAtomicNoFollow(
    walkRoot,
    artDir,
    target,
    JSON.stringify({ ...manifest, updatedAt: new Date().toISOString() }, null, 2) + "\n",
    { label: "[worktree-isolation]" }
  );
}

/**
 * Record the verified Contract-Commit SHA after `contract-review` passes
 * settlement verification (and reset mergedAfterContract for a fresh contract).
 */
export function recordVerifiedContractCommit(artDir, commitSha, wtDir) {
  if (!commitSha) return;
  const manifest = readWorktreesManifest(artDir, wtDir);
  manifest.integrationWorktree = resolve(wtDir || ".");
  manifest.integrationBranch = gitBranchIn(wtDir || ".");
  if (manifest.verifiedContractCommit !== commitSha) {
    manifest.mergedAfterContract = false;
  }
  manifest.verifiedContractCommit = commitSha;
  manifest.baseCommit = commitSha;
  writeWorktreesManifest(artDir, manifest, wtDir);
}

/**
 * Mark that `task-review-merge` succeeded and merged approved task branches
 * onto the integration branch, allowing post-merge retry loops to accept the
 * pinned `verifiedContractCommit` as an ancestor of HEAD.
 */
export function recordMergedAfterContract(artDir, wtDir) {
  const manifest = readWorktreesManifest(artDir, wtDir);
  manifest.integrationWorktree = resolve(wtDir || ".");
  manifest.integrationBranch = gitBranchIn(wtDir || ".");
  manifest.mergedAfterContract = true;
  manifest.mergedHead = gitHeadIn(wtDir || ".");
  writeWorktreesManifest(artDir, manifest, wtDir);
}

function readGateClaims(artDir, wtRootDir = null) {
  const walkRoot = resolveTrustedWalkRoot(artDir, null, wtRootDir);
  const p = join(artDir, DISPATCH_GATE_CLAIMS_FILE);
  if (!verifySafePathFromRoot(walkRoot, artDir, p).ok) return {};
  if (!existsSync(p)) return {};
  try {
    const { text } = readFileNoFollow(walkRoot, artDir, p, { encoding: "utf8", label: "[worktree-isolation]" });
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeGateClaims(artDir, claims, wtRootDir = null) {
  const walkRoot = resolveTrustedWalkRoot(artDir, null, wtRootDir);
  const target = join(artDir, DISPATCH_GATE_CLAIMS_FILE);
  writeFileAtomicNoFollow(
    walkRoot,
    artDir,
    target,
    JSON.stringify(claims, null, 2) + "\n",
    { label: "[worktree-isolation]" }
  );
}

function sampleFsEpochMtimeMs(dir, wtRootDir = null) {
  const walkRoot = resolveTrustedWalkRoot(dir, null, wtRootDir);
  const canary = join(dir, `.orca-fs-epoch-${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}.tmp`);
  assertSafePathFromRoot(walkRoot, dir, canary, "[worktree-isolation]");
  mkdirSync(dir, { recursive: true });
  assertSafePathFromRoot(walkRoot, dir, canary, "[worktree-isolation]");
  let fd = null;
  let created = false;
  try {
    fd = openSync(canary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW_FLAG, 0o600);
    created = true;
    const ms = fstatSync(fd).mtimeMs;
    closeSync(fd);
    fd = null;
    unlinkSync(canary);
    created = false;
    return ms;
  } catch {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    if (created) {
      try { unlinkSync(canary); } catch {}
    }
    return Date.now();
  }
}

/**
 * Bind the active `dispatchId` to `step.writes` in `.dispatch-gate-claims.json` immediately
 * upon worker launch so settlement verification can prove per-dispatch artifact ownership!
 */
export function dispatchIsolatedArtifactRel(dispatchId, writes) {
  const safeId = String(dispatchId || "").replace(/[^A-Za-z0-9._-]+/g, "_");
  return `.dispatch-${safeId}/${writes}`;
}

export function bindStepArtifactDispatchClaim(wtDir, artDirRel, step, { dispatchId, taskId = null, fsEpochMtimeMs = null, clearedAtMs = null } = {}) {
  if (!step || !step.writes) return;
  const artDir = join(wtDir, artDirRel);
  const canonTarget = join(artDir, step.writes);
  const claimsTarget = join(artDir, DISPATCH_GATE_CLAIMS_FILE);
  // P0-01b: Verify lexical, full symlink-walk from `wtDir`, AND physical `realpathSync` containment
  // BEFORE ANY `mkdirSync`, `readGateClaims`, or `writeGateClaims`!
  assertSafePathFromRoot(wtDir, artDir, canonTarget, "[worktree-isolation]");
  assertSafePathFromRoot(wtDir, artDir, claimsTarget, "[worktree-isolation]");
  if (dispatchId) {
    const scopeDir = join(artDir, `.dispatch-${String(dispatchId).replace(/[^A-Za-z0-9._-]+/g, "_")}`);
    const scopedTarget = join(scopeDir, step.writes);
    assertSafePathFromRoot(wtDir, scopeDir, scopedTarget, "[worktree-isolation]");
    mkdirSync(scopeDir, { recursive: true });
    assertSafePathFromRoot(wtDir, scopeDir, scopedTarget, "[worktree-isolation]");
  }
  const claims = readGateClaims(artDir, wtDir);
  claims[step.writes] = {
    stepId: step.id,
    writes: step.writes,
    activeDispatchId: dispatchId || null,
    dispatchRelPath: dispatchId ? dispatchIsolatedArtifactRel(dispatchId, step.writes) : null,
    taskId: taskId || null,
    cleared: true,
    fsEpochMtimeMs: fsEpochMtimeMs ?? clearedAtMs ?? Date.now(),
    clearedAtMs: clearedAtMs ?? Date.now(),
    boundAt: new Date().toISOString(),
  };
  writeGateClaims(artDir, claims, wtDir);
}

/**
 * Remove stale output artifact before EVERY actual dispatch attempt so a PASS written in an
 * earlier round or abandoned attempt can never survive a crash or skipped rewrite on retry.
 * Samples kernel filesystem monotonic mtime (`fsEpochMtimeMs`) AFTER unlinking and resets
 * the dispatch claim entry; throws if an existing stale artifact cannot be deleted cleanly.
 */
export function clearStaleStepArtifact(step, wtDir, stepWtDir, artDirRel) {
  if (!step || !step.writes) return { cleared: true, clearedAtMs: Date.now(), fsEpochMtimeMs: Date.now(), targets: [] };
  const artDir = join(wtDir, artDirRel);
  const mainTarget = join(wtDir, artDirRel, step.writes);
  // P0-01b: Walk every segment from `wtDir` (and `stepWtDir` when isolated) and verify physical
  // `realpathSync` containment BEFORE ANY `rmSync`, `sampleFsEpochMtimeMs`, or `writeGateClaims`!
  assertSafePathFromRoot(wtDir, artDir, mainTarget, "[worktree-isolation]");
  assertSafePathFromRoot(wtDir, artDir, join(artDir, DISPATCH_GATE_CLAIMS_FILE), "[worktree-isolation]");
  const targets = [mainTarget];
  if (stepWtDir && !samePath(stepWtDir, wtDir)) {
    const isoArtDir = join(stepWtDir, artDirRel);
    const isoTarget = join(isoArtDir, step.writes);
    assertSafePathFromRoot(stepWtDir, isoArtDir, isoTarget, "[worktree-isolation]");
    targets.push(isoTarget);
  }
  for (const p of targets) {
    let lst = null;
    try { lst = lstatSync(p); } catch (e) {
      if (e && e.code !== "ENOENT") {
        throw new Error(`[worktree-isolation] failed to stat stale step artifact "${p}": ${e?.message || e}`);
      }
    }
    if (!lst) continue;
    if (lst.isSymbolicLink()) {
      throw new Error(`[worktree-isolation] refusing to follow or unlink symlinked step artifact "${p}"`);
    }
    try {
      rmSync(p, { force: false });
    } catch (e) {
      if (!e || e.code !== "ENOENT") {
        throw new Error(`[worktree-isolation] failed to remove stale step artifact "${p}": ${e?.message || e}`);
      }
    }
    if (existsSync(p)) {
      throw new Error(`[worktree-isolation] stale step artifact "${p}" still exists after unlink — refusing unsafe dispatch`);
    }
  }
  const clearedAtMs = Date.now();
  const useIsoSample = Boolean(stepWtDir && !samePath(stepWtDir, wtDir));
  const sampleDir = useIsoSample ? join(stepWtDir, artDirRel) : artDir;
  const sampleRoot = useIsoSample ? stepWtDir : wtDir;
  const fsEpochMtimeMs = sampleFsEpochMtimeMs(sampleDir, sampleRoot);
  const claims = readGateClaims(artDir, wtDir);
  claims[step.writes] = {
    stepId: step.id,
    writes: step.writes,
    activeDispatchId: null,
    dispatchRelPath: null,
    taskId: null,
    cleared: true,
    fsEpochMtimeMs,
    clearedAtMs,
    boundAt: null,
  };
  writeGateClaims(artDir, claims, wtDir);
  return { cleared: true, clearedAtMs, fsEpochMtimeMs, targets };
}

/**
 * P0-01b: Entry-by-entry recursive directory copy with zero symlink traversal or symlink copying!
 * Rejects symlinks at ANY depth in BOTH `srcDir` and `dstDir`, and copies every regular file via
 * `copyFileAtomicNoFollow` (`O_RDONLY | O_NOFOLLOW` + exclusive `O_CREAT | O_EXCL | O_NOFOLLOW` temp).
 */
function copyDirectoryNoFollow(srcRoot, srcContainer, srcDir, dstRoot, dstContainer, dstDir) {
  if (!verifySafePathFromRoot(srcRoot, srcContainer, srcDir).ok) return;
  if (!verifySafePathFromRoot(dstRoot, dstContainer, dstDir).ok) return;
  const srcLst = lstatSafe(srcDir);
  if (!srcLst || srcLst.isSymbolicLink() || !srcLst.isDirectory()) return;

  const dstLstBefore = lstatSafe(dstDir);
  if (dstLstBefore) {
    if (dstLstBefore.isSymbolicLink() || !dstLstBefore.isDirectory()) return;
  } else {
    try {
      mkdirSync(dstDir, { recursive: true });
    } catch {
      return;
    }
  }
  if (!verifySafePathFromRoot(dstRoot, dstContainer, dstDir).ok) return;
  const dstLstAfter = lstatSafe(dstDir);
  if (!dstLstAfter || dstLstAfter.isSymbolicLink() || !dstLstAfter.isDirectory()) return;

  let entries = [];
  try {
    entries = readdirSync(srcDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name || name === "." || name === "..") continue;
    const sChild = join(srcDir, name);
    const dChild = join(dstDir, name);
    const sChildLst = lstatSafe(sChild);
    if (!sChildLst || sChildLst.isSymbolicLink()) continue;
    if (!verifySafePathFromRoot(srcRoot, srcContainer, sChild).ok) continue;

    const dChildLst = lstatSafe(dChild);
    if (dChildLst && dChildLst.isSymbolicLink()) continue;
    if (!verifySafePathFromRoot(dstRoot, dstContainer, dChild).ok) continue;

    if (sChildLst.isDirectory()) {
      if (dChildLst && !dChildLst.isDirectory()) continue;
      copyDirectoryNoFollow(srcRoot, srcContainer, sChild, dstRoot, dstContainer, dChild);
    } else if (sChildLst.isFile()) {
      if (dChildLst && dChildLst.isDirectory()) continue;
      try {
        copyFileAtomicNoFollow(srcRoot, srcContainer, sChild, dstRoot, dstContainer, dChild, {
          label: "[worktree-isolation]",
        });
      } catch { /* best-effort */ }
    }
  }
}

/**
 * Copy upstream read artifacts, review/audit feedback reports, and screenshots
 * from integration worktree into the isolated step worktree.
 */
export function syncInputsToIsolatedWorktree({ step, wtDir, stepWtDir, artDirRel, byId, effectiveReads, allSteps }) {
  if (!stepWtDir || samePath(stepWtDir, wtDir)) return;
  const srcArt = join(wtDir, artDirRel);
  const dstArt = join(stepWtDir, artDirRel);
  if (!verifySafePathFromRoot(wtDir, srcArt, join(srcArt, WORKTREES_MANIFEST)).ok) return;
  if (!verifySafePathFromRoot(stepWtDir, dstArt, join(dstArt, WORKTREES_MANIFEST)).ok) return;
  mkdirSync(dstArt, { recursive: true });

  const filesToCopy = new Set();
  for (const rid of effectiveReads(step)) {
    if (byId[rid]?.writes) filesToCopy.add(byId[rid].writes);
  }
  for (const s of allSteps) {
    if (s.writes && s.id !== step.id && s.onFailGoto) {
      filesToCopy.add(s.writes);
    }
  }
  if (existsSync(join(srcArt, WORKTREES_MANIFEST))) {
    filesToCopy.add(WORKTREES_MANIFEST);
  }

  for (const fname of filesToCopy) {
    const src = join(srcArt, fname);
    const dst = join(dstArt, fname);
    if (!verifySafePathFromRoot(wtDir, srcArt, src).ok) continue;
    if (!verifySafePathFromRoot(stepWtDir, dstArt, dst).ok) continue;
    if (existsSync(src)) {
      try {
        copyFileAtomicNoFollow(wtDir, srcArt, src, stepWtDir, dstArt, dst, {
          label: "[worktree-isolation]",
        });
      } catch { /* best-effort */ }
    }
  }
  // Also sync Playwright screenshots dir when present (helpful on visual-gate retry) — NEVER via cpSync!
  const srcShots = join(srcArt, "screenshots");
  const dstShots = join(dstArt, "screenshots");
  if (existsSync(srcShots)) {
    copyDirectoryNoFollow(wtDir, srcArt, srcShots, stepWtDir, dstArt, dstShots);
  }
}

/**
 * Sync the isolated step's output artifact and progress checklist back to the
 * integration worktree's artifacts dir, preserving the source file's exact `mtime`
 * (never laundering a stale pre-dispatch file with a fresh copy timestamp!).
 */
export function syncOutputsFromIsolatedWorktree({ step, stepWtDir, wtDir, artDirRel, minSourceMtimeMs = null, dispatchId = null }) {
  if (!stepWtDir || samePath(stepWtDir, wtDir)) return;
  const srcArt = join(stepWtDir, artDirRel);
  const dstArt = join(wtDir, artDirRel);
  if (!verifySafePathFromRoot(wtDir, dstArt, join(dstArt, WORKTREES_MANIFEST)).ok) return;
  if (!verifySafePathFromRoot(stepWtDir, srcArt, join(srcArt, WORKTREES_MANIFEST)).ok) return;
  mkdirSync(dstArt, { recursive: true });
  const safeDisp = dispatchId ? String(dispatchId).replace(/[^A-Za-z0-9._-]+/g, "_") : null;
  const scopedWriteRel = (safeDisp && step.writes) ? dispatchIsolatedArtifactRel(dispatchId, step.writes) : null;
  const relCandidates = [
    ...(scopedWriteRel ? [scopedWriteRel] : []),
    ...(step.writes ? [step.writes] : []),
    ...(step.progress ? [step.progress] : []),
  ];
  let syncedScopedWrite = false;
  for (const fname of relCandidates) {
    const src = join(srcArt, fname);
    try {
      const isScopedWrite = Boolean(scopedWriteRel && fname === scopedWriteRel);
      const srcContainer = isScopedWrite ? join(srcArt, `.dispatch-${safeDisp}`) : srcArt;
      if (!verifySafePathFromRoot(stepWtDir, srcContainer, src).ok) continue;
      const isCanonicalWrite = Boolean(step.writes && fname === step.writes);
      const isMainWrite = isScopedWrite || isCanonicalWrite;
      const { buf: srcBuf, text: srcText, stat: st } = readFileNoFollow(stepWtDir, srcContainer, src, {
        encoding: dispatchId && isMainWrite ? "utf8" : null,
        label: "[worktree-isolation]",
      });
      if (isMainWrite && minSourceMtimeMs != null && Number.isFinite(minSourceMtimeMs) && st.mtimeMs < minSourceMtimeMs) {
        continue;
      }

      let dstRel = fname;
      if (dispatchId && isMainWrite) {
        const writerIds = extractWriterAttestedDispatchIds(srcText || "");
        // Reject any artifact carrying a mismatched Dispatch-ID!
        if (writerIds.some((id) => id !== dispatchId)) {
          continue;
        }
        if (isCanonicalWrite) {
          if (syncedScopedWrite) continue;
          const existingCanonDst = join(dstArt, step.writes);
          // Require positive writer attestation before overwriting an existing canonical file or staging a gated step!
          if ((step.verify || existsSync(existingCanonDst)) && !writerIds.includes(dispatchId)) {
            continue;
          }
          // For gated steps (`step.verify`), stage into `.dispatch-<id>/<writes>` so `verifyStepArtifact`
          // validates content in-place BEFORE promoting to canonical `<writes>`!
          if (step.verify && scopedWriteRel) {
            dstRel = scopedWriteRel;
          }
        }
      }

      const dst = join(dstArt, dstRel);
      const dstContainer = (dstRel === scopedWriteRel && safeDisp) ? join(dstArt, `.dispatch-${safeDisp}`) : dstArt;
      if (!verifySafePathFromRoot(wtDir, dstContainer, dst).ok) continue;
      writeFileAtomicNoFollow(wtDir, dstContainer, dst, srcBuf, {
        mode: (st.mode & 0o777) || 0o644,
        atime: st.atime,
        mtime: st.mtime,
        label: "[worktree-isolation]",
      });
      if (isScopedWrite || dstRel === scopedWriteRel) syncedScopedWrite = true;
    } catch { /* best-effort / ENOENT */ }
  }
}

/**
 * Ensure an isolated Orca/Git worktree exists for `step`, creating it from the
 * integration worktree's current HEAD on first launch or reusing it ONLY when
 * its baseCommit still matches the active Contract-Commit (or post-merge retry
 * within the same run).
 */
export function prepareStepWorktree({
  step,
  objective,
  runId,
  wtSelector,
  wtDir,
  artDirRel,
  orca,
  pick,
  res,
  byId,
  effectiveReads,
  allSteps,
  isolatedState,
  log,
  warn,
  die,
}) {
  const realHead = gitHeadIn(wtDir);
  const fallbackHead = (!realHead && process.env.ORCA_TEST_MODE === "1") ? (process.env.ORCA_VERIFY_HEAD_SHA || null) : null;
  const currentHead = realHead || fallbackHead;
  const integrationBranch = gitBranchIn(wtDir);

  if (!step.isolatedWorktree) {
    return {
      isolated: false,
      stepId: step.id,
      wtName: null,
      selector: wtSelector,
      dir: wtDir,
      branch: integrationBranch,
      baseCommit: currentHead,
    };
  }

  const artDir = join(wtDir, artDirRel);
  const manifest = readWorktreesManifest(artDir, wtDir);
  manifest.integrationWorktree = resolve(wtDir);
  manifest.integrationBranch = integrationBranch;
  if (runId) manifest.runId = runId;

  // Determine the expected contract base commit: if a verified contract commit
  // exists and matches HEAD (or is in a post-merge retry loop), honor it; else HEAD.
  const expectedBase = (manifest.mergedAfterContract && manifest.verifiedContractCommit)
    ? manifest.verifiedContractCommit
    : currentHead;

  // Reuse an existing isolated worktree ONLY if:
  //   1. Its directory still exists on disk, AND
  //   2. Its recorded baseCommit matches the active expectedBase (prevents
  //      silently reusing a worktree built on an outdated Contract-Commit!), AND
  //   3. Either it was created in this run OR matches the pinned contract commit.
  const existing = isolatedState[step.id] || manifest.tasks[step.id];
  const baseMatches = !expectedBase || !existing?.baseCommit || existing.baseCommit === expectedBase;
  const runMatches = !existing?.runId || !runId || existing.runId === runId || manifest.verifiedContractCommit === existing.baseCommit;
  if (existing && existing.path && existsSync(existing.path) && baseMatches && runMatches) {
    existing.status = "retrying";
    existing.runId = runId || existing.runId || null;
    isolatedState[step.id] = existing;
    manifest.tasks[step.id] = existing;
    manifest.baseCommit = expectedBase || manifest.baseCommit;
    writeWorktreesManifest(artDir, manifest, wtDir);
    ensureLocalGitExclude(existing.path, artDirRel);
    syncInputsToIsolatedWorktree({ step, wtDir, stepWtDir: existing.path, artDirRel, byId, effectiveReads, allSteps });
    log(`[worktree-isolation] reusing isolated worktree ${existing.wtName} (${existing.branch}) -> ${existing.path}`);
    return {
      isolated: true,
      stepId: step.id,
      wtName: existing.wtName,
      selector: existing.selector,
      dir: existing.path,
      branch: existing.branch,
      baseCommit: existing.baseCommit || currentHead,
    };
  }

  if (existing && existing.path && !baseMatches) {
    warn(`[worktree-isolation] existing worktree ${existing.wtName} was based on stale commit ${String(existing.baseCommit).slice(0, 8)} (current ${String(expectedBase).slice(0, 8)}); creating a fresh isolated worktree.`);
  }

  const objSlug = slugifyPart(objective, 14);
  const stepSlug = slugifyPart(step.id, 18);
  // Hash incorporates objective + baseCommit + runId so non-ASCII/Chinese
  // objectives and new contract commits never collide on worktree or branch names.
  const uniq = shortHash(`${objective}|${currentHead || "nogit"}|${runId || ""}|${step.id}`, 6);
  const wtName = `wt-${objSlug}-${stepSlug}-${uniq}`;
  const prefix = step.branchPrefix || "task/";
  const branch = `${prefix}${objSlug}-${stepSlug}-${uniq}`;
  const repoRoot = gitIn(wtDir, ["rev-parse", "--show-toplevel"]) || resolve(wtDir);

  const createArgs = ["worktree", "create", "--repo", `path:${repoRoot}`, "--name", wtName, "--branch", branch, "--no-parent"];
  if (currentHead) createArgs.push("--base-branch", currentHead);

  const c = orca(createArgs);
  if (!c.ok) {
    const detail = String(c.json?.error || c.stderr || c.raw || "orca worktree create failed").slice(0, 600);
    die(`[worktree-isolation] failed to create isolated worktree "${wtName}" for step "${step.id}": ${detail}`);
  }

  const selector = `name:${wtName}`;
  let stepWtDir = pick(pick(res(c.json), ["worktree"]) || {}, ["path"]) || null;
  if (!stepWtDir) {
    const shown = orca(["worktree", "show", "--worktree", selector]);
    stepWtDir = pick(pick(res(shown.json), ["worktree"]) || {}, ["path"]) || null;
  }
  if (!stepWtDir) {
    die(`[worktree-isolation] created worktree "${wtName}" but could not resolve its path.`);
  }
  const isoArtDir = join(stepWtDir, artDirRel);
  assertSafePathFromRoot(stepWtDir, isoArtDir, join(isoArtDir, WORKTREES_MANIFEST), "[worktree-isolation]");
  mkdirSync(isoArtDir, { recursive: true });
  ensureLocalGitExclude(stepWtDir, artDirRel);

  const entry = {
    stepId: step.id,
    title: step.title,
    runId: runId || null,
    wtName,
    selector,
    path: resolve(stepWtDir),
    branch,
    baseCommit: currentHead,
    headCommit: gitHeadIn(stepWtDir) || currentHead,
    dirty: false,
    status: "running",
    createdAt: new Date().toISOString(),
  };
  isolatedState[step.id] = entry;
  manifest.baseCommit = currentHead;
  manifest.tasks[step.id] = entry;
  writeWorktreesManifest(artDir, manifest, wtDir);
  syncInputsToIsolatedWorktree({ step, wtDir, stepWtDir, artDirRel, byId, effectiveReads, allSteps });
  log(`[worktree-isolation] created isolated worktree ${wtName} (branch=${branch}${currentHead ? `, base=${currentHead.slice(0, 8)}` : ""}) -> ${stepWtDir}`);

  return {
    isolated: true,
    stepId: step.id,
    wtName,
    selector,
    dir: resolve(stepWtDir),
    branch,
    baseCommit: currentHead,
  };
}

/**
 * Record final commit SHA / dirty status and sync artifacts back to the
 * integration worktree AFTER agent config has been restored.
 */
export function finalizeStepWorktree({ step, stepCtx, outcome, wtDir, artDirRel, isolatedState, minSourceMtimeMs = null, dispatchId = null }) {
  if (!stepCtx || !stepCtx.isolated) return;
  syncOutputsFromIsolatedWorktree({ step, stepWtDir: stepCtx.dir, wtDir, artDirRel, minSourceMtimeMs, dispatchId });
  const artDir = join(wtDir, artDirRel);
  const manifest = readWorktreesManifest(artDir, wtDir);
  const entry = isolatedState[step.id] || manifest.tasks[step.id] || {
    stepId: step.id,
    title: step.title,
    wtName: stepCtx.wtName,
    selector: stepCtx.selector,
    path: stepCtx.dir,
    branch: stepCtx.branch,
    baseCommit: stepCtx.baseCommit,
  };
  entry.headCommit = gitHeadIn(stepCtx.dir) || entry.baseCommit;
  entry.dirty = gitDirtyIn(stepCtx.dir, artDirRel);
  entry.status = outcome || "unknown";
  entry.finishedAt = new Date().toISOString();
  isolatedState[step.id] = entry;
  manifest.tasks[step.id] = entry;
  writeWorktreesManifest(artDir, manifest, wtDir);
}

/**
 * Return existing isolated worktree paths recorded in WORKTREES.json so startup
 * crash self-heal can restore leftover agent configs in them too.
 */
export function knownIsolatedWorktreePaths(artDir) {
  const mf = readWorktreesManifest(artDir);
  return Object.values(mf.tasks || {})
    .map((t) => t?.path)
    .filter((p) => typeof p === "string" && p && existsSync(p));
}

export function renderIsolatedWorktreeNote(stepCtx, outRelPath) {
  if (!stepCtx || !stepCtx.isolated) return "";
  return (
    `\n\nISOLATED WORKTREE EXECUTION (ENFORCED BY ENGINE):\n` +
    `- Worktree: ${stepCtx.wtName} (${stepCtx.dir})\n` +
    `- Task Branch: ${stepCtx.branch}` + (stepCtx.baseCommit ? ` (branched from Contract-Commit ${stepCtx.baseCommit})` : "") + "\n" +
    `- You are physically isolated from other parallel workers. Stay strictly on branch "${stepCtx.branch}", ` +
    `do NOT modify frozen contract files, and commit ONLY your own source/test files cleanly on this branch before finishing ` +
    `(NEVER \`git add\` \`.orca/artifacts/\` or temporary agent config files; leave \`git status\` clean).\n` +
    `- Write your report to ${outRelPath} (automatically synced back to the integration worktree for the Reviewer merge gate).`
  );
}
