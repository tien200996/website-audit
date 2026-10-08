#!/usr/bin/env node
import packageInfo from "../package.json" with { type: "json" }
import * as mcpCommand from "./mcp.js"

const CLI_COMMANDS = { mcp: mcpCommand }
const HELP_FLAGS = ["--help", "-h"]
const [commandName, ...commandArgs] = process.argv.slice(2)

if (!commandName || HELP_FLAGS.includes(commandName)) {
  process.stdout.write(buildHelp())
} else if (!Object.hasOwn(CLI_COMMANDS, commandName)) {
  failWithReason(`Unknown command ${commandName}\n\n${buildHelp()}`)
} else {
  await CLI_COMMANDS[commandName].main(commandArgs).catch(commandError => failWithReason(commandError.message))
}

function buildHelp() {
  const commandLines = Object.values(CLI_COMMANDS).map(cliCommand => `  ${cliCommand.commandUsage}\n    ${cliCommand.commandDescription}`)
  return `Usage: npx ${packageInfo.name} <command>\n\nCommands:\n${commandLines.join("\n")}\n`
}

function failWithReason(failReason) {
  process.stderr.write(`${failReason}\n`)
  process.exitCode = 1
}
