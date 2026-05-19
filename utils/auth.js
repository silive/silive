const { checkApiConnectivity, request, getActiveApiHost, apiUrl, authHeader } = require("./api")
const { isStoreFeaturesEnabled } = require("./review")

function getLoginState() {
  const userSession = wx.getStorageSync("userSession") || ""
  const openid = wx.getStorageSync("openid") || ""
  const phone = wx.getStorageSync("memberPhone") || ""
  return {
    loggedIn: !!(userSession && openid && phone),
    userSession,
    openid,
    phone,
    name: wx.getStorageSync("memberName") || ""
  }
}

function maskValue(value) {
  const text = String(value || "")
  if (!text) return "empty"
  if (text.length <= 7) return `${text.slice(0, 2)}***`
  return `${text.slice(0, 3)}***${text.slice(-4)}`
}

function readLoginDebugState() {
  const app = getApp()
  const userInfo = app.globalData && app.globalData.userInfo
  return {
    memberPhone: maskValue(wx.getStorageSync("memberPhone") || ""),
    openid: maskValue(wx.getStorageSync("openid") || ""),
    userSession: maskValue(wx.getStorageSync("userSession") || ""),
    userToken: maskValue(wx.getStorageSync("userToken") || ""),
    globalDataUserInfo: userInfo ? {
      phone: maskValue(userInfo.phone || ""),
      openid: maskValue(userInfo.openid || ""),
      userSession: maskValue(userInfo.userSession || "")
    } : null,
    storeInfo: wx.getStorageSync("storeInfo") ? "exists" : "empty"
  }
}

function logLoginDebug(label) {
  console.log(`[auth] ${label}`, readLoginDebugState())
}

function stringifyDebugValue(value) {
  if (value === undefined || value === null || value === "") return "-"
  if (typeof value === "boolean") return value ? "true" : "false"
  return String(value)
}

function buildVisibleLoginDebug(debugInfo = {}) {
  const lines = [
    ["step", debugInfo.step],
    ["getPhoneNumber errMsg", debugInfo.errMsg],
    ["errno", debugInfo.errno],
    ["hasPhoneCode", debugInfo.hasPhoneCode],
    ["wx.login errMsg", debugInfo.wxLoginErrMsg],
    ["hasLoginCode", debugInfo.hasLoginCode],
    ["requestUrl", debugInfo.requestUrl],
    ["statusCode", debugInfo.statusCode],
    ["message", debugInfo.message],
    ["errcode", debugInfo.errcode],
    ["hasPhoneNumber", debugInfo.hasPhoneNumber],
    ["hasOpenid", debugInfo.hasOpenid],
    ["hasUserSession", debugInfo.hasUserSession],
    ["hasUserToken", debugInfo.hasUserToken]
  ]
  return lines.map(([label, value]) => `${label}: ${stringifyDebugValue(value)}`).join("\n")
}

function clearIncompleteLoginState() {
  const userSession = wx.getStorageSync("userSession") || ""
  const openid = wx.getStorageSync("openid") || ""
  const phone = wx.getStorageSync("memberPhone") || ""
  if (userSession && openid && phone) return
  wx.removeStorageSync("memberPhone")
  wx.removeStorageSync("openid")
  wx.removeStorageSync("userSession")
  wx.removeStorageSync("userToken")
  const app = getApp()
  if (app.globalData) app.globalData.userInfo = null
}

function ensureOpenid() {
  const cachedOpenid = wx.getStorageSync("openid") || ""
  const cachedSession = wx.getStorageSync("userSession") || ""
  if (cachedOpenid && cachedSession) return Promise.resolve(cachedOpenid)
  return new Promise((resolve, reject) => {
    wx.login({
      success: loginRes => {
        if (!loginRes.code) {
          reject(new Error("手机号快捷登录失败"))
          return
        }
        request("/api/wechat/openid", {
          method: "POST",
          data: { code: loginRes.code }
        }).then(res => {
          if (res.userSession) wx.setStorageSync("userSession", res.userSession)
          if (res.openid) wx.setStorageSync("openid", res.openid)
          resolve(res.openid || "")
        }).catch(reject)
      },
      fail: reject
    })
  })
}

