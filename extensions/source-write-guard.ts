// PURPOSE: execution-time routing guard, NOT an OS sandbox or a shell parser.
// Keep source mutations on edit/write. Deliberately conservative: Python and
// inline interpreters are refused even for read-only analysis. Arbitrary scripts,
// aliases, external tools and obfuscation remain outside this heuristic boundary.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const PREFIX = '[source-write-guard] Blocked before execution. ';
const GUIDANCE = 'Use read/grep/find/ls to inspect source and edit/write to change files. Run build/tests as ordinary commands, not inline scripts.';

const PYTHON = /\b(?:python(?:w|\d+(?:\.\d+)*)?|pypy\d*)\b/i;

function scriptReason(code: string, checkPython = true): string | undefined {
  if (checkPython && PYTHON.test(code)) return 'Python execution is disabled.';
  if (/\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|truncate(?:Sync)?|write_text|write_bytes|outputFile(?:Sync)?|Deno\s*\.\s*write\w*|Bun\s*\.\s*write)\s*\(/.test(code)) return 'Script filesystem writes are disabled.';
  if (/\b(?:open(?:Sync)?\s*\([^\n]*[,=]\s*['"](?:[wa]|r\+)|(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\()/i.test(code)) return 'Script file-write/process escape is disabled; call the guarded bash tool instead.';
  return undefined;
}

export function commandReason(command: string): string | undefined {
  // Quoted prose/JSON is data, not an interpreter invocation. Keep quoted
  // executable paths visible, e.g. "/usr/bin/python3", and leave all other
  // script/write/escape checks on the original command (this is no shell parser).
  const pythonCommand = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (quoted) => {
    const value = quoted.slice(1, -1);
    return /^(?:[^\s'"`$;|&]*\/)?(?:python(?:w|\d+(?:\.\d+)*)?|pypy\d*)$/i.test(value)
      ? value : ' '.repeat(quoted.length);
  });
  if (PYTHON.test(pythonCommand)) return 'Python execution is disabled.';
  const script = scriptReason(command, false);
  if (script) return script;
  if (/\b(?:node|nodejs|bun|deno|ruby|perl|php|lua|julia)\b[^\n;&|]*(?:\s-(?:[A-Za-z]*[epc]|-[a-z-]*(?:eval|print))\b|<<)/i.test(command)) return 'Inline interpreter scripts are disabled.';
  if (/\b(?:sh|bash|dash|zsh|fish)\b[^\n;&|]*\s-[a-z]*c\b/i.test(command)) return 'Nested shell command strings are disabled.';
  if (/\b(?:sed|perl)\b[^\n;&|]*\s(?:-[a-z]*i\b|--in-place\b)/i.test(command)) return 'In-place script editing is disabled.';
  if (/\b(?:tee|dd|cp|mv|install|touch|truncate)\b/i.test(command)) return 'Shell file-write commands are disabled; use edit/write.';
  if (/\b(?:awk|gawk)\b/i.test(command)) return 'Awk scripts can write files; use a source reader or a non-writing analysis tool.';
  // Allow stderr merging and output disposal, but no file-producing redirection.
  // Mask quoted strings so comparisons/test-name arguments containing > stay usable.
  const shell = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (quoted) => {
    // Keep redirections with quoted targets detectable, without treating quoted > as operators.
    return 'Q'.repeat(quoted.length);
  }).replace(/\b[012]?>\s*&[012-]\b/g, '').replace(/(?:&|\b[012])?>>?\s*\/dev\/null\b/g, '').replace(/(^|\s)>>?\s*\/dev\/null\b/g, '$1');
  if (/>/.test(shell)) return 'Shell output redirection to files is disabled.';
  if (/<<|\$\(|`/.test(command)) return 'Heredocs and shell command substitution are disabled.';
  return undefined;
}

function localName(name: string): string {
  return name.replace(/^mcp__.+?__/, '').replace(/^.*[./]/, '');
}

export function guardReason(toolName: string, input: any): string | undefined {
  const name = localName(toolName);
  if (name === 'bash') {
    return typeof input?.command === 'string' ? commandReason(input.command) : 'Missing shell command.';
  }
  if (name === 'ctx_batch_execute') {
    if (!Array.isArray(input?.commands)) return 'Missing batch commands.';
    for (const item of input.commands) {
      if (typeof item?.command !== 'string') return 'Invalid batch command.';
      const reason = commandReason(item.command);
      if (reason) return reason;
    }
  }
  if (name === 'ctx_execute' || name === 'ctx_execute_file') {
    if (!['shell', 'javascript', 'typescript'].includes(input?.language)) return 'This execution language is disabled; Python and other inline interpreters cannot edit source.';
    if (typeof input?.code !== 'string') return 'Missing execution code.';
    return input.language === 'shell' ? commandReason(input.code) : scriptReason(input.code);
  }
  if (name === 'codemode') {
    if (typeof input?.code !== 'string') return 'Missing codemode script.';
    // Nested tools also pass tool_call. Catch obvious raw escapes in the wrapper;
    // normal tools.edit/tools.write remain permitted.
    return scriptReason(input.code);
  }
  return undefined;
}

export default function sourceWriteGuard(pi: ExtensionAPI) {
  pi.on('tool_call', async (event) => {
    const reason = guardReason(event.toolName, event.input);
    if (reason) return { block: true, reason: PREFIX + reason + ' ' + GUIDANCE };
    return undefined;
  });
}
