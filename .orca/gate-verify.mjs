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

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyMergeDangerGate } from "./merge-danger.mjs";

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const ALLOWED_VERIFY_KEYS = new Set(["requireVerdict", "requireContractCommit", "requireMergedTasks", "mergeDangerCheck"]);
const O_NOFOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK_FLAG = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;

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

function readManifestSafe(artDir, { gitDir = null, wtRootDir = null } = {}) {
  if (!artDir) {
    return { ok: false, manifest: null, missing: true, reason: "WORKTREES.json is missing" };
  }
  const walkRoot = resolveTrustedWalkRoot(artDir, gitDir, wtRootDir);
  const p = join(artDir, "WORKTREES.json");
  try {
    const { text } = readFileNoFollow(walkRoot, artDir, p, { encoding: "utf8", label: "[gate-verify]" });
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, manifest: null, missing: false, reason: "WORKTREES.json must be a JSON object" };
    }
    return { ok: true, manifest: parsed, missing: false, reason: null };
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return { ok: false, manifest: null, missing: true, reason: "WORKTREES.json is missing" };
    }
    return { ok: false, manifest: null, missing: false, reason: e?.message || "invalid WORKTREES.json" };
  }
}

/**
 * Deterministic verification of an artifact's UTF-8 text against `verify` rules.
 *
 * Options:
 *  - gitDir: integration worktree directory
 *  - artDir: artifacts directory (used to consult WORKTREES.json)
 *  - wtRootDir: optional explicit worktree root directory for containment checks
 *  - mode: "settlement" (strict HEAD match) | "readiness" (allows post-merge ancestor match)
 */
export function verifyArtifactContent(text, verify, { gitDir = null, artDir = null, wtRootDir = null, mode = "settlement", targetBranch = "dev", allowOneWayMerge = false, preStepTargetSha = null, preStepOriginTargetSha = null, preStepRemoteTargetSha = null, preStepRemoteError = null, preStepHasOrigin = false, preStepHeadSha = null, mergeDangerThresholds = null } = {}) {
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
      const mfRes = mode === "readiness" ? readManifestSafe(artDir, { gitDir, wtRootDir }) : null;
      const mf = mfRes?.ok ? mfRes.manifest : null;
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
    const mfRes = readManifestSafe(artDir, { gitDir, wtRootDir });
    if (!mfRes.ok) {
      return {
        ok: false,
        reason: `invalid or missing WORKTREES.json for requireMergedTasks: ${mfRes.reason}`,
        verdict: foundVerdict, contractCommit: foundCommit, expectedCommit,
      };
    }
    if (!mfRes.manifest.tasks || typeof mfRes.manifest.tasks !== "object" || Array.isArray(mfRes.manifest.tasks)) {
      return {
        ok: false,
        reason: "invalid or missing WORKTREES.json for requireMergedTasks: manifest.tasks must be an object",
        verdict: foundVerdict, contractCommit: foundCommit, expectedCommit,
      };
    }
    const tasks = Object.values(mfRes.manifest.tasks);
    const isRealGit = gitDir ? spawnSync("git", ["-C", gitDir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).status === 0 : false;
    for (const t of tasks) {
      if (!t || typeof t !== "object" || Array.isArray(t)) {
        return {
          ok: false,
          reason: "invalid or missing WORKTREES.json for requireMergedTasks: malformed task entry",
          verdict: foundVerdict, contractCommit: foundCommit, expectedCommit,
        };
      }
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

export function resolveTrustedWalkRoot(artDir, gitDir = null, wtRootDir = null) {
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

function sameResolvedPath(a, b) {
  return (process.platform === "win32" || process.platform === "darwin")
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/**
 * P0-01b: Verify lexical containment (`containerDir` inside/equal `trustedRootDir`, `targetPath`
 * strictly inside `containerDir`), walk EVERY segment from `trustedRootDir` down to `targetPath`
 * via `lstatSync` to reject any symlink (`.orca`, `artifacts`, nested subdirs, or leaf), AND
 * verify physical `realpathSync` containment of the deepest existing ancestor inside `trustedRootDir`
 * BEFORE any filesystem mutation (`mkdirSync`, `rmSync`, `writeFileSync`, `copyFileSync`)!
 */
export function verifySafePathFromRoot(trustedRootDir, containerDir, targetPath) {
  if (!trustedRootDir || !containerDir || !targetPath) {
    return { ok: false, reason: "missing root/container/target path for containment verification" };
  }
  const rootAbs = resolve(trustedRootDir);
  const containerAbs = resolve(containerDir);
  const targetAbs = resolve(targetPath);
  if (!sameResolvedPath(rootAbs, containerAbs) && !isStrictlyInsideDir(rootAbs, containerAbs)) {
    return { ok: false, reason: `container path "${containerAbs}" escapes trusted root "${rootAbs}"` };
  }
  if (!isStrictlyInsideDir(containerAbs, targetAbs)) {
    return { ok: false, reason: `target path "${targetAbs}" escapes container directory "${containerAbs}"` };
  }
  const sym = hasSymlinkInPath(rootAbs, targetAbs);
  if (sym.bad) {
    return { ok: false, reason: sym.reason };
  }
  if (existsSync(rootAbs)) {
    let realRoot;
    try {
      realRoot = realpathSync(rootAbs);
    } catch (e) {
      return { ok: false, reason: `failed to resolve realpath of trusted root "${rootAbs}": ${e?.message || e}` };
    }
    let anc = targetAbs;
    while (!sameResolvedPath(anc, rootAbs) && !lstatSafe(anc)) {
      const parent = dirname(anc);
      if (parent === anc) break;
      anc = parent;
    }
    const ancLst = lstatSafe(anc);
    if (ancLst && ancLst.isSymbolicLink()) {
      return { ok: false, reason: `symlink rejected in physical path (${anc})` };
    }
    if (existsSync(anc)) {
      let realAnc;
      try {
        realAnc = realpathSync(anc);
      } catch (e) {
        return { ok: false, reason: `failed to resolve realpath of ancestor "${anc}": ${e?.message || e}` };
      }
      if (!sameResolvedPath(realAnc, realRoot) && !isStrictlyInsideDir(realRoot, realAnc)) {
        return { ok: false, reason: `physical path "${realAnc}" escapes trusted root "${realRoot}"` };
      }
      if (existsSync(containerAbs)) {
        let realContainer;
        try {
          realContainer = realpathSync(containerAbs);
        } catch (e) {
          return { ok: false, reason: `failed to resolve realpath of container "${containerAbs}": ${e?.message || e}` };
        }
        if (!sameResolvedPath(realContainer, realRoot) && !isStrictlyInsideDir(realRoot, realContainer)) {
          return { ok: false, reason: `physical container "${realContainer}" escapes trusted root "${realRoot}"` };
        }
        if (sameResolvedPath(anc, containerAbs) || isStrictlyInsideDir(containerAbs, anc)) {
          if (!sameResolvedPath(realAnc, realContainer) && !isStrictlyInsideDir(realContainer, realAnc)) {
            return { ok: false, reason: `physical path "${realAnc}" escapes container "${realContainer}"` };
          }
        }
      }
    }
  }
  return { ok: true, reason: null };
}

export function assertSafePathFromRoot(trustedRootDir, containerDir, targetPath, errPrefix = "[gate-verify]") {
  const check = verifySafePathFromRoot(trustedRootDir, containerDir, targetPath);
  if (!check.ok) {
    throw new Error(`${errPrefix} ${check.reason}`);
  }
}

/**
 * P0-01b: Read a regular file inside `containerDir` (anchored at `walkRoot`) from a
 * SINGLE `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` descriptor (no separate pre-open `lstatSync`
 * race window, and `O_NONBLOCK` prevents blocking on writerless POSIX FIFOs before `fstatSync`!),
 * verifying `fstatSync(fd).isFile()` before AND after `readFileSync(fd)` with matching
 * `(dev, ino)` and `buf.length === stAfter.size`.
 */
export function readFileNoFollow(walkRoot, containerDir, srcPath, { encoding = null, label = "[gate-verify]" } = {}) {
  assertSafePathFromRoot(walkRoot, containerDir, srcPath, label);
  let fd = null;
  try {
    try {
      fd = openSync(srcPath, constants.O_RDONLY | O_NOFOLLOW_FLAG | O_NONBLOCK_FLAG);
    } catch (e) {
      if (e && (e.code === "ELOOP" || e.code === "EMLINK" || e.code === "EFTYPE")) {
        const err = new Error(`${label} symlink rejected: "${srcPath}"`);
        err.code = "ELOOP";
        throw err;
      }
      if (e && e.code === "EISDIR") {
        const err = new Error(`${label} directory rejected: "${srcPath}"`);
        err.code = "EINVAL";
        throw err;
      }
      throw e;
    }
    const stBefore = fstatSync(fd);
    if (!stBefore.isFile()) {
      const err = new Error(`${label} non-regular file rejected: "${srcPath}"`);
      err.code = "EINVAL";
      throw err;
    }
    const buf = readFileSync(fd);
    const stAfter = fstatSync(fd);
    if (
      !stAfter.isFile() ||
      stAfter.dev !== stBefore.dev ||
      stAfter.ino !== stBefore.ino ||
      buf.length !== stAfter.size
    ) {
      const err = new Error(`${label} concurrent modification detected while reading "${srcPath}"`);
      err.code = "EAGAIN";
      throw err;
    }
    return { buf, text: encoding ? buf.toString(encoding) : null, stat: stAfter };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

/**
 * P0-01b: Atomically publish `data` to `targetPath` inside `containerDir` (anchored at `walkRoot`):
 *   1. Creates a private `0o700` staging directory `.orca-stage-*` (unless explicit `tempName` is passed).
 *   2. Opens `tmpPath` with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` (fails `EEXIST` if occupied)
 *      and captures kernel identity `(expectedDev, expectedIno)`.
 *   3. Keeps `fd` open on POSIX across pre-rename `lstatSync` (binding `dev`, `ino`, `size`, `nlink === 1`),
 *      `renameSync(tmpPath, targetPath)`, AND post-rename verification (`openSync(targetPath, O_RDONLY | O_NOFOLLOW)`
 *      asserting `dev === expectedDev`, `ino === expectedIno`, `size === buf.length`, and exact byte equality).
 */
export function writeFileAtomicNoFollow(
  walkRoot,
  containerDir,
  targetPath,
  data,
  { mode = 0o644, atime = null, mtime = null, label = "[gate-verify]", tempName = null } = {}
) {
  assertSafePathFromRoot(walkRoot, containerDir, targetPath, label);
  const parentDir = dirname(resolve(targetPath));
  mkdirSync(parentDir, { recursive: true });
  assertSafePathFromRoot(walkRoot, containerDir, targetPath, label);
  const existingDstLst = lstatSafe(targetPath);
  if (existingDstLst && (existingDstLst.isSymbolicLink() || existingDstLst.isDirectory())) {
    throw new Error(`${label} refusing to overwrite symlink or directory at "${targetPath}"`);
  }

  let stageDir = null;
  let createdStageDir = false;
  let tmpPath = null;
  let fd = null;
  let createdTmp = false;
  let expectedDev = null;
  let expectedIno = null;

  try {
    if (tempName != null) {
      const leafTmp = basename(String(tempName));
      tmpPath = join(parentDir, leafTmp);
      if (!leafTmp || leafTmp === "." || leafTmp === ".." || dirname(resolve(tmpPath)) !== parentDir || !isStrictlyInsideDir(containerDir, tmpPath)) {
        throw new Error(`${label} invalid temporary path "${tmpPath}" outside container "${containerDir}"`);
      }
    } else {
      stageDir = join(parentDir, `.orca-stage-${process.pid}-${Date.now()}-${randomBytes(12).toString("hex")}`);
      if (dirname(resolve(stageDir)) !== parentDir || !isStrictlyInsideDir(containerDir, stageDir)) {
        throw new Error(`${label} invalid staging directory "${stageDir}" outside container "${containerDir}"`);
      }
      mkdirSync(stageDir, { mode: 0o700 });
      createdStageDir = true;
      assertSafePathFromRoot(walkRoot, containerDir, stageDir, label);
      const stageLst = lstatSafe(stageDir);
      if (!stageLst || stageLst.isSymbolicLink() || !stageLst.isDirectory()) {
        throw new Error(`${label} staging directory check failed at "${stageDir}"`);
      }
      const leafTmp = `.tmp-${basename(targetPath)}-${randomBytes(12).toString("hex")}`;
      tmpPath = join(stageDir, leafTmp);
      if (dirname(resolve(tmpPath)) !== resolve(stageDir) || !isStrictlyInsideDir(containerDir, tmpPath)) {
        throw new Error(`${label} invalid staged temporary path "${tmpPath}"`);
      }
    }

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    // Kernel-atomic exclusive creation: fails with `EEXIST` if ANY regular file, directory,
    // live symlink, or dangling symlink already occupies `tmpPath`, without ever following it!
    fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW_FLAG, mode);
    createdTmp = true;
    const tmpFdStat = fstatSync(fd);
    if (!tmpFdStat.isFile()) {
      throw new Error(`${label} temporary fd is not a regular file at "${tmpPath}"`);
    }
    expectedDev = tmpFdStat.dev;
    expectedIno = tmpFdStat.ino;

    let offset = 0;
    while (offset < buf.length) {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    }
    if (atime != null && mtime != null) {
      futimesSync(fd, atime, mtime);
    }
    const writtenStat = fstatSync(fd);
    if (
      !writtenStat.isFile() ||
      writtenStat.dev !== expectedDev ||
      writtenStat.ino !== expectedIno ||
      writtenStat.size !== buf.length ||
      writtenStat.nlink !== 1
    ) {
      throw new Error(`${label} temporary fd state changed unexpectedly at "${tmpPath}"`);
    }

    // Windows blocks renaming an open descriptor; on POSIX keep `fd` open across `renameSync`
    // and post-rename verification so the kernel cannot recycle `(expectedDev, expectedIno)`!
    if (process.platform === "win32") {
      closeSync(fd);
      fd = null;
    }

    assertSafePathFromRoot(walkRoot, containerDir, targetPath, label);
    assertSafePathFromRoot(walkRoot, containerDir, tmpPath, label);
    const postDstLst = lstatSafe(targetPath);
    if (postDstLst && (postDstLst.isSymbolicLink() || postDstLst.isDirectory())) {
      throw new Error(`${label} refusing to replace symlink or directory at "${targetPath}"`);
    }
    const postTmpLst = lstatSafe(tmpPath);
    if (
      !postTmpLst ||
      postTmpLst.isSymbolicLink() ||
      !postTmpLst.isFile() ||
      postTmpLst.dev !== expectedDev ||
      postTmpLst.ino !== expectedIno ||
      postTmpLst.size !== buf.length ||
      postTmpLst.nlink !== 1
    ) {
      throw new Error(`${label} temporary file identity mismatch before rename at "${tmpPath}"`);
    }

    renameSync(tmpPath, targetPath);
    createdTmp = false;

    // Post-rename verification: confirm the published file at `targetPath` has the EXACT
    // `(expectedDev, expectedIno)` and byte-for-byte content we wrote!
    let verifyFd = null;
    try {
      assertSafePathFromRoot(walkRoot, containerDir, targetPath, label);
      verifyFd = openSync(targetPath, constants.O_RDONLY | O_NOFOLLOW_FLAG | O_NONBLOCK_FLAG);
      const pubStat = fstatSync(verifyFd);
      if (
        !pubStat.isFile() ||
        pubStat.dev !== expectedDev ||
        pubStat.ino !== expectedIno ||
        pubStat.size !== buf.length
      ) {
        throw new Error(`${label} published artifact identity mismatch after rename at "${targetPath}"`);
      }
      const pubBuf = readFileSync(verifyFd);
      if (pubBuf.length !== buf.length || Buffer.compare(pubBuf, buf) !== 0) {
        throw new Error(`${label} published artifact content mismatch after rename at "${targetPath}"`);
      }
    } finally {
      if (verifyFd !== null) {
        try { closeSync(verifyFd); } catch {}
      }
    }
  } catch (e) {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
      fd = null;
    }
    if (createdTmp && tmpPath) {
      try {
        const curLst = lstatSafe(tmpPath);
        if (
          curLst &&
          !curLst.isSymbolicLink() &&
          curLst.isFile() &&
          curLst.dev === expectedDev &&
          curLst.ino === expectedIno
        ) {
          unlinkSync(tmpPath);
        }
      } catch {}
    }
    throw e;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
      fd = null;
    }
    if (createdStageDir && stageDir) {
      try { rmdirSync(stageDir); } catch {}
    }
  }
}

export function copyFileAtomicNoFollow(
  srcWalkRoot,
  srcContainerDir,
  srcPath,
  dstWalkRoot,
  dstContainerDir,
  dstPath,
  { preserveMtime = false, label = "[worktree-isolation]", tempName = null } = {}
) {
  const { buf, stat } = readFileNoFollow(srcWalkRoot, srcContainerDir, srcPath, { label });
  writeFileAtomicNoFollow(dstWalkRoot, dstContainerDir, dstPath, buf, {
    mode: (stat.mode & 0o777) || 0o644,
    atime: preserveMtime ? stat.atime : null,
    mtime: preserveMtime ? stat.mtime : null,
    label,
    tempName,
  });
}

/**
 * Full artifact check for a pipeline step: strict directory containment (`artDir` & `.dispatch-<id>`),
 * symlink rejection from trusted worktree root, single-FD snapshot verification (zero double-open
 * between verify and promote), writer-attested per-dispatch provenance, verify rules, and
 * inode-bound atomic promotion.
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
  const canonRootCheck = verifySafePathFromRoot(walkRoot, artDir, canonicalPath);
  if (!canonRootCheck.ok) {
    return { ok: false, reason: canonRootCheck.reason };
  }
  if (dispatchScopedDir && dispatchScopedPath) {
    const scopedRootCheck = verifySafePathFromRoot(walkRoot, dispatchScopedDir, dispatchScopedPath);
    if (!scopedRootCheck.ok) {
      return { ok: false, reason: scopedRootCheck.reason };
    }
  }

  const thresholdMs = (opts.fsEpochMtimeMs != null && Number.isFinite(opts.fsEpochMtimeMs))
    ? opts.fsEpochMtimeMs
    : ((opts.minMtimeMs != null && Number.isFinite(opts.minMtimeMs)) ? opts.minMtimeMs : null);

  const verifyDispatchClaimRecord = (stMtimeMs) => {
    if (!opts.dispatchId) return { ok: true };
    const claimFile = join(artDir, ".dispatch-gate-claims.json");
    if (!verifySafePathFromRoot(walkRoot, artDir, claimFile).ok) {
      return {
        ok: false,
        reason: `symlink rejected on dispatch provenance claim file for ${step.writes}`,
      };
    }
    let claim = null;
    try {
      const { text: claimRaw } = readFileNoFollow(walkRoot, artDir, claimFile, { encoding: "utf8", label: "[gate-verify]" });
      const claims = JSON.parse(claimRaw);
      claim = claims?.[step.writes] || null;
    } catch (e) {
      if (e && e.code === "ELOOP") {
        return {
          ok: false,
          reason: `symlink rejected on dispatch provenance claim file for ${step.writes}`,
        };
      }
      return {
        ok: false,
        reason: `unattributed gate artifact: missing dispatch provenance claim for ${step.writes} (expected dispatch ${opts.dispatchId})`,
      };
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

  // P0-01b: Capture a SINGLE `O_RDONLY | O_NOFOLLOW` descriptor snapshot (`scopedBuf`, `scopedText`,
  // `scopedStat`), validate ALL rules on that exact buffer, and promote `scopedBuf` directly via
  // `writeFileAtomicNoFollow` — NEVER re-opening `dispatchScopedPath` by path!
  if (isSettlement && dispatchScopedPath) {
    const scopedChain = verifySafePathFromRoot(walkRoot, dispatchScopedDir, dispatchScopedPath);
    if (!scopedChain.ok) {
      return { ok: false, reason: scopedChain.reason };
    }
    let scopedSnap = null;
    try {
      scopedSnap = readFileNoFollow(walkRoot, dispatchScopedDir, dispatchScopedPath, {
        encoding: "utf8",
        label: "[gate-verify]",
      });
    } catch (e) {
      if (e && e.code === "ENOENT") {
        scopedSnap = null;
      } else if (e && (e.code === "ELOOP" || e.code === "EINVAL")) {
        return { ok: false, reason: `symlink or non-regular gate artifact rejected at .dispatch-${safeDisp}/${step.writes}` };
      } else {
        return { ok: false, reason: `read failed: ${e?.message || e}` };
      }
    }
    if (scopedSnap) {
      const { buf: scopedBuf, text: scopedText, stat: scopedStat } = scopedSnap;
      if (opts.clearedBeforeDispatch === false) {
        return { ok: false, reason: `stale artifact guard: ${step.writes} was not cleared prior to dispatch` };
      }
      if (scopedBuf.length < minBytes || scopedStat.size < minBytes) {
        return { ok: false, reason: `too small (${scopedBuf.length} bytes < ${minBytes} min)` };
      }
      if (thresholdMs != null && scopedStat.mtimeMs < thresholdMs) {
        return { ok: false, reason: `stale artifact: ${step.writes} mtime (${scopedStat.mtimeMs.toFixed(3)}) predates current dispatch (${thresholdMs.toFixed(3)})` };
      }
      const claimRes = verifyDispatchClaimRecord(scopedStat.mtimeMs);
      if (!claimRes.ok) return claimRes;

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
          gitDir, artDir, wtRootDir: opts.wtRootDir || null, mode: opts.mode || "settlement", targetBranch: opts.targetBranch || "dev",
          allowOneWayMerge: Boolean(opts.allowOneWayMerge), preStepTargetSha: opts.preStepTargetSha || null,
          preStepOriginTargetSha: opts.preStepOriginTargetSha || null, preStepRemoteTargetSha: opts.preStepRemoteTargetSha || null,
          preStepRemoteError: opts.preStepRemoteError || null, preStepHasOrigin: Boolean(opts.preStepHasOrigin),
          preStepHeadSha: opts.preStepHeadSha || null, mergeDangerThresholds: opts.mergeDangerThresholds || null,
        });
        if (!contentRes.ok) return contentRes;
      }

      // Promote the ALREADY-VERIFIED `scopedBuf` directly (zero second open of `dispatchScopedPath`!).
      try {
        writeFileAtomicNoFollow(walkRoot, artDir, canonicalPath, scopedBuf, {
          mode: (scopedStat.mode & 0o777) || 0o644,
          atime: scopedStat.atime,
          mtime: scopedStat.mtime,
          label: "[gate-verify]",
        });
      } catch (e) {
        return { ok: false, reason: `atomic promotion of ${step.writes} failed: ${e?.message || e}` };
      }
      return contentRes;
    }
  }

  const canonPathCheck = verifySafePathFromRoot(walkRoot, artDir, canonicalPath);
  if (!canonPathCheck.ok) {
    return { ok: false, reason: canonPathCheck.reason };
  }
  const filePath = canonicalPath;
  let canonSnap = null;
  try {
    canonSnap = readFileNoFollow(walkRoot, artDir, filePath, {
      encoding: "utf8",
      label: "[gate-verify]",
    });
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return { ok: false, reason: "missing" };
    }
    if (e && (e.code === "ELOOP" || e.code === "EINVAL")) {
      return { ok: false, reason: `symlink or non-regular gate artifact rejected: ${step.writes}` };
    }
    return { ok: false, reason: `read failed: ${e?.message || e}` };
  }
  const { buf: canonBuf, text, stat: st } = canonSnap;
  if (canonBuf.length < minBytes || st.size < minBytes) {
    return { ok: false, reason: `too small (${canonBuf.length} bytes < ${minBytes} min)` };
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
  return verifyArtifactContent(text, step.verify, { gitDir, artDir, wtRootDir: opts.wtRootDir || null, mode: opts.mode || "settlement", targetBranch: opts.targetBranch || "dev", allowOneWayMerge: Boolean(opts.allowOneWayMerge), preStepTargetSha: opts.preStepTargetSha || null, preStepOriginTargetSha: opts.preStepOriginTargetSha || null, preStepRemoteTargetSha: opts.preStepRemoteTargetSha || null, preStepRemoteError: opts.preStepRemoteError || null, preStepHasOrigin: Boolean(opts.preStepHasOrigin), preStepHeadSha: opts.preStepHeadSha || null, mergeDangerThresholds: opts.mergeDangerThresholds || null });
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
  let cliText = "";
  let cliStat = null;
  let cliFd = null;
  try {
    cliFd = openSync(abs, constants.O_RDONLY | O_NOFOLLOW_FLAG | O_NONBLOCK_FLAG);
    cliStat = fstatSync(cliFd);
    if (!cliStat.isFile()) {
      console.error(`[gate-verify] FAIL: non-regular artifact rejected: ${abs}`);
      process.exit(1);
    }
    cliText = readFileSync(cliFd, "utf8");
  } catch (e) {
    const msg = e && e.code === "ENOENT" ? `artifact not found: ${abs}` : `${e?.message || e}`;
    console.error(`[gate-verify] FAIL: ${msg}`);
    process.exit(1);
  } finally {
    if (cliFd !== null) {
      try { closeSync(cliFd); } catch {}
    }
  }
  const size = Buffer.byteLength(cliText, "utf8");
  if (size < opts.minBytes || cliStat.size < opts.minBytes) {
    console.error(`[gate-verify] FAIL: artifact too small (${size} < ${opts.minBytes} bytes): ${abs}`);
    process.exit(1);
  }
  const verify = {};
  if (opts.requireVerdict) verify.requireVerdict = opts.requireVerdict;
  if (opts.requireContractCommit) verify.requireContractCommit = opts.requireContractCommit;
  const res = verifyArtifactContent(cliText, verify, { gitDir: opts.gitDir, artDir: opts.artDir, mode: "settlement" });
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
