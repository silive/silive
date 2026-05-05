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
    wx.setStorageSync("memberPhone", phone)
    if (res.openid) wx.setStorageSync("openid", res.openid)
    const token = res.token || res.userSession || ""
    if (token) {
      wx.setStorageSync("userSession", token)
      wx.setStorageSync("userToken", token)
    }
    const state = {
      ...getLoginState(),
      loggedIn: true,
      phone,
      openid: res.openid || wx.getStorageSync("openid") || "",
      userSession: token || wx.getStorageSync("userSession") || ""
    }
    const app = getApp()
    app.globalData = app.globalData || {}
    app.globalData.userInfo = {
      ...(app.globalData.userInfo || {}),
      phone,
      openid: state.openid,
      userSession: state.userSession
    }
    const readyState = state.openid && state.userSession
      ? Promise.resolve(state)
      : ensureOpenid().then(() => ({
          ...getLoginState(),
          loggedIn: true,
          phone
        }))
    return readyState.then(nextState => bindStoredPromotionRelation(wx.getStorageSync("memberName") || "微信用户").then(() => nextState))
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
  bindStoredPromotionRelation,
  logout
}
