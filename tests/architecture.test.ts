import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ARCHITECTURE FENCE: the rules that keep this codebase enterprise-grade as it grows. CI fails if anyone breaks them.
 * See docs/ARCHITECTURE.md for the picture. In short:
 *
 *   src/
 *     shared/      shared kernel (no business rules)       may import: shared
 *     contracts/   the seam between product and core       may import: shared, contracts
 *     core/        Platform Core (extractable service)     may import: shared, contracts, core
 *     product/     counselling product                     may import: shared, contracts, product
 *     app/         composition root                        may import: everything
 *   core|product / modules / <module> / { domain, application, infrastructure, http } + index.ts (public API)
 */
const SRC = join(process.cwd(), 'src');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.d.ts') ? [p] : [];
  });

interface Imp {
  file: string;
  target: string;
  typeOnly: boolean;
}

const STATEMENT = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/g;

const importsOf = (file: string): Imp[] => {
  const out: Imp[] = [];
  for (const m of readFileSync(file, 'utf8').matchAll(STATEMENT)) {
    const target = resolve(dirname(file), m[3]!.replace(/\.js$/, '.ts'));
    out.push({ file, target, typeOnly: !!m[1] });
  }
  return out;
};

const ALL = walk(SRC);
const IMPORTS = ALL.flatMap(importsOf);

const parts = (abs: string) => relative(SRC, abs).split(sep);
const contextOf = (abs: string) => parts(abs)[0]!;
/** "core/identity" for src/core/modules/identity/..., else null */
const moduleOf = (abs: string): string | null => {
  const p = parts(abs);
  return (p[0] === 'core' || p[0] === 'product') && p[1] === 'modules' && p[2] ? `${p[0]}/${p[2]}` : null;
};
/** domain | application | infrastructure | http | index (module root file) | null */
const layerOf = (abs: string): string | null => {
  const p = parts(abs);
  if (!moduleOf(abs)) return null;
  return p[3] === 'index.ts' ? 'index' : (p[3] ?? null);
};
const rel = (f: string) => relative(SRC, f).split(sep).join('/');

const ALLOWED_CONTEXT: Record<string, string[]> = {
  shared: ['shared', 'config'],
  contracts: ['shared', 'config', 'contracts'],
  core: ['shared', 'config', 'contracts', 'core'],
  product: ['shared', 'config', 'contracts', 'product'],
  config: ['config'],
  app: ['shared', 'config', 'contracts', 'core', 'product', 'app'],
};

describe('contexts: who may import whom', () => {
  it.each(Object.keys(ALLOWED_CONTEXT))('%s only imports its allowed contexts', (ctx) => {
    const bad = IMPORTS.filter((i) => contextOf(i.file) === ctx && !ALLOWED_CONTEXT[ctx]!.includes(contextOf(i.target)));
    expect(bad.map((i) => `${rel(i.file)} -> ${rel(i.target)}`)).toEqual([]);
  });

  it('every top-level folder is a known context', () => {
    const tops = readdirSync(SRC).filter((f) => statSync(join(SRC, f)).isDirectory());
    expect(tops.sort()).toEqual(Object.keys(ALLOWED_CONTEXT).sort());
  });
});

