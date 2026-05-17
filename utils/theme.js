const ENABLE_REMOTE_THEME = false

const DEFAULT_THEME = {
  skinId: "skin01",
  skin: "skin01",
  name: "Skin01 橙色活力品牌风",
  version: 1,
  updatedAt: "",
  colors: {
    primaryColor: "#FF5A00",
    accentColor: "#FFD21A",
    lightBg: "#FFF3E8",
    pageTopColor: "#FFF9F3",
    pageBottomColor: "#FFFFFF",
    cardColor: "#FFFFFF",
    textColor: "#1F2937",
    mutedTextColor: "#6B7280",
    priceColor: "#FF4D00",
    successColor: "#22C55E",
    warningColor: "#F59E0B",
    borderColor: "#FFD9BF",
    buttonGradientStart: "#FF7A00",
    buttonGradientEnd: "#FF4D00",
    shadowColor: "rgba(255,106,0,.10)"
  },
  radius: {
    cardRadius: 28,
    buttonRadius: 999
  },
  tabbar: {
    activeColor: "#FF5A00",
    inactiveColor: "#999999",
    backgroundColor: "#FFFFFF"
  },
  navigationBar: {
    frontColor: "#000000",
    backgroundColor: "#FFF9F3"
  },
  banners: {},
  icons: {},
  banner: ""
}

function radiusNumber(value, fallback) {
  const matched = String(value == null ? "" : value).match(/\d+/)
  return matched ? Number(matched[0]) : fallback
}

