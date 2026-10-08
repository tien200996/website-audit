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

export const commandUsage = "mcp --library <folder> [--audits <folder>]"
export const commandDescription = "Start the MCP server with the audit tools and prompts"
const PACKAGE_FOLDER = dirname(dirname(fileURLToPath(import.meta.url)))
const TOOLS_FOLDER = join(PACKAGE_FOLDER, "tools")
const PROMPTS_FOLDER = join(PACKAGE_FOLDER, "prompts")
const COMMAND_OPTIONS = { library: { type: "string", default: "" }, audits: { type: "string", default: "" } }

export async function main(commandArgs) {
  const { values: commandOptions } = parseArgs({ args: commandArgs, options: COMMAND_OPTIONS })
  const libraryFolder = commandOptions.library && resolve(commandOptions.library)
  if (!libraryFolder) {
    throw new Error("No --library, pass the path of a library folder like the example folder of website-audit")
  }
  if (!(await pathExists(join(libraryFolder, "checks")))) {
    throw new Error(`No checks folder in ${libraryFolder}, pass --library the path of a library folder like the example folder of website-audit`)
  }
  const auditsFolder = resolve(commandOptions.audits || join(libraryFolder, "audits"))
  const serverConfig = { libraryFolder, auditsFolder }
  const mcpServer = new McpServer({ name: packageInfo.name, version: packageInfo.version })
  await registerTools(mcpServer, serverConfig)
  await registerPrompts(mcpServer, serverConfig)
  await mcpServer.connect(new StdioServerTransport())
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
