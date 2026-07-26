const fs = require("fs")
const path = require("path")
const crypto = require("crypto")

let sharp
try {
  sharp = require("sharp")
} catch (error) {
  sharp = null
}

const MAX_PRODUCT_IMAGE_SIZE = 10 * 1024 * 1024
const MAX_PRODUCT_IMAGE_EDGE = 1200
const SUPPORTED_FORMATS = new Set(["jpeg", "png", "webp"])
const PRODUCT_WEBP_OPTIONS = {
  quality: 80,
  alphaQuality: 85,
  smartSubsample: true
}

function requireSharp() {
  if (!sharp) throw new Error("图片压缩组件 sharp 不可用")
  return sharp
}

function normalizedFormat(value) {
  const format = String(value || "").toLowerCase()
  if (format === "jpg") return "jpeg"
  return format
}

function sourceExtension(filename) {
  return normalizedFormat(path.extname(String(filename || "")).slice(1))
}

function assertSupportedMetadata(metadata, filename = "") {
  const actualFormat = normalizedFormat(metadata?.format)
  if (!SUPPORTED_FORMATS.has(actualFormat)) {
    throw new Error("商品图片只支持 JPG、JPEG、PNG、WebP")
  }
  const declaredFormat = sourceExtension(filename)
  if (declaredFormat && declaredFormat !== actualFormat) {
    throw new Error("图片扩展名与实际格式不一致")
  }
  return actualFormat
}

function buildWebpPipeline(input) {
  return requireSharp()(input, { failOnError: true })
    .rotate()
    .resize({
      width: MAX_PRODUCT_IMAGE_EDGE,
      height: MAX_PRODUCT_IMAGE_EDGE,
      fit: "inside",
      withoutEnlargement: true
    })
    .webp(PRODUCT_WEBP_OPTIONS)
}

async function verifyImage(file, expectedFormat) {
  const metadata = await requireSharp()(file, { failOnError: true }).metadata()
  const actualFormat = normalizedFormat(metadata.format)
  if (actualFormat !== normalizedFormat(expectedFormat)) {
    throw new Error(`优化后图片格式异常：期望 ${expectedFormat}，实际 ${actualFormat || "unknown"}`)
  }
  if (!metadata.width || !metadata.height) throw new Error("优化后图片无法读取尺寸")
  return metadata
}

function randomProductImageName() {
  return `product-${Date.now()}-${crypto.randomBytes(12).toString("hex")}.webp`
}

async function optimizeProductImageUpload(options = {}) {
  const buffer = options.buffer
  const outputDir = options.outputDir
  const sourceName = options.sourceName || "product-image"
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("商品图片内容为空")
  if (buffer.length > MAX_PRODUCT_IMAGE_SIZE) throw new Error("商品图片超过10MB")
  if (!outputDir) throw new Error("商品图片输出目录未配置")

  fs.mkdirSync(outputDir, { recursive: true })
  const inputMetadata = await requireSharp()(buffer, { failOnError: true }).metadata()
  const sourceFormat = assertSupportedMetadata(inputMetadata, sourceName)
  const filename = randomProductImageName()
  const targetFile = path.join(outputDir, filename)
  const tempFile = path.join(outputDir, `.${filename}.${crypto.randomBytes(6).toString("hex")}.tmp`)

  try {
    await buildWebpPipeline(buffer).toFile(tempFile)
    const outputMetadata = await verifyImage(tempFile, "webp")
    fs.renameSync(tempFile, targetFile)
    const sizeBytes = fs.statSync(targetFile).size
    return {
      filename,
      file: targetFile,
      format: "webp",
      sourceFormat,
      width: outputMetadata.width,
      height: outputMetadata.height,
      originalWidth: inputMetadata.autoOrient?.width || inputMetadata.width || null,
      originalHeight: inputMetadata.autoOrient?.height || inputMetadata.height || null,
      originalSizeBytes: buffer.length,
      sizeBytes
    }
  } catch (error) {
    fs.rmSync(tempFile, { force: true })
    fs.rmSync(targetFile, { force: true })
    throw error
  }
}

async function inspectImage(file, options = {}) {
  const stat = fs.statSync(file)
  const metadata = await requireSharp()(file, { failOnError: true }).metadata()
  const format = options.allowExtensionMismatch
    ? normalizedFormat(metadata.format)
    : assertSupportedMetadata(metadata, file)
  if (!SUPPORTED_FORMATS.has(format)) {
    throw new Error("商品图片只支持 JPG、JPEG、PNG、WebP")
  }
  return {
    file,
    format,
    width: metadata.autoOrient?.width || metadata.width || null,
    height: metadata.autoOrient?.height || metadata.height || null,
    sizeBytes: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs)
  }
}

function productWebpName(buffer) {
  const digest = crypto
    .createHash("sha256")
    .update(buffer)
    .update(JSON.stringify({
      maxEdge: MAX_PRODUCT_IMAGE_EDGE,
      ...PRODUCT_WEBP_OPTIONS
    }))
    .digest("hex")
    .slice(0, 24)
  return `product-${digest}.webp`
}

async function generateHistoricalWebp(options = {}) {
  const sourceFile = options.sourceFile
  const outputDir = options.outputDir
  const dryRun = !!options.dryRun
  const before = await inspectImage(sourceFile)
  if (!outputDir) throw new Error("历史商品图片输出目录未配置")

  const tempDir = options.tempDir || outputDir
  fs.mkdirSync(tempDir, { recursive: true })
  const tempFile = path.join(tempDir, `.product-webp-${crypto.randomBytes(8).toString("hex")}.tmp`)
  try {
    await buildWebpPipeline(sourceFile).toFile(tempFile)
    const outputMetadata = await verifyImage(tempFile, "webp")
    const outputStat = fs.statSync(tempFile)
    const outputBuffer = fs.readFileSync(tempFile)
    const filename = productWebpName(outputBuffer)
    const targetFile = path.join(outputDir, filename)
    const after = {
      file: targetFile,
      filename,
      format: "webp",
      width: outputMetadata.width,
      height: outputMetadata.height,
      sizeBytes: outputStat.size,
      hasAlpha: !!outputMetadata.hasAlpha
    }
    if (dryRun) {
      fs.rmSync(tempFile, { force: true })
      return { status: "would_convert", before, after }
    }
    fs.mkdirSync(outputDir, { recursive: true })
    if (fs.existsSync(targetFile)) {
      const existing = await verifyImage(targetFile, "webp")
      fs.rmSync(tempFile, { force: true })
      return {
        status: "reused",
        before,
        after: {
          ...after,
          width: existing.width,
          height: existing.height,
          sizeBytes: fs.statSync(targetFile).size,
          hasAlpha: !!existing.hasAlpha
        }
      }
    }
    fs.renameSync(tempFile, targetFile)
    await verifyImage(targetFile, "webp")
    return { status: "converted", before, after }
  } catch (error) {
    fs.rmSync(tempFile, { force: true })
    throw error
  }
}

module.exports = {
  MAX_PRODUCT_IMAGE_SIZE,
  MAX_PRODUCT_IMAGE_EDGE,
  PRODUCT_WEBP_OPTIONS,
  optimizeProductImageUpload,
  generateHistoricalWebp,
  inspectImage,
  productWebpName,
  normalizedFormat
}
