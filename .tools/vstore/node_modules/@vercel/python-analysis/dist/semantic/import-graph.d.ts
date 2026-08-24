/**
 * Static import-graph analysis: compute the transitive closure of modules a
 * Python application imports at startup, without executing any user code.
 *
 * The closure feeds bytecode packing. Both error directions are safe:
 * over-included modules waste capacity, and missed modules (plugin loaders,
 * imports made by compiled extensions) still ship from residual capacity.
 *
 * Resolution semantics mirror CPython:
 * - dotted name -> `a/b/__init__.py` | `a/b.py` | PEP 420 namespace dir
 * - importing `a.b.c` executes every parent `__init__.py` (emitted + recursed)
 * - `from a import b` probes `b` as a submodule of `a`
 * - relative imports resolve against the importer's package by dot level
 * - first search root wins, so app modules shadow vendor (runtime sys.path)
 *
 * Startup heuristics (applied on top of the raw WASM extraction):
 * - imports inside function bodies are lazy and excluded
 * - `if TYPE_CHECKING:` blocks never run at runtime and are excluded
 * - both branches of module-level `if` / `try` are included
 */
export interface ImportStmt {
    /** Dotted module path for from-imports; undefined for `from . import x`. */
    module?: string;
    /** Relative-import level (number of leading dots). 0 = absolute. */
    level: number;
    /** Imported names for from-imports (each may be a submodule). */
    names: string[];
    /** False when nested in a function body (lazy import). */
    isModuleLevel: boolean;
    /** True when under `if TYPE_CHECKING:` (never runs at runtime). */
    inTypeChecking: boolean;
}
/**
 * Extract every import statement in Python source with its syntactic
 * context. Returns an empty list for invalid syntax.
 */
export declare function extractImports(source: string): Promise<ImportStmt[]>;
export interface ImportClosureOptions {
    /**
     * Entry points of the closure: absolute `.py` file paths and/or dotted
     * module or object names (e.g. Django's ROOT_URLCONF / INSTALLED_APPS
     * strings), resolved to their longest importable prefix against searchRoots.
     */
    seeds: string[];
    /**
     * Ordered module search roots (e.g. [workPath, ...sitePackageDirs]).
     * First match wins, so earlier roots shadow later ones.
     */
    searchRoots: string[];
    /**
     * Approximate safety bound on parsed files, checked per frontier batch.
     * On overflow the partial closure is returned with `truncated: true`
     * (remaining modules fall to the residual bytecode tier).
     */
    maxFiles?: number;
}
export interface ImportClosureResult {
    /** Absolute paths of every `.py` file imported at startup. */
    files: Set<string>;
    truncated: boolean;
}
/**
 * Compute the transitive closure of modules imported at startup.
 *
 * Only module-level imports outside `if TYPE_CHECKING:` blocks are followed
 * (see module docstring). Files are read and parsed frontier-by-frontier in
 * parallel; cycles are cut by the visited set.
 */
export declare function collectImportClosure({ seeds, searchRoots, maxFiles, }: ImportClosureOptions): Promise<ImportClosureResult>;
