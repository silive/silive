const { authHeader, request, uploadFileWithFallback } = require("../../utils/api")
const { applyTheme } = require("../../utils/theme")
const { isPromotionEnabled, isReviewMode, isStoreFeaturesEnabled } = require("../../utils/review")
const { copyText } = require("../../utils/privacy")

const STORE_IDENTITY_CACHE_KEY = "storeIdentityCache"
const STORE_IDENTITY_CACHE_TTL = 5 * 60 * 1000

function readStoreIdentityCache() {
  try {
    const cache = wx.getStorageSync(STORE_IDENTITY_CACHE_KEY)
    if (!cache || !cache.checkedAt || Date.now() - Number(cache.checkedAt || 0) > STORE_IDENTITY_CACHE_TTL) {
      if (cache) console.log("[store-identity-expired]", { hasCache: true })
      return null
    }
    return cache
  } catch (error) {
    return null
  }
}

function writeStoreIdentityCache(payload = {}) {
  try {
    wx.setStorageSync(STORE_IDENTITY_CACHE_KEY, {
      isStoreOwner: !!payload.isStoreOwner,
      storeId: payload.storeId || "",
      storeName: payload.storeName || "",
      checkedAt: Date.now()
    })
  } catch (error) {}
}

function clearStoreIdentityCache() {
  try {
    wx.removeStorageSync(STORE_IDENTITY_CACHE_KEY)
  } catch (error) {}
}

