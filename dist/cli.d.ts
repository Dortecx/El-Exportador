#!/usr/bin/env node
import { CliOptions } from "./types.js";
export declare function runCli(): Promise<void>;
export declare function run(filePath: string, options: Partial<CliOptions> & {
    file: string;
}): Promise<void>;
//# sourceMappingURL=cli.d.ts.map