const fs = require("fs")
const path = require("path")

let sharp
try {
  sharp = require("sharp")
} catch (error) {
  sharp = null
}

const uploadsDir = path.join(__dirname, "..", "cms", "uploads")
const allowedExts = new Set([".jpg", ".jpeg", ".png", ".webp"])
const variants = [
  [".optimized", { width: 1200, height: 1200, fit: "inside", quality: 80 }],
  [".banner", { width: 1200, height: 500, fit: "cover", quality: 80 }],
  [".banner-thumb", { width: 600, height: 250, fit: "cover", quality: 74 }],
  [".thumb", { width: 400, height: 400, fit: "cover", quality: 80 }],
  [".cart-thumb", { width: 200, height: 200, fit: "cover", quality: 74 }],
  [".detail", { width: 800, height: 4000, fit: "inside", quality: 80 }]
]

function isVariant(name) {
  return /\.(optimized|banner|banner-thumb|thumb|cart-thumb|detail)\.(webp|jpg)$/i.test(name)
}

async function writeVariant(sourceFile, targetFile, options) {
  const resize = options.fit === "cover"
    ? { width: options.width, height: options.height, fit: "cover", position: "centre" }
    : { width: options.width, height: options.height, fit: "inside", withoutEnlargement: true }
  await sharp(sourceFile, { failOnError: false }).rotate().resize(resize).webp({ quality: options.quality }).toFile(targetFile)
}

async function main() {
  if (!sharp) {
    console.log("sharp 未安装，跳过历史图片压缩。")
    return
  }
  if (!fs.existsSync(uploadsDir)) {
    console.log(`uploads 目录不存在：${uploadsDir}`)
    return
  }
  let processed = 0
  let skipped = 0
  let failed = 0
  const files = fs.readdirSync(uploadsDir)
  for (const name of files) {
    const ext = path.extname(name).toLowerCase()
    if (!allowedExts.has(ext) || isVariant(name)) {
      skipped += 1
      continue
    }
    const sourceFile = path.join(uploadsDir, name)
    const stat = fs.statSync(sourceFile)
    if (!stat.isFile() || stat.size < 20 * 1024) {
      skipped += 1
      continue
    }
    const base = path.basename(name, ext)
    try {
      for (const [suffix, options] of variants) {
        const targetFile = path.join(uploadsDir, `${base}${suffix}.webp`)
        if (fs.existsSync(targetFile)) continue
        await writeVariant(sourceFile, targetFile, options)
        processed += 1
      }
    } catch (error) {
      failed += 1
      console.warn(`处理失败：${name} - ${error.message}`)
    }
  }
  console.log(`历史图片处理完成：生成 ${processed} 个，跳过 ${skipped} 个，失败 ${failed} 个。`)
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
