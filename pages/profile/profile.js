const { applyTheme } = require("../../utils/theme")

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
    themeStyle: "",
    themeClass: "theme-skin01",
    pendingPayCount: 0,
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
    storeBound: false,
    storeInfo: null,
    storeStats: null
  },

  onShow() {
    applyTheme(this)
    this.refreshLoginState()
    this.loadContact()
    this.loadPromotionSummary()
    this.loadOrderSummary()
    this.loadStoreMe()
  },

  refreshLoginState() {
    const { getLoginState } = require("../../utils/auth")
    const state = getLoginState()
    this.setData({
      loggedIn: state.loggedIn,
      memberPhone: state.phone,
      maskedPhone: this.maskPhone(state.phone)
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
        loginVisible: false
      })
      wx.showToast({ title: "登录成功", icon: "success" })
      this.loadPromotionSummary()
      this.loadOrderSummary()
      this.loadStoreMe()
    }).catch(error => {
      if (error.isAuthDenied) {
        wx.showToast({ title: "未授权手机号", icon: "none" })
        return
      }
      wx.showModal({
        title: "登录接口异常",
        content: error.message || "登录失败，请检查API域名和网络",
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
    if (!this.requireLogin()) return
    wx.navigateTo({ url: "/pages/promotion/promotion" })
  },

  loadPromotionSummary() {
    const phone = wx.getStorageSync("memberPhone")
    if (!phone) {
      this.setData({ shoppingMoney: "0.00", pendingReward: "0.00" })
      return
    }
    const { request } = require("../../utils/api")
    request(`/api/promotion/summary?phone=${encodeURIComponent(phone)}`)
      .then(data => {
        this.setData({
          shoppingMoney: data.profile?.shoppingMoney || "0.00",
          pendingReward: data.profile?.pendingReward || "0.00"
        })
      })
      .catch(() => {})
  },

  loadContact() {
    const { request } = require("../../utils/api")
    request("/api/help-center")
      .then(data => {
        this.setData({
          contact: data.contact || this.data.contact,
          banner: data.profileBanner || null
        })
      })
      .catch(() => {})
  },

  loadOrderSummary() {
    const { request } = require("../../utils/api")
    const { getLoginState } = require("../../utils/auth")
    const loginState = getLoginState()
    const userId = wx.getStorageSync("localUserId") || ""
    const userToken = wx.getStorageSync("userToken") || userId || ""
    const openid = wx.getStorageSync("openid") || ""
    const userSession = wx.getStorageSync("userSession") || ""
    if (!loginState.loggedIn || (!userId && !userToken && !openid && !userSession)) {
      this.setData({ pendingPayCount: 0 })
      return
    }
    request(`/api/orders?userSession=${encodeURIComponent(userSession)}&openid=${encodeURIComponent(openid)}&userId=${encodeURIComponent(userId)}&userToken=${encodeURIComponent(userToken)}`)
      .then(orders => {
        const pendingPayCount = (orders || []).filter(order => order.paymentStatus === "待支付" || order.status === "待支付").length
        this.setData({ pendingPayCount })
      })
      .catch(() => {
        this.setData({ pendingPayCount: 0 })
      })
  },

  loadStoreMe() {
    if (!this.data.loggedIn) {
      this.setData({ storeBound: false, storeInfo: null, storeStats: null })
      return
    }
    const { request } = require("../../utils/api")
    request("/api/store/me")
      .then(data => {
        const levelMap = { display: "展示点", pickup: "自提点", supplier: "供货点", partner: "合伙点" }
        const storeInfo = data.storeInfo
          ? { ...data.storeInfo, levelText: levelMap[data.storeInfo.level] || data.storeInfo.level || "门店" }
          : null
        this.setData({
          storeBound: !!data.bound,
          storeInfo,
          storeStats: data.stats || null
        })
      })
      .catch(() => {
        this.setData({ storeBound: false, storeInfo: null, storeStats: null })
      })
  },

  goStoreCenter() {
    if (!this.requireLogin()) return
    wx.navigateTo({ url: "/pages/store/center/center" })
  },

  chooseAddress() {
    if (!this.requireLogin()) return
    wx.chooseAddress({
      fail: () => wx.showToast({ title: "未选择地址", icon: "none" })
    })
  },

  contact() {
    if (!this.requireLogin()) return
    const contact = this.data.contact || {}
    const actions = []
    if (String(contact.showWorkWechat) !== "false") actions.push({ key: "workWechat", label: "在线客服（企业微信）" })
    if (String(contact.showPhone) !== "false") actions.push({ key: "phone", label: "电话联系" })
    if (String(contact.showWechat) !== "false") actions.push({ key: "wechat", label: "复制微信号" })
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
            title: "在线客服（企业微信）",
            content: contact.workWechatId || contact.workWechatUrl || "暂未配置企业微信客服",
            showCancel: false
          })
        }
        if (action.key === "phone") {
          if (contact.phone) wx.makePhoneCall({ phoneNumber: contact.phone })
          else wx.showToast({ title: "暂未设置电话", icon: "none" })
        }
        if (action.key === "wechat") {
          if (contact.wechat) wx.setClipboardData({ data: contact.wechat })
          else wx.showToast({ title: "暂未设置微信号", icon: "none" })
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
    const value = entry.targetValue || ""
    if (entry.targetType === "service") {
      this.contact()
      return
    }
    if (entry.targetType === "secondary") {
      const parts = value.split("/")
      wx.navigateTo({ url: `/pages/category/list?primary=${encodeURIComponent(parts[0] || "")}&secondary=${encodeURIComponent(parts[1] || "全部")}` })
      return
    }
    if (entry.targetType === "product") {
      wx.navigateTo({ url: `/pages/product/detail?id=${encodeURIComponent(value)}` })
      return
    }
    if (entry.targetType === "productList") {
      wx.navigateTo({ url: `/pages/category/list?ids=${encodeURIComponent(value)}&primary=${encodeURIComponent(entry.title || "精选商品")}` })
      return
    }
    if (entry.targetType === "poster") {
      wx.navigateTo({ url: `/pages/poster/poster?title=${encodeURIComponent(entry.title || "活动海报")}&image=${encodeURIComponent(entry.imageUrl || "")}` })
      return
    }
    if (entry.targetType === "custom") {
      if (value.indexOf("/") === 0) wx.navigateTo({ url: value })
      else wx.showModal({ title: entry.title || "链接", content: value || "暂未配置链接", showCancel: false })
      return
    }
    wx.navigateTo({ url: `/pages/category/list?primary=${encodeURIComponent(value || entry.title || "")}` })
  }
})
