"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = log;
/** Minimal logger — writes to stderr with timestamp */
function log(level, msg) {
    const ts = new Date().toISOString();
    process.stderr.write(`[omnibreak][${level}] ${msg}\n`);
}
