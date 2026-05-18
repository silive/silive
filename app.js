const { checkApiConnectivity, request } = require("./utils/api")
const { loadCurrentTheme } = require("./utils/theme")
const { REVIEW_MODE } = require("./utils/review")
const STORE_REFERRAL_TTL_MS = 30 * 24 * 60 * 60 * 1000
const REFERRAL_CONTEXT_KEY = "referralContext"
const REFERRAL_DEDUPE_MS = 5000
const REFERRAL_TOAST_DEDUPE_MS = 3000

function safeDecode(value = "") {
  let text = String(value || "")
  for (let i = 0; i < 3; i += 1) {
    try {
      const decoded = decodeURIComponent(text)
      if (decoded === text) break
      text = decoded
    } catch (error) {
      break
    }
  }
  return text
}

function readStorage(key, fallback = "") {
  try {
    const value = wx.getStorageSync(key)
    return value == null || value === "" ? fallback : value
  } catch (error) {
    return fallback
  }
}

function writeStorage(key, value) {
  try {
    wx.setStorageSync(key, value)
  } catch (error) {}
}

function removeStorage(key) {
  try {
    wx.removeStorageSync(key)
  } catch (error) {}
}

function parseQueryText(text = {}) {
  const params = {}
  if (!text) return params
  if (typeof text === "object") {
    Object.keys(text).forEach(key => {
      if (text[key] !== undefined && text[key] !== null && text[key] !== "") params[key] = safeDecode(text[key])
    })
    return params
  }
  const raw = safeDecode(text)
  const query = raw.includes("?") ? raw.split("?").slice(1).join("?") : raw
  query.split("&").forEach(part => {
    const [key, ...rest] = part.split("=")
    if (!key) return
    params[safeDecode(key)] = safeDecode(rest.join("="))
  })
  return params
}

function looksLikePickupCode(value = "") {
  return /^[A-Z0-9]{6}$/.test(String(value || "").trim().toUpperCase())
}

function normalizeReferralCode(value = "") {
  return String(value || "").trim().replace(/[^\w-]/g, "").slice(0, 64)
}

function robustParseScene(options = {}) {
  try {
    const query = { ...(options.query || {}) }
    Object.keys(options || {}).forEach(key => {
      if (key !== "query" && query[key] === undefined) query[key] = options[key]
    })
    const rawScene = safeDecode(query.scene || "")
    const parsed = {
      invite: "",
      storeId: "",
      storeCode: "",
      rawScene,
      path: options.path || query.path || "",
      rawQuery: query
    }
    const params = {
      ...parseQueryText(query),
      ...parseQueryText(rawScene)
    }
    const nested = params.scene || params.q || ""
    if (nested) Object.assign(params, parseQueryText(nested))
    const storeValue = params.store_id || params.storeId || params.referrerStoreId || ""
    const inviteValue = params.invite || params.inviterCode || ""
    const codeValue = params.code || params.s || ""
    if (storeValue) parsed.storeId = normalizeReferralCode(storeValue)
    if (inviteValue) parsed.invite = normalizeReferralCode(inviteValue)
    const code = normalizeReferralCode(codeValue)
    if (!parsed.storeId && code && /^(STORE_|ST)/i.test(code)) {
      parsed.storeId = code
      parsed.storeCode = code
    } else if (!parsed.invite && code && /^VS/i.test(code)) {
      parsed.invite = code
    } else if (!parsed.invite && !parsed.storeId && code && !looksLikePickupCode(code)) {
      parsed.invite = code
    }
    const pure = normalizeReferralCode(rawScene)
    if (!parsed.storeId && /^(STORE_|ST)/i.test(pure)) {
      parsed.storeId = pure
      parsed.storeCode = pure
    } else if (!parsed.invite && /^VS/i.test(pure)) {
      parsed.invite = pure
    }
    console.log("[referral-scene-parse]", {
      source: options.source || "",
      hasInvite: !!parsed.invite,
      hasStoreId: !!parsed.storeId,
      hasRawScene: !!rawScene
    })
    return parsed
  } catch (error) {
    console.warn("[referral-scene-parse]", { source: options.source || "", error: error.message || "parse_failed" })
    return { invite: "", storeId: "", storeCode: "", rawScene: "", path: "", rawQuery: {} }
  }
}

