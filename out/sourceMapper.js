"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SourceMapper = void 0;
class SourceMapper {
    mappings = new Map();
    constructor(mappings) {
        for (const [from, to] of Object.entries(mappings)) {
            this.mappings.set(from, to);
            // // `Source mapping: ${from} → ${to}`);
        }
    }
    /** Convert local VSCode path to remote compilation path for GDB */
    localToCompile(localPath) {
        for (const [compilePrefix, localPrefix] of this.mappings) {
            if (localPath.startsWith(localPrefix)) {
                return compilePrefix + localPath.substring(localPrefix.length);
            }
        }
        return localPath;
    }
    /** Convert remote compilation path to local VSCode path for display */
    compileToLocal(compilePath) {
        for (const [compilePrefix, localPrefix] of this.mappings) {
            if (compilePath.startsWith(compilePrefix)) {
                return localPrefix + compilePath.substring(compilePrefix.length);
            }
        }
        return compilePath;
    }
    /** Generate GDB substitute-path commands */
    toGdbCommands() {
        const cmds = [];
        for (const [from, to] of this.mappings) {
            cmds.push(`set substitute-path ${from} ${to}`);
        }
        return cmds;
    }
}
exports.SourceMapper = SourceMapper;
