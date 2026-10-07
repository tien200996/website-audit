#!/usr/bin/env node
import { access, readdir, readFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import Mustache from "mustache"
import { parse as parseYaml } from "yaml"
import * as zod from "zod"
import packageInfo from "../package.json" with { type: "json" }

const PACKAGE_FOLDER = dirname(dirname(fileURLToPath(import.meta.url)))
const TOOLS_FOLDER = join(PACKAGE_FOLDER, "tools")
const PROMPTS_FOLDER = join(PACKAGE_FOLDER, "prompts")
const { values: serverOptions } = parseArgs({ options: { library: { type: "string", default: "" } } })
const LIBRARY_FOLDER = serverOptions.library && resolve(serverOptions.library)
const serverConfig = { libraryFolder: LIBRARY_FOLDER, auditsFolder: join(LIBRARY_FOLDER, "audits") }
const mcpServer = new McpServer({ name: packageInfo.name, version: packageInfo.version })

if (!LIBRARY_FOLDER) {
  exitWithReason("No --library, pass the path of a library folder like the example folder of website-audit")
}
if (!(await pathExists(join(LIBRARY_FOLDER, "checks")))) {
  exitWithReason(`No checks folder in ${LIBRARY_FOLDER}, pass --library the path of a library folder like the example folder of website-audit`)
}
await registerTools(mcpServer, serverConfig)
await registerPrompts(mcpServer, serverConfig)
await mcpServer.connect(new StdioServerTransport())

function exitWithReason(failReason) {
  process.stderr.write(`${failReason}\n`)
  process.exit(1)
}

function pathExists(filePath) {
  return access(filePath).then(() => true, () => false)
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

async function registerPrompts(mcpServer, serverConfig) {
  const promptFiles = (await readdir(PROMPTS_FOLDER)).filter(fileName => fileName.endsWith(".yaml"))
  for (const promptFile of promptFiles) {
    const promptSpec = parseYaml(await readFile(join(PROMPTS_FOLDER, promptFile), "utf8"))
    const promptOptions = {
      title: promptSpec.title,
      description: promptSpec.description,
      argsSchema: buildArgsSchema(promptSpec.arguments ?? {}),
    }
    mcpServer.registerPrompt(basename(promptFile, ".yaml"), promptOptions, promptInput => renderPrompt(promptSpec.prompt, { ...promptInput, libraryFolder: serverConfig.libraryFolder }))
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