App({
  globalData: {
    brandName: "非常智造",
    reviewMode: REVIEW_MODE
  },

  onLaunch(options = {}) {
    this.ensureLocalUserId()
    this.handleReferralScene(options, "launch")
    loadCurrentTheme().then(theme => {
      this.globalData.theme = theme
    })
    checkApiConnectivity().then(status => {
      this.globalData.apiConnectivity = status
      if (!status.ok) wx.setStorageSync("lastApiConnectivityError", status.message || "API连接失败")
    }).catch(error => {
      wx.setStorageSync("lastApiConnectivityError", error.message || "API连接失败")
    })
  },

  onShow(options = {}) {
    this.ensureLocalUserId()
    this.handleReferralScene(options, "show")
    const riskTip = wx.getStorageSync("inviteRiskTip")
    if (riskTip) {
      removeStorage("inviteRiskTip")
      this.showReferralToast(riskTip)
    }
  },

  getReferralContext() {
    const current = readStorage(REFERRAL_CONTEXT_KEY, null)
    const context = current && typeof current === "object" ? current : {}
    const legacyStoreId = readStorage("referrerStoreId") || readStorage("pendingReferrerStoreId") || readStorage("boundReferrerStoreId")
    const legacyBoundAt = Number(readStorage("referrerStoreBoundAt") || 0)
    const legacyExpireAt = Number(readStorage("referrerStoreExpireAt") || 0)
    const legacyInvite = readStorage("boundInviterCode") || readStorage("inviterCode")
    let migrated = false
    if (legacyStoreId && !context.storeReferral?.storeId) {
      context.storeReferral = {
        storeId: legacyStoreId,
        storeCode: "",
        boundAt: legacyBoundAt || Date.now(),
        expiresAt: legacyExpireAt || Date.now() + STORE_REFERRAL_TTL_MS,
        source: "legacy",
        rawScene: "",
        lastVisitAt: 0
      }
      migrated = true
    }
    if (legacyInvite && !context.personalInvite?.inviteCode) {
      context.personalInvite = {
        inviteCode: legacyInvite,
        boundAt: Number(readStorage("inviteBoundAt") || 0) || Date.now(),
        source: "legacy",
        rawScene: ""
      }
      migrated = true
    }
    if (migrated) {
      writeStorage(REFERRAL_CONTEXT_KEY, context)
      console.log("[referral-context-migrate]", {
        hasInvite: !!context.personalInvite?.inviteCode,
        hasStoreId: !!context.storeReferral?.storeId
      })
    }
    return context
  },

  saveReferralContext(context = {}) {
    writeStorage(REFERRAL_CONTEXT_KEY, context)
    return context
  },

  referralKey(parsed = {}) {
    return [parsed.path || "", parsed.rawScene || "", parsed.invite || "", parsed.storeId || ""].join("|")
  },

  shouldSkipReferral(parsed = {}) {
    const key = this.referralKey(parsed)
    const now = Date.now()
    if (!key.replace(/\|/g, "")) return { skip: true, key, reason: "empty" }
    if (this.lastReferralKey === key && now - Number(this.lastReferralHandledAt || 0) < REFERRAL_DEDUPE_MS) {
      return { skip: true, key, reason: "duplicate" }
    }
    this.lastReferralKey = key
    this.lastReferralHandledAt = now
    return { skip: false, key, reason: "" }
  },

  showReferralToast(message) {
    const now = Date.now()
    if (!message) return
    if (this.lastReferralToast === message && now - Number(this.lastReferralToastAt || 0) < REFERRAL_TOAST_DEDUPE_MS) return
    this.lastReferralToast = message
    this.lastReferralToastAt = now
    setTimeout(() => wx.showToast({ title: message, icon: "none" }), 300)
  },

  handleReferralScene(options = {}, source = "page-load") {
    if (REVIEW_MODE) {
      console.log("[review-mode] referral disabled", { source })
      return
    }
    const parsed = robustParseScene({ ...(options || {}), source })
    const skip = this.shouldSkipReferral(parsed)
    if (skip.skip) {
      console.log("[referral-handle-skip]", { source, skipReason: skip.reason, hasInvite: !!parsed.invite, hasStoreId: !!parsed.storeId })
      return
    }
    const context = this.getReferralContext()
    context.lastScene = { rawScene: parsed.rawScene || "", parsedAt: Date.now(), source }
    this.saveReferralContext(context)
    if (parsed.storeId) {
      this.captureStoreReferrer(parsed.storeId, { source, rawScene: parsed.rawScene, storeCode: parsed.storeCode })
      return
    }
    if (this.getValidReferrerStoreId()) {
      console.log("[referral-handle-skip]", { source, skipReason: "store_referrer_active", hasInvite: !!parsed.invite, hasStoreId: false })
      return
    }
    if (parsed.invite) this.capturePersonalInvite(parsed.invite, { source, rawScene: parsed.rawScene })
  },

  captureInvite(options = {}) {
    this.handleReferralScene(options, "page-load")
  },

  ensureLocalUserId() {
    let id = readStorage("localUserId")
    if (!id) {
      id = `U${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`
      writeStorage("localUserId", id)
    }
    return id
  },

  capturePersonalInvite(invite, meta = {}) {
    if (!invite) return
    const localUserId = this.ensureLocalUserId()
    const ownInvite = readStorage("profileInviteCode") || localUserId
    if (invite === localUserId || invite === ownInvite) {
      writeStorage("inviteRiskTip", "不能邀请自己")
      this.showReferralToast("不能邀请自己")
      return
    }
    const context = this.getReferralContext()
    const bound = context.personalInvite?.inviteCode || readStorage("boundInviterCode") || readStorage("inviterCode")
    if (bound && bound !== invite) {
      writeStorage("inviteRiskTip", "同设备已绑定邀请关系，不能重复绑定")
      this.showReferralToast("同设备已绑定邀请关系，不能重复绑定")
      return
    }
    if (!bound) {
      context.personalInvite = {
        inviteCode: invite,
        boundAt: Date.now(),
        source: meta.source || "",
        rawScene: meta.rawScene || ""
      }
      this.saveReferralContext(context)
      writeStorage("boundInviterCode", invite)
      writeStorage("inviterCode", invite)
      writeStorage("inviteBoundAt", Date.now())
      this.recordPromotionVisitThenBind(invite, localUserId, meta)
    }
  },

  recordPromotionVisitThenBind(invite, localUserId, meta = {}) {
    const shouldBind = !!(readStorage("memberPhone") && readStorage("userSession"))
    console.log("[referral-visit]", { source: meta.source || "", hasInvite: !!invite, shouldBind })
    return request("/api/promotion/visit", {
      method: "POST",
      data: { invite, visitorId: localUserId },
      timeout: 5000
    }).then(() => {
      console.log("[referral-visit]", { source: meta.source || "", ok: true, shouldBind })
      return null
    }).catch(error => {
      console.warn("[referral-visit]", { source: meta.source || "", ok: false, message: error.message || "visit_failed", shouldBind })
      return null
    }).then(() => {
      if (!shouldBind) return null
      console.log("[referral-bind]", { source: meta.source || "", hasInvite: !!invite, shouldBind: true })
      return request("/api/promotion/bind", {
        method: "POST",
        data: { inviterCode: invite, name: readStorage("memberName") || "微信用户" },
        timeout: 5000
      }).then(() => {
        console.log("[referral-bind]", { source: meta.source || "", ok: true })
        return null
      }).catch(error => {
        console.warn("[referral-bind]", { source: meta.source || "", ok: false, message: error.message || "bind_failed" })
        return null
      })
    })
  },

  captureStoreReferrer(storeId, meta = {}) {
    const now = Date.now()
    const expireAt = now + STORE_REFERRAL_TTL_MS
    const context = this.getReferralContext()
    context.storeReferral = {
      storeId,
      storeCode: meta.storeCode || "",
      boundAt: now,
      expiresAt: expireAt,
      source: meta.source || "",
      rawScene: meta.rawScene || "",
      lastVisitAt: now
    }
    this.saveReferralContext(context)
    writeStorage("pendingReferrerStoreId", storeId)
    writeStorage("boundReferrerStoreId", storeId)
    writeStorage("referrerStoreId", storeId)
    writeStorage("referrerStoreBoundAt", now)
    writeStorage("referrerStoreExpireAt", expireAt)
    request(`/api/store/source/validate?storeId=${encodeURIComponent(storeId)}`, { timeout: 5000 })
      .then(data => {
        if (!data.valid && this.getValidReferrerStoreId() === storeId) this.clearStoreReferrer()
      })
      .catch(error => console.warn("[store-referrer] validate failed", { source: meta.source || "", message: error.message || "validate_failed" }))
  },

  clearStoreReferrer() {
    const context = this.getReferralContext()
    delete context.storeReferral
    this.saveReferralContext(context)
    removeStorage("pendingReferrerStoreId")
    removeStorage("boundReferrerStoreId")
    removeStorage("referrerStoreId")
    removeStorage("referrerStoreBoundAt")
    removeStorage("referrerStoreExpireAt")
  },

  getReferrerStoreMeta() {
    const context = this.getReferralContext()
    const store = context.storeReferral || {}
    const storeId = this.getValidReferrerStoreId()
    if (!storeId) return { referrerStoreId: "", referrerStoreBoundAt: "", referrerStoreExpireAt: "" }
    return {
      referrerStoreId: storeId,
      referrerStoreBoundAt: store.boundAt || readStorage("referrerStoreBoundAt") || "",
      referrerStoreExpireAt: store.expiresAt || readStorage("referrerStoreExpireAt") || ""
    }
  },

  getValidReferrerStoreId() {
    const context = this.getReferralContext()
    const store = context.storeReferral || {}
    const storeId = store.storeId || readStorage("referrerStoreId") || ""
    const expireAt = Number(store.expiresAt || readStorage("referrerStoreExpireAt") || 0)
    if (!storeId) return ""
    if (!expireAt || Date.now() > expireAt) {
      this.clearStoreReferrer()
      return ""
    }
    return storeId
  }
})
