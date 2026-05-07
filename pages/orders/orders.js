const { request, uploadFileWithFallback } = require("../../utils/api")
const { getLoginState, loginWithPhoneDetail } = require("../../utils/auth")
const { applyTheme } = require("../../utils/theme")

const BADGE_TEXT = {
  new: "新品推荐",
  hot: "人气热卖",
  best: "爆品推荐",
  none: ""
}

const STATUS_TABS = [
  { key: "unpaid", label: "待付款", icon: "¥", row: "top" },
  { key: "design", label: "待确认", icon: "✓", row: "top" },
  { key: "receiving", label: "待收货", icon: "↗", row: "top" },
  { key: "afterSale", label: "售后", icon: "!", row: "bottom" },
  { key: "all", label: "全部订单", icon: "≡", row: "bottom" }
]

function displayStatus(order) {
  if (order.refundStatus === "待审核" || order.status === "退款中") return "退款中"
  if (order.status === "已退款" || order.paymentStatus === "已退款" || order.refundStatus === "退款成功" || order.refundStatus === "部分退款成功") return "已退款"
  if (order.paymentStatus === "待支付" || order.status === "待支付") return "未支付"
  if (order.deliveryType === "pickup" && order.pickupStatus === "arrived_store") return "已到店，待自提"
  if (order.deliveryType === "pickup" && order.pickupStatus === "picked_up") return "已自提"
  if (order.deliveryType === "pickup" && order.pickupStatus === "preparing") return "备货中"
  if (order.status === "待发货") return "待确认设计"
  return order.status || "待发货"
}

function normalizeProduct(product) {
  return {
    ...product,
    categories: Array.isArray(product.categories) ? product.categories : [],
    badgeText: BADGE_TEXT[product.badge] || product.badge || ""
  }
}

function normalizeOrder(order, products = []) {
  const product = products.find(item => item.id === order.productId || item.name === order.productName) || {}
  return {
    ...order,
    productImage: product.imageUrl || order.originalImageUrl || "",
    productIntro: product.intro || "",
    product,
    categories: Array.isArray(product.categories) ? product.categories : [],
    displayStatus: displayStatus(order),
    pickupLine: order.deliveryType === "pickup" && order.pickupStore ? `${order.pickupStore.name} · 取货码 ${order.pickupCode || "-"}` : "",
    pickupTip: order.deliveryType === "pickup"
      ? (order.pickupStatus === "arrived_store" ? "请凭取货码到店领取" : order.pickupStatus === "picked_up" ? "订单已完成自提" : "商品到店后，我们会通知你到店自提")
      : "",
    refundLine: order.refundStatus ? `${order.refundStatus}${order.refundAmount ? ` · ¥${order.refundAmount}` : ""}` : "",
    canRefund: ["待确认设计", "待发货", "已发货", "已完成"].includes(displayStatus(order))
  }
}

function statusMatches(order, key) {
  if (key === "all") return true
  if (key === "unpaid") return order.displayStatus === "未支付"
  if (key === "receiving") return order.displayStatus === "已发货"
  if (key === "design") return ["待确认设计", "待发货", "制作中"].includes(order.displayStatus)
  if (key === "afterSale") return ["退款中", "已退款"].includes(order.displayStatus) || !!order.refundStatus
  return true
}

function buildRecommendations(products, orders) {
  const orderedIds = new Set(orders.map(order => order.productId).filter(Boolean))
  const historyCategories = new Set(orders.flatMap(order => order.categories || []))
  const scored = products
    .filter(product => product.status !== "off")
    .map(product => {
      const sameCategory = product.categories.some(category => historyCategories.has(category) || Array.from(historyCategories).some(item => category.startsWith(`${item}/`) || item.startsWith(`${category}/`)))
      let score = 0
      if (sameCategory) score += 8
      if (String(product.promotionHot) === "true") score += 5
      if (product.badge === "best") score += 4
      if (product.badge === "hot") score += 3
      if (!orderedIds.has(product.id)) score += 1
      return { ...product, recommendReason: sameCategory ? "同类推荐" : product.badgeText || "热卖精选", score }
    })
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, 8)
}

