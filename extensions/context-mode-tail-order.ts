// Keep context-mode's tail injection from swallowing the real user prompt.
//
// The problem this solves
// ----------------------
// context-mode (npm:context-mode, build/adapters/pi/extension.js) registers a
// `context` handler that pushes ONE extra `{ role: "user" }` message at the END
// of the transcript every turn (routing anchor + <active_memory> + resume
// snapshot). It does this deliberately, at the end rather than in the system
// prompt, to preserve the prefix prompt cache.
//
// `zcode-provider` builds its prompt with
//     [...context.messages].reverse().find(m => m.role === "user")
// i.e. it takes the LAST user message. That is context-mode's injected tail, so
// the ZCode agent receives the routing anchor instead of what you typed and
// replies with a generic greeting. Verified via ZCODE_DEBUG=1:
//     session/send content = "context-mode active. Hierarchy: ctx_batch_execute > ..."
//
// The fix
// -------
// Move the injected tail so it sits immediately BEFORE the last real user
// message, leaving the real prompt as the final user message. Everything the
// model would otherwise see is preserved, and the prefix up to the previous
// turn's last message is untouched, so this does not disturb prompt caching.
//
// Why `context_with_system` and why unconditional
// ----------------------------------------------
// - Ordering: local extensions register before package extensions, so a `context`
//   handler here runs BEFORE context-mode's push. `context_with_system` runs
//   while the final transcript is assembled, i.e. after all `context` handlers,
//   which is where the injected tail is already visible.
// - Scope: Pi exposes no provider information to context assembly (`pi` has no
//   getModel(); `before_agent_start` / `context` carry no model), so this cannot
//   branch on "am I talking to zcode?". The trigger is therefore the injection
//   itself: it only acts when the final user message carries the context-mode
//   anchor marker. For any other provider the same text is still delivered in
//   the same turn, only ahead of the task instead of after it.
//
// Fails open: if the marker ever changes upstream, this returns undefined and the
// transcript is left exactly as context-mode built it.

const ANCHOR_MARKER = "context-mode active. ";
const DEBUG = process.env.ZCODE_PROMPT_FIX_DEBUG === "1";

type Block = { type?: string; text?: string };
type Message = { role?: string; content?: unknown };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: Block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
}

function isInjectedTail(message: Message | undefined): boolean {
  return message?.role === "user" && textOf(message.content).includes(ANCHOR_MARKER);
}

export default function contextModeTailOrder(pi: unknown): void {
  const on = (pi as { on: (event: string, handler: (event: { messages?: Message[] }) => unknown) => void }).on;

  on("context_with_system", (event) => {
    const messages = event?.messages;
    if (!Array.isArray(messages) || messages.length < 2) return undefined;
    if (messages[0]?.role !== "system") return undefined; // contract: system stays at index 0

    const tail = messages[messages.length - 1];
    if (!isInjectedTail(tail)) return undefined;

    // Last user message that is not the injected tail: the real prompt.
    let promptIndex = -1;
    for (let i = messages.length - 2; i >= 1; i--) {
      if (messages[i]?.role === "user" && !isInjectedTail(messages[i])) {
        promptIndex = i;
        break;
      }
    }
    if (promptIndex === -1) return undefined;

    const reordered = [...messages];
    reordered.splice(promptIndex, 0, tail); // insert the tail before the prompt
    reordered.splice(messages.length, 1); // drop the original tail position

    if (DEBUG) {
      try {
        process.getBuiltinModule?.("node:fs")?.appendFileSync?.(
          (process.getBuiltinModule("node:os") as { homedir: () => string }).homedir() +
            "/.pi/agent/zcode-prompt-fix.log",
          `${new Date().toISOString()} moved injected tail from ${messages.length - 1} to ${promptIndex} (messages=${messages.length})\n`,
        );
      } catch {
        /* diagnostic only */
      }
    }

    return { messages: reordered };
  });
}
