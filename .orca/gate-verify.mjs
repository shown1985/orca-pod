#!/usr/bin/env node
// gate-verify.mjs — Hard content-aware artifact gate verification for orca-pod.
//
// Enforces deterministic, engine-level verification of review/audit/merge gates:
//   - requireVerdict: last non-empty line must be exact `VERDICT: <want>` with
//     no conflicting standalone VERDICT lines (including markdown headings/quotes).
//   - requireContractCommit: exact single full 40-char lowercase SHA matching:
//       * settlement mode: exact `git rev-parse HEAD`
//       * readiness mode: exact `HEAD`, OR (after task-review-merge has merged
//         approved task branches) pinned `verifiedContractCommit` that is an
//         ancestor of `HEAD` (prevents retry deadlocks after local merges).
//   - requireMergedTasks: verifies via `git merge-base --is-ancestor` that every
//     isolated task branch `headCommit` recorded in WORKTREES.json is merged
//     into the integration worktree HEAD before task-review-merge can PASS.
//
// Zero external dependencies (Node builtins only).

import { existsSync, readFileSync, statSync, lstatSync, copyFileSync, renameSync, rmSync, utimesSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyMergeDangerGate } from "./merge-danger.mjs";

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const ALLOWED_VERIFY_KEYS = new Set(["requireVerdict", "requireContractCommit", "requireMergedTasks", "mergeDangerCheck"]);

export function validateVerifyConfig(step, die) {
  if (step.verify == null) return;
  if (typeof step.verify !== "object" || Array.isArray(step.verify)) {
    die(`step "${step.id}": verify must be an object (got ${Array.isArray(step.verify) ? "array" : typeof step.verify}).`);
  }
  for (const k of Object.keys(step.verify)) {
    if (!ALLOWED_VERIFY_KEYS.has(k)) {
      die(`step "${step.id}": unknown verify rule "${k}" (allowed: ${[...ALLOWED_VERIFY_KEYS].join(", ")}).`);
    }
  }
  if (step.verify.requireVerdict !== undefined) {
    if (typeof step.verify.requireVerdict !== "string" || !step.verify.requireVerdict.trim()) {
      die(`step "${step.id}": verify.requireVerdict must be a non-empty string (e.g. "PASS").`);
    }
  }
  if (step.verify.requireContractCommit !== undefined) {
    const v = step.verify.requireContractCommit;
    if (typeof v !== "string" || (v !== "HEAD" && !FULL_SHA_RE.test(v))) {
      die(`step "${step.id}": verify.requireContractCommit must be "HEAD" or a 40-char lowercase hex SHA.`);
    }
  }
  if (step.verify.requireMergedTasks !== undefined && typeof step.verify.requireMergedTasks !== "boolean") {
    die(`step "${step.id}": verify.requireMergedTasks must be a boolean.`);
  }
  if (step.verify.mergeDangerCheck !== undefined && typeof step.verify.mergeDangerCheck !== "boolean") {
    die(`step "${step.id}": verify.mergeDangerCheck must be a boolean.`);
  }
  if (!step.writes) {
    die(`step "${step.id}": verify requires a non-empty "writes" artifact filename.`);
  }
}

/**
 * Resolve the 40-char lowercase Git HEAD commit SHA for `gitDir`.
 * Real git resolution ALWAYS takes precedence. ORCA_VERIFY_HEAD_SHA is ONLY
 * accepted as a fallback when git resolution fails AND ORCA_TEST_MODE=1.
 */
export function resolveGitHead(gitDir) {
  const args = gitDir ? ["-C", gitDir, "rev-parse", "HEAD"] : ["rev-parse", "HEAD"];
  const g = spawnSync("git", args, { encoding: "utf8" });
  if (!g.error && g.status === 0) {
    const sha = (g.stdout || "").trim();
    if (FULL_SHA_RE.test(sha)) return sha;
  }
  if (process.env.ORCA_TEST_MODE === "1") {
    const override = process.env.ORCA_VERIFY_HEAD_SHA;
    if (override && FULL_SHA_RE.test(override.trim())) return override.trim();
  }
  return null;
}

