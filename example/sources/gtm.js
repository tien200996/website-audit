import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"

const API_URL = "https://tagmanager.googleapis.com/tagmanager/v2"
const WORK_FOLDER = process.env.WORKDIR
const GOOGLE_TOKEN = process.env.GOOGLE_TOKEN
const commandArgs = parseArgs({ options: { container: { type: "string" } } }).values
const containerPath = await findContainerPath(commandArgs.container)
const liveVersion = await requestApi(`${containerPath}/versions:live`)

await writeFile(join(WORK_FOLDER, "tags.json"), JSON.stringify((liveVersion.tag ?? []).map(buildTagRecord), null, 2))

async function findContainerPath(publicId) {
  const lookupResult = await requestApi(`accounts/containers:lookup?tagId=${encodeURIComponent(publicId)}`)
  return lookupResult.path
}

async function requestApi(apiPath) {
  const apiResponse = await fetch(`${API_URL}/${apiPath}`, { headers: { Authorization: `Bearer ${GOOGLE_TOKEN}` } })
  const responseData = await apiResponse.json().catch(() => ({}))
  if (!apiResponse.ok) exitWithReason(`GTM API ${apiResponse.status}: ${responseData.error?.message ?? apiResponse.statusText}`)
  return responseData
}

function exitWithReason(failReason) {
  process.stderr.write(`${failReason}\n`)
  process.exit(1)
}

function buildTagRecord(tagInfo) {
  return {
    id: `tag#${tagInfo.tagId}`,
    name: tagInfo.name,
    type: tagInfo.type,
    paused: Boolean(tagInfo.paused),
    event: tagInfo.type === "gaawe" ? readParameter(tagInfo.parameter ?? [], "eventName") : "",
    text: collectParameterText(tagInfo.parameter ?? []),
  }
}

function readParameter(parameterList, parameterKey) {
  return parameterList.find(parameterInfo => parameterInfo.key === parameterKey)?.value ?? ""
}

function collectParameterText(parameterList) {
  return parameterList
    .flatMap(parameterInfo => [
      parameterInfo.value ?? "",
      collectParameterText(parameterInfo.list ?? []),
      collectParameterText(parameterInfo.map ?? []),
    ])
    .filter(Boolean)
    .join(" ")
}
