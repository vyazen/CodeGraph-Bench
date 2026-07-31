import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assignFileOwnership,
  discoverProjects,
  type OracleProject,
  selectTsconfigForProject,
  walkRepoFiles,
} from '../oracle/project-discovery';

function projectAt(rootPath: string, projects: OracleProject[]): OracleProject | undefined {
  return projects.find((p) => p.rootPath === rootPath);
}

describe('discoverProjects — one project per package.json (mirrors project detector)', () => {
  it('synthesizes a root project when there is no package.json at all', () => {
    const projects = discoverProjects(['a.ts', 'b.ts']);
    expect(projects.length).toBe(1);
    expect(projects[0].rootPath).toBe('.');
    expect(projects[0].tsconfigPath).toBeNull();
    expect(projects[0].languages).toEqual(['JavaScript']);
  });

  it('detects a root project from a root package.json, JS-only when there is no tsconfig', () => {
    const projects = discoverProjects(['package.json', 'index.js']);
    expect(projects.length).toBe(1);
    expect(projects[0].rootPath).toBe('.');
    expect(projects[0].tsconfigPath).toBeNull();
    expect(projects[0].languages).toEqual(['JavaScript']);
  });

  it('marks the root project TS-capable when a root tsconfig.json sits beside package.json', () => {
    const projects = discoverProjects(['package.json', 'tsconfig.json', 'index.ts']);
    expect(projects.length).toBe(1);
    expect(projects[0].rootPath).toBe('.');
    expect(projects[0].tsconfigPath).toBe('tsconfig.json');
    expect(projects[0].languages).toEqual(['TypeScript', 'JavaScript']);
  });

  it('detects one project per package.json in a monorepo, each with its own tsconfig resolution', () => {
    const files = [
      'package.json',
      'apps/foo/package.json',
      'apps/foo/tsconfig.json',
      'apps/foo/index.ts',
    ];
    const projects = discoverProjects(files);
    expect(projects.length).toBe(2);

    const root = projectAt('.', projects);
    expect(root?.tsconfigPath).toBeNull();
    expect(root?.languages).toEqual(['JavaScript']);

    const foo = projectAt('apps/foo', projects);
    expect(foo?.tsconfigPath).toBe('apps/foo/tsconfig.json');
    expect(foo?.languages).toEqual(['TypeScript', 'JavaScript']);
  });

  it('synthesizes a root project alongside a detected sub-project when there is no root package.json', () => {
    const files = [
      'apps/foo/package.json',
      'apps/foo/tsconfig.json',
      'apps/foo/index.ts',
      'README.md',
    ];
    const projects = discoverProjects(files);
    expect(projects.length).toBe(2);
    expect(projectAt('.', projects)).toBeDefined();
    expect(projectAt('apps/foo', projects)?.tsconfigPath).toBe('apps/foo/tsconfig.json');
  });

  it("does not let a sub-project's tsconfig-less status pick up the root's tsconfig", () => {
    const files = ['package.json', 'tsconfig.json', 'apps/foo/package.json', 'apps/foo/index.js'];
    const projects = discoverProjects(files);
    const foo = projectAt('apps/foo', projects);
    expect(foo?.tsconfigPath).toBeNull();
    expect(foo?.languages).toEqual(['JavaScript']);
  });

  it('wires through tsconfig priority ordering for a detected project (tsconfig.json beats tsconfig.build.json)', () => {
    const files = [
      'apps/foo/package.json',
      'apps/foo/tsconfig.json',
      'apps/foo/tsconfig.build.json',
      'apps/foo/index.ts',
    ];
    const projects = discoverProjects(files);
    expect(projectAt('apps/foo', projects)?.tsconfigPath).toBe('apps/foo/tsconfig.json');
  });

  it('falls back to a variant when tsconfig.json is absent (tsconfig.app.json beats tsconfig.build.json)', () => {
    const files = [
      'apps/foo/package.json',
      'apps/foo/tsconfig.app.json',
      'apps/foo/tsconfig.build.json',
      'apps/foo/index.ts',
    ];
    const projects = discoverProjects(files);
    expect(projectAt('apps/foo', projects)?.tsconfigPath).toBe('apps/foo/tsconfig.app.json');
  });
});

describe('selectTsconfigForProject — reimplementation parity smoke test', () => {
  it('returns null when no tsconfig sits directly at the project root', () => {
    expect(selectTsconfigForProject('.', ['index.ts'])).toBeNull();
  });

  it('ignores a tsconfig that lives in a subdirectory of the project root', () => {
    expect(selectTsconfigForProject('.', ['src/tsconfig.json'])).toBeNull();
  });
});

