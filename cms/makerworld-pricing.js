"use strict"

function finiteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function booleanValue(value, fallback = false) {
  if (value == null || value === "") return fallback
  return value === true || ["true", "1", "yes", "on"].includes(String(value).toLowerCase())
}

function normalizePricingSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {}
  const mode = source.mode === "single" ? "single" : "sum"
  const allowedMetrics = ["weight", "time", "colors", "ams", "plates"]
  return {
    enabled: booleanValue(source.enabled, false),
    mode,
    singleMetric: allowedMetrics.includes(source.singleMetric) ? source.singleMetric : "weight",
    basePrice: Math.max(0, finiteNumber(source.basePrice)),
    perGram: Math.max(0, finiteNumber(source.perGram)),
    perMinute: Math.max(0, finiteNumber(source.perMinute)),
    perColor: Math.max(0, finiteNumber(source.perColor, finiteNumber(source.perExtraColor))),
    amsFee: Math.max(0, finiteNumber(source.amsFee)),
    perPlate: Math.max(0, finiteNumber(source.perPlate)),
    minimumPrice: Math.max(0, finiteNumber(source.minimumPrice)),
    rounding: [0.01, 0.1, 0.5, 1].includes(finiteNumber(source.rounding)) ? finiteNumber(source.rounding) : 0.1,
    useWeight: booleanValue(source.useWeight, true),
    useTime: booleanValue(source.useTime, true),
    useColors: booleanValue(source.useColors, true),
    useAms: booleanValue(source.useAms, true),
    usePlates: booleanValue(source.usePlates, true),
    defaultStock: Math.max(0, Math.floor(finiteNumber(source.defaultStock, 100)))
  }
}

function profileIdFromUrl(value = "") {
  const match = String(value).match(/(?:#|[?&])profileId-(\d+)|[?&#]profileId=(\d+)/i)
  return match ? String(match[1] || match[2] || "") : ""
}

function extractPrintMetadata(design = {}, submittedUrl = "") {
  const instances = Array.isArray(design.instances) ? design.instances : []
  const requestedId = profileIdFromUrl(submittedUrl)
  const selected = instances.find(item => String(item?.id || "") === requestedId) ||
    instances.find(item => String(item?.id || "") === String(design.defaultInstanceId || "")) ||
    instances.find(item => item?.isDefault) || instances[0]
  if (!selected) return null
  const plates = Array.isArray(selected.extention?.modelInfo?.plates) ? selected.extention.modelInfo.plates : []
  const plateSeconds = plates.reduce((sum, plate) => sum + Math.max(0, finiteNumber(plate?.prediction)), 0)
  const plateWeight = plates.reduce((sum, plate) => sum + Math.max(0, finiteNumber(plate?.weight)), 0)
  const filaments = (Array.isArray(selected.instanceFilaments) && selected.instanceFilaments.length
    ? selected.instanceFilaments
    : plates.flatMap(plate => Array.isArray(plate?.filaments) ? plate.filaments : []))
  const colors = [...new Set(filaments.map(item => String(item?.color || "").trim().toUpperCase()).filter(Boolean))]
  const materialWeight = filaments.reduce((sum, item) => sum + Math.max(0, finiteNumber(item?.usedG)), 0)
  return {
    profileId: String(selected.id || ""),
    profileDataId: String(selected.profileId || ""),
    profileTitle: String(selected.titleTranslated || selected.title || "").trim(),
    plateCount: Math.max(1, plates.length || 1),
    printTimeSeconds: Math.max(0, finiteNumber(selected.prediction, plateSeconds)),
    weightGrams: Math.max(0, finiteNumber(selected.weight, plateWeight || materialWeight)),
    colorCount: Math.max(0, finiteNumber(selected.materialColorCnt, colors.length)),
    colors,
    needAms: booleanValue(selected.needAms, false),
    materialCount: Math.max(0, finiteNumber(selected.materialCnt, filaments.length)),
    printer: String(selected.extention?.modelInfo?.compatibility?.devProductName || "").trim(),
    fetchedAt: new Date().toISOString()
  }
}

function calculatePrice(metadata = {}, rawSettings = {}) {
  const settings = normalizePricingSettings(rawSettings)
  if (!settings.enabled || !metadata) return null
  const minutes = Math.max(0, finiteNumber(metadata.printTimeSeconds)) / 60
  const parts = {
    weight: Math.max(0, finiteNumber(metadata.weightGrams)) * settings.perGram,
    time: minutes * settings.perMinute,
    colors: Math.max(0, finiteNumber(metadata.colorCount)) * settings.perColor,
    ams: booleanValue(metadata.needAms, false) ? settings.amsFee : 0,
    plates: Math.max(0, finiteNumber(metadata.plateCount)) * settings.perPlate
  }
  const enabled = {
    weight: settings.useWeight,
    time: settings.useTime,
    colors: settings.useColors,
    ams: settings.useAms,
    plates: settings.usePlates
  }
  const variable = settings.mode === "single"
    ? (enabled[settings.singleMetric] ? parts[settings.singleMetric] : 0)
    : Object.keys(parts).reduce((sum, key) => sum + (enabled[key] ? parts[key] : 0), 0)
  const raw = Math.max(settings.minimumPrice, settings.basePrice + variable)
  const rounded = Math.ceil((raw - 1e-9) / settings.rounding) * settings.rounding
  return {
    price: rounded.toFixed(2),
    rawPrice: Math.round(raw * 10000) / 10000,
    parts: Object.fromEntries(Object.entries(parts).map(([key, value]) => [key, Math.round(value * 10000) / 10000])),
    mode: settings.mode,
    singleMetric: settings.singleMetric,
    calculatedAt: new Date().toISOString()
  }
}

module.exports = { calculatePrice, extractPrintMetadata, normalizePricingSettings, profileIdFromUrl }
