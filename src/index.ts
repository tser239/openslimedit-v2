import { Plugin } from "@opencode/plugin"
import * as fs from "fs"
import * as path from "path"

const LINE_RANGE_RE = /^(\d+)(?:\s*-\s*(\d+))?$/

// Short descriptions that replace the verbose built-in tool schemas sent to the LLM.
const SLIM: Record<string, string> = {
  read: "Read file content.",
  edit: "Edit file. oldString can be line range '55-64'.",
  apply_patch: "Apply a patch to files.",
  write: "Write file.",
  bash: "Run shell command.",
  glob: "Find files.",
  grep: "Search in files.",
  list: "List directory.",
  fetch: "Fetch URL.",
}

function resolvePath(filePath: string, directory: string): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath)
  return path.resolve(directory, filePath)
}

// Mutable view of Tool.Result so we can compact output in the after hook.
// V2 types mark result/output as readonly, but at runtime the object is not frozen.
type MutableResult = {
  output?: string
  content?: string | readonly unknown[]
  metadata?: Record<string, unknown>
}

export default Plugin.define({
  id: "openslimedit",
  async setup(ctx) {
    const directory = ctx.location.directory

    // ── Tool description compression ──────────────────────────────────────
    // Replaces verbose built-in tool descriptions with minimal versions.
    await ctx.tool.transform((editor) => {
      for (const tool of editor.list()) {
        const slim = SLIM[tool.id]
        if (slim) {
          editor.update(tool.id, (t) => {
            t.description = slim
          })
        }
      }
    })

    // ── Compact tool output after execution ───────────────────────────────
    await ctx.tool.hook("execute.after", (event) => {
      // Compress edit output
      if (event.tool === "edit") {
        if (event.status === "completed") {
          const result = event.result as MutableResult | undefined
          if (result && typeof result.output === "string" && result.output.startsWith("Edit applied successfully.")) {
            result.output = "OK"
          }
        }
        return
      }

      // Compact read output
      if (event.tool !== "read") return
      if (event.status !== "completed") return

      const result = event.result as MutableResult | undefined
      if (!result) return
      let output: string | undefined
      if (typeof result.output === "string") output = result.output
      else if (typeof result.content === "string") output = result.content
      if (!output) return

      if (output.includes("<type>directory</type>")) return

      const pathMatch = output.match(/<path>(.+?)<\/path>/)
      if (!pathMatch) return

      // Shorten to relative path
      const absPath = path.normalize(pathMatch[1])
      const relPath = path.relative(directory, absPath)
      output = output.replace(`<path>${pathMatch[1]}</path>`, `<path>${relPath}</path>`)

      // Remove type tag and footer
      output = output.replace("<type>file</type>\n", "")
      output = output.replace(/\n\n\(End of file - total \d+ lines\)\n/, "\n")

      result.output = output
      if (typeof result.content === "string") result.content = output
    })

    // ── Expand line ranges in oldString before edit execution ─────────────
    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool !== "edit") return
      const args = event.input as { oldString?: string; filePath?: string } | undefined
      if (!args?.oldString || !args.filePath) return

      const filePath = resolvePath(args.filePath, directory)
      let content: string
      try {
        content = fs.readFileSync(filePath, "utf-8")
      } catch {
        return
      }

      if (content.includes(args.oldString)) return

      const match = args.oldString.trim().match(LINE_RANGE_RE)
      if (!match) return

      const lines = content.split("\n")
      const startLine = parseInt(match[1], 10)
      const endLine = match[2] ? parseInt(match[2], 10) : startLine

      if (startLine >= 1 && endLine <= lines.length && startLine <= endLine) {
        args.oldString = lines.slice(startLine - 1, endLine).join("\n")
      }
    })
  },
})
