import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const LOGIN_FILE = join(homedir(), ".config", "website-audit", "google-login.json")
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const SCOPES = ["https://www.googleapis.com/auth/tagmanager.readonly"]
const LOGIN_TIMEOUT = 5 * 60 * 1000
const WORK_FOLDER = process.env.WORKDIR
const commandArgs = parseArgs({ options: { "client-file": { type: "string" }, "wait-login": { type: "boolean" } } }).values
const clientFile = commandArgs["client-file"].replace(/^~(?=$|\/)/, homedir())
const oauthClient = await readOauthClient(clientFile)

if (!commandArgs["wait-login"]) await saveAccessToken(oauthClient, clientFile)
else waitForLogin(oauthClient)

async function readOauthClient(clientFile) {
  const clientJson = await readFile(clientFile, "utf8").then(JSON.parse).catch(() => exitWithReason(`Cannot read client file ${clientFile}`))
  if (!clientJson.installed) exitWithReason(`${clientFile} is not an OAuth client of a desktop app`)
  return clientJson.installed
}

function exitWithReason(failReason) {
  process.stderr.write(`${failReason}\n`)
  process.exit(1)
}

async function saveAccessToken(oauthClient, clientFile) {
  const accessToken = await refreshSavedLogin(oauthClient)
  if (!accessToken) exitWithReason(`Open this link and allow access, then run the audit again: ${await startLoginHelper(clientFile)}`)
  await writeFile(join(WORK_FOLDER, "token.json"), JSON.stringify(accessToken))
}

async function refreshSavedLogin(oauthClient) {
  const savedLogin = await readFile(LOGIN_FILE, "utf8").then(JSON.parse).catch(() => null)
  if (savedLogin?.client_id !== oauthClient.client_id) return ""
  const tokenData = await requestToken({
    grant_type: "refresh_token",
    refresh_token: savedLogin.refresh_token,
    client_id: oauthClient.client_id,
    client_secret: oauthClient.client_secret,
  }).catch(tokenError => exitWithReason(tokenError.message))
  if (tokenData.access_token) return tokenData.access_token
  if (tokenData.error !== "invalid_grant") exitWithReason(`Google token refresh failed: ${tokenData.error_description ?? tokenData.error}`)
  await rm(LOGIN_FILE, { force: true })
  return ""
}

async function requestToken(tokenParams) {
  const tokenResponse = await fetch(TOKEN_URL, { method: "POST", body: new URLSearchParams(tokenParams) }).catch(networkError => {
    throw new Error(`Cannot reach Google: ${networkError.message}`)
  })
  return tokenResponse.json()
}

function startLoginHelper(clientFile) {
  const helperArgs = [fileURLToPath(import.meta.url), "--client-file", clientFile, "--wait-login"]
  const loginHelper = spawn(process.execPath, helperArgs, { detached: true, stdio: ["ignore", "pipe", "ignore"] })
  return new Promise((resolvePromise, rejectPromise) => {
    loginHelper.once("exit", () => rejectPromise(new Error("Login helper stopped before giving a link")))
    loginHelper.stdout.once("data", outputChunk => {
      loginHelper.stdout.destroy()
      loginHelper.unref()
      resolvePromise(outputChunk.toString().trim())
    })
  })
}

function waitForLogin(oauthClient) {
  const loginSession = {
    oauthClient,
    loginState: randomBytes(16).toString("hex"),
    codeVerifier: randomBytes(32).toString("base64url"),
    redirectUrl: "",
  }
  const callbackServer = createServer((httpRequest, httpResponse) => handleCallback(loginSession, httpRequest, httpResponse))
  callbackServer.listen(0, "127.0.0.1", () => {
    loginSession.redirectUrl = `http://127.0.0.1:${callbackServer.address().port}`
    process.stdout.write(`${buildLoginLink(loginSession)}\n`)
  })
  setTimeout(() => process.exit(1), LOGIN_TIMEOUT)
}

async function handleCallback(loginSession, httpRequest, httpResponse) {
  const callbackParams = new URL(httpRequest.url, loginSession.redirectUrl).searchParams
  if (callbackParams.get("state") !== loginSession.loginState || !callbackParams.get("code")) {
    httpResponse.writeHead(400).end("This link does not match the login, run the audit again")
    return
  }
  try {
    await saveLogin(loginSession.oauthClient, await exchangeCode(loginSession, callbackParams.get("code")))
    httpResponse.end("Google access saved, close this tab and run the audit again", () => process.exit(0))
  } catch (loginError) {
    httpResponse.writeHead(500).end(`Google login failed: ${loginError.message}`, () => process.exit(1))
  }
}

async function saveLogin(oauthClient, refreshToken) {
  await mkdir(dirname(LOGIN_FILE), { recursive: true })
  await writeFile(LOGIN_FILE, JSON.stringify({ client_id: oauthClient.client_id, refresh_token: refreshToken }), { mode: 0o600 })
}

async function exchangeCode(loginSession, authCode) {
  const tokenData = await requestToken({
    grant_type: "authorization_code",
    code: authCode,
    client_id: loginSession.oauthClient.client_id,
    client_secret: loginSession.oauthClient.client_secret,
    redirect_uri: loginSession.redirectUrl,
    code_verifier: loginSession.codeVerifier,
  })
  if (!tokenData.refresh_token) throw new Error(tokenData.error_description ?? tokenData.error ?? "No refresh token given")
  return tokenData.refresh_token
}

function buildLoginLink(loginSession) {
  const linkParams = new URLSearchParams({
    client_id: loginSession.oauthClient.client_id,
    redirect_uri: loginSession.redirectUrl,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: loginSession.loginState,
    code_challenge: createHash("sha256").update(loginSession.codeVerifier).digest("base64url"),
    code_challenge_method: "S256",
  })
  return `${AUTH_URL}?${linkParams}`
}
