"use strict"

const fs = require("fs")
const path = require("path")

const uploadsDir = path.join(__dirname, "..", "cms", "uploads")
const now = Date.now()
const oneDayMs = 24 * 60 * 60 * 1000
const result = {
  directory: uploadsDir,
  files: 0,
  totalBytes: 0,
  olderThan24Hours: 0,
  olderThan7Days: 0,
  unreadable: 0
}

if (fs.existsSync(uploadsDir)) {
  for (const name of fs.readdirSync(uploadsDir)) {
    if (!/^ai-preview-[A-Za-z0-9-]+\.(?:png|svg)$/i.test(name)) continue
    try {
      const stat = fs.statSync(path.join(uploadsDir, name))
      if (!stat.isFile()) continue
      result.files += 1
      result.totalBytes += stat.size
      if (now - stat.mtimeMs > oneDayMs) result.olderThan24Hours += 1
      if (now - stat.mtimeMs > 7 * oneDayMs) result.olderThan7Days += 1
    } catch (error) {
      result.unreadable += 1
    }
  }
}

console.log(JSON.stringify(result, null, 2))
