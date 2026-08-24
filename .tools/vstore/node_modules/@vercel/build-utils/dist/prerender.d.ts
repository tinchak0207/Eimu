import type { File, HasField, Chain } from './types';
import { Lambda } from './lambda';
/**
 * The framework's own description of what it prerendered, mirroring the
 * Next.js prerender taxonomy rather than re-deriving it from build artifacts.
 */
export interface PrerenderClassification {
    /** What kind of entry this is within its route group. */
    routeType: 'route' | 'page' | 'shell' | 'fallback';
    /** How much of the response the prerender contains. */
    response: 'empty' | 'initial' | 'complete';
    /** What has to happen at request time to finish the response. */
    compute: 'blocking' | 'resuming' | 'static';
    /** Byte size of the prerendered HTML shell, when the entry has one. */
    htmlSize?: number;
}
interface PrerenderOptions {
    expiration: number | false;
    staleExpiration?: number;
    lambda?: Lambda;
    fallback: File | null;
    group?: number;
    bypassToken?: string | null;
    allowQuery?: string[];
    allowHeader?: string[];
    initialHeaders?: Record<string, string>;
    initialStatus?: number;
    passQuery?: boolean;
    sourcePath?: string;
    experimentalBypassFor?: HasField;
    experimentalStreamingLambdaPath?: string;
    chain?: Chain;
    exposeErrBody?: boolean;
    partialFallback?: boolean;
    prerenderClassification?: PrerenderClassification;
}
export declare class Prerender {
    type: 'Prerender';
    /**
     * `expiration` is `revalidate` in Next.js terms, and `s-maxage` in
     * `cache-control` terms.
     */
    expiration: number | false;
    /**
     * `staleExpiration` is `expire` in Next.js terms, and
     * `stale-while-revalidate` + `s-maxage` in `cache-control` terms. It's
     * expected to be undefined if `expiration` is `false`.
     */
    staleExpiration?: number;
    lambda?: Lambda;
    fallback: File | null;
    group?: number;
    bypassToken: string | null;
    allowQuery?: string[];
    allowHeader?: string[];
    initialHeaders?: Record<string, string>;
    initialStatus?: number;
    passQuery?: boolean;
    sourcePath?: string;
    experimentalBypassFor?: HasField;
    experimentalStreamingLambdaPath?: string;
    chain?: Chain;
    exposeErrBody?: boolean;
    partialFallback?: boolean;
    /**
     * The framework's classification of this prerender. `undefined` when the
     * framework did not provide one, which is legitimate: not-found routes and
     * Pages Router `fallback: false` templates have no classification.
     */
    prerenderClassification?: PrerenderClassification;
    constructor({ expiration, staleExpiration, lambda, fallback, group, bypassToken, allowQuery, allowHeader, initialHeaders, initialStatus, passQuery, sourcePath, experimentalBypassFor, experimentalStreamingLambdaPath, chain, exposeErrBody, partialFallback, prerenderClassification, }: PrerenderOptions);
}
export {};