function hexToRgba(color, alpha) {
  const hex = String(color || "").replace("#", "")
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return color
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

function normalizeTheme(theme = {}) {
  if (!ENABLE_REMOTE_THEME) theme = DEFAULT_THEME
  const source = theme || {}
  const sourceColors = source.colors || {}
  const gradient = Array.isArray(source.buttonGradient) && source.buttonGradient.length >= 2
    ? source.buttonGradient
    : [sourceColors.buttonGradientStart || source.primaryColor || DEFAULT_THEME.colors.buttonGradientStart, sourceColors.buttonGradientEnd || source.accentColor || DEFAULT_THEME.colors.buttonGradientEnd]
  const colors = {
    ...DEFAULT_THEME.colors,
    ...sourceColors,
    primaryColor: sourceColors.primaryColor || source.primaryColor || DEFAULT_THEME.colors.primaryColor,
    accentColor: sourceColors.accentColor || source.accentColor || DEFAULT_THEME.colors.accentColor,
    lightBg: sourceColors.lightBg || source.lightBg || source.softColor || DEFAULT_THEME.colors.lightBg,
    pageTopColor: sourceColors.pageTopColor || source.pageTopColor || DEFAULT_THEME.colors.pageTopColor,
    pageBottomColor: sourceColors.pageBottomColor || source.pageBottomColor || DEFAULT_THEME.colors.pageBottomColor,
    cardColor: sourceColors.cardColor || source.cardColor || DEFAULT_THEME.colors.cardColor,
    textColor: sourceColors.textColor || source.textColor || DEFAULT_THEME.colors.textColor,
    mutedTextColor: sourceColors.mutedTextColor || source.mutedTextColor || source.mutedColor || DEFAULT_THEME.colors.mutedTextColor,
    priceColor: sourceColors.priceColor || source.priceColor || DEFAULT_THEME.colors.priceColor,
    buttonGradientStart: sourceColors.buttonGradientStart || gradient[0],
    buttonGradientEnd: sourceColors.buttonGradientEnd || gradient[1],
    shadowColor: sourceColors.shadowColor || source.shadowColor || DEFAULT_THEME.colors.shadowColor
  }
  const radius = {
    cardRadius: radiusNumber(source.radius?.cardRadius ?? source.cardRadius, DEFAULT_THEME.radius.cardRadius),
    buttonRadius: radiusNumber(source.radius?.buttonRadius ?? source.buttonRadius, DEFAULT_THEME.radius.buttonRadius)
  }
  const skinId = source.skinId || source.skin || DEFAULT_THEME.skinId
  return {
    ...DEFAULT_THEME,
    ...source,
    skinId,
    skin: skinId,
    colors,
    radius,
    tabbar: {
      ...DEFAULT_THEME.tabbar,
      ...(source.tabbar || {}),
      activeColor: source.tabbar?.activeColor || colors.priceColor,
      backgroundColor: source.tabbar?.backgroundColor || DEFAULT_THEME.tabbar.backgroundColor
    },
    navigationBar: {
      ...DEFAULT_THEME.navigationBar,
      ...(source.navigationBar || {}),
      frontColor: source.navigationBar?.frontColor === "#ffffff" ? "#ffffff" : "#000000",
      backgroundColor: source.navigationBar?.backgroundColor || colors.pageTopColor
    },
    primaryColor: colors.primaryColor,
    accentColor: colors.accentColor,
    softColor: colors.lightBg,
    pageTopColor: colors.pageTopColor,
    pageBottomColor: colors.pageBottomColor,
    cardColor: colors.cardColor,
    textColor: colors.textColor,
    mutedColor: colors.mutedTextColor,
    priceColor: colors.priceColor,
    buttonGradient: [colors.buttonGradientStart, colors.buttonGradientEnd],
    cardRadius: `${radius.cardRadius}rpx`,
    buttonRadius: `${radius.buttonRadius}rpx`,
    shadowColor: colors.shadowColor
  }
}

function buildThemeStyle(theme = DEFAULT_THEME) {
  const next = normalizeTheme(theme)
  const c = next.colors
  return [
    `--primary-color:${c.primaryColor}`,
    `--accent-color:${c.accentColor}`,
    `--soft-color:${c.lightBg}`,
    `--page-top-color:${c.pageTopColor}`,
    `--page-bottom-color:${c.pageBottomColor}`,
    `--card-color:${c.cardColor}`,
    `--text-color:${c.textColor}`,
    `--muted-color:${c.mutedTextColor}`,
    `--price-color:${c.priceColor}`,
    `--success-color:${c.successColor || "#22C55E"}`,
    `--warning-color:${c.warningColor || "#F59E0B"}`,
    `--border-color:${c.borderColor || "#FFD9BF"}`,
    `--button-start:${c.buttonGradientStart}`,
    `--button-end:${c.buttonGradientEnd}`,
    `--card-radius:${next.radius.cardRadius}rpx`,
    `--button-radius:${next.radius.buttonRadius}rpx`,
    `--theme-shadow:${c.shadowColor}`,
    `background:linear-gradient(180deg, ${c.pageTopColor} 0%, ${c.pageBottomColor} 100%)`,
    `color:${c.textColor}`
  ].join(";")
}

function buildThemeStyles(theme = DEFAULT_THEME) {
  const next = normalizeTheme(theme)
  const c = next.colors
  const gradient = `linear-gradient(90deg, ${c.buttonGradientStart}, ${c.buttonGradientEnd})`
  const bannerGradient = `linear-gradient(135deg, ${c.primaryColor}, ${c.accentColor})`
  return {
    themeStyle: buildThemeStyle(next),
    pageStyle: buildThemeStyle(next),
    cardStyle: `border-radius:${next.radius.cardRadius}rpx;background:${c.cardColor};border:1rpx solid ${c.borderColor || "#FFD9BF"};box-shadow:0 12rpx 32rpx ${c.shadowColor}`,
    primaryButtonStyle: `background:${gradient};border-radius:${next.radius.buttonRadius}rpx;color:#fff`,
    secondaryButtonStyle: `background:${c.cardColor};border:1rpx solid ${c.borderColor || c.lightBg};border-radius:${next.radius.buttonRadius}rpx;color:${c.primaryColor}`,
    bannerStyle: `background:${bannerGradient};border-radius:${next.radius.cardRadius}rpx;box-shadow:0 12rpx 32rpx ${c.shadowColor}`,
    bannerOverlayStyle: `left:0;right:auto;width:58%;background:linear-gradient(90deg, rgba(15,23,42,.26), rgba(15,23,42,.08), transparent);pointer-events:none`,
    bannerImageStyle: "",
    priceStyle: `color:${c.priceColor}`,
    mutedTextStyle: `color:${c.mutedTextColor}`,
    tagStyle: `background:${c.lightBg};color:${c.primaryColor};border-radius:${next.radius.buttonRadius}rpx`,
    iconBadgeStyle: `background:${gradient};color:#fff;box-shadow:0 10rpx 24rpx ${c.shadowColor}`,
    tabActiveColor: next.tabbar.activeColor,
    tabInactiveColor: next.tabbar.inactiveColor,
    walletCardStyle: `background:${bannerGradient};border-radius:${next.radius.cardRadius}rpx;box-shadow:0 12rpx 32rpx ${c.shadowColor};color:#fff`
  }
}

function buildThemeData(theme = DEFAULT_THEME) {
  const next = normalizeTheme(theme)
  return {
    theme: next,
    ...buildThemeStyles(next),
    themeClass: `theme-${next.skinId || "skin01"}`
  }
}

function getCachedTheme() {
  return normalizeTheme(DEFAULT_THEME)
}

function setCachedTheme(theme) {
  return normalizeTheme(theme)
}

function clearThemeCache() {}

function fetchCurrentTheme() {
  return Promise.resolve(normalizeTheme(DEFAULT_THEME))
}

function isThemeChanged(oldTheme, newTheme) {
  const oldNext = normalizeTheme(oldTheme || DEFAULT_THEME)
  const newNext = normalizeTheme(newTheme || DEFAULT_THEME)
  return oldNext.skinId !== newNext.skinId
    || String(oldNext.version || "") !== String(newNext.version || "")
    || String(oldNext.updatedAt || "") !== String(newNext.updatedAt || "")
}

function applyRuntimeTheme(theme = DEFAULT_THEME) {
  const next = normalizeTheme(theme)
  try {
    wx.setNavigationBarColor({
      frontColor: next.navigationBar.frontColor,
      backgroundColor: next.navigationBar.backgroundColor
    })
  } catch (error) {}
  try {
    wx.setTabBarStyle({
      color: next.tabbar.inactiveColor,
      selectedColor: next.tabbar.activeColor,
      backgroundColor: next.tabbar.backgroundColor,
      borderStyle: "white"
    })
  } catch (error) {}
}

function applyThemeToPage(page, theme = DEFAULT_THEME) {
  if (!page || typeof page.setData !== "function") return
  const next = normalizeTheme(theme)
  page.setData(buildThemeData(next))
  applyRuntimeTheme(next)
  const app = typeof getApp === "function" ? getApp() : null
  if (app && app.globalData) app.globalData.theme = next
}

function loadCurrentTheme() {
  const theme = normalizeTheme(DEFAULT_THEME)
  applyRuntimeTheme(theme)
  return Promise.resolve(theme)
}

function applyTheme(page) {
  const theme = normalizeTheme(DEFAULT_THEME)
  applyThemeToPage(page, theme)
  return Promise.resolve(theme)
}

module.exports = {
  ENABLE_REMOTE_THEME,
  DEFAULT_THEME,
  normalizeTheme,
  buildThemeStyle,
  buildThemeStyles,
  buildThemeData,
  fetchCurrentTheme,
  getCachedTheme,
  setCachedTheme,
  isThemeChanged,
  applyRuntimeTheme,
  clearThemeCache,
  loadCurrentTheme,
  applyTheme
}