Page({
  data: {
    userInfo: {},
    loggedIn: false,
    memberPhone: "",
    maskedPhone: "",
    loginVisible: false,
    loginLoading: false,
    shoppingMoney: "0.00",
    pendingReward: "0.00",
    estimatedReward: "0.00",
    actualPayable: "0.00",
    themeStyle: "",
    themeClass: "theme-skin01",
    orderCount: 0,
    afterSaleDot: true,
    contact: {
      phone: "",
      wechat: "",
      workWechatUrl: "",
      workWechatId: "",
      showWorkWechat: "true",
      showPhone: "true",
      showWechat: "true"
    },
    banner: null,
    storeChecked: false,
    storeBound: false,
    isStoreManager: false,
    isStoreOwner: false,
    identityLoading: false,
    storeIdentityReady: false,
    storeInfo: null,
    storeStats: null,
    storeConflictMessage: "",
    reviewMode: isReviewMode(),
    promotionEnabled: isPromotionEnabled(),
    storeFeaturesEnabled: isStoreFeaturesEnabled()
  },

  onShow() {
    applyTheme(this)
    this.refreshLoginState()
    this.loadContact()
    if (this.data.loggedIn) {
      this.loadAuthenticatedProfile()
      return
    }
    this.loadPromotionSummary()
    this.loadOrderSummary()
    this.loadStoreMe()
  },

  onPullDownRefresh() {
    this.refreshLoginState()
    const tasks = [Promise.resolve(this.loadContact())]
    if (this.data.loggedIn) {
      tasks.push(this.loadAuthenticatedProfile())
    } else {
      tasks.push(
        Promise.resolve(this.loadPromotionSummary()),
        Promise.resolve(this.loadOrderSummary()),
        Promise.resolve(this.loadStoreMe())
      )
    }
    Promise.all(tasks).finally(() => wx.stopPullDownRefresh())
  },

  loadAuthenticatedProfile() {
    const { ensureAuthenticated, clearExpiredLoginState } = require("../../utils/auth")
    return ensureAuthenticated({ source: "profile" }).then(() => {
      this.refreshLoginState()
      return Promise.all([
        Promise.resolve(this.loadPromotionSummary()),
        Promise.resolve(this.loadOrderSummary()),
        Promise.resolve(this.loadStoreMe()),
        Promise.resolve(this.loadUserProfile())
      ])
    }).catch(error => {
      const isAuthFailure = Number(error.statusCode || 0) === 401 ||
        /请先.*登录|登录状态.*过期|登录已过期|授权手机号|会话已过期/.test(error.message || "")
      if (isAuthFailure) {
        clearExpiredLoginState()
        clearStoreIdentityCache()
        this.refreshLoginState()
        this.loadPromotionSummary()
        this.loadOrderSummary()
        this.loadStoreMe()
      }
      wx.showToast({
        title: isAuthFailure ? "登录状态已过期，请重新登录" : "个人信息加载失败，请稍后重试",
        icon: "none"
      })
      console.warn("[profile-identity-error]", {
        statusCode: error.statusCode || 0,
        reason: error.message || "authentication failed"
      })
    })
  },

  refreshLoginState() {
    const { getLoginState } = require("../../utils/auth")
    const state = getLoginState()
    const memberAvatar = wx.getStorageSync("memberAvatar") || ""
    const ownerCache = state.loggedIn ? readStoreIdentityCache() : null
    const userInfo = {
      ...(this.data.userInfo || {}),
      avatarUrl: memberAvatar || this.data.userInfo.avatarUrl || "",
      nickName: wx.getStorageSync("memberName") || this.data.userInfo.nickName || ""
    }
    this.setData({
      loggedIn: state.loggedIn,
      userInfo,
      memberPhone: state.phone,
      maskedPhone: this.maskPhone(state.phone),
      storeChecked: !state.loggedIn,
      identityLoading: !!state.loggedIn,
      storeIdentityReady: !state.loggedIn || !!(ownerCache && ownerCache.isStoreOwner),
      storeBound: state.loggedIn ? !!(ownerCache && ownerCache.isStoreOwner) : false,
      isStoreManager: state.loggedIn ? !!(ownerCache && ownerCache.isStoreOwner) : false,
      isStoreOwner: state.loggedIn ? !!(ownerCache && ownerCache.isStoreOwner) : false,
      storeInfo: state.loggedIn && ownerCache && ownerCache.isStoreOwner ? { id: ownerCache.storeId, name: ownerCache.storeName } : null,
      storeStats: state.loggedIn ? this.data.storeStats : null,
      storeConflictMessage: state.loggedIn ? this.data.storeConflictMessage : ""
    })
  },

  maskPhone(phone) {
    const value = String(phone || "")
    if (value.length !== 11) return value
    return `${value.slice(0, 3)}****${value.slice(7)}`
  },

  getUserProfile() {
    wx.getUserProfile({
      desc: "用于展示会员头像昵称",
      success: res => {
        this.setData({ userInfo: res.userInfo })
        if (res.userInfo.nickName) wx.setStorageSync("memberName", res.userInfo.nickName)
      },
      fail: () => {
        wx.showToast({ title: "未授权，可继续浏览", icon: "none" })
      }
    })
  },

  loadUserProfile() {
    if (!this.data.loggedIn) return
    request("/api/user/profile")
      .then(profile => {
        const avatarUrl = profile.avatarUrl || wx.getStorageSync("memberAvatar") || ""
        const nickName = profile.nickname || wx.getStorageSync("memberName") || this.data.userInfo.nickName || ""
        if (profile.avatarUrl) wx.setStorageSync("memberAvatar", profile.avatarUrl)
        if (profile.nickname) wx.setStorageSync("memberName", profile.nickname)
        this.setData({
          userInfo: {
            ...(this.data.userInfo || {}),
            avatarUrl,
            nickName
          }
        })
      })
      .catch(error => {
        console.warn("[profile] load user profile failed:", error.message || error)
        if (error.statusCode === 401 || /登录|授权/.test(error.message || "")) {
          const { clearExpiredLoginState } = require("../../utils/auth")
          clearExpiredLoginState()
          this.refreshLoginState()
        }
      })
  },

  saveUserProfile(profile = {}) {
    return request("/api/user/profile", {
      method: "POST",
      data: {
        avatarUrl: profile.avatarUrl || "",
        nickname: profile.nickName || profile.nickname || wx.getStorageSync("memberName") || "用户"
      }
    })
  },

  uploadAvatarIfNeeded(avatarUrl) {
    if (/^https?:\/\//.test(avatarUrl)) return Promise.resolve(avatarUrl)
    return uploadFileWithFallback("/api/upload/public", {
      filePath: avatarUrl,
      name: "file",
      header: authHeader(),
      formData: { type: "avatar" }
    }).then(data => data.url || data.data?.url || "")
  },

  onChooseAvatar(event) {
    const avatarUrl = event.detail && event.detail.avatarUrl
    if (!avatarUrl) {
      wx.showToast({ title: "未选择头像", icon: "none" })
      return
    }
    const userInfo = {
      ...(this.data.userInfo || {}),
      avatarUrl
    }
    this.setData({ userInfo })
    wx.setStorageSync("memberAvatar", avatarUrl)
    const app = getApp()
    app.globalData = app.globalData || {}
    app.globalData.userInfo = {
      ...(app.globalData.userInfo || {}),
      avatarUrl
    }
    wx.showLoading({ title: "保存头像" })
    this.uploadAvatarIfNeeded(avatarUrl)
      .then(remoteUrl => {
        if (!remoteUrl) throw new Error("头像上传失败")
        wx.setStorageSync("memberAvatar", remoteUrl)
        const nextUserInfo = { ...(this.data.userInfo || {}), avatarUrl: remoteUrl }
        this.setData({ userInfo: nextUserInfo })
        app.globalData.userInfo = { ...(app.globalData.userInfo || {}), avatarUrl: remoteUrl }
        return this.saveUserProfile({ avatarUrl: remoteUrl, nickName: nextUserInfo.nickName })
      })
      .then(() => wx.showToast({ title: "头像已保存", icon: "success" }))
      .catch(error => wx.showToast({ title: error.message || "头像保存失败", icon: "none" }))
      .finally(() => wx.hideLoading())
  },

  showLoginSheet() {
    this.setData({ loginVisible: true })
  },

  closeLoginSheet() {
    this.setData({ loginVisible: false })
  },

  onLoginPhone(event) {
    const { loginWithPhoneDetail } = require("../../utils/auth")
    this.setData({ loginLoading: true })
    loginWithPhoneDetail(event.detail || {}).then(state => {
      this.setData({
        loggedIn: true,
        memberPhone: state.phone,
        maskedPhone: this.maskPhone(state.phone),
        loginVisible: false,
        storeChecked: false,
        storeBound: false,
        isStoreManager: false,
        isStoreOwner: false,
        identityLoading: true,
        storeIdentityReady: false,
        storeInfo: null,
        storeStats: null
      })
      wx.showToast({ title: "登录成功", icon: "success" })
      this.loadAuthenticatedProfile()
    }).catch(error => {
      if (error.isAuthDenied) {
        wx.showToast({ title: "未授权手机号", icon: "none" })
        return
      }
      wx.showModal({
        title: "登录失败",
        content: error.message || "登录失败，请稍后重试",
        showCancel: false
      })
    }).finally(() => {
      this.setData({ loginLoading: false })
    })
  },

  requireLogin() {
    if (this.data.loggedIn) return true
    wx.showToast({ title: "请先登录", icon: "none" })
    return false
  },

  goOrders() {
    if (!this.requireLogin()) return
    wx.switchTab({ url: "/pages/orders/orders" })
  },

  goPromotion() {
    if (!this.data.promotionEnabled) {
      wx.showToast({ title: "该功能暂未开放", icon: "none" })
      return
    }
    if (!this.data.loggedIn) {
      this.showLoginSheet()
      return
    }
    wx.navigateTo({ url: "/pages/promotion/promotion" })
  },

  loadPromotionSummary() {
    const phone = wx.getStorageSync("memberPhone")
    if (!phone) {
      this.setData({ shoppingMoney: "0.00", pendingReward: "0.00", estimatedReward: "0.00", actualPayable: "0.00" })
      return
    }
    request("/api/promotion/summary")
      .then(data => {
        this.setData({
          shoppingMoney: data.profile?.settledTotal || data.profile?.shoppingMoney || "0.00",
          pendingReward: data.profile?.payableTotal || data.profile?.pendingReward || "0.00",
          estimatedReward: data.profile?.estimatedTotal || "0.00",
          actualPayable: data.profile?.actualPayable || data.profile?.pendingReward || "0.00"
        })
      })
      .catch(() => {})
  },

  loadContact() {
    request("/api/help-center")
      .then(data => {
        const profileAd = data.profileBottomAd || data.ads?.profile_bottom_ad || null
        this.setData({
          contact: data.contact || this.data.contact,
          banner: profileAd && String(profileAd.enabled) !== "false" ? {
            ...profileAd,
            desc: profileAd.desc || profileAd.subtitle || "",
            targetType: profileAd.targetType || profileAd.linkType,
            targetValue: profileAd.targetValue || profileAd.linkValue
          } : null
        })
      })
      .catch(() => {})
  },

  loadOrderSummary() {
    const { getLoginState } = require("../../utils/auth")
    const loginState = getLoginState()
    if (!loginState.loggedIn) {
      this.setData({ orderCount: 0 })
      return
    }
    return request("/api/orders")
      .then(orders => {
        this.setData({ orderCount: Array.isArray(orders) ? orders.length : 0 })
      })
      .catch(error => {
        console.warn("[profile] load order summary failed:", error.message || error)
        if (error.statusCode === 401 || /登录|授权/.test(error.message || "")) {
          const { clearExpiredLoginState } = require("../../utils/auth")
          clearExpiredLoginState()
          this.refreshLoginState()
        }
        this.setData({ orderCount: 0 })
      })
  },

  loadStoreMe() {
    if (!this.data.storeFeaturesEnabled) {
      this.setData({ storeChecked: true, identityLoading: false, storeIdentityReady: true, storeBound: false, isStoreManager: false, isStoreOwner: false, storeInfo: null, storeStats: null, storeConflictMessage: "" })
      return
    }
    if (!this.data.loggedIn) {
      clearStoreIdentityCache()
      this.setData({ storeChecked: true, identityLoading: false, storeIdentityReady: true, storeBound: false, isStoreManager: false, isStoreOwner: false, storeInfo: null, storeStats: null })
      return
    }
    const { getLoginState, clearExpiredLoginState } = require("../../utils/auth")
    const loginState = getLoginState()
    console.log("[profile-identity-check]", {
      hasToken: !!loginState.hasToken,
      hasPhone: !!loginState.hasPhone
    })
    this.setData({ storeChecked: false, identityLoading: true, storeIdentityReady: false, storeConflictMessage: "" })
    const { request } = require("../../utils/api")
    return request("/api/store/me")
      .then(data => {
        console.log("[store-identity-result]", {
          hasUserSession: !!wx.getStorageSync("userSession"),
          ok: data.ok !== false,
          bound: !!data.bound,
          storeBound: !!data.storeBound,
          hasStoreId: !!data.storeId,
          error: data.error || "",
          message: data.message || "",
          debugStatus: data.debugStatus || ""
        })
        const levelMap = { display: "展示点", pickup: "自提点", supplier: "供货点", partner: "合伙点" }
        const storeInfo = data.storeInfo
          ? { ...data.storeInfo, levelText: levelMap[data.storeInfo.level] || data.storeInfo.level || "门店" }
          : null
        const isStoreManager = !!(
          data.bound ||
          data.storeBound ||
          data.storeId ||
          storeInfo?.id ||
          /manager|owner|负责人|店长/.test(String(data.role || data.storeRole || storeInfo?.storeRole || storeInfo?.role || ""))
        )
        if (isStoreManager) {
          writeStoreIdentityCache({
            isStoreOwner: true,
            storeId: data.storeId || storeInfo?.id || "",
            storeName: storeInfo?.name || ""
          })
        } else {
          clearStoreIdentityCache()
        }
        this.setData({
          storeChecked: true,
          identityLoading: false,
          storeIdentityReady: true,
          storeBound: !!(data.bound || data.storeBound || data.storeId || storeInfo?.id),
          isStoreManager,
          isStoreOwner: isStoreManager,
          storeInfo,
          storeStats: data.stats || null,
          storeConflictMessage: data.error || ""
        })
        if (data.error) wx.showToast({ title: data.error, icon: "none" })
      })
      .catch(error => {
        console.warn("[store-identity-error]", {
          statusCode: error.statusCode || 0,
          message: error.message || "unknown"
        })
        if (error.statusCode === 401 || /登录|授权/.test(error.message || "")) {
          clearExpiredLoginState()
          clearStoreIdentityCache()
          this.refreshLoginState()
          wx.showToast({ title: "登录状态已过期，请重新登录", icon: "none" })
          return
        }
        clearStoreIdentityCache()
        this.setData({
          storeChecked: false,
          identityLoading: false,
          storeIdentityReady: false,
          storeBound: false,
          isStoreManager: false,
          isStoreOwner: false,
          storeInfo: null,
          storeStats: null,
          storeConflictMessage: "门店身份暂时无法确认"
        })
      })
  },

  goStoreCenter() {
    if (!this.data.storeFeaturesEnabled) {
      wx.showToast({ title: "该功能暂未开放", icon: "none" })
      return
    }
    if (!this.requireLogin()) return
    wx.navigateTo({ url: "/pages/store/center/center" })
  },

  contact() {
    if (!this.requireLogin()) return
    const contact = this.data.contact || {}
    const actions = []
    if (String(contact.showWorkWechat) !== "false") actions.push({ key: "workWechat", label: "联系客服" })
    if (String(contact.showPhone) !== "false") actions.push({ key: "phone", label: "电话联系" })
    if (String(contact.showWechat) !== "false") actions.push({ key: "wechat", label: "复制客服号" })
    if (!actions.length) {
      wx.showToast({ title: "客服入口暂未开放", icon: "none" })
      return
    }
    wx.showActionSheet({
      itemList: actions.map(item => item.label),
      success: res => {
        const action = actions[res.tapIndex]
        if (!action) return
        if (action.key === "workWechat") {
          if (contact.workWechatUrl && contact.workWechatUrl.indexOf("/") === 0) {
            wx.navigateTo({ url: contact.workWechatUrl })
            return
          }
          wx.showModal({
            title: "联系客服",
            content: contact.workWechatId || contact.workWechatUrl || "暂未配置客服",
            showCancel: false
          })
        }
        if (action.key === "phone") {
          if (contact.phone) wx.makePhoneCall({ phoneNumber: contact.phone })
          else wx.showToast({ title: "暂未设置电话", icon: "none" })
        }
        if (action.key === "wechat") {
          if (contact.wechat) copyText(contact.wechat)
          else wx.showToast({ title: "暂未设置客服号", icon: "none" })
        }
      }
    })
  },

  goHelp() {
    wx.navigateTo({ url: "/pages/help/help" })
  },

  openBanner() {
    this.handleTarget(this.data.banner)
  },

  handleTarget(entry) {
    if (!entry) return
    const type = entry.targetType || entry.linkType || "none"
    const value = entry.targetValue || entry.linkValue || ""
    if (type === "none") return
    if (type === "service" || type === "contact") {
      wx.showToast({ title: "请点击联系客服按钮", icon: "none" })
      return
    }
    if (type === "secondary") {
      const parts = value.split("/")
      wx.navigateTo({ url: `/pages/category/list?primary=${encodeURIComponent(parts[0] || "")}&secondary=${encodeURIComponent(parts[1] || "全部")}` })
      return
    }
    if (type === "product") {
      wx.navigateTo({ url: `/pages/product/detail?id=${encodeURIComponent(value)}` })
      return
    }
    if (type === "productList") {
      wx.navigateTo({ url: `/pages/category/list?ids=${encodeURIComponent(value)}&primary=${encodeURIComponent(entry.title || "精选商品")}` })
      return
    }
    if (type === "poster") {
      wx.navigateTo({ url: `/pages/poster/poster?title=${encodeURIComponent(entry.title || "活动海报")}&image=${encodeURIComponent(entry.imageUrl || "")}` })
      return
    }
    if (type === "custom" || type === "page" || type === "web") {
      if (value.indexOf("/") === 0) wx.navigateTo({ url: value })
      else wx.showModal({ title: entry.title || "链接", content: value || "暂未配置链接", showCancel: false })
      return
    }
    wx.navigateTo({ url: `/pages/category/list?primary=${encodeURIComponent(value || entry.title || "")}` })
  }
})
