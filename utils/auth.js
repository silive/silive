const { checkApiConnectivity, request } = require("./api")

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
        if (!loginRes.code) {
          reject(new Error("微信登录失败，请重试"))
          return
        }
        resolve(loginRes.code)
      },
      fail: () => reject(new Error("微信登录失败，请重试"))
    })
  })
}

function unauthorizedPhoneError() {
  const error = new Error("未授权手机号")
  error.isAuthDenied = true
  return error
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
  if (errMsg && !/ok/i.test(errMsg)) return Promise.reject(unauthorizedPhoneError())
  if (!detail.code) return Promise.reject(unauthorizedPhoneError())

  return checkApiConnectivity().then(status => {
    if (!status.ok) {
      throw new Error(`${status.message} 当前检测：${status.results.map(item => `${item.host}=${item.message}`).join("；")}`)
    }
    return wxLoginCode()
  }).then(loginCode => request("/api/wechat/phone", {
      method: "POST",
      data: {
        code: detail.code,
        loginCode
      }
    })).then(res => {
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
    if (!error.isAuthDenied) {
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