describe('assignFileOwnership — deepest matching project owns a file', () => {
  it('gives a root-only project every file', () => {
    const root: OracleProject = {
      id: '.',
      languages: ['JavaScript'],
      rootPath: '.',
      tsconfigPath: null,
    };
    const files = ['a.ts', 'lib/b.ts', 'deep/nested/c.ts'];
    const ownership = assignFileOwnership([root], files);
    for (const f of files) {
      expect(ownership.get(f)).toBe(root);
    }
  });

  it('gives a nested project its own subtree instead of the root', () => {
    const root: OracleProject = {
      id: '.',
      languages: ['JavaScript'],
      rootPath: '.',
      tsconfigPath: null,
    };
    const foo: OracleProject = {
      id: 'apps/foo',
      languages: ['TypeScript', 'JavaScript'],
      rootPath: 'apps/foo',
      tsconfigPath: 'apps/foo/tsconfig.json',
    };
    const ownership = assignFileOwnership(
      [root, foo],
      ['index.ts', 'apps/foo/index.ts', 'apps/foo/lib/util.ts']
    );
    expect(ownership.get('index.ts')).toBe(root);
    expect(ownership.get('apps/foo/index.ts')).toBe(foo);
    expect(ownership.get('apps/foo/lib/util.ts')).toBe(foo);
  });

  it('respects directory boundaries — a sibling with a longer name is not treated as nested', () => {
    const root: OracleProject = {
      id: '.',
      languages: ['JavaScript'],
      rootPath: '.',
      tsconfigPath: null,
    };
    const foo: OracleProject = {
      id: 'apps/foo',
      languages: ['JavaScript'],
      rootPath: 'apps/foo',
      tsconfigPath: null,
    };
    const ownership = assignFileOwnership([root, foo], ['apps/foobar/x.ts']);
    // 'apps/foobar/x.ts' must NOT be claimed by 'apps/foo' via a bare string-prefix match.
    expect(ownership.get('apps/foobar/x.ts')).toBe(root);
  });

  it('picks the deepest of three nested projects', () => {
    const root: OracleProject = {
      id: '.',
      languages: ['JavaScript'],
      rootPath: '.',
      tsconfigPath: null,
    };
    const apps: OracleProject = {
      id: 'apps',
      languages: ['JavaScript'],
      rootPath: 'apps',
      tsconfigPath: null,
    };
    const foo: OracleProject = {
      id: 'apps/foo',
      languages: ['JavaScript'],
      rootPath: 'apps/foo',
      tsconfigPath: null,
    };
    const ownership = assignFileOwnership(
      [root, apps, foo],
      ['top.ts', 'apps/mid.ts', 'apps/foo/leaf.ts']
    );
    expect(ownership.get('top.ts')).toBe(root);
    expect(ownership.get('apps/mid.ts')).toBe(apps);
    expect(ownership.get('apps/foo/leaf.ts')).toBe(foo);
  });

  it('leaves every file owned exactly once when a root project is present (full-coverage invariant)', () => {
    const projects = discoverProjects([
      'package.json',
      'apps/foo/package.json',
      'apps/foo/tsconfig.json',
      'apps/foo/index.ts',
      'top-level.ts',
    ]);
    const files = [
      'package.json',
      'apps/foo/package.json',
      'apps/foo/tsconfig.json',
      'apps/foo/index.ts',
      'top-level.ts',
    ];
    const ownership = assignFileOwnership(projects, files);
    for (const f of files) {
      expect(ownership.has(f)).toBe(true);
    }
  });
});

describe('walkRepoFiles', () => {
  function withTempRepo(build: (dir: string) => void, run: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'project-discovery-fixture-'));
    try {
      build(dir);
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('returns repo-relative, POSIX-separated paths for every file in a nested tree', () => {
    withTempRepo(
      (dir) => {
        mkdirSync(join(dir, 'apps', 'foo'), { recursive: true });
        writeFileSync(join(dir, 'package.json'), '{}');
        writeFileSync(join(dir, 'apps', 'foo', 'index.ts'), 'export {};');
      },
      (dir) => {
        const files = walkRepoFiles(dir).sort();
        expect(files).toEqual(['apps/foo/index.ts', 'package.json']);
      }
    );
  });

  it('skips node_modules and .git entirely', () => {
    withTempRepo(
      (dir) => {
        mkdirSync(join(dir, 'node_modules', 'some-pkg'), { recursive: true });
        mkdirSync(join(dir, '.git'), { recursive: true });
        writeFileSync(join(dir, 'node_modules', 'some-pkg', 'index.js'), '');
        writeFileSync(join(dir, '.git', 'HEAD'), '');
        writeFileSync(join(dir, 'a.ts'), '');
      },
      (dir) => {
        expect(walkRepoFiles(dir)).toEqual(['a.ts']);
      }
    );
  });
});
