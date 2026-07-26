const childProcess = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

const {
  generateHistoricalWebp,
  inspectImage
} = require("../cms/product-image-optimizer")

let mysql
try {
  mysql = require("mysql2/promise")
} catch (error) {
  mysql = null
}

const ROOT = path.resolve(process.env.VSC_ROOT || path.join(__dirname, ".."))
const UPLOADS_DIR = path.join(ROOT, "cms", "uploads")
const PRODUCT_OUTPUT_DIR = path.join(UPLOADS_DIR, "products")
const HOME_FILE = path.join(ROOT, "cms", "data", "home.json")
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"])

function loadEnv(file) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#")) continue
    const index = line.indexOf("=")
    if (index < 1) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1)
    if (!process.env[key]) process.env[key] = value
  }
}

function optionValue(name, fallback = "") {
  const exact = process.argv.indexOf(`--${name}`)
  if (exact !== -1 && process.argv[exact + 1] && !process.argv[exact + 1].startsWith("--")) {
    return process.argv[exact + 1]
  }
  const prefix = `--${name}=`
  const item = process.argv.find(arg => arg.startsWith(prefix))
  return item ? item.slice(prefix.length) : fallback
}

function parseOptions() {
  const apply = process.argv.includes("--apply")
  const rollbackFile = optionValue("rollback", "").trim()
  return {
    apply,
    dryRun: !apply && !rollbackFile,
    rollbackFile,
    limit: Math.max(0, Number.parseInt(optionValue("limit", "0"), 10) || 0),
    productId: optionValue("product-id", "").trim(),
    mappingFile: optionValue("mapping-file", "").trim(),
    snapshotFile: optionValue("snapshot", "").trim()
  }
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback
  if (Array.isArray(value) || (typeof value === "object" && !Buffer.isBuffer(value))) return value
  try {
    return JSON.parse(String(value))
  } catch (error) {
    return fallback
  }
}

function normalizeList(value) {
  const parsed = parseJson(value, value)
  const list = Array.isArray(parsed) ? parsed : String(parsed || "").split(/[,，\n]/)
  return list.map(item => String(item || "").trim()).filter(Boolean)
}

function timestamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temp, file)
}

function databaseConfig() {
  return {
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || "very_simple_custom"
  }
}

function createPool() {
  if (!mysql) throw new Error("缺少 mysql2，无法安全读取或更新商品图片引用")
  const config = databaseConfig()
  if (!config.host || !config.user || !config.password || !config.database) {
    throw new Error("MySQL 环境变量不完整")
  }
  return mysql.createPool({ ...config, connectionLimit: 1, namedPlaceholders: true })
}

async function loadMysqlState(pool, productId) {
  const params = {}
  const where = productId ? " WHERE id = :id" : ""
  if (productId) params.id = productId
  const [rows] = await pool.query(
    `SELECT id, image_url, gallery_images, detail_images FROM products${where}`,
    params
  )
  const [homeRows] = await pool.query("SELECT id, data FROM home_config WHERE id = 1")
  return {
    source: "mysql",
    products: rows.map(row => ({
      id: row.id,
      imageUrl: String(row.image_url || ""),
      galleryImages: normalizeList(row.gallery_images),
      detailImages: normalizeList(row.detail_images)
    })),
    home: parseJson(homeRows[0]?.data, {}),
    hasHomeRow: !!homeRows[0]
  }
}

function loadJsonState(productId) {
  const home = fs.existsSync(HOME_FILE)
    ? parseJson(fs.readFileSync(HOME_FILE, "utf8"), {})
    : {}
  const products = (Array.isArray(home.products) ? home.products : [])
    .filter(product => !productId || String(product.id) === productId)
    .map(product => ({
      id: String(product.id || ""),
      imageUrl: String(product.imageUrl || product.mainImage || ""),
      galleryImages: normalizeList(product.galleryImages),
      detailImages: normalizeList(product.detailImages)
    }))
  return { source: "json", products, home, hasHomeRow: false }
}

