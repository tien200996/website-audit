#!/usr/bin/env node
import { access, readdir, readFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import Mustache from "mustache"
import { parse as parseYaml } from "yaml"
import * as zod from "zod"
import packageInfo from "../package.json" with { type: "json" }

const PACKAGE_FOLDER = dirname(dirname(fileURLToPath(import.meta.url)))
const TOOLS_FOLDER = join(PACKAGE_FOLDER, "tools")
const PROMPTS_FOLDER = join(PACKAGE_FOLDER, "prompts")
const LIBRARY_FOLDER = process.cwd()
const serverConfig = { libraryFolder: LIBRARY_FOLDER, auditsFolder: join(LIBRARY_FOLDER, "audits") }
const mcpServer = new McpServer({ name: packageInfo.name, version: packageInfo.version })

if (!(await pathExists(join(LIBRARY_FOLDER, "library.yaml")))) {
  exitWithReason(`No library.yaml in ${LIBRARY_FOLDER}, run inside a library folder like the example folder of website-audit`)
}
await registerTools(mcpServer, serverConfig)
await registerPrompts(mcpServer)
await mcpServer.connect(new StdioServerTransport())

function pathExists(filePath) {
  return access(filePath).then(() => true, () => false)
}

function exitWithReason(failReason) {
  process.stderr.write(`${failReason}\n`)
  process.exit(1)
}

async function registerTools(mcpServer, serverConfig) {
  const toolFiles = (await readdir(TOOLS_FOLDER)).filter(fileName => fileName.endsWith(".js"))
  for (const toolFile of toolFiles) {
    const toolModule = await import(pathToFileURL(join(TOOLS_FOLDER, toolFile)))
    const toolOptions = {
      description: toolModule.toolDescription,
      inputSchema: toolModule.inputSchema,
      outputSchema: toolModule.outputSchema,
    }
    mcpServer.registerTool(basename(toolFile, ".js"), toolOptions, toolInput => handleToolCall(toolModule, toolInput, serverConfig))
  }
}

async function handleToolCall(toolModule, toolInput, serverConfig) {
  try {
    const toolResult = await toolModule.main(toolInput, serverConfig)
    return { content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }], structuredContent: toolResult }
  } catch (callError) {
    return { content: [{ type: "text", text: callError.message }], isError: true }
  }
}

async function registerPrompts(mcpServer) {
  const promptFiles = (await readdir(PROMPTS_FOLDER)).filter(fileName => fileName.endsWith(".yaml"))
  for (const promptFile of promptFiles) {
    const promptSpec = parseYaml(await readFile(join(PROMPTS_FOLDER, promptFile), "utf8"))
    const promptOptions = {
      title: promptSpec.title,
      description: promptSpec.description,
      argsSchema: buildArgsSchema(promptSpec.arguments ?? {}),
    }
    mcpServer.registerPrompt(basename(promptFile, ".yaml"), promptOptions, promptInput => renderPrompt(promptSpec.prompt, promptInput))
  }
}

function buildArgsSchema(promptArguments) {
  return Object.fromEntries(Object.entries(promptArguments).map(([argumentName, argumentSpec]) => {
    const argumentSchema = zod.string().describe(argumentSpec.description)
    return [argumentName, argumentSpec.required ? argumentSchema : argumentSchema.optional()]
  }))
}

function renderPrompt(promptTemplate, promptInput) {
  const promptText = Mustache.render(promptTemplate, promptInput, {}, { escape: plainText => plainText })
  return { messages: [{ role: "user", content: { type: "text", text: promptText } }] }
}