function wxLoginCode(debugInfo = {}) {
  return new Promise((resolve, reject) => {
    wx.login({
      success: loginRes => {
        debugInfo.step = "wx.login"
        debugInfo.wxLoginErrMsg = loginRes.errMsg || ""
        debugInfo.hasLoginCode = !!loginRes.code
        console.log("[login] wx.login", {
          errMsg: loginRes.errMsg,
          hasLoginCode: !!loginRes.code
        })
        if (!loginRes.code) {
          const error = new Error("手机号快捷登录失败：未返回 loginCode")
          error.loginDebugInfo = debugInfo
          reject(error)
          return
        }
        resolve(loginRes.code)
      },
      fail: error => {
        debugInfo.step = "wx.login"
        debugInfo.wxLoginErrMsg = error && error.errMsg || ""
        debugInfo.hasLoginCode = false
        console.log("[login] wx.login", {
          errMsg: error && error.errMsg,
          hasLoginCode: false
        })
        const nextError = new Error("手机号快捷登录失败：未返回 loginCode")
        nextError.loginDebugInfo = debugInfo
        reject(nextError)
      }
    })
  })
}

function phoneCodeMissingError(detail = {}, debugInfo = {}) {
  debugInfo.step = "getPhoneNumber"
  debugInfo.errMsg = detail.errMsg || ""
  debugInfo.errno = detail.errno
  debugInfo.hasPhoneCode = !!detail.code
  const error = new Error("手机号授权失败，请重新尝试")
  error.isPhoneCodeMissing = true
  error.loginDebugInfo = debugInfo
  return error
}

function requestPhoneLogin(phoneCode, loginCode, debugInfo = {}) {
  const url = apiUrl("/api/wechat/phone", getActiveApiHost())
  debugInfo.step = "requestPhoneLogin"
  debugInfo.requestUrl = url
  debugInfo.hasPhoneCode = !!phoneCode
  debugInfo.hasLoginCode = !!loginCode
  console.log("[login] request phone login", {
    url,
    hasPhoneCode: !!phoneCode,
    hasLoginCode: !!loginCode
  })
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: "POST",
      data: {
        code: phoneCode,
        loginCode
      },
      header: authHeader(),
      timeout: 12000,
      success: res => {
        const data = res.data || {}
        debugInfo.step = "phoneLoginResponse"
        debugInfo.statusCode = res.statusCode
        debugInfo.ok = data && data.ok
        debugInfo.message = data && data.message
        debugInfo.errcode = data && data.errcode
        debugInfo.hasPhoneNumber = !!(data && data.phoneNumber)
        debugInfo.hasOpenid = !!(data && data.openid)
        debugInfo.hasUserSession = !!(data && data.userSession)
        debugInfo.hasUserToken = !!(data && data.userToken)
        console.log("[login] phone login response", {
          statusCode: res.statusCode,
          ok: data && data.ok,
          message: data && data.message,
          errcode: data && data.errcode,
          hasPhoneNumber: !!(data && data.phoneNumber),
          hasOpenid: !!(data && data.openid),
          hasUserSession: !!(data && data.userSession),
          hasUserToken: !!(data && data.userToken)
        })
        if (res.statusCode >= 200 && res.statusCode < 300 && data.ok !== false) {
          resolve(data.data !== undefined ? data.data : data)
          return
        }
        const error = new Error(`登录失败：${data.message || `HTTP ${res.statusCode}`}`)
        error.loginDebugInfo = debugInfo
        reject(error)
      },
      fail: error => {
        debugInfo.step = "phoneLoginResponse"
        debugInfo.statusCode = 0
        debugInfo.ok = false
        debugInfo.message = error && error.errMsg || "接口连接失败"
        debugInfo.hasPhoneNumber = false
        debugInfo.hasOpenid = false
        debugInfo.hasUserSession = false
        debugInfo.hasUserToken = false
        console.log("[login] phone login response", {
          statusCode: 0,
          ok: false,
          message: error && error.errMsg,
          hasPhoneNumber: false,
          hasOpenid: false,
          hasUserSession: false,
          hasUserToken: false
        })
        const nextError = new Error(`登录失败：${(error && error.errMsg) || "接口连接失败"}`)
        nextError.loginDebugInfo = debugInfo
        reject(nextError)
      }
    })
  })
}

function bindStoredPromotionRelation(name = "用户") {
  const storeId = wx.getStorageSync("referrerStoreId") || wx.getStorageSync("pendingReferrerStoreId") || ""
  const storeExpireAt = Number(wx.getStorageSync("referrerStoreExpireAt") || 0)
  if (isStoreFeaturesEnabled() && storeId && storeExpireAt && Date.now() <= storeExpireAt) return Promise.resolve(null)
  const inviterCode = wx.getStorageSync("boundInviterCode") || wx.getStorageSync("inviterCode") || ""
  if (!inviterCode) return Promise.resolve(null)
  return request("/api/promotion/bind", {
    method: "POST",
    data: {
      inviterCode,
      name
    }
  }).catch(error => {
    console.warn("[promotion] bind failed:", error.message || error)
    return null
  })
}

