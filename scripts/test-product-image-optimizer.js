const assert = require("assert")
const fs = require("fs")
const http = require("http")
const os = require("os")
const path = require("path")
const crypto = require("crypto")
const sharp = require("sharp")

const {
  MAX_PRODUCT_IMAGE_SIZE,
  optimizeProductImageUpload,
  generateHistoricalWebp
} = require("../cms/product-image-optimizer")
const {
  productReferences,
  buildDatabaseChanges,
  buildRollbackChanges
} = require("./optimize-product-images")

function randomRgb(width, height) {
  return crypto.randomBytes(width * height * 3)
}

async function createLargeJpeg() {
  const width = 4000
  const height = 3000
  let quality = 88
  let buffer
  do {
    buffer = await sharp(randomRgb(width, height), { raw: { width, height, channels: 3 } })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer()
    quality -= 4
  } while (buffer.length > MAX_PRODUCT_IMAGE_SIZE && quality >= 60)
  assert(buffer.length <= MAX_PRODUCT_IMAGE_SIZE, "4000x3000 JPEG fixture must remain under 10MB")
  return buffer
}

async function assertUploadCase(outputDir, name, buffer, expected = {}) {
  const result = await optimizeProductImageUpload({ buffer, outputDir, sourceName: name })
  const metadata = await sharp(result.file).metadata()
  assert(metadata.width <= 1200 && metadata.height <= 1200, `${name} longest edge should be <= 1200`)
  assert.strictEqual(metadata.format, "webp")
  assert.strictEqual(result.format, "webp")
  assert.strictEqual(path.extname(result.file).toLowerCase(), ".webp")
  if (expected.width) assert.strictEqual(metadata.width, expected.width)
  if (expected.height) assert.strictEqual(metadata.height, expected.height)
  if (expected.hasAlpha != null) assert.strictEqual(metadata.hasAlpha, expected.hasAlpha)
  if (expected.metadataStripped) {
    assert.strictEqual(metadata.orientation, undefined)
    assert.strictEqual(metadata.exif, undefined)
  }
  return result
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vsc-product-images-"))
  const outputDir = path.join(root, "uploads", "products")
  const results = []
  try {
    const phoneJpeg = await createLargeJpeg()
    const phoneResult = await assertUploadCase(outputDir, "phone.jpg", phoneJpeg, {
      width: 1200,
      height: 900
    })
    assert(phoneResult.sizeBytes < phoneResult.originalSizeBytes, "large JPEG should shrink")
    results.push({ case: "4000x3000 JPEG", ...phoneResult })

    const oriented = await sharp({
      create: { width: 800, height: 1200, channels: 3, background: "#ff6a00" }
    }).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer()
    const orientedResult = await assertUploadCase(outputDir, "oriented.jpg", oriented, {
      width: 1200,
      height: 800,
      metadataStripped: true
    })
    results.push({ case: "EXIF orientation", ...orientedResult })

    const transparent = await sharp({
      create: { width: 1600, height: 1000, channels: 4, background: { r: 255, g: 106, b: 0, alpha: 0.35 } }
    }).png().toBuffer()
    const transparentResult = await assertUploadCase(outputDir, "transparent.png", transparent, {
      width: 1200,
      height: 750,
      hasAlpha: true
    })
    results.push({ case: "transparent PNG", ...transparentResult })

    const square800 = await sharp({
      create: { width: 800, height: 800, channels: 3, background: "#ffffff" }
    }).jpeg({ quality: 90 }).toBuffer()
    const squareResult = await assertUploadCase(outputDir, "square.jpg", square800, {
      width: 800,
      height: 800
    })
    results.push({ case: "800x800", ...squareResult })

    const small300 = await sharp({
      create: { width: 300, height: 300, channels: 3, background: "#111827" }
    }).png().toBuffer()
    const smallResult = await assertUploadCase(outputDir, "small.png", small300, {
      width: 300,
      height: 300
    })
    results.push({ case: "300x300", ...smallResult })

    const webp = await sharp({
      create: { width: 1600, height: 900, channels: 3, background: "#f5f5f5" }
    }).webp({ quality: 95 }).toBuffer()
    const webpResult = await assertUploadCase(outputDir, "sample.webp", webp, {
      width: 1200,
      height: 675
    })
    results.push({ case: "WebP", ...webpResult })

    await assert.rejects(
      () => optimizeProductImageUpload({
        buffer: Buffer.from("not-an-image"),
        outputDir,
        sourceName: "broken.jpg"
      }),
      /unsupported|invalid|corrupt|image|Input/i
    )

    await assert.rejects(
      () => optimizeProductImageUpload({
        buffer: Buffer.alloc(MAX_PRODUCT_IMAGE_SIZE + 1),
        outputDir,
        sourceName: "too-large.jpg"
      }),
      /10MB/
    )

    await assert.rejects(
      () => optimizeProductImageUpload({
        buffer: square800,
        outputDir,
        sourceName: "wrong.png"
      }),
      /扩展名与实际格式不一致/
    )

    const dryRunFile = path.join(root, "dry-run.jpg")
    fs.writeFileSync(dryRunFile, phoneJpeg)
    const dryRunBefore = fs.readFileSync(dryRunFile)
    const dryRunResult = await generateHistoricalWebp({
      sourceFile: dryRunFile,
      outputDir,
      dryRun: true,
      tempDir: path.join(root, "dry-run-temp")
    })
    assert.strictEqual(dryRunResult.status, "would_convert")
    assert.strictEqual(dryRunResult.after.format, "webp")
    assert.strictEqual(path.extname(dryRunResult.after.file), ".webp")
    assert(dryRunResult.after.sizeBytes < dryRunResult.before.sizeBytes)
    assert(fs.readFileSync(dryRunFile).equals(dryRunBefore), "dry-run must not modify source image")

    const historicalFile = path.join(root, "uploads", "historical.jpg")
    fs.mkdirSync(path.dirname(historicalFile), { recursive: true })
    fs.writeFileSync(historicalFile, phoneJpeg)
    const historyResult = await generateHistoricalWebp({
      sourceFile: historicalFile,
      outputDir,
      dryRun: false
    })
    assert.strictEqual(historyResult.status, "converted")
    assert(fs.existsSync(historicalFile), "historical original must be retained")
    assert(fs.existsSync(historyResult.after.file), "new WebP must exist")
    assert.notStrictEqual(historicalFile, historyResult.after.file, "historical image must use a new URL")
    const repeatResult = await generateHistoricalWebp({
      sourceFile: historicalFile,
      outputDir,
      dryRun: false
    })
    assert.strictEqual(repeatResult.status, "reused")
    assert.strictEqual(repeatResult.after.file, historyResult.after.file)

    const historicalPng = path.join(root, "uploads", "historical-transparent.png")
    fs.writeFileSync(historicalPng, transparent)
    const historicalPngResult = await generateHistoricalWebp({
      sourceFile: historicalPng,
      outputDir,
      dryRun: false
    })
    const historicalPngMetadata = await sharp(historicalPngResult.after.file).metadata()
    assert.strictEqual(historicalPngMetadata.format, "webp")
    assert.strictEqual(historicalPngMetadata.hasAlpha, true)

    const historicalWebp = path.join(root, "uploads", "historical.webp")
    fs.writeFileSync(historicalWebp, webp)
    const historicalWebpResult = await generateHistoricalWebp({
      sourceFile: historicalWebp,
      outputDir,
      dryRun: false
    })
    assert.strictEqual((await sharp(historicalWebpResult.after.file).metadata()).format, "webp")

    const duplicatedUrl = "/uploads/historical.jpg"
    const state = {
      products: [{
        id: 1,
        imageUrl: duplicatedUrl,
        galleryImages: ["/uploads/old-a.png", duplicatedUrl, "/uploads/old-b.png"],
        detailImages: [duplicatedUrl, "/uploads/detail-b.png"]
      }],
      home: {
        recommended: [{ imageUrl: duplicatedUrl }],
        banner: { imageUrl: "/uploads/unrelated-banner.png" }
      }
    }
    const references = productReferences(state.products)
    assert.strictEqual(references.filter(item => item.url === duplicatedUrl).length, 3)
    const sameUrlMapping = new Map([[duplicatedUrl, "/uploads/products/new.webp"]])
    const changes = buildDatabaseChanges(state, sameUrlMapping)
    assert.strictEqual(changes.productChanges.length, 1)
    assert.deepStrictEqual(changes.productChanges[0].after.galleryImages, [
      "/uploads/old-a.png",
      "/uploads/products/new.webp",
      "/uploads/old-b.png"
    ])
    assert.deepStrictEqual(changes.productChanges[0].after.detailImages, [
      "/uploads/products/new.webp",
      "/uploads/detail-b.png"
    ])
    assert.strictEqual(changes.homeChange.after.recommended[0].imageUrl, "/uploads/products/new.webp")
    assert.strictEqual(changes.homeChange.after.banner.imageUrl, "/uploads/unrelated-banner.png")
    assert.deepStrictEqual(changes.productChanges[0].before, {
      imageUrl: duplicatedUrl,
      galleryImages: ["/uploads/old-a.png", duplicatedUrl, "/uploads/old-b.png"],
      detailImages: [duplicatedUrl, "/uploads/detail-b.png"]
    })
    const rollback = buildRollbackChanges(changes)
    assert.deepStrictEqual(rollback.productChanges[0].after, changes.productChanges[0].before)
    assert.deepStrictEqual(rollback.homeChange.after, changes.homeChange.before)

    const server = http.createServer((request, response) => {
      if (request.url !== `/uploads/products/${historyResult.after.filename}`) {
        response.writeHead(404)
        response.end()
        return
      }
      response.writeHead(200, { "Content-Type": "image/webp" })
      fs.createReadStream(historyResult.after.file).pipe(response)
    })
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      const response = await fetch(
        `http://127.0.0.1:${address.port}/uploads/products/${historyResult.after.filename}`
      )
      assert.strictEqual(response.status, 200)
      assert.strictEqual(response.headers.get("content-type"), "image/webp")
      const fetchedMetadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata()
      assert.strictEqual(fetchedMetadata.format, "webp")
    } finally {
      await new Promise(resolve => server.close(resolve))
    }

    console.log(JSON.stringify({
      ok: true,
      cases: results.map(item => ({
        case: item.case,
        originalSizeBytes: item.originalSizeBytes,
        sizeBytes: item.sizeBytes,
        width: item.width,
        height: item.height,
        savedPercent: Number((((item.originalSizeBytes - item.sizeBytes) / item.originalSizeBytes) * 100).toFixed(1))
      })),
      invalidImageRejected: true,
      oversizedImageRejected: true,
      extensionMismatchRejected: true,
      dryRunPreservedSource: true,
      historicalOriginalRetained: true,
      historicalJpegConverted: true,
      historicalTransparentPngConverted: true,
      historicalWebpReoptimized: true,
      repeatRunReusedWebp: true,
      duplicateReferenceMappedOnce: true,
      galleryOrderPreserved: true,
      detailOrderPreserved: true,
      homeProductReferenceUpdated: true,
      unrelatedHomeImagePreserved: true,
      rollbackSnapshotPreserved: true,
      newWebpUrlServedOverHttp: true
    }, null, 2))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
