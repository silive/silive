"use strict"

const crypto = require("crypto")
const fs = require("fs")
const path = require("path")
const childProcess = require("child_process")

const TEST_DATABASE_PREFIX = "vsc_security_test_"
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"])
const MAX_PLAN_AGE_MS = 60 * 60 * 1000
const MIN_MYSQL_MAJOR = 8
const DEFAULT_SAFETY_MARGIN_BYTES = 512 * 1024 * 1024

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function sha256File(filename) {
  return sha256(fs.readFileSync(filename))
}

function isAbsoluteExternalPath(filename, repoRoot = path.resolve(__dirname, "..", "..")) {
  if (!filename || !path.isAbsolute(filename)) return false
  const resolved = path.resolve(filename)
  return resolved !== repoRoot && !resolved.startsWith(`${repoRoot}${path.sep}`)
}

function requireExternalPath(filename, label, repoRoot) {
  if (!isAbsoluteExternalPath(filename, repoRoot)) throw new Error(`安全拒绝：${label}必须是 Git 仓库外的绝对路径`)
  return path.resolve(filename)
}

function readJson(filename, label, repoRoot) {
  const resolved = requireExternalPath(filename, label, repoRoot)
  try {
    return { filename: resolved, value: JSON.parse(fs.readFileSync(resolved, "utf8")), sha256: sha256File(resolved) }
  } catch (error) {
    throw new Error(`安全拒绝：无法读取${label}：${error.message}`)
  }
}