function syncStoredStoreReferrer() {
  if (!isStoreFeaturesEnabled()) return Promise.resolve(null)
  const storeId = wx.getStorageSync("referrerStoreId") || wx.getStorageSync("pendingReferrerStoreId") || ""
  const expireAt = Number(wx.getStorageSync("referrerStoreExpireAt") || 0)
  if (!storeId) return Promise.resolve(null)
  if (!expireAt || Date.now() > expireAt) {
    wx.removeStorageSync("pendingReferrerStoreId")
    wx.removeStorageSync("boundReferrerStoreId")
    wx.removeStorageSync("referrerStoreId")
    wx.removeStorageSync("referrerStoreBoundAt")
    wx.removeStorageSync("referrerStoreExpireAt")
    return Promise.resolve(null)
  }
  return request(`/api/store/source/validate?storeId=${encodeURIComponent(storeId)}`, { timeout: 5000 })
    .then(data => {
      if (!data.valid) {
        wx.removeStorageSync("pendingReferrerStoreId")
        wx.removeStorageSync("boundReferrerStoreId")
        wx.removeStorageSync("referrerStoreId")
        wx.removeStorageSync("referrerStoreBoundAt")
        wx.removeStorageSync("referrerStoreExpireAt")
        return null
      }
      wx.setStorageSync("referrerStoreId", storeId)
      wx.setStorageSync("boundReferrerStoreId", storeId)
      return data.store || null
    })
    .catch(error => {
      console.warn("[store-referrer] sync failed:", error.message || error)
      return null
    })
}

function loginWithPhoneDetail(detail = {}) {
  logLoginDebug("before phone login")
  const debugInfo = {
    step: "getPhoneNumber",
    errMsg: detail.errMsg || "",
    errno: detail.errno,
    hasPhoneCode: !!detail.code
  }
  const errMsg = String(detail.errMsg || "")
  if (errMsg && !/ok/i.test(errMsg)) return Promise.reject(phoneCodeMissingError(detail, debugInfo))
  if (!detail.code) return Promise.reject(phoneCodeMissingError(detail, debugInfo))

  return checkApiConnectivity().then(status => {
    if (!status.ok) {
      debugInfo.step = "apiConnectivity"
      debugInfo.message = `${status.message} 当前检测：${status.results.map(item => `${item.host}=${item.message}`).join("；")}`
      const error = new Error(debugInfo.message)
      error.loginDebugInfo = debugInfo
      throw error
    }
    return wxLoginCode(debugInfo)
  }).then(loginCode => requestPhoneLogin(detail.code, loginCode, debugInfo)).then(res => {
    const phone = res.phoneNumber || ""
    if (!phone) {
      const error = new Error("获取手机号失败")
      debugInfo.message = error.message
      error.loginDebugInfo = debugInfo
      throw error
    }
    const openid = res.openid || ""
    const token = res.token || res.userSession || ""
    if (!openid || !token) {
      clearIncompleteLoginState()
      const error = new Error("登录信息不完整，请重新授权")
      debugInfo.message = error.message
      error.loginDebugInfo = debugInfo
      throw error
    }
    wx.setStorageSync("memberPhone", phone)
    wx.setStorageSync("openid", openid)
    wx.setStorageSync("userSession", token)
    wx.setStorageSync("userToken", token)
    const state = {
      ...getLoginState(),
      loggedIn: true,
      phone,
      openid,
      userSession: token
    }
    const app = getApp()
    app.globalData = app.globalData || {}
    app.globalData.userInfo = {
      ...(app.globalData.userInfo || {}),
      phone,
      openid: state.openid,
      userSession: state.userSession
    }
    logLoginDebug("after phone login saved")
    return syncStoredStoreReferrer()
      .then(() => bindStoredPromotionRelation(wx.getStorageSync("memberName") || "用户"))
      .catch(error => {
        console.warn("[auth] post-login promotion sync failed:", error.message || error)
        return null
      })
      .then(() => state)
  }).catch(error => {
    if (!error.isAuthDenied && !error.isPhoneCodeMissing) {
      console.warn("[auth] phone login failed:", error.message || error)
      clearIncompleteLoginState()
      logLoginDebug("after phone login failed")
    }
    throw error
  })
}

function logout() {
  wx.removeStorageSync("memberPhone")
  wx.removeStorageSync("memberName")
  wx.removeStorageSync("openid")
  wx.removeStorageSync("userSession")
  wx.removeStorageSync("userToken")
  const app = getApp()
  if (app.globalData) app.globalData.userInfo = null
}

module.exports = {
  getLoginState,
  ensureOpenid,
  loginWithPhoneDetail,
  clearIncompleteLoginState,
  buildVisibleLoginDebug,
  bindStoredPromotionRelation,
  logout
}
