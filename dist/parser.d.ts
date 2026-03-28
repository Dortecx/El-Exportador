import { Track, ParsedM3UResult } from "./types.js";
export declare function cleanTitle(title: string): string;
export declare function isValidM3UFile(filePath: string): boolean;
export declare function validateFilePath(filePath: string): void;
export declare function parseM3U(content: string, isExtended: boolean): Track[];
export declare function detectFormat(content: string): "extended" | "standard";
export declare function parseFile(filePath: string): ParsedM3UResult;
//# sourceMappingURL=parser.d.ts.map