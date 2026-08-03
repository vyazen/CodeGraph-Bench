/**
 * Project discovery for the multi-project oracle.
 *
 * Reimplements the two rules Vyazen's pipeline uses to find TS/JS project
 * boundaries — `project detector` (one project per `package.json`, TS-capable
 * iff a `tsconfig*.json` sits in the same directory) and `selectTsconfigForProject`
 * (deterministic tsconfig-variant priority) — so the oracle discovers the same
 * boundaries a real Vyazen index would, without depending on gilfoyle's NestJS
 * module graph or a live Neo4j connection. See VSCODE_CODE_GRAPH_EVAL_PLAN.md §1.1
 * for why this is the documented fallback (the primary approach — reading the
 * `Project` nodes Vyazen already wrote for a repo — is Phase 2/adapter territory).
 *
 * Source of truth mirrored here:
 * - apps/gilfoyle/src/modules/structural-graph/core/detectors/node-project.detector.ts
 * - apps/gilfoyle/src/modules/resolution/core/services/tsconfig-selector.ts
 *
 * F17 (VSCODE_ORACLE_RESOLUTION_FIX_PLAN.md): the rule above is a Vyazen
 * replica, and it has a blind spot Vyazen shares — a repo whose real TS config
 * lives in a source directory with no `package.json` next to it (e.g. vscode's
 * `src/tsconfig.json`) never gets that tsconfig selected. Every file under it
 * then falls back to `loadCompilerOptionsForProject`'s inferred options — no
 * `baseUrl`/`paths`/`module`, so every bare-specifier import in that subtree is
 * unresolvable. `discoverProjects` breaks the mirroring deliberately: it adds
 * one project per tsconfig directory that has no adjacent `package.json`,
 * because the oracle's job is the language's real semantics, not a copy of
 * Vyazen's own detection gap.
 */

import { readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

const TSCONFIG_REGEX = /^tsconfig(\..+)?\.json$/;

/** Priority order for picking a project's primary tsconfig — mirrors tsconfig-selector.ts exactly. */
const TSCONFIG_PRIORITY: readonly string[] = [
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.lib.json',
  'tsconfig.base.json',
  'tsconfig.src.json',
  'tsconfig.build.json',
  'tsconfig.spec.json',
  'tsconfig.test.json',
];

/** Directories never treated as project source — mirrors "no npm install" (§3.1): there is no node_modules to walk. */
const WALK_IGNORED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git']);

export interface OracleProject {
  /** Repo-relative project root; also used as the map key for ownership. Unique within one discovery result. */
  id: string;
  languages: readonly string[];
  /** Repo-relative project root — '.' for the repo root, else e.g. 'apps/foo'. */
  rootPath: string;
  /** Repo-relative path to the selected tsconfig, or null if the project has none. */
  tsconfigPath: string | null;
}

/**
 * Picks the primary tsconfig for a project — mirrors `selectTsconfigForProject`
 * exactly, including the "must sit directly at the project root" scope rule
 * and the priority-then-lexical-fallback ordering.
 */
export function selectTsconfigForProject(
  projectRoot: string,
  filePaths: Iterable<string>
): string | null {
  const prefix = projectRoot === '.' ? '' : `${projectRoot}/`;
  const candidates = new Set<string>();

  for (const path of filePaths) {
    const name = basename(path);
    if (!TSCONFIG_REGEX.test(name)) {
      continue;
    }
    if (path === `${prefix}${name}`) {
      candidates.add(name);
    }
  }

  if (candidates.size === 0) {
    return null;
  }

  for (const priority of TSCONFIG_PRIORITY) {
    if (candidates.has(priority)) {
      return `${prefix}${priority}`;
    }
  }

  const fallback = [...candidates].sort()[0];
  return `${prefix}${fallback}`;
}

function buildProject(rootPath: string, filePaths: readonly string[]): OracleProject {
  const tsconfigPath = selectTsconfigForProject(rootPath, filePaths);
  const languages = tsconfigPath ? ['TypeScript', 'JavaScript'] : ['JavaScript'];
  return { id: rootPath, languages, rootPath, tsconfigPath };
}

/**
 * Detects one project per `package.json` — mirrors `project detector.detect`.
 * TS-capability is a same-directory tsconfig existence check, independent of
 * which specific variant `selectTsconfigForProject` ends up picking.
 */
function detectNodeProjects(filePaths: readonly string[]): OracleProject[] {
  const packageJsonPaths = filePaths.filter((f) => basename(f) === 'package.json');
  return packageJsonPaths.map((pkgPath) => {
    const rootPath = pkgPath === 'package.json' ? '.' : dirname(pkgPath);
    return buildProject(rootPath, filePaths);
  });
}

/**
 * F17 — one project per directory holding a `tsconfig*.json` with no
 * `package.json` beside it, for every such directory not already covered by
 * `detectNodeProjects`. `buildProject` already selects the right tsconfig
 * variant and priority for that directory once it's treated as a project
 * root — the same logic a `package.json`-rooted project gets.
 */
function detectTsconfigOnlyProjects(
  filePaths: readonly string[],
  alreadyCoveredRoots: ReadonlySet<string>
): OracleProject[] {
  const tsconfigDirs = new Set<string>();
  for (const path of filePaths) {
    if (TSCONFIG_REGEX.test(basename(path))) {
      tsconfigDirs.add(dirname(path));
    }
  }
  const projects: OracleProject[] = [];
  for (const dir of tsconfigDirs) {
    if (!alreadyCoveredRoots.has(dir)) {
      projects.push(buildProject(dir, filePaths));
    }
  }
  return projects;
}

/**
 * Discovers project boundaries from a flat file list.
 *
 * Always guarantees a project with `rootPath === '.'` exists, synthesizing one
 * if no root `package.json` was found — this is what keeps every file owned
 * (§1.2's ownership invariant) and is what makes a repo with no `package.json`
 * at all (e.g. a bare fixture, or a non-Node project) behave exactly like the
 * single-tsconfig-program oracle did before this refactor: one implicit
 * root project.
 *
 * F17 adds a second discovery rule after the `package.json` rule: a directory
 * whose `tsconfig*.json` has no `package.json` beside it gets its own project
 * too, so its tsconfig (and whatever `baseUrl`/`paths`/`module` it sets) is
 * actually used instead of silently falling back to inferred options.
 * `assignFileOwnership`'s deepest-root-wins rule resolves the resulting
 * overlap with an ancestor project without any change there.
 */
export function discoverProjects(filePaths: readonly string[]): OracleProject[] {
  const detected = detectNodeProjects(filePaths);
  const coveredRoots = new Set(detected.map((p) => p.rootPath));

  for (const project of detectTsconfigOnlyProjects(filePaths, coveredRoots)) {
    detected.push(project);
    coveredRoots.add(project.rootPath);
  }

  if (!coveredRoots.has('.')) {
    detected.push(buildProject('.', filePaths));
  }
  return detected;
}

/** True when `filePath` is `rootPath` itself or lives under it, respecting directory boundaries. */
function isUnderRoot(filePath: string, rootPath: string): boolean {
  if (rootPath === '.') {
    return true;
  }
  return filePath === rootPath || filePath.startsWith(`${rootPath}/`);
}

/**
 * Assigns each file to exactly one project: the deepest (longest `rootPath`)
 * project whose root contains it. This is a deliberate divergence from
 * Vyazen's own `queryProjectFiles`, whose `STARTS WITH ''` prefix match lets
 * projects overlap (root owns everything, sub-projects own their subtree
 * again) — see VSCODE_CODE_GRAPH_EVAL_PLAN.md §1.2. The oracle needs each
 * symbol/edge emitted exactly once, so ownership here is exclusive.
 *
 * Every file is guaranteed an owner as long as `projects` includes one with
 * `rootPath === '.'` (which `discoverProjects` always provides).
 */
export function assignFileOwnership(
  projects: readonly OracleProject[],
  filePaths: readonly string[]
): Map<string, OracleProject> {
  const byDepth = [...projects].sort((a, b) => b.rootPath.length - a.rootPath.length);
  const ownership = new Map<string, OracleProject>();
  for (const filePath of filePaths) {
    const owner = byDepth.find((p) => isUnderRoot(filePath, p.rootPath));
    if (owner) {
      ownership.set(filePath, owner);
    }
  }
  return ownership;
}

/**
 * Walks a repo checkout for its full file list (repo-relative, POSIX-separated
 * paths), skipping `node_modules`/`.git`. Used in place of Vyazen's git-tree
 * manifest since the oracle operates on a local checkout, not a git blob store.
 */
export function walkRepoFiles(repoPath: string): string[] {
  const out: string[] = [];

  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (WALK_IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(relative(repoPath, join(dir, entry.name)).replace(/\\/g, '/'));
      }
    }
  };

  walk(repoPath);
  return out;
}
