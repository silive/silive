const { checkApiConnectivity, request, getActiveApiHost, apiUrl, authHeader } = require("./api")

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
          reject(new Error("微信登录失败"))
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

function wxLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: loginRes => {
        console.log("[login] wx.login", {
          errMsg: loginRes.errMsg,
          hasLoginCode: !!loginRes.code
        })
        if (!loginRes.code) {
          reject(new Error("微信登录失败：未返回 loginCode"))
          return
        }
        resolve(loginRes.code)
      },
      fail: error => {
        console.log("[login] wx.login", {
          errMsg: error && error.errMsg,
          hasLoginCode: false
        })
        reject(new Error("微信登录失败：未返回 loginCode"))
      }
    })
  })
}

function phoneCodeMissingError(detail = {}) {
  const error = new Error(`手机号授权失败：微信未返回手机号 code\nerrMsg: ${detail.errMsg || ""}\nerrno: ${detail.errno || ""}`)
  error.isPhoneCodeMissing = true
  return error
}

function requestPhoneLogin(phoneCode, loginCode) {
  const url = apiUrl("/api/wechat/phone", getActiveApiHost())
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
        reject(new Error(`登录失败：${data.message || `HTTP ${res.statusCode}`}`))
      },
      fail: error => {
        console.log("[login] phone login response", {
          statusCode: 0,
          ok: false,
          message: error && error.errMsg,
          hasPhoneNumber: false,
          hasOpenid: false,
          hasUserSession: false,
          hasUserToken: false
        })
        reject(new Error(`登录失败：${(error && error.errMsg) || "接口连接失败"}`))
      }
    })
  })
}

function bindStoredPromotionRelation(name = "微信用户") {
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

function loginWithPhoneDetail(detail = {}) {
  logLoginDebug("before phone login")
  const errMsg = String(detail.errMsg || "")
  if (errMsg && !/ok/i.test(errMsg)) return Promise.reject(phoneCodeMissingError(detail))
  if (!detail.code) return Promise.reject(phoneCodeMissingError(detail))

  return checkApiConnectivity().then(status => {
    if (!status.ok) {
      throw new Error(`${status.message} 当前检测：${status.results.map(item => `${item.host}=${item.message}`).join("；")}`)
    }
    return wxLoginCode()
  }).then(loginCode => requestPhoneLogin(detail.code, loginCode)).then(res => {
    const phone = res.phoneNumber || ""
    if (!phone) throw new Error("获取手机号失败")
    const openid = res.openid || ""
    const token = res.token || res.userSession || ""
    if (!openid || !token) {
      clearIncompleteLoginState()
      throw new Error("登录信息不完整，请重新授权")
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
    return bindStoredPromotionRelation(wx.getStorageSync("memberName") || "微信用户")
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
  bindStoredPromotionRelation,
  logout
}