describe('modules: public API only', () => {
  it('a module may import another module only through its index.ts', () => {
    const bad = IMPORTS.filter((i) => {
      const from = moduleOf(i.file);
      const to = moduleOf(i.target);
      return from && to && from !== to && layerOf(i.target) !== 'index';
    });
    expect(bad.map((i) => `${rel(i.file)} -> ${rel(i.target)}`)).toEqual([]);
  });

  it('modules never reach into another context\'s modules', () => {
    const bad = IMPORTS.filter((i) => {
      const from = moduleOf(i.file);
      const to = moduleOf(i.target);
      return from && to && from.split('/')[0] !== to.split('/')[0];
    });
    expect(bad.map((i) => `${rel(i.file)} -> ${rel(i.target)}`)).toEqual([]);
  });

  it('every module has an index.ts and only the four known layers', () => {
    const problems: string[] = [];
    for (const ctx of ['core', 'product']) {
      const base = join(SRC, ctx, 'modules');
      for (const m of readdirSync(base)) {
        if (!existsSync(join(base, m, 'index.ts'))) problems.push(`${ctx}/${m} has no index.ts`);
        if (!existsSync(join(base, m, 'module.json'))) problems.push(`${ctx}/${m} has no module.json (declare its dependsOn)`);
        for (const entry of readdirSync(join(base, m))) {
          if (entry === 'index.ts' || entry === 'module.json') continue;
          if (!['domain', 'application', 'infrastructure', 'http'].includes(entry)) problems.push(`${ctx}/${m}/${entry} is not a known layer`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('layers inside a module', () => {
  const sameModule = (i: Imp) => moduleOf(i.file) !== null && moduleOf(i.file) === moduleOf(i.target);

  it('domain is pure: only its own domain, shared/kernel, the contracts vocabulary (permission and module keys), and TYPE-only imports of other modules', () => {
    const bad = IMPORTS.filter((i) => {
      if (layerOf(i.file) !== 'domain') return false;
      if (sameModule(i)) return layerOf(i.target) !== 'domain';
      if (moduleOf(i.target)) return !i.typeOnly; // other module: types only
      if (contextOf(i.target) === 'contracts') return !rel(i.target).endsWith('contracts/port.ts'); // port.ts = pure constants and interfaces
      return !(contextOf(i.target) === 'shared' && parts(i.target)[1] === 'kernel');
    });
    expect(bad.map((i) => `${rel(i.file)} -> ${rel(i.target)}`)).toEqual([]);
  });

  it('infrastructure never imports application or http', () => {
    const bad = IMPORTS.filter((i) => layerOf(i.file) === 'infrastructure' && sameModule(i) && ['application', 'http'].includes(layerOf(i.target)!));
    expect(bad.map((i) => `${rel(i.file)} -> ${rel(i.target)}`)).toEqual([]);
  });

  it('application never imports http', () => {
    const bad = IMPORTS.filter((i) => layerOf(i.file) === 'application' && sameModule(i) && layerOf(i.target) === 'http');
    expect(bad.map((i) => `${rel(i.file)} -> ${rel(i.target)}`)).toEqual([]);
  });

  it('only http and application touch the request/ORM edges: domain has no mongoose, express or zod', () => {
    const bad = ALL.filter((f) => layerOf(f) === 'domain' && /from\s+['"](mongoose|express|zod)['"]/.test(readFileSync(f, 'utf8')));
    expect(bad.map(rel)).toEqual([]);
  });
});

describe('module dependency graph', () => {
  const edges = new Map<string, Set<string>>();
  for (const i of IMPORTS) {
    const from = moduleOf(i.file);
    const to = moduleOf(i.target);
    if (from && to && from !== to) (edges.get(from) ?? edges.set(from, new Set()).get(from)!).add(to);
  }

  /**
   * Every cross-module dependency is deliberate: a module declares what it may use in ITS OWN module.json ("dependsOn").
   * Adding an import of another module without declaring it there fails this test, and the change shows up in that module's diff.
   */
  const PINNED: Record<string, string[]> = {};
  for (const ctx of ['core', 'product']) {
    const base = join(SRC, ctx, 'modules');
    for (const m of readdirSync(base)) {
      const f = join(base, m, 'module.json');
      const deps: string[] = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).dependsOn ?? [] : [];
      PINNED[`${ctx}/${m}`] = deps.map((d) => `${ctx}/${d}`);
    }
  }

  it('has no cycles', () => {
    const state = new Map<string, 1 | 2>();
    const cycles: string[] = [];
    const visit = (n: string, path: string[]) => {
      if (state.get(n) === 2) return;
      if (state.get(n) === 1) return void cycles.push([...path, n].join(' -> '));
      state.set(n, 1);
      for (const next of edges.get(n) ?? []) visit(next, [...path, n]);
      state.set(n, 2);
    };
    for (const n of edges.keys()) visit(n, []);
    expect(cycles).toEqual([]);
  });

  it('matches the pinned dependency list (new dependencies must be added here on purpose)', () => {
    const actual = Object.fromEntries([...new Set([...Object.keys(PINNED), ...edges.keys()])].sort().map((m) => [m, [...(edges.get(m) ?? [])].sort()]));
    expect(actual).toEqual(Object.fromEntries(Object.entries(PINNED).sort().map(([m, d]) => [m, [...d].sort()])));
  });
});

describe('data access', () => {
  it('tenant data is only reachable through tenantModel(): no direct model registration in product code', () => {
    const bad = ALL.filter((f) => contextOf(f) === 'product' && /\bmongoose\.model\(|\bmodel\s*\(/.test(readFileSync(f, 'utf8')));
    expect(bad.map(rel)).toEqual([]);
  });

  it('only the shared tenant connection helper builds tenant database names', () => {
    const bad = ALL.filter((f) => !rel(f).endsWith('shared/infra/tenantDb.ts') && /cp_t_/.test(readFileSync(f, 'utf8')));
    expect(bad.map(rel)).toEqual([]);
  });
});