function git(command, repoRoot) {
  try {
    return childProcess.execFileSync("git", command, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch (error) {
    throw new Error(`安全拒绝：Git 检查失败（git ${command.join(" ")}）`)
  }
}

function gitState(repoRoot = path.resolve(__dirname, "..", "..")) {
  return {
    sha: git(["rev-parse", "HEAD"], repoRoot),
    branch: git(["branch", "--show-current"], repoRoot),
    dirty: !!git(["status", "--porcelain"], repoRoot)
  }
}

function hasFlag(args, name) { return args.includes(name) }
function valueArg(args, name) {
  const prefix = `${name}=`
  const arg = args.find(value => value.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : ""
}

function parseCommonOperationArgs(argv) {
  const args = [...argv]
  return {
    production: hasFlag(args, "--production"),
    rehearsal: hasFlag(args, "--rehearsal"),
    apply: hasFlag(args, "--apply"),
    dryRun: hasFlag(args, "--dry-run"),
    readOnly: hasFlag(args, "--read-only"),
    confirmProduction: hasFlag(args, "--confirm-production"),
    expectedDatabase: valueArg(args, "--expected-database"),
    expectedServerUuid: valueArg(args, "--expected-server-uuid"),
    expectedGitSha: valueArg(args, "--expected-git-sha"),
    backupManifest: valueArg(args, "--backup-manifest"),
    operationLog: valueArg(args, "--operation-log"),
    raw: args
  }
}

function assertMode(args, env = process.env, repoRoot) {
  if (args.production && args.rehearsal) throw new Error("安全拒绝：--production 与 --rehearsal 互斥")
  if (!args.production && !args.rehearsal) return { kind: "isolated" }
  if (!args.confirmProduction) throw new Error("安全拒绝：缺少 --confirm-production")
  for (const [label, value] of Object.entries({ "--expected-database": args.expectedDatabase, "--expected-server-uuid": args.expectedServerUuid, "--expected-git-sha": args.expectedGitSha })) {
    if (!value) throw new Error(`安全拒绝：缺少 ${label}`)
  }
  const state = gitState(repoRoot)
  if (state.dirty) throw new Error("安全拒绝：当前工作树不干净")
  if (state.sha !== args.expectedGitSha) throw new Error("安全拒绝：Git SHA 不一致")
  if (state.branch && state.branch !== "release/blue-team-2026-08-rc3") throw new Error("安全拒绝：当前分支不是指定 RC3")
  const nodeEnv = String(env.NODE_ENV || "").trim().toLowerCase()
  const storageMode = String(env.STORAGE_MODE || "").trim().toLowerCase()
  const payMock = String(env.PAY_MOCK || "").trim().toLowerCase()
  if (args.production) {
    if (nodeEnv !== "production") throw new Error("安全拒绝：生产模式要求 NODE_ENV=production")
    if (storageMode !== "mysql") throw new Error("安全拒绝：生产模式要求 STORAGE_MODE=mysql")
    if (payMock !== "false") throw new Error("安全拒绝：生产模式要求 PAY_MOCK=false")
    if (String(env.AI_PREVIEW_ENABLED || "").trim().toLowerCase() === "true") throw new Error("安全拒绝：AI_PREVIEW_ENABLED=true")
    return { kind: "production", state }
  }
  if (nodeEnv !== "test") throw new Error("安全拒绝：彩排模式要求 NODE_ENV=test")
  return { kind: "rehearsal", state }
}

function mysqlConfigForMode(env, mode) {
  const isolated = mode.kind === "isolated" || mode.kind === "rehearsal"
  const host = String(isolated ? env.MYSQL_HOST : env.MYSQL_HOST || "").trim().toLowerCase()
  const database = String(isolated ? env.MYSQL_TEST_DATABASE : env.MYSQL_DATABASE || "").trim()
  const user = String(isolated ? env.MYSQL_TEST_USER : env.MYSQL_USER || "").trim()
  const port = Number(isolated ? env.MYSQL_TEST_PORT || 3306 : env.MYSQL_PORT || 3306)
  if (!host || !database || !user) throw new Error("安全拒绝：MySQL 连接信息不完整")
  if (mode.kind === "isolated") {
    if (!LOCAL_HOSTS.has(host) || !database.startsWith(TEST_DATABASE_PREFIX)) throw new Error("安全拒绝：隔离模式仅允许本机 vsc_security_test_ 数据库")
  }
  if (mode.kind === "rehearsal") {
    if (!LOCAL_HOSTS.has(host) || !database.startsWith(TEST_DATABASE_PREFIX)) throw new Error("安全拒绝：彩排仅允许本机 vsc_security_test_ 数据库")
  }
  return { host, port, user, password: isolated ? env.MYSQL_TEST_PASSWORD || "" : env.MYSQL_PASSWORD || "", database, namedPlaceholders: true, dateStrings: true, connectionLimit: 4 }
}

async function databaseFingerprint(connection) {
  const [[row]] = await connection.query("SELECT DATABASE() AS database_name, @@hostname AS hostname, @@server_uuid AS server_uuid, @@version AS version, CURRENT_USER() AS current_user_name")
  return {
    database: String(row.database_name || ""),
    hostname: String(row.hostname || ""),
    serverUuid: String(row.server_uuid || ""),
    version: String(row.version || ""),
    currentUser: String(row.current_user_name || "")
  }
}

function fingerprintDigest(fingerprint) {
  return sha256(JSON.stringify(fingerprint)).slice(0, 16)
}

function assertCompatibleMysql(version) {
  const major = Number(String(version).match(/^(\d+)/)?.[1] || 0)
  if (major < MIN_MYSQL_MAJOR) throw new Error(`安全拒绝：MySQL ${version} 不兼容，要求 ${MIN_MYSQL_MAJOR}.x 或更高版本`)
}

function assertFingerprint(fingerprint, args, mode) {
  assertCompatibleMysql(fingerprint.version)
  if (mode.kind === "production") {
    if (fingerprint.database.startsWith(TEST_DATABASE_PREFIX)) throw new Error("安全拒绝：生产模式拒绝测试库前缀")
    if (fingerprint.database !== args.expectedDatabase) throw new Error("安全拒绝：数据库名不一致")
    if (fingerprint.serverUuid !== args.expectedServerUuid) throw new Error("安全拒绝：server_uuid 不一致")
  }
  if (mode.kind === "rehearsal") {
    if (!fingerprint.database.startsWith(TEST_DATABASE_PREFIX)) throw new Error("安全拒绝：彩排数据库必须为 vsc_security_test_ 前缀")
    if (fingerprint.database !== args.expectedDatabase) throw new Error("安全拒绝：彩排数据库名不一致")
    if (fingerprint.serverUuid !== args.expectedServerUuid) throw new Error("安全拒绝：彩排 server_uuid 不一致")
  }
}

function assertPlanFresh(plan, expectedSha) {
  if (!plan || plan.conclusion !== "PASS") throw new Error("安全拒绝：preflight 计划结论不是 PASS")
  if (plan.gitSha !== expectedSha) throw new Error("安全拒绝：计划文件 Git SHA 不一致")
  const generated = Date.parse(plan.generatedAt || "")
  const expires = Date.parse(plan.expiresAt || "")
  if (!Number.isFinite(generated) || !Number.isFinite(expires) || expires <= generated || expires - generated > MAX_PLAN_AGE_MS || Date.now() > expires) {
    throw new Error("安全拒绝：计划文件已过期或有效期非法")
  }
}

function assertBackupManifest(filename, fingerprint, repoRoot, now = Date.now()) {
  const { value, sha256: manifestSha256 } = readJson(filename, "备份清单", repoRoot)
  const required = ["database", "serverUuid", "createdAt", "backupFile", "backupSize", "sha256", "checksumVerified", "restoreVerification"]
  for (const field of required) if (!(field in value)) throw new Error(`安全拒绝：备份清单缺少 ${field}`)
  if (value.database !== fingerprint.database || value.serverUuid !== fingerprint.serverUuid) throw new Error("安全拒绝：备份清单数据库指纹不一致")
  const createdAt = Date.parse(value.createdAt)
  if (!Number.isFinite(createdAt) || now - createdAt > 2 * 60 * 60 * 1000 || createdAt > now + 5 * 60 * 1000) throw new Error("安全拒绝：备份时间不在两小时维护窗口内")
  if (!path.isAbsolute(value.backupFile) || !fs.existsSync(value.backupFile)) throw new Error("安全拒绝：备份文件不存在")
  const stat = fs.statSync(value.backupFile)
  if (!stat.isFile() || stat.size <= 0 || Number(value.backupSize) !== stat.size) throw new Error("安全拒绝：备份文件大小不一致或为零")
  if (sha256File(value.backupFile) !== value.sha256) throw new Error("安全拒绝：备份文件 SHA-256 不一致")
  if (value.checksumVerified !== true || value.restoreVerification !== "PASS") throw new Error("安全拒绝：备份校验或恢复验证未通过")
  return { manifest: value, manifestSha256, backupSize: stat.size }
}

function assertDiskSpace(referencePath, requiredBytes, env = process.env) {
  let available = 0
  if (env.VSC_GUARD_SIMULATE_AVAILABLE_BYTES && String(env.NODE_ENV).toLowerCase() === "test") available = Number(env.VSC_GUARD_SIMULATE_AVAILABLE_BYTES)
  else available = Number(fs.statfsSync(referencePath).bavail) * Number(fs.statfsSync(referencePath).bsize)
  const required = Number(requiredBytes) + DEFAULT_SAFETY_MARGIN_BYTES
  if (!Number.isFinite(available) || available < required) throw new Error("安全拒绝：可用磁盘空间不足")
  return { availableBytes: available, requiredBytes: required }
}

function createOperationLog(filename, record, repoRoot) {
  const resolved = requireExternalPath(filename, "操作审计日志", repoRoot)
  const safe = JSON.stringify(record) + "\n"
  fs.writeFileSync(resolved, safe, { mode: 0o600, flag: "a" })
  fs.chmodSync(resolved, 0o600)
  return resolved
}

module.exports = {
  DEFAULT_SAFETY_MARGIN_BYTES,
  LOCAL_HOSTS,
  MAX_PLAN_AGE_MS,
  TEST_DATABASE_PREFIX,
  assertBackupManifest,
  assertCompatibleMysql,
  assertDiskSpace,
  assertFingerprint,
  assertMode,
  assertPlanFresh,
  createOperationLog,
  databaseFingerprint,
  fingerprintDigest,
  gitState,
  isAbsoluteExternalPath,
  mysqlConfigForMode,
  parseCommonOperationArgs,
  readJson,
  requireExternalPath,
  sha256,
  sha256File
}