function buildStatusTabs(orders) {
  return STATUS_TABS.map(tab => ({
    ...tab,
    count: orders.filter(order => statusMatches(order, tab.key)).length
  }))
}

function getUserIdentity() {
  const userId = wx.getStorageSync("localUserId") || ""
  const userToken = wx.getStorageSync("userToken") || userId || ""
  const openid = wx.getStorageSync("openid") || ""
  const userSession = wx.getStorageSync("userSession") || ""
  return { userId, userToken, openid, userSession }
}

Page({
  data: {
    orders: [],
    products: [],
    statusTabs: buildStatusTabs([]),
    statusTabsTop: buildStatusTabs([]).filter(item => item.row === "top"),
    statusTabsBottom: buildStatusTabs([]).filter(item => item.row === "bottom"),
    activeStatus: "all",
    recentOrders: [],
    recommendations: [],
    themeStyle: "",
    themeClass: "theme-skin01",
    loggedIn: false,
    loginVisible: false,
    loginLoading: false,
    loading: true,
    refundVisible: false,
    refundOrder: null,
    refundForm: {
      refundType: "仅退款",
      refundReason: "",
      refundAmount: "",
      refundRemark: "",
      refundImageUrl: ""
    },
    submittingRefund: false
  },

  onShow() {
    applyTheme(this)
    const loginState = getLoginState()
    this.setData({ loggedIn: loginState.loggedIn })
    this.loadPage()
  },

  loadPage() {
    const loginState = getLoginState()
    const identity = getUserIdentity()
    const query = loginState.loggedIn && (identity.userSession || identity.openid || identity.userId || identity.userToken)
      ? `?userSession=${encodeURIComponent(identity.userSession)}&openid=${encodeURIComponent(identity.openid)}&userId=${encodeURIComponent(identity.userId)}&userToken=${encodeURIComponent(identity.userToken)}`
      : ""
    Promise.all([
      loginState.loggedIn ? request(`/api/orders${query}`) : Promise.resolve([]),
      request("/api/products")
    ]).then(([orders, products]) => {
      const normalizedProducts = products.map(normalizeProduct)
      const normalizedOrders = orders.map(order => normalizeOrder(order, normalizedProducts))
      const statusTabs = buildStatusTabs(normalizedOrders)
      this.setData({
        orders: normalizedOrders,
        products: normalizedProducts,
        statusTabs,
        statusTabsTop: statusTabs.filter(item => item.row === "top"),
        statusTabsBottom: statusTabs.filter(item => item.row === "bottom"),
        recommendations: buildRecommendations(normalizedProducts, normalizedOrders),
        loading: false
      })
      this.refreshRecentOrders()
    }).catch(() => {
      this.setData({ loading: false })
    })
  },

  showLoginSheet() {
    this.setData({ loginVisible: true })
  },

  closeLoginSheet() {
    this.setData({ loginVisible: false })
  },

  onLoginPhone(event) {
    this.setData({ loginLoading: true })
    loginWithPhoneDetail(event.detail || {}).then(() => {
      this.setData({ loggedIn: true, loginVisible: false })
      wx.showToast({ title: "登录成功", icon: "success" })
      this.loadPage()
    }).catch(error => {
      if (error.isAuthDenied) {
        wx.showToast({ title: "未授权手机号", icon: "none" })
        return
      }
      wx.showModal({
        title: error.visibleDebugMessage ? "登录调试信息" : "登录接口异常",
        content: error.visibleDebugMessage || error.message || "登录失败，请检查API域名和网络",
        showCancel: false
      })
    }).finally(() => {
      this.setData({ loginLoading: false })
    })
  },

  switchStatus(event) {
    const activeStatus = event.currentTarget.dataset.key
    this.setData({ activeStatus })
    this.refreshRecentOrders(activeStatus)
  },

  refreshRecentOrders(nextStatus) {
    const activeStatus = nextStatus || this.data.activeStatus
    this.setData({
      recentOrders: this.data.orders.filter(order => statusMatches(order, activeStatus)).slice(0, 3)
    })
  },

  openOrderProduct(event) {
    const order = this.data.recentOrders[event.currentTarget.dataset.index]
    if (!order) return
    if (order.productId) {
      wx.navigateTo({ url: `/pages/product/detail?id=${encodeURIComponent(order.productId)}` })
      return
    }
    wx.showToast({ title: "商品已下架，可联系客服", icon: "none" })
  },

  reorder(event) {
    const order = this.data.recentOrders[event.currentTarget.dataset.index]
    const product = order && order.product
    if (!product || !product.id) {
      wx.showToast({ title: "商品已下架，可联系客服", icon: "none" })
      return
    }
    wx.navigateTo({
      url: `/pages/checkout/checkout?product=${encodeURIComponent(JSON.stringify(product))}`
    })
  },

  openRecommendProduct(event) {
    const product = this.data.recommendations[event.currentTarget.dataset.index]
    if (!product) return
    this.trackRecommend("click", product)
    wx.navigateTo({
      url: `/pages/product/detail?id=${encodeURIComponent(product.id)}&source=order-recommendation`
    })
  },

  trackRecommend(type, product) {
    request("/api/order-recommendation/event", {
      method: "POST",
      data: {
        type,
        productId: product.id,
        productName: product.name,
        phone: wx.getStorageSync("memberPhone") || "",
        page: "orders"
      }
    }).catch(() => {})
  },

  openRefund(event) {
    if (!this.data.loggedIn) {
      wx.showToast({ title: "请先登录", icon: "none" })
      return
    }
    const order = this.data.recentOrders[event.currentTarget.dataset.index]
    this.setData({
      refundVisible: true,
      refundOrder: order,
      refundForm: {
        refundType: event.currentTarget.dataset.type || "仅退款",
        refundReason: "",
        refundAmount: order.amount,
        refundRemark: "",
        refundImageUrl: ""
      }
    })
  },

  closeRefund() {
    this.setData({ refundVisible: false, refundOrder: null })
  },

  onRefundInput(event) {
    const field = event.currentTarget.dataset.field
    this.setData({ [`refundForm.${field}`]: event.detail.value })
  },

  chooseRefundImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: res => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file) return
        if (file.size && file.size > 10 * 1024 * 1024) {
          wx.showToast({ title: "图片超过10MB，请压缩后上传", icon: "none" })
          return
        }
        wx.showLoading({ title: "上传中" })
        uploadFileWithFallback("/api/upload/public", {
          filePath: file.tempFilePath,
          name: "file"
        }).then(data => {
            wx.hideLoading()
            if (!data.ok || !data.url) {
              wx.showToast({ title: data.message || "上传失败，请重试", icon: "none" })
              return
            }
            this.setData({ "refundForm.refundImageUrl": data.url })
          }).catch(error => {
            wx.hideLoading()
            wx.showToast({ title: error.message || "上传失败，请重试", icon: "none" })
          })
      }
    })
  },

  submitRefund() {
    const { refundReason, refundAmount } = this.data.refundForm
    if (!refundReason || !refundAmount) {
      wx.showToast({ title: "请填写退款原因和金额", icon: "none" })
      return
    }
    this.setData({ submittingRefund: true })
    request("/api/orders/refund", {
      method: "POST",
      data: {
        orderId: this.data.refundOrder.id,
        ...getUserIdentity(),
        ...this.data.refundForm
      }
    }).then(() => {
      wx.showToast({ title: "已提交退款申请", icon: "success" })
      this.closeRefund()
      this.loadPage()
    }).catch(error => {
      wx.showToast({ title: error.message || "提交失败", icon: "none" })
    }).finally(() => {
      this.setData({ submittingRefund: false })
    })
  }
})
