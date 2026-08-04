#!/usr/bin/env node
"use strict"

const assert = require("assert")
const childProcess = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")
const guard = require("./lib/production-operation-guard")

function command(args, cwd) { return childProcess.execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8" }).trim() }

function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "production-operation-guard-"))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "production-operation-files-"))
  const checks = []
  const check = (name, fn) => { fn(); checks.push(name) }
  try {
    command(["git", "init", "-q"], temp); command(["git", "config", "user.email", "test@example.invalid"], temp); command(["git", "config", "user.name", "guard-test"], temp)
    fs.writeFileSync(path.join(temp, "README"), "fixture\n"); command(["git", "add", "README"], temp); command(["git", "commit", "-qm", "fixture"], temp); command(["git", "branch", "-M", "release/blue-team-2026-08-rc3"], temp)
    const sha = command(["git", "rev-parse", "HEAD"], temp)
    const base = ["--rehearsal", "--confirm-production", "--expected-database=vsc_security_test_production_entry_rehearsal", "--expected-server-uuid=fixture-uuid", `--expected-git-sha=${sha}`]
    const rehearsalEnv = { NODE_ENV: "test", MYSQL_HOST: "127.0.0.1", MYSQL_TEST_DATABASE: "vsc_security_test_production_entry_rehearsal", MYSQL_TEST_USER: "test" }
    check("缺少生产确认拒绝", () => assert.throws(() => guard.assertMode(guard.parseCommonOperationArgs(["--rehearsal", "--expected-database=x", "--expected-server-uuid=x", `--expected-git-sha=${sha}`]), rehearsalEnv, temp), /confirm-production/))
    check("production与rehearsal互斥", () => assert.throws(() => guard.assertMode(guard.parseCommonOperationArgs([...base, "--production"]), rehearsalEnv, temp), /互斥/))
    check("错误Git SHA拒绝", () => assert.throws(() => guard.assertMode(guard.parseCommonOperationArgs(base.map(value => value.startsWith("--expected-git-sha=") ? `--expected-git-sha=${"0".repeat(64)}` : value)), rehearsalEnv, temp), /Git SHA/))
    check("错误分支拒绝", () => { command(["git", "branch", "-M", "wrong-branch"], temp); assert.throws(() => guard.assertMode(guard.parseCommonOperationArgs(base), rehearsalEnv, temp), /分支/); command(["git", "branch", "-M", "release/blue-team-2026-08-rc3"], temp) })
    check("工作树不干净拒绝", () => { fs.writeFileSync(path.join(temp, "dirty"), "x"); assert.throws(() => guard.assertMode(guard.parseCommonOperationArgs(base), rehearsalEnv, temp), /工作树不干净/); fs.unlinkSync(path.join(temp, "dirty")) })
    check("彩排仅允许test环境", () => assert.throws(() => guard.assertMode(guard.parseCommonOperationArgs(base), { ...rehearsalEnv, NODE_ENV: "production" }, temp), /NODE_ENV=test/))
    check("生产必须mysql和真实支付开关", () => assert.throws(() => guard.assertMode(guard.parseCommonOperationArgs(base.map(value => value === "--rehearsal" ? "--production" : value)), { NODE_ENV: "production", STORAGE_MODE: "mysql", PAY_MOCK: "true" }, temp), /PAY_MOCK=false/))
    check("测试库连接约束", () => assert.throws(() => guard.mysqlConfigForMode({ MYSQL_HOST: "10.0.0.1", MYSQL_TEST_DATABASE: "vsc_security_test_x", MYSQL_TEST_USER: "test" }, { kind: "rehearsal" }), /本机/))
    check("仓库内计划路径拒绝", () => assert.throws(() => guard.requireExternalPath(path.join(temp, "plan.json"), "计划", temp), /仓库外/))
    const backup = path.join(outside, "backup.sql.gz"); fs.writeFileSync(backup, "isolated fixture backup")
    const fingerprint = { database: "vsc_security_test_production_entry_rehearsal", hostname: "local", serverUuid: "fixture-uuid", version: "8.0.45", currentUser: "test@localhost" }
    const manifest = path.join(outside, "manifest.json")
    const validManifest = { database: fingerprint.database, serverUuid: fingerprint.serverUuid, createdAt: new Date().toISOString(), backupFile: backup, backupSize: fs.statSync(backup).size, sha256: guard.sha256File(backup), checksumVerified: true, restoreVerification: "PASS" }
    fs.writeFileSync(manifest, JSON.stringify(validManifest))
    check("有效备份清单通过", () => assert.strictEqual(guard.assertBackupManifest(manifest, fingerprint, temp).backupSize, validManifest.backupSize))
    check("备份摘要错误拒绝", () => { fs.writeFileSync(manifest, JSON.stringify({ ...validManifest, sha256: "0".repeat(64) })); assert.throws(() => guard.assertBackupManifest(manifest, fingerprint, temp), /SHA-256/); fs.writeFileSync(manifest, JSON.stringify(validManifest)) })
    check("恢复验证失败拒绝", () => { fs.writeFileSync(manifest, JSON.stringify({ ...validManifest, restoreVerification: "FAIL" })); assert.throws(() => guard.assertBackupManifest(manifest, fingerprint, temp), /恢复验证/); fs.writeFileSync(manifest, JSON.stringify(validManifest)) })
    check("空间不足拒绝", () => assert.throws(() => guard.assertDiskSpace(outside, validManifest.backupSize, { NODE_ENV: "test", VSC_GUARD_SIMULATE_AVAILABLE_BYTES: "1" }), /磁盘空间不足/))
    check("操作日志0600", () => { const log = path.join(outside, "operation.log"); guard.createOperationLog(log, { operation: "fixture", result: "PASS" }, temp); assert.strictEqual(fs.statSync(log).mode & 0o777, 0o600) })
    console.log(JSON.stringify({ ok: true, passedCount: checks.length, checks }, null, 2))
  } finally { fs.rmSync(temp, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }) }
}

main()
