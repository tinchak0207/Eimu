import type { LambdaOptionsBase } from './lambda';
import type { Env, Files } from './types';
export interface ContainerImageConfig extends Pick<LambdaOptionsBase, 'handler' | 'architecture' | 'memory' | 'maxDuration' | 'maxConcurrency' | 'environment' | 'regions' | 'functionFailoverRegions' | 'experimentalTriggers' | 'supportsCancellation'> {
    /**
     * The OCI image reference, for example
     * `vcr.vercel.com/team/project/svc@sha256:...`.
     * The build output contract carries this value in `handler`.
     */
    runtime: 'container';
    command?: string[];
}
export declare class ContainerImage implements ContainerImageConfig {
    type: 'ContainerImage';
    files: Files;
    /** The OCI image reference, carried in `handler` (see ContainerImageConfig). */
    handler: string;
    runtime: 'container';
    command?: string[];
    environment: Env;
    architecture?: ContainerImageConfig['architecture'];
    memory?: ContainerImageConfig['memory'];
    maxDuration?: ContainerImageConfig['maxDuration'];
    maxConcurrency?: ContainerImageConfig['maxConcurrency'];
    regions?: ContainerImageConfig['regions'];
    functionFailoverRegions?: ContainerImageConfig['functionFailoverRegions'];
    experimentalTriggers?: ContainerImageConfig['experimentalTriggers'];
    supportsCancellation?: ContainerImageConfig['supportsCancellation'];
    constructor(params: ContainerImageConfig & {
        files: Files;
    });
}
