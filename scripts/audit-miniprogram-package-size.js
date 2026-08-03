#!/usr/bin/env node
"use strict"

const fs = require("fs")
const path = require("path")

const projectRoot = path.resolve(__dirname, "..")
const argument = name => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : ""
}
const jsonPath = argument("--json")

function readJson(relativePath) {
  const absolutePath = path.join(projectRoot, relativePath)
  return fs.existsSync(absolutePath)
    ? JSON.parse(fs.readFileSync(absolutePath, "utf8"))
    : {}
}

function normalize(relativePath) {
  return String(relativePath || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
}

function wildcardMatcher(pattern) {
  const escaped = normalize(pattern).replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`)
}

function buildIgnoreMatcher(ignoreRules) {
  const rules = Array.isArray(ignoreRules) ? ignoreRules : []
  return relativePath => {
    const normalizedPath = normalize(relativePath)
    return rules.find(rule => {
      const value = normalize(rule?.value)
      if (!value) return false
      if (rule.type === "folder") return normalizedPath === value || normalizedPath.startsWith(`${value}/`)
      return wildcardMatcher(value).test(normalizedPath)
    }) || null
  }
}

function walk(directory, relativeDirectory, ignored, files, ignoredFiles) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = normalize(path.posix.join(relativeDirectory, entry.name))
    const ignoredRule = ignored(relativePath)
    const absolutePath = path.join(directory, entry.name)
    if (ignoredRule) {
      if (entry.isDirectory()) {
        const size = directorySize(absolutePath)
        ignoredFiles.push({ path: relativePath, type: "folder", bytes: size, rule: ignoredRule.value })
      } else if (entry.isFile()) {
        ignoredFiles.push({ path: relativePath, type: "file", bytes: fs.statSync(absolutePath).size, rule: ignoredRule.value })
      }
      continue
    }
    if (entry.isDirectory()) walk(absolutePath, relativePath, ignored, files, ignoredFiles)
    if (entry.isFile()) {
      const stat = fs.statSync(absolutePath)
      files.push({ path: relativePath, bytes: stat.size, extension: path.extname(entry.name).toLowerCase() || "[none]" })
    }
  }
}

function directorySize(directory) {
  let bytes = 0
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) bytes += directorySize(absolutePath)
    if (entry.isFile()) bytes += fs.statSync(absolutePath).size
  }
  return bytes
}

function summarize(files) {
  const extensions = {}
  for (const file of files) {
    const current = extensions[file.extension] || { files: 0, bytes: 0 }
    current.files += 1
    current.bytes += file.bytes
    extensions[file.extension] = current
  }
  return Object.entries(extensions)
    .map(([extension, value]) => ({ extension, ...value }))
    .sort((left, right) => right.bytes - left.bytes)
}

const projectConfig = readJson("project.config.json")
const privateConfig = readJson("project.private.config.json")
const miniprogramRoot = path.resolve(projectRoot, projectConfig.miniprogramRoot || "./")
const publicIgnore = projectConfig.packOptions?.ignore || []
const privateIgnore = privateConfig.packOptions?.ignore || []
const ignored = buildIgnoreMatcher(publicIgnore)
const files = []
const ignoredFiles = []
walk(miniprogramRoot, "", ignored, files, ignoredFiles)
const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
const report = {
  generatedAt: new Date().toISOString(),
  note: "这是按 project.config.json packOptions.ignore 估算的本地结果，微信开发者工具显示的实际源码包大小才是最终依据。",
  projectRoot,
  miniprogramRoot,
  publicIgnoreCount: publicIgnore.length,
  privateIgnoreCount: privateIgnore.length,
  files: files.length,
  bytes: totalBytes,
  kib: Number((totalBytes / 1024).toFixed(2)),
  extensionSummary: summarize(files),
  largestFiles: [...files].sort((left, right) => right.bytes - left.bytes).slice(0, 50),
  filesOver50KiB: files.filter(file => file.bytes > 50 * 1024).sort((left, right) => right.bytes - left.bytes),
  ignored: ignoredFiles.sort((left, right) => right.bytes - left.bytes)
}

if (jsonPath) {
  const output = path.resolve(projectRoot, jsonPath)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
}

console.log(JSON.stringify({
  files: report.files,
  bytes: report.bytes,
  kib: report.kib,
  miniprogramRoot: report.miniprogramRoot,
  largestFiles: report.largestFiles.slice(0, 10),
  ignoredBytes: report.ignored.reduce((sum, file) => sum + file.bytes, 0),
  ignoredCount: report.ignored.length,
  note: report.note
}, null, 2))