function loadSnapshot(file, productId) {
  const data = parseJson(fs.readFileSync(file, "utf8"), {})
  return {
    source: "snapshot",
    products: (Array.isArray(data.products) ? data.products : [])
      .filter(product => !productId || String(product.id) === productId)
      .map(product => ({
        id: product.id,
        imageUrl: String(product.imageUrl || product.image_url || ""),
        galleryImages: normalizeList(product.galleryImages || product.gallery_images),
        detailImages: normalizeList(product.detailImages || product.detail_images)
      })),
    home: data.home || {},
    hasHomeRow: !!data.home
  }
}

async function loadState(options, pool) {
  if (options.snapshotFile) return loadSnapshot(path.resolve(options.snapshotFile), options.productId)
  if (pool) return loadMysqlState(pool, options.productId)
  return loadJsonState(options.productId)
}

function productReferences(products) {
  const references = []
  for (const product of products) {
    if (product.imageUrl) {
      references.push({ productId: product.id, field: "image_url", index: null, url: product.imageUrl })
    }
    product.galleryImages.forEach((url, index) => {
      references.push({ productId: product.id, field: "gallery_images", index, url })
    })
    product.detailImages.forEach((url, index) => {
      references.push({ productId: product.id, field: "detail_images", index, url })
    })
  }
  return references
}

