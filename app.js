const { checkApiConnectivity, request } = require("./utils/api")
const { loadCurrentTheme } = require("./utils/theme")

App({
  globalData: {
    brandName: "非常智造"
  },

  onLaunch(options = {}) {
    this.ensureLocalUserId()
    this.captureInvite(options)
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
    this.captureInvite(options)
    const riskTip = wx.getStorageSync("inviteRiskTip")
    if (riskTip) {
      wx.removeStorageSync("inviteRiskTip")
      wx.showToast({ title: riskTip, icon: "none" })
    }
  },

  ensureLocalUserId() {
    let id = wx.getStorageSync("localUserId")
    if (!id) {
      id = `U${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`
      wx.setStorageSync("localUserId", id)
    }
    return id
  },

  captureInvite(options = {}) {
    const query = options.query || {}
    const scene = decodeURIComponent(query.scene || "")
    const storeId = decodeURIComponent(query.store_id || query.storeId || (scene.match(/(?:^|&)store_id=([^&]+)/) || [])[1] || "")
    if (storeId && !wx.getStorageSync("referrerStoreId")) {
      wx.setStorageSync("referrerStoreId", storeId)
      wx.setStorageSync("referrerStoreBoundAt", Date.now())
    }
    const invite = decodeURIComponent(query.invite || query.inviterCode || "")
    if (!invite) return
    const localUserId = this.ensureLocalUserId()
    const ownInvite = wx.getStorageSync("profileInviteCode") || localUserId
    if (invite === localUserId || invite === ownInvite) {
      wx.setStorageSync("inviteRiskTip", "不能邀请自己")
      return
    }
    const bound = wx.getStorageSync("boundInviterCode") || wx.getStorageSync("inviterCode")
    if (bound && bound !== invite) {
      wx.setStorageSync("inviteRiskTip", "同设备已绑定邀请关系，不能重复绑定")
      return
    }
    if (!bound) {
      wx.setStorageSync("boundInviterCode", invite)
      wx.setStorageSync("inviterCode", invite)
      wx.setStorageSync("inviteBoundAt", Date.now())
      request("/api/promotion/visit", {
        method: "POST",
        data: { invite, visitorId: localUserId },
        timeout: 5000
      }).catch(() => {})
    }
  }
})