export function isGitAncestor(gitDir, ancestorSha, descendantRef = "HEAD") {
  if (!gitDir || !FULL_SHA_RE.test(String(ancestorSha || ""))) return false;
  const r = spawnSync("git", ["-C", gitDir, "merge-base", "--is-ancestor", ancestorSha, descendantRef], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

/**
 * Strip leading markdown list/heading/blockquote prefixes and optional
 * wrapping emphasis/code delimiters.
 */
function normalizeMarkerLine(raw) {
  let s = String(raw || "").trim();
  // Strip repeated markdown heading / quote / bullet prefixes (e.g. "## > - ...")
  let prev;
  do {
    prev = s;
    s = s.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+)/, "").trim();
  } while (s !== prev);
  if ((s.startsWith("**") && s.endsWith("**")) || (s.startsWith("__") && s.endsWith("__"))) {
    s = s.slice(2, -2).trim();
  }
  if (s.startsWith("`") && s.endsWith("`") && s.length >= 2) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function readManifestSafe(artDir) {
  if (!artDir) return null;
  const p = join(artDir, "WORKTREES.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/**
 * Deterministic verification of an artifact's UTF-8 text against `verify` rules.
 *
 * Options:
 *  - gitDir: integration worktree directory
 *  - artDir: artifacts directory (used to consult WORKTREES.json)
 *  - mode: "settlement" (strict HEAD match) | "readiness" (allows post-merge ancestor match)
 */
export function verifyArtifactContent(text, verify, { gitDir = null, artDir = null, mode = "settlement", targetBranch = "dev", allowOneWayMerge = false, preStepTargetSha = null, preStepOriginTargetSha = null, preStepRemoteTargetSha = null, preStepRemoteError = null, preStepHasOrigin = false, preStepHeadSha = null, mergeDangerThresholds = null } = {}) {
  if (!verify || typeof verify !== "object") {
    return { ok: true, reason: null, verdict: null, contractCommit: null, expectedCommit: null };
  }

  const lines = String(text || "").split(/\r?\n/);
  let foundVerdict = null;
  let foundCommit = null;
  let expectedCommit = null;

  if (verify.requireVerdict) {
    const want = verify.requireVerdict.trim();
    const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
    if (!nonEmpty.length) {
      return { ok: false, reason: `empty artifact; expected trailing "VERDICT: ${want}"`, verdict: null, contractCommit: null, expectedCommit: null };
    }

    const lastNorm = normalizeMarkerLine(nonEmpty[nonEmpty.length - 1]);
    const lastMatch = /^VERDICT\s*:\s*(\S+)$/.exec(lastNorm);
    if (!lastMatch) {
      return {
        ok: false,
        reason: `last non-empty line must be "VERDICT: ${want}" (found: ${JSON.stringify(nonEmpty[nonEmpty.length - 1].slice(0, 80))})`,
        verdict: null, contractCommit: null, expectedCommit: null,
      };
    }
    foundVerdict = lastMatch[1];
    if (foundVerdict !== want) {
      return {
        ok: false,
        reason: `verdict is "${foundVerdict}", required "${want}"`,
        verdict: foundVerdict, contractCommit: null, expectedCommit: null,
      };
    }

    // Reject conflicting standalone VERDICT lines anywhere earlier (including headings/quotes/bullets).
    for (const raw of nonEmpty.slice(0, -1)) {
      const cleaned = normalizeMarkerLine(raw);
      const m = /^VERDICT\s*:\s*(\S+)$/i.exec(cleaned);
      if (m && m[1] !== want) {
        return {
          ok: false,
          reason: `conflicting verdict line "${cleaned}" alongside trailing "VERDICT: ${want}"`,
          verdict: foundVerdict, contractCommit: null, expectedCommit: null,
        };
      }
    }
  }

  if (verify.requireContractCommit) {
    expectedCommit = verify.requireContractCommit === "HEAD"
      ? resolveGitHead(gitDir)
      : verify.requireContractCommit;

    if (!expectedCommit) {
      return {
        ok: false,
        reason: `cannot resolve expected Contract-Commit (${verify.requireContractCommit}) in ${gitDir || process.cwd()}`,
        verdict: foundVerdict, contractCommit: null, expectedCommit: null,
      };
    }

    // Matches:
    //   Contract-Commit: <sha>
    //   **Contract-Commit**: <sha>
    //   **Contract-Commit:** <sha>
    //   - `Contract-Commit`: `<sha>`
    const commitHits = [];
    for (const raw of lines) {
      const cleaned = normalizeMarkerLine(raw);
      const m = /^(?:\*\*|__)?Contract-Commit(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*`?([^`\s*]+)`?\s*(?:\*\*|__)?$/i.exec(cleaned);
      if (m) commitHits.push(m[1]);
    }

    if (commitHits.length === 0) {
      return {
        ok: false,
        reason: `missing required "Contract-Commit: <40-char-sha>" header (expected ${expectedCommit})`,
        verdict: foundVerdict, contractCommit: null, expectedCommit,
      };
    }
    if (commitHits.length > 1) {
      return {
        ok: false,
        reason: `ambiguous Contract-Commit headers (${commitHits.length} found; exactly 1 required)`,
        verdict: foundVerdict, contractCommit: commitHits[0], expectedCommit,
      };
    }

    foundCommit = commitHits[0];
    if (!FULL_SHA_RE.test(foundCommit)) {
      return {
        ok: false,
        reason: `Contract-Commit must be a full 40-char lowercase hex SHA (got "${foundCommit}")`,
        verdict: foundVerdict, contractCommit: foundCommit, expectedCommit,
      };
    }

    if (foundCommit !== expectedCommit) {
      // In readiness mode AFTER task-review-merge has merged approved task branches,
      // HEAD advances to the merge commit. Allow the pinned verifiedContractCommit
      // if (and only if) it was verified at settlement and is an ancestor of HEAD.
      const mf = mode === "readiness" ? readManifestSafe(artDir) : null;
      const isRealGit = gitDir ? spawnSync("git", ["-C", gitDir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).status === 0 : false;
      const postMergeAllowed = Boolean(
        mode === "readiness" &&
        mf &&
        mf.mergedAfterContract === true &&
        mf.verifiedContractCommit === foundCommit &&
        (isRealGit ? isGitAncestor(gitDir, foundCommit, "HEAD") : process.env.ORCA_TEST_MODE === "1")
      );
      if (!postMergeAllowed) {
        return {
          ok: false,
          reason: `stale Contract-Commit: report=${foundCommit}, expected=${expectedCommit}`,
          verdict: foundVerdict, contractCommit: foundCommit, expectedCommit,
        };
      }
    }
  }

  if (verify.requireMergedTasks && mode === "settlement") {
    const mf = readManifestSafe(artDir);
    const tasks = mf && mf.tasks ? Object.values(mf.tasks) : [];
    const isRealGit = gitDir ? spawnSync("git", ["-C", gitDir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).status === 0 : false;
    for (const t of tasks) {
      if (t.status !== "succeeded") {
        return {
          ok: false,
          reason: `isolated task "${t.stepId}" has status="${t.status}", cannot mark merge PASS`,
          verdict: foundVerdict, contractCommit: foundCommit, expectedCommit,
        };
      }
      if (isRealGit) {
        if (t.dirty === true) {
          return {
            ok: false,
            reason: `isolated task "${t.stepId}" (${t.branch}) has uncommitted changes (dirty=true)`,
            verdict: foundVerdict, contractCommit: foundCommit, expectedCommit,
          };
        }
        if (t.headCommit && FULL_SHA_RE.test(t.headCommit) && !isGitAncestor(gitDir, t.headCommit, "HEAD")) {
          return {
            ok: false,
            reason: `isolated task "${t.stepId}" commit ${t.headCommit.slice(0, 8)} (${t.branch}) is NOT merged into integration HEAD`,
            verdict: foundVerdict, contractCommit: foundCommit, expectedCommit,
          };
        }
      }
    }
  }

  let mergeDanger = null;
  let mergeDangerResult = null;
  let pendingHumanMerge = false;
  if (verify.mergeDangerCheck && mode === "settlement") {
    const md = verifyMergeDangerGate({
      text,
      gitDir,
      targetBranch,
      allowOneWayMerge,
      preStepTargetSha,
      preStepOriginTargetSha,
      preStepRemoteTargetSha,
      preStepRemoteError,
      preStepHasOrigin,
      preStepHeadSha,
      thresholds: mergeDangerThresholds,
    });
    mergeDanger = md.classification;
    mergeDangerResult = md;
    pendingHumanMerge = Boolean(md.pendingHumanMerge);
    if (!md.ok) {
      return {
        ok: false,
        reason: md.reason,
        verdict: foundVerdict,
        contractCommit: foundCommit,
        expectedCommit,
        mergeDanger,
        mergeDangerResult,
        pendingHumanMerge: false,
      };
    }
  }

  return { ok: true, reason: null, verdict: foundVerdict, contractCommit: foundCommit, expectedCommit, mergeDanger, mergeDangerResult, pendingHumanMerge };
}

function stripContainerPrefixes(line) {
  let s = String(line || "");
  while (true) {
    const next = s.replace(/^[ \t]{0,3}(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+)/, "");
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * Strip multi-line CommonMark inline code spans (matching exact backtick run lengths `N`
 * across newlines per CommonMark §6.1, while honoring `\` escapes outside code spans and
 * unwrapping standalone `Dispatch-ID: \`<id>\`` value-only backticks).
 */
function stripMultiLineInlineCodeSpans(docText) {
  const preUnwrapped = String(docText || "").replace(
    /^([ \t]{0,3}(?:\*\*|__)?Dispatch-ID(?:\*\*|__)?[ \t]*:[ \t]*)`([^`\r\n\s*]+)`([ \t]*)$/gim,
    "$1$2$3"
  );
  let out = "";
  let i = 0;
  while (i < preUnwrapped.length) {
    const ch = preUnwrapped[i];
    if (ch === "\\" && i + 1 < preUnwrapped.length) {
      out += ch + preUnwrapped[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      let runLen = 1;
      while (i + runLen < preUnwrapped.length && preUnwrapped[i + runLen] === "`") {
        runLen++;
      }
      // Scan forward for a matching closing run of EXACT length `runLen`
      let j = i + runLen;
      let closeIdx = -1;
      while (j < preUnwrapped.length) {
        if (preUnwrapped[j] === "`") {
          let cLen = 1;
          while (j + cLen < preUnwrapped.length && preUnwrapped[j + cLen] === "`") {
            cLen++;
          }
          if (cLen === runLen) {
            closeIdx = j;
            break;
          }
          j += cLen;
          continue;
        }
        j++;
      }
      if (closeIdx >= 0) {
        const spanSlice = preUnwrapped.slice(i, closeIdx + runLen);
        out += spanSlice.replace(/[^\r\n]/g, " ");
        i = closeIdx + runLen;
        continue;
      }
      // Unclosed backtick run is literal text in CommonMark
      out += "`".repeat(runLen);
      i += runLen;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function extractTopLevelMarkdownProseLines(text) {
  const rawLines = String(text || "").split(/\r?\n/);
  const kept = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  for (const raw of rawLines) {
    // Strip any leading blockquote (`>`) AND list item (`- `, `* `, `+ `, `1. `) prefixes
    // so fenced code blocks nested inside lists or blockquotes are ALWAYS tracked!
    const strippedContainer = stripContainerPrefixes(raw);
    const tf = strippedContainer.replace(/^[ \t]{0,3}/, "");
    const fm = tf.match(/^(`{3,}|~{3,})/);
    if (fm) {
      const ch = fm[1][0];
      const len = fm[1].length;
      if (!inFence && (ch === "~" || !tf.slice(len).includes("`"))) {
        inFence = true;
        fenceChar = ch;
        fenceLen = len;
        kept.push("");
        continue;
      }
      if (inFence && ch === fenceChar && len >= fenceLen && tf.slice(len).trim() === "") {
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
        kept.push("");
        continue;
      }
    }
    if (inFence) {
      kept.push("");
      continue;
    }
    // Reject blockquoted lines (`>`), list-item lines, or 4-space/tab indented code lines
    // as top-level writer provenance declarations!
    if (/^[ \t]{0,3}>/.test(raw) || /^(?: {4,}|\t)/.test(raw) || strippedContainer !== raw) {
      kept.push("");
      continue;
    }
    kept.push(raw);
  }
  return stripMultiLineInlineCodeSpans(kept.join("\n")).split("\n");
}

export function extractWriterAttestedDispatchIds(text) {
  const ids = new Set();
  const topLines = extractTopLevelMarkdownProseLines(text);
  const topText = topLines.join("\n");
  const commentRe = /<!--\s*orca-dispatch:\s*([^\s>]+)\s*-->/gi;
  let cm = null;
  while ((cm = commentRe.exec(topText)) !== null) {
    if (cm[1]) ids.add(cm[1].trim());
  }
  for (const raw of topLines) {
    const cleaned = normalizeMarkerLine(raw);
    const dm = /^(?:\*\*|__)?Dispatch-ID(?:\*\*|__)?\s*:\s*`?([^`\s*]+)`?$/i.exec(cleaned);
    if (dm && dm[1]) ids.add(dm[1].trim());
  }
  return [...ids];
}

function lstatSafe(p) {
  try { return lstatSync(p); } catch { return null; }
}

function resolveTrustedWalkRoot(artDir, gitDir = null, wtRootDir = null) {
  const artAbs = resolve(artDir);
  if (wtRootDir) {
    const wtAbs = resolve(wtRootDir);
    const r = relative(wtAbs, artAbs);
    if (!r.startsWith("..") && !isAbsolute(r)) return wtAbs;
  }
  if (gitDir) {
    const gitAbs = resolve(gitDir);
    const r = relative(gitAbs, artAbs);
    if (!r.startsWith("..") && !isAbsolute(r)) return gitAbs;
  }
  // Standard `.orca/artifacts` layout: walk from the enclosing worktree root two levels up
  // so `.orca` or `.orca/artifacts` being a symlink is ALWAYS detected even in standalone calls!
  const parentDir = dirname(artAbs);
  if (basename(parentDir) === ".orca") {
    return dirname(parentDir);
  }
  return artAbs;
}

/**
 * P0-01: Walk EVERY path component from `baseDir` down to `targetPath` with `lstatSync`
 * so a symlink on any parent directory (e.g. `reviews -> /tmp/evil`) or path traversal
 * (`..`) is rejected identically to a leaf symlink!
 */
export function hasSymlinkInPath(baseDir, targetPath) {
  const baseAbs = resolve(baseDir);
  const targetAbs = resolve(targetPath);
  const rel = relative(baseAbs, targetAbs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { bad: true, reason: `path traversal outside artifact root rejected (${rel})` };
  }
  const baseLst = lstatSafe(baseAbs);
  if (baseLst && baseLst.isSymbolicLink()) {
    return { bad: true, reason: `symlink rejected on artifact root ${baseAbs}` };
  }
  if (!rel) return { bad: false, reason: null };
  const parts = rel.split(sep).filter(Boolean);
  let cur = baseAbs;
  for (const seg of parts) {
    cur = join(cur, seg);
    const lst = lstatSafe(cur);
    if (!lst) break;
    if (lst.isSymbolicLink()) {
      return { bad: true, reason: `symlink rejected in artifact path (${seg})` };
    }
  }
  return { bad: false, reason: null };
}

/**
 * P0-01: Verify that `targetPath` resolves strictly INSIDE `rootDir` (never equal to `rootDir`,
 * never escaping via `..`, and never absolute outside `rootDir`).
 */
export function isStrictlyInsideDir(rootDir, targetPath) {
  if (!rootDir || !targetPath) return false;
  const rootAbs = resolve(rootDir);
  const targetAbs = resolve(targetPath);
  const rel = relative(rootAbs, targetAbs);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    return false;
  }
  return true;
}

/**
 * Full artifact check for a pipeline step: strict directory containment (`artDir` & `.dispatch-<id>`),
 * symlink rejection from trusted worktree root, existence, minBytes, writer-attested per-dispatch
 * provenance, verify rules, and atomic promotion.
 */
export function verifyStepArtifact(step, artDir, gitDir, minBytes = 200, opts = {}) {
  if (!step || !step.writes) return { ok: true, reason: null };
  const rawWrites = String(step.writes).trim();
  if (!rawWrites || isAbsolute(rawWrites) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(rawWrites)) {
    return { ok: false, reason: `artifact path "${step.writes}" escapes artifact directory` };
  }
  const isSettlement = (opts.mode || "settlement") === "settlement";
  const safeDisp = opts.dispatchId ? String(opts.dispatchId).replace(/[^A-Za-z0-9._-]+/g, "_") : null;
  const dispatchScopedDir = safeDisp ? join(artDir, `.dispatch-${safeDisp}`) : null;
  const dispatchScopedPath = dispatchScopedDir ? join(dispatchScopedDir, step.writes) : null;
  const canonicalPath = join(artDir, step.writes);

  // P0-01: Enforce independent strict containment bounds on BOTH `canonicalPath` (inside `artDir`)
  // AND `dispatchScopedPath` (inside `dispatchScopedDir`), BEFORE touching the filesystem!
  if (!isStrictlyInsideDir(artDir, canonicalPath)) {
    return { ok: false, reason: `artifact path "${step.writes}" escapes artifact directory` };
  }
  if (dispatchScopedDir && (!isStrictlyInsideDir(artDir, dispatchScopedDir) || !isStrictlyInsideDir(dispatchScopedDir, dispatchScopedPath))) {
    return { ok: false, reason: `scoped artifact path "${step.writes}" escapes dispatch scope directory` };
  }

  const walkRoot = resolveTrustedWalkRoot(artDir, gitDir, opts.wtRootDir || null);
  const artRootCheck = hasSymlinkInPath(walkRoot, artDir);
  if (artRootCheck.bad) {
    return { ok: false, reason: artRootCheck.reason };
  }

  const thresholdMs = (opts.fsEpochMtimeMs != null && Number.isFinite(opts.fsEpochMtimeMs))
    ? opts.fsEpochMtimeMs
    : ((opts.minMtimeMs != null && Number.isFinite(opts.minMtimeMs)) ? opts.minMtimeMs : null);

  const verifyDispatchClaimRecord = (stMtimeMs) => {
    if (!opts.dispatchId) return { ok: true };
    const claimFile = join(artDir, ".dispatch-gate-claims.json");
    if (hasSymlinkInPath(walkRoot, claimFile).bad) {
      return {
        ok: false,
        reason: `symlink rejected on dispatch provenance claim file for ${step.writes}`,
      };
    }
    const clStat = lstatSafe(claimFile);
    if (!clStat || clStat.isSymbolicLink() || !clStat.isFile()) {
      return {
        ok: false,
        reason: `unattributed gate artifact: missing dispatch provenance claim for ${step.writes} (expected dispatch ${opts.dispatchId})`,
      };
    }
    let claim = null;
    try {
      const claims = JSON.parse(readFileSync(claimFile, "utf8"));
      claim = claims?.[step.writes] || null;
    } catch {
      claim = null;
    }
    if (!claim || claim.cleared !== true || claim.activeDispatchId !== opts.dispatchId) {
      return {
        ok: false,
        reason: `unattributed gate artifact: ${step.writes} provenance (${claim?.activeDispatchId || "none"}) does not match active dispatch ${opts.dispatchId}`,
      };
    }
    if (claim.fsEpochMtimeMs != null && Number.isFinite(claim.fsEpochMtimeMs) && stMtimeMs < claim.fsEpochMtimeMs) {
      return {
        ok: false,
        reason: `stale gate artifact: ${step.writes} mtime (${stMtimeMs.toFixed(3)}) predates dispatch ${opts.dispatchId} epoch (${claim.fsEpochMtimeMs.toFixed(3)})`,
      };
    }
    return { ok: true };
  };

  // P0-01: Inspect dispatch-scoped candidate IN-PLACE FIRST (rejecting symlinks along the
  // entire path chain and wrong-ID/invalid content BEFORE touching canonical `<writes>`!),
  // then atomically promote via basename temp + rename!
  if (isSettlement && dispatchScopedPath) {
    const scopedChain = hasSymlinkInPath(walkRoot, dispatchScopedPath);
    if (scopedChain.bad) {
      return { ok: false, reason: scopedChain.reason };
    }
    const scopedLst = lstatSafe(dispatchScopedPath);
    if (scopedLst) {
      if (scopedLst.isSymbolicLink() || !scopedLst.isFile()) {
        return { ok: false, reason: `symlink or non-regular gate artifact rejected at .dispatch-${safeDisp}/${step.writes}` };
      }
      if (opts.clearedBeforeDispatch === false) {
        return { ok: false, reason: `stale artifact guard: ${step.writes} was not cleared prior to dispatch` };
      }
      if (scopedLst.size < minBytes) {
        return { ok: false, reason: `too small (${scopedLst.size} bytes < ${minBytes} min)` };
      }
      if (thresholdMs != null && scopedLst.mtimeMs < thresholdMs) {
        return { ok: false, reason: `stale artifact: ${step.writes} mtime (${scopedLst.mtimeMs.toFixed(3)}) predates current dispatch (${thresholdMs.toFixed(3)})` };
      }
      const claimRes = verifyDispatchClaimRecord(scopedLst.mtimeMs);
      if (!claimRes.ok) return claimRes;

      let scopedText = "";
      try { scopedText = readFileSync(dispatchScopedPath, "utf8"); } catch (e) { return { ok: false, reason: `read failed: ${e.message}` }; }
      const writerIds = extractWriterAttestedDispatchIds(scopedText);
      if (writerIds.some((id) => id !== opts.dispatchId)) {
        const bad = writerIds.find((id) => id !== opts.dispatchId);
        return {
          ok: false,
          reason: `mismatched Dispatch-ID in .dispatch-${safeDisp}/${step.writes}: found "${bad}", expected "${opts.dispatchId}"`,
        };
      }
      let contentRes = { ok: true, reason: null };
      if (step.verify) {
        contentRes = verifyArtifactContent(scopedText, step.verify, {
          gitDir, artDir, mode: opts.mode || "settlement", targetBranch: opts.targetBranch || "dev",
          allowOneWayMerge: Boolean(opts.allowOneWayMerge), preStepTargetSha: opts.preStepTargetSha || null,
          preStepOriginTargetSha: opts.preStepOriginTargetSha || null, preStepRemoteTargetSha: opts.preStepRemoteTargetSha || null,
          preStepRemoteError: opts.preStepRemoteError || null, preStepHasOrigin: Boolean(opts.preStepHasOrigin),
          preStepHeadSha: opts.preStepHeadSha || null, mergeDangerThresholds: opts.mergeDangerThresholds || null,
        });
        if (!contentRes.ok) return contentRes;
      }

      // All checks passed in-place: verify entire canonical destination path from `walkRoot` has zero symlinks, then atomically promote!
      const canonChain = hasSymlinkInPath(walkRoot, canonicalPath);
      if (canonChain.bad) {
        return { ok: false, reason: canonChain.reason };
      }
      mkdirSync(dirname(canonicalPath), { recursive: true });
      const promoteTmp = join(dirname(canonicalPath), `.tmp-${basename(canonicalPath)}-${process.pid}-${Date.now()}`);
      try {
        copyFileSync(dispatchScopedPath, promoteTmp);
        try { utimesSync(promoteTmp, scopedLst.atime, scopedLst.mtime); } catch {}
        renameSync(promoteTmp, canonicalPath);
      } catch (e) {
        try { rmSync(promoteTmp, { force: true }); } catch {}
        return { ok: false, reason: `atomic promotion of ${step.writes} failed: ${e.message}` };
      }
      return contentRes;
    }
  }

  const canonPathCheck = hasSymlinkInPath(walkRoot, canonicalPath);
  if (canonPathCheck.bad) {
    return { ok: false, reason: canonPathCheck.reason };
  }
  const filePath = canonicalPath;
  const st = lstatSafe(filePath);
  if (!st) {
    return { ok: false, reason: "missing" };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { ok: false, reason: `symlink or non-regular gate artifact rejected: ${step.writes}` };
  }
  if (st.size < minBytes) {
    return { ok: false, reason: `too small (${st.size} bytes < ${minBytes} min)` };
  }
  if (isSettlement) {
    if (opts.clearedBeforeDispatch === false) {
      return { ok: false, reason: `stale artifact guard: ${step.writes} was not cleared prior to dispatch` };
    }
    if (thresholdMs != null && st.mtimeMs < thresholdMs) {
      return {
        ok: false,
        reason: `stale artifact: ${step.writes} mtime (${st.mtimeMs.toFixed(3)}) predates current dispatch (${thresholdMs.toFixed(3)})`,
      };
    }
    const claimRes = verifyDispatchClaimRecord(st.mtimeMs);
    if (!claimRes.ok) return claimRes;
  }
  if (!step.verify) {
    return { ok: true, reason: null };
  }
  let text = "";
  try { text = readFileSync(filePath, "utf8"); } catch (e) { return { ok: false, reason: `read failed: ${e.message}` }; }
  if (isSettlement && opts.dispatchId) {
    const writerIds = extractWriterAttestedDispatchIds(text);
    if (writerIds.some((id) => id !== opts.dispatchId)) {
      const bad = writerIds.find((id) => id !== opts.dispatchId);
      return {
        ok: false,
        reason: `mismatched Dispatch-ID in ${step.writes}: found "${bad}", expected "${opts.dispatchId}"`,
      };
    }
    if (!writerIds.includes(opts.dispatchId)) {
      return {
        ok: false,
        reason: `unattested gate artifact: ${step.writes} lacks writer-attested provenance for active dispatch ${opts.dispatchId} (missing Dispatch-ID marker and not written via .dispatch-${safeDisp}/${step.writes})`,
      };
    }
  }
  return verifyArtifactContent(text, step.verify, { gitDir, artDir, mode: opts.mode || "settlement", targetBranch: opts.targetBranch || "dev", allowOneWayMerge: Boolean(opts.allowOneWayMerge), preStepTargetSha: opts.preStepTargetSha || null, preStepOriginTargetSha: opts.preStepOriginTargetSha || null, preStepRemoteTargetSha: opts.preStepRemoteTargetSha || null, preStepRemoteError: opts.preStepRemoteError || null, preStepHasOrigin: Boolean(opts.preStepHasOrigin), preStepHeadSha: opts.preStepHeadSha || null, mergeDangerThresholds: opts.mergeDangerThresholds || null });
}

export function formatVerifySummary(verify) {
  if (!verify) return "";
  const parts = [];
  if (verify.requireVerdict) parts.push(`verdict:${verify.requireVerdict}`);
  if (verify.requireContractCommit) parts.push(`commit:${verify.requireContractCommit}`);
  if (verify.requireMergedTasks) parts.push("merged-tasks");
  if (verify.mergeDangerCheck) parts.push("merge-danger");
  return parts.join(",");
}

// --- Standalone CLI entrypoint ---
function runCli(argv) {
  const opts = { artifact: null, requireVerdict: null, requireContractCommit: null, gitDir: process.cwd(), artDir: null, minBytes: 200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--artifact" && argv[i + 1]) opts.artifact = argv[++i];
    else if (a === "--require-verdict" && argv[i + 1]) opts.requireVerdict = argv[++i];
    else if (a === "--require-contract-commit" && argv[i + 1]) opts.requireContractCommit = argv[++i];
    else if (a === "--git-dir" && argv[i + 1]) opts.gitDir = argv[++i];
    else if (a === "--art-dir" && argv[i + 1]) opts.artDir = argv[++i];
    else if (a === "--min-bytes" && argv[i + 1]) opts.minBytes = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node .orca/gate-verify.mjs --artifact <file> [--require-verdict PASS] [--require-contract-commit HEAD|<40-sha>] [--git-dir <dir>] [--min-bytes 200]");
      process.exit(0);
    }
  }
  if (!opts.artifact) {
    console.error("[gate-verify] ERROR: --artifact <file> is required.");
    process.exit(2);
  }
  const abs = resolve(opts.artifact);
  if (!existsSync(abs)) {
    console.error(`[gate-verify] FAIL: artifact not found: ${abs}`);
    process.exit(1);
  }
  const size = statSync(abs).size;
  if (size < opts.minBytes) {
    console.error(`[gate-verify] FAIL: artifact too small (${size} < ${opts.minBytes} bytes): ${abs}`);
    process.exit(1);
  }
  const verify = {};
  if (opts.requireVerdict) verify.requireVerdict = opts.requireVerdict;
  if (opts.requireContractCommit) verify.requireContractCommit = opts.requireContractCommit;
  const res = verifyArtifactContent(readFileSync(abs, "utf8"), verify, { gitDir: opts.gitDir, artDir: opts.artDir, mode: "settlement" });
  if (!res.ok) {
    console.error(`[gate-verify] FAIL: ${res.reason}`);
    process.exit(1);
  }
  console.log(`[gate-verify] PASS: ${abs}` +
    (res.verdict ? ` (VERDICT=${res.verdict})` : "") +
    (res.contractCommit ? ` (Contract-Commit=${res.contractCommit})` : ""));
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2));
}