function localFileForUrl(value) {
  let pathname = String(value || "").trim()
  try {
    if (/^https?:\/\//i.test(pathname)) pathname = new URL(pathname).pathname
  } catch (error) {
    return null
  }
  if (pathname.startsWith("/cms/uploads/")) pathname = pathname.replace(/^\/cms\/uploads\//, "/uploads/")
  if (!pathname.startsWith("/uploads/")) return null
  const relative = decodeURIComponent(pathname.slice("/uploads/".length))
  if (!relative || relative.includes("\0")) return null
  const file = path.resolve(UPLOADS_DIR, relative)
  if (file !== UPLOADS_DIR && !file.startsWith(`${UPLOADS_DIR}${path.sep}`)) return null
  if (!IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())) return null
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null
  return { file, relative }
}

function publicUrlFor(oldUrl, filename) {
  const pathname = `/uploads/products/${filename}`
  try {
    if (/^https?:\/\//i.test(oldUrl)) return `${new URL(oldUrl).origin}${pathname}`
  } catch (error) {
    // The local path form below remains compatible with publicAssetUrl().
  }
  return pathname
}

function groupReferencesByFile(references) {
  const groups = new Map()
  let externalOrMissing = 0
  for (const reference of references) {
    const resolved = localFileForUrl(reference.url)
    if (!resolved) {
      externalOrMissing += 1
      continue
    }
    const group = groups.get(resolved.file) || {
      file: resolved.file,
      relative: resolved.relative,
      urls: new Set(),
      references: []
    }
    group.urls.add(reference.url)
    group.references.push(reference)
    groups.set(resolved.file, group)
  }
  return { groups: [...groups.values()], externalOrMissing }
}

function replaceExactUrls(value, mapping, stats = { replacements: 0 }) {
  if (typeof value === "string") {
    if (!mapping.has(value)) return value
    stats.replacements += 1
    return mapping.get(value)
  }
  if (Array.isArray(value)) return value.map(item => replaceExactUrls(item, mapping, stats))
  if (value && typeof value === "object") {
    const result = {}
    for (const [key, item] of Object.entries(value)) {
      result[key] = replaceExactUrls(item, mapping, stats)
    }
    return result
  }
  return value
}

function buildDatabaseChanges(state, mapping) {
  const productChanges = []
  let databaseFields = 0
  let referenceOccurrences = 0
  for (const product of state.products) {
    const before = {
      imageUrl: product.imageUrl,
      galleryImages: [...product.galleryImages],
      detailImages: [...product.detailImages]
    }
    const after = {
      imageUrl: mapping.get(before.imageUrl) || before.imageUrl,
      galleryImages: before.galleryImages.map(url => mapping.get(url) || url),
      detailImages: before.detailImages.map(url => mapping.get(url) || url)
    }
    const fields = []
    if (after.imageUrl !== before.imageUrl) fields.push("image_url")
    if (JSON.stringify(after.galleryImages) !== JSON.stringify(before.galleryImages)) fields.push("gallery_images")
    if (JSON.stringify(after.detailImages) !== JSON.stringify(before.detailImages)) fields.push("detail_images")
    if (!fields.length) continue
    databaseFields += fields.length
    referenceOccurrences += Number(after.imageUrl !== before.imageUrl)
    referenceOccurrences += before.galleryImages.filter((url, index) => after.galleryImages[index] !== url).length
    referenceOccurrences += before.detailImages.filter((url, index) => after.detailImages[index] !== url).length
    productChanges.push({ id: product.id, fields, before, after })
  }

  const homeStats = { replacements: 0 }
  const homeAfter = replaceExactUrls(state.home, mapping, homeStats)
  const homeChanged = homeStats.replacements > 0
  if (homeChanged) databaseFields += 1
  referenceOccurrences += homeStats.replacements
  return {
    productChanges,
    homeChange: homeChanged ? { before: state.home, after: homeAfter } : null,
    databaseFields,
    referenceOccurrences,
    homeReferenceOccurrences: homeStats.replacements
  }
}

function defaultMappingFile(options) {
  if (options.mappingFile) return path.resolve(options.mappingFile)
  const base = options.dryRun ? os.tmpdir() : path.join(ROOT, "cms", "data", "product-image-migrations")
  return path.join(base, `product-image-webp-${timestamp()}.json`)
}

function defaultBackupFile() {
  const name = `mysql_backup_${timestamp()}.sql`
  const preferred = "/www/backup/very-simple-custom"
  const dir = fs.existsSync("/www") ? preferred : path.join(ROOT, "cms", "data", "database-backups")
  return path.join(dir, name)
}

function backupDatabase() {
  const config = databaseConfig()
  const backupFile = defaultBackupFile()
  fs.mkdirSync(path.dirname(backupFile), { recursive: true })
  const fd = fs.openSync(backupFile, "wx", 0o600)
  const args = [
    "--single-transaction",
    "--routines",
    "--triggers",
    "--host", config.host,
    "--port", String(config.port),
    "--user", config.user,
    config.database
  ]
  const result = childProcess.spawnSync("mysqldump", args, {
    env: { ...process.env, MYSQL_PWD: config.password },
    stdio: ["ignore", fd, "pipe"]
  })
  fs.closeSync(fd)
  if (result.status !== 0 || !fs.existsSync(backupFile) || fs.statSync(backupFile).size === 0) {
    fs.rmSync(backupFile, { force: true })
    throw new Error(`数据库备份失败：${String(result.stderr || "mysqldump 执行失败").trim()}`)
  }
  return backupFile
}

function backupReferencedImages(groups) {
  const backupRoot = fs.existsSync("/www")
    ? "/www/backup/very-simple-custom"
    : path.join(ROOT, "cms", "data", "product-image-backups")
  const backupFile = path.join(backupRoot, `product_images_${timestamp()}.tar.gz`)
  fs.mkdirSync(path.dirname(backupFile), { recursive: true })
  const relativeFiles = [...new Set(groups.map(group => group.relative))]
  if (!relativeFiles.length) throw new Error("没有可备份的商品图片")
  const result = childProcess.spawnSync(
    "tar",
    ["-czf", backupFile, "-C", UPLOADS_DIR, "--", ...relativeFiles],
    { encoding: "utf8" }
  )
  if (result.status !== 0 || !fs.existsSync(backupFile) || fs.statSync(backupFile).size === 0) {
    fs.rmSync(backupFile, { force: true })
    throw new Error(`商品图片备份失败：${String(result.stderr || "tar 执行失败").trim()}`)
  }
  return backupFile
}

async function applyChanges(pool, changes) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    for (const change of changes.productChanges) {
      await connection.query(
        `UPDATE products
         SET image_url = :imageUrl,
             gallery_images = :galleryImages,
             detail_images = :detailImages
         WHERE id = :id`,
        {
          id: change.id,
          imageUrl: change.after.imageUrl,
          galleryImages: JSON.stringify(change.after.galleryImages),
          detailImages: JSON.stringify(change.after.detailImages)
        }
      )
    }
    if (changes.homeChange) {
      await connection.query(
        "UPDATE home_config SET data = :data WHERE id = 1",
        { data: JSON.stringify(changes.homeChange.after) }
      )
    }
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function rollbackMigration(pool, mappingFile) {
  const migration = parseJson(fs.readFileSync(mappingFile, "utf8"), null)
  if (!migration || migration.status !== "applied" || !migration.databaseChanges) {
    throw new Error("映射文件不是已执行的商品图片迁移记录")
  }
  const current = await loadMysqlState(pool, "")
  const byId = new Map(current.products.map(product => [String(product.id), product]))
  for (const change of migration.databaseChanges.productChanges || []) {
    const row = byId.get(String(change.id))
    if (!row || !equalJson({
      imageUrl: row.imageUrl,
      galleryImages: row.galleryImages,
      detailImages: row.detailImages
    }, change.after)) {
      throw new Error(`商品 ${change.id} 当前图片字段已发生变化，停止回滚以避免覆盖新数据`)
    }
  }
  if (
    migration.databaseChanges.homeChange &&
    !equalJson(current.home, migration.databaseChanges.homeChange.after)
  ) {
    throw new Error("首页配置在迁移后又被修改，停止回滚以避免覆盖新数据")
  }

  const reverse = buildRollbackChanges(migration.databaseChanges)
  const databaseBackupFile = backupDatabase()
  await applyChanges(pool, reverse)
  migration.status = "rolled_back"
  migration.rolledBackAt = new Date().toISOString()
  migration.rollbackDatabaseBackupFile = databaseBackupFile
  writeJsonAtomic(mappingFile, migration)
  console.log(JSON.stringify({
    ok: true,
    rolledBack: true,
    mappingFile,
    databaseBackupFile,
    restoredProducts: reverse.productChanges.length,
    restoredHomeConfig: !!reverse.homeChange,
    generatedWebpFilesRetained: true
  }, null, 2))
}

function buildRollbackChanges(databaseChanges) {
  return {
    productChanges: (databaseChanges.productChanges || []).map(change => ({
      ...change,
      after: change.before
    })),
    homeChange: databaseChanges.homeChange
      ? { after: databaseChanges.homeChange.before }
      : null
  }
}

function formatBytes(value) {
  const bytes = Number(value || 0)
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`
  return `${(bytes / 1024).toFixed(1)}KB`
}

function savedPercent(before, after) {
  return before ? Number((((before - after) / before) * 100).toFixed(1)) : 0
}

async function migrate(options, pool) {
  if (options.apply && !pool) throw new Error("--apply 必须连接 MySQL，不能使用本地 JSON 回退")
  const state = await loadState(options, pool)
  const references = productReferences(state.products)
  const grouped = groupReferencesByFile(references)
  const selected = options.limit ? grouped.groups.slice(0, options.limit) : grouped.groups
  if (options.apply && !selected.length) {
    throw new Error("没有找到可迁移的本地商品图片，未创建备份或修改数据库")
  }
  const mapping = new Map()
  const records = []
  const databaseBackupFile = options.apply ? backupDatabase() : ""
  const imageBackupFile = options.apply ? backupReferencedImages(selected) : ""
  let originalSizeBytes = 0
  let webpSizeBytes = 0
  let failed = 0

  for (const group of selected) {
    try {
      const result = await generateHistoricalWebp({
        sourceFile: group.file,
        outputDir: PRODUCT_OUTPUT_DIR,
        dryRun: options.dryRun,
        tempDir: options.dryRun
          ? path.join(os.tmpdir(), "vsc-product-webp-dry-run")
          : PRODUCT_OUTPUT_DIR
      })
      originalSizeBytes += result.before.sizeBytes
      webpSizeBytes += result.after.sizeBytes
      const urlMappings = []
      for (const oldUrl of group.urls) {
        const newUrl = publicUrlFor(oldUrl, result.after.filename)
        mapping.set(oldUrl, newUrl)
        urlMappings.push({ oldUrl, newUrl })
      }
      records.push({
        status: result.status,
        sourceFile: group.relative,
        outputFile: `products/${result.after.filename}`,
        sourceFormat: result.before.format,
        originalSizeBytes: result.before.sizeBytes,
        webpSizeBytes: result.after.sizeBytes,
        originalDimensions: `${result.before.width}x${result.before.height}`,
        webpDimensions: `${result.after.width}x${result.after.height}`,
        hasAlpha: result.after.hasAlpha,
        savedPercent: savedPercent(result.before.sizeBytes, result.after.sizeBytes),
        productIds: [...new Set(group.references.map(item => item.productId))],
        referencedFields: [...new Set(group.references.map(item => item.field))],
        urlMappings
      })
      console.log(
        `${result.status.padEnd(13)} ${group.relative} ` +
        `${formatBytes(result.before.sizeBytes)} -> ${formatBytes(result.after.sizeBytes)} ` +
        `(${savedPercent(result.before.sizeBytes, result.after.sizeBytes)}%) ` +
        `${result.before.width}x${result.before.height} -> ${result.after.width}x${result.after.height}`
      )
    } catch (error) {
      failed += 1
      records.push({
        status: "failed",
        sourceFile: group.relative,
        error: error.message,
        productIds: [...new Set(group.references.map(item => item.productId))]
      })
      console.warn(`failed        ${group.relative} - ${error.message}`)
    }
  }

  const changes = buildDatabaseChanges(state, mapping)
  const mappingFile = defaultMappingFile(options)
  const migration = {
    version: 2,
    status: options.dryRun ? "dry_run" : "prepared",
    createdAt: new Date().toISOString(),
    source: state.source,
    options: {
      limit: options.limit,
      productId: options.productId
    },
    summary: {
      products: state.products.length,
      productReferences: references.length,
      uniqueLocalImages: grouped.groups.length,
      selectedImages: selected.length,
      convertedImages: records.filter(item => item.status !== "failed").length,
      failedImages: failed,
      externalOrMissing: grouped.externalOrMissing,
      affectedProducts: changes.productChanges.length,
      databaseFields: changes.databaseFields,
      referenceOccurrences: changes.referenceOccurrences,
      homeReferenceOccurrences: changes.homeReferenceOccurrences,
      originalSizeBytes,
      webpSizeBytes,
      originalSize: formatBytes(originalSizeBytes),
      webpSize: formatBytes(webpSizeBytes),
      savedPercent: savedPercent(originalSizeBytes, webpSizeBytes)
    },
    records,
    databaseChanges: changes,
    databaseBackupFile,
    imageBackupFile
  }
  writeJsonAtomic(mappingFile, migration)

  if (options.apply) {
    if (!records.some(item => item.status !== "failed")) throw new Error("没有成功生成可迁移的 WebP")
    await applyChanges(pool, changes)
    migration.status = "applied"
    migration.appliedAt = new Date().toISOString()
    writeJsonAtomic(mappingFile, migration)
  }

  console.log(JSON.stringify({
    ok: failed === 0,
    dryRun: options.dryRun,
    applied: options.apply,
    mappingFile,
    databaseBackupFile,
    imageBackupFile,
    originalFilesRetained: true,
    ...migration.summary,
    examples: records
      .filter(item => item.urlMappings?.length)
      .slice(0, 3)
      .map(item => ({
        oldUrl: item.urlMappings[0].oldUrl,
        newUrl: item.urlMappings[0].newUrl,
        originalSize: formatBytes(item.originalSizeBytes),
        webpSize: formatBytes(item.webpSizeBytes)
      }))
  }, null, 2))
}

async function main() {
  loadEnv(path.join(ROOT, ".env"))
  const options = parseOptions()
  let pool = null
  try {
    if (!options.snapshotFile && mysql && process.env.MYSQL_HOST) pool = createPool()
    if (options.rollbackFile) {
      if (!pool) throw new Error("--rollback 必须连接 MySQL")
      await rollbackMigration(pool, path.resolve(options.rollbackFile))
    } else {
      await migrate(options, pool)
    }
  } finally {
    if (pool) await pool.end()
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}

module.exports = {
  normalizeList,
  productReferences,
  localFileForUrl,
  publicUrlFor,
  groupReferencesByFile,
  replaceExactUrls,
  buildDatabaseChanges,
  buildRollbackChanges,
  savedPercent
}
