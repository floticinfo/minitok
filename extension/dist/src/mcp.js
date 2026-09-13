"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.QUOTED_ESCAPES = void 0;
exports.parseMcpCommand = parseMcpCommand;
exports.packagedMcpCommand = packagedMcpCommand;
const path = __importStar(require("node:path"));
exports.QUOTED_ESCAPES = "\"'\\";
function parseMcpCommand(value) {
    const result = [];
    let token = "";
    let quote;
    let escaped = false;
    for (const character of value.trim()) {
        if (escaped) {
            // Only a quote, a backslash or whitespace is escapable. A backslash before
            // anything else is a literal path separator: treating every backslash as an
            // escape silently turned "C:\Program Files\node.exe" into
            // "C:Program Filesnodejsnode.exe". Single quotes never escape, as in a shell.
            token += exports.QUOTED_ESCAPES.includes(character) || /\s/.test(character) ? character : `\\${character}`;
            escaped = false;
        }
        else if (character === "\\" && quote !== "'") {
            escaped = true;
        }
        else if (quote) {
            if (character === quote)
                quote = undefined;
            else
                token += character;
        }
        else if (character === '"' || character === "'") {
            quote = character;
        }
        else if (/\s/.test(character)) {
            if (token) {
                result.push(token);
                token = "";
            }
        }
        else {
            token += character;
        }
    }
    if (escaped)
        token += "\\";
    if (quote)
        throw new Error("Unclosed quote in minitok.mcpCommand");
    if (token)
        result.push(token);
    return result;
}
function packagedMcpCommand(extensionPath, nodePath) {
    return [nodePath, path.join(extensionPath, "runtime", "src", "runtime", "stdio-entry.js")];
}
