declare enum GemSource {
    REGISTRY = "registry",
    GIT = "git",
    PLUGIN = "plugin"
}
interface GemEntry {
    version: string;
    source: GemSource;
    sourceUrl: string;
}
export declare function parseGemfileLock(content: string): {
    gems: Map<string, GemEntry>;
    directGems: Map<string, string | undefined>;
};
export declare function generateRubyProjectManifest({ workPath, gemfileLockPath, framework, serviceType, outputRuntime, }: {
    workPath: string;
    gemfileLockPath: string | undefined;
    framework?: string | null;
    serviceType?: string | null;
    outputRuntime?: string;
}): Promise<void>;
export {};
