const { request, uploadFileWithFallback } = require("../../utils/api")
const { ensureOpenid, getLoginState, loginWithPhoneDetail } = require("../../utils/auth")
const { applyTheme } = require("../../utils/theme")
const { isReviewMode } = require("../../utils/review")

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

const ORDER_PAGE_SIZE = 10

function pickImage(...values) {
  return values.find(value => !!value) || ""
}

function getProductListImage(product = {}) {
  return pickImage(
    product.cartThumbUrl,
    product.cart_thumb_url,
    product.thumbUrl,
    product.thumb_url,
    product.listImage,
    product.list_image,
    product.optimizedUrl,
    product.optimized_url,
    product.imageUrl,
    product.image_url
  )
}

function getOrderProductImage(order = {}, product = {}) {
  return pickImage(
    order.cartThumbUrl,
    order.cart_thumb_url,
    order.thumbUrl,
    order.thumb_url,
    order.listImage,
    order.list_image,
    order.optimizedUrl,
    order.optimized_url,
    order.productImage,
    order.imageUrl,
    order.image_url,
    getProductListImage(product)
  )
}

function afterSalesStatus(order) {
  const raw = order.afterSalesStatus || order.after_sales_status || ""
  const map = {
    requested: "requested",
    approved: "requested",
    refund_pending: "refund_pending",
    rejected: "rejected",
    refunded: "refunded",
    remake: "remake",
    reship: "reship",
    "待审核": "requested",
    "售后处理中": "requested",
    "退款处理中": "refund_pending",
    "售后已拒绝": "rejected",
    "已拒绝": "rejected",
    "退款成功": "refunded",
    "已退款": "refunded",
    "重新制作中": "remake",
    "补发处理中": "reship"
  }
  return map[String(raw || order.refundStatus || "").trim()] || "none"
}

function afterSalesText(order) {
  return order.afterSalesText || ({
    requested: "售后处理中",
    rejected: "售后已拒绝",
    refund_pending: "退款处理中",
    refunded: "已退款",
    remake: "重新制作中",
    reship: "补发处理中",
    none: ""
  })[afterSalesStatus(order)] || ""
}

function afterSalesRejectReason(order = {}) {
  return order.afterSalesRejectReason ||
    order.after_sales_reject_reason ||
    order.rejectReason ||
    order.refundRejectReason ||
    "请联系客服了解详情"
}

function displayStatus(order) {
  const status = order.status || "待发货"
  if (isQuoteOrder(order)) return "待报价"
  const afterStatus = afterSalesStatus(order)
  if (afterStatus === "requested") return "售后处理中"
  if (afterStatus === "rejected") return "售后已拒绝"
  if (afterStatus === "refund_pending") return "退款处理中"
  if (afterStatus === "refunded") return "已退款"
  if (afterStatus === "remake") return "重新制作中"
  if (afterStatus === "reship") return "补发处理中"
  if (isRefunded(order)) return "已退款"
  if (isRefunding(order)) return "退款中"
  if (isUnpaid(order)) return "未支付"
  if (status === "制作中") return "制作中"
  if (status === "已完成" || order.pickupStatus === "picked_up") return order.deliveryType === "pickup" ? "已自提" : "已完成"
  if (order.deliveryType === "pickup") {
    if (status === "已发货" || order.pickupStatus === "arrived_store") return "待自提"
    if (status === "待发货" || order.pickupStatus === "preparing") return "待确认"
    return status
  }
  if (status === "待发货") return "待发货"
  if (status === "已发货") return "待收货"
  return status
}

function isUnpaid(order) {
  return order.paymentStatus === "待支付" || order.paymentStatus === "未支付" || order.status === "待支付"
}

function isQuoteOrder(order) {
  return order.paymentStatus === "待报价" || order.status === "待客服确认" || order.priceMode === "quote"
}

function isPaid(order) {
  return !isUnpaid(order) && (order.paymentStatus === "已支付" || !!order.paidAt || !!order.transactionId || !order.paymentStatus)
}

function isStrictPaid(order = {}) {
  const status = String(order.paymentStatus || order.payment_status || order.payStatus || order.pay_status || "").trim().toLowerCase()
  return order.isPaid === true ||
    ["已支付", "paid", "success", "支付成功"].includes(status) ||
    !!order.paidAt ||
    !!order.paid_at ||
    !!order.transactionId ||
    !!order.transaction_id
}

function canShowPickupCode(order = {}) {
  const pickup = order.deliveryType === "pickup" ||
    order.delivery_type === "pickup" ||
    !!order.pickupStoreId ||
    !!order.pickup_store_id
  const code = order.pickupCode || order.pickup_code
  return isStrictPaid(order) && pickup && !!code
}

function isRefunding(order) {
  return ["requested", "refund_pending", "remake", "reship"].includes(afterSalesStatus(order)) ||
    ["待审核", "售后处理中", "退款处理中", "补发处理中", "重新制作中"].includes(order.refundStatus) ||
    order.status === "退款中"
}

function isRefunded(order) {
  return afterSalesStatus(order) === "refunded" || order.status === "已退款" || order.paymentStatus === "已退款" || order.refundStatus === "退款成功" || order.refundStatus === "部分退款成功"
}

function isCompletedWithinAfterSaleWindow(order) {
  if (!["已完成", "已自提"].includes(displayStatus(order))) return false
  const source = order.completedAt || order.pickedUpAt || order.paidAt || order.createdAt
  const time = source ? new Date(String(source).replace(/-/g, "/")).getTime() : 0
  return !!time && Date.now() - time <= 7 * 24 * 60 * 60 * 1000
}

function canApplyAfterSales(order) {
  if (!isPaid(order) || isQuoteOrder(order) || isUnpaid(order) || isRefunded(order) || isRefunding(order)) return false
  if (afterSalesStatus(order) === "rejected") return canReapplyAfterSales(order)
  const display = displayStatus(order)
  if (["待收货", "待自提", "制作中", "待确认"].includes(display)) return true
  return isCompletedWithinAfterSaleWindow(order)
}

function canReapplyAfterSales(order) {
  if (afterSalesStatus(order) !== "rejected") return false
  const applyCount = Number(order.afterSalesApplyCount || order.after_sales_apply_count || 0)
  return applyCount < 2 && isPaid(order) && !isQuoteOrder(order) && !isUnpaid(order) && !isRefunded(order)
}

function normalizeProduct(product) {
  return {
    ...product,
    categories: Array.isArray(product.categories) ? product.categories : [],
    badgeText: BADGE_TEXT[product.badge] || product.badge || "",
    displayImage: getProductListImage(product)
  }
}

function normalizeOrder(order, products = []) {
  const product = products.find(item => item.id === order.productId || item.name === order.productName) || {}
  const detailProductId = resolveOrderProductId(order, product)
  const display = displayStatus(order)
  const quote = isQuoteOrder(order)
  return {
    ...order,
    productImage: getOrderProductImage(order, product),
    productIntro: product.intro || "",
    product,
    detailProductId,
    categories: Array.isArray(product.categories) ? product.categories : [],
    createdAtDisplay: order.createdAtText || order.createdAt || "",
    paidAtDisplay: order.paidAtText || order.paidAt || "",
    arrivedStoreAtDisplay: order.arrivedStoreAtText || order.arrivedStoreAt || "",
    pickedUpAtDisplay: order.pickedUpAtText || order.pickedUpAt || "",
    displayStatus: display,
    afterSalesStatus: afterSalesStatus(order),
    afterSalesText: afterSalesText(order),
    afterSalesRejectReason: afterSalesStatus(order) === "rejected" ? afterSalesRejectReason(order) : "",
    canReapplyAfterSales: order.canReapplyAfterSales === true || canReapplyAfterSales(order),
    isQuoteOrder: quote,
    isUnpaidOrder: isUnpaid(order),
    isRefundingOrder: isRefunding(order),
    isRefundedOrder: isRefunded(order),
    canPay: isUnpaid(order) && !quote && !isReviewMode(),
    canContact: ["待报价", "待确认", "制作中", "待自提", "售后已拒绝"].includes(display),
    canViewDetail: display === "待收货",
    canShowPickupCode: canShowPickupCode(order),
    canConfirmReceive: display === "待收货",
    canAfterSale: canApplyAfterSales(order),
    pickupLine: order.deliveryType === "pickup" && order.pickupStore
      ? `${order.pickupStore.name}${canShowPickupCode(order) ? ` · 取货码 ${order.pickupCode || order.pickup_code}` : ""}`
      : "",
    canShowPickupCredential: canShowPickupCode(order) && !!(order.pickupQrCodeUrl || order.pickup_qrcode_url),
    pickupTip: order.deliveryType === "pickup"
      ? (order.pickupStatus === "arrived_store" ? "请凭取货码到店领取" : order.pickupStatus === "picked_up" ? "订单已完成自提" : "商品到店后，我们会通知你到店自提")
      : "",
    refundLine: afterSalesText(order) || (order.refundStatus ? `${order.refundStatus}${order.refundAmount && Number(order.refundAmount) > 0 ? ` · ¥${order.refundAmount}` : ""}` : ""),
    canRefund: canApplyAfterSales(order)
  }
}

function resolveOrderProductId(order = {}, product = {}) {
  const candidates = [
    order.detailProductId,
    order.firstProductId,
    order.itemProductId,
    order.productId,
    order.product_id,
    product.id
  ].filter(Boolean).map(value => String(value).trim())
  const id = candidates.find(value => value && value !== "CART_ORDER" && value !== "CUSTOM_UPLOAD")
  if (id) return id
  const items = Array.isArray(order.items) ? order.items : []
  const item = items.find(entry => entry && (entry.productId || entry.product_id || entry.id))
  return item ? String(item.productId || item.product_id || item.id || "").trim() : ""
}

function statusMatches(order, key) {
  if (key === "all") return true
  if (key === "unpaid") return isUnpaid(order)
  if (key === "afterSale") return ["requested", "refund_pending", "remake", "reship"].includes(afterSalesStatus(order)) || isRefunded(order) || isCompletedWithinAfterSaleWindow(order)
  if (key === "design") {
    return isPaid(order) && ["待发货", "制作中"].includes(order.status || "")
  }
  if (key === "receiving") {
    if (order.deliveryType === "pickup") return order.status === "已发货" || order.pickupStatus === "arrived_store"
    return order.status === "已发货"
  }
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
      return { ...product, imageUrl: product.displayImage || getProductListImage(product), recommendReason: sameCategory ? "同类推荐" : product.badgeText || "热卖精选", score }
    })
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, 8)
}

function buildStatusTabs(orders) {
  return STATUS_TABS.map(tab => ({
    ...tab,
    count: tab.key === "afterSale" ? "" : orders.filter(order => statusMatches(order, tab.key)).length
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
    visibleLimit: ORDER_PAGE_SIZE,
    totalFilteredOrders: 0,
    hasMoreOrders: false,
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
      afterSalesType: "退款",
      afterSalesReason: "",
      afterSalesDesc: "",
      afterSalesImages: [],
      contactPhone: ""
    },
    afterSalesTypes: ["退款", "退货退款", "补发", "重新制作"],
    submittingRefund: false,
    payLoadingOrderId: "",
    reviewMode: isReviewMode()
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
    this.setData({ loginVisible: false })
    setTimeout(() => {
      this.setData({ loginVisible: true })
    }, 20)
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
        title: "登录失败",
        content: error.message || "登录失败，请稍后重试",
        showCancel: false
      })
    }).finally(() => {
      this.setData({ loginLoading: false })
    })
  },

  switchStatus(event) {
    const activeStatus = event.currentTarget.dataset.key
    this.setData({ activeStatus, visibleLimit: ORDER_PAGE_SIZE })
    this.refreshRecentOrders(activeStatus)
  },

  refreshRecentOrders(nextStatus) {
    const activeStatus = nextStatus || this.data.activeStatus
    const filteredOrders = this.data.orders.filter(order => statusMatches(order, activeStatus))
    const visibleLimit = this.data.visibleLimit || ORDER_PAGE_SIZE
    this.setData({
      recentOrders: filteredOrders.slice(0, visibleLimit),
      totalFilteredOrders: filteredOrders.length,
      hasMoreOrders: filteredOrders.length > visibleLimit
    })
  },

  loadMoreOrders() {
    if (!this.data.hasMoreOrders) return
    this.setData({ visibleLimit: (this.data.visibleLimit || ORDER_PAGE_SIZE) + ORDER_PAGE_SIZE })
    this.refreshRecentOrders()
  },

  onReachBottom() {
    this.loadMoreOrders()
  },

  openOrderProduct(event) {
    const order = this.data.recentOrders[event.currentTarget.dataset.index]
    if (!order) return
    const productId = resolveOrderProductId(order, order.product || {})
    if (productId) {
      wx.navigateTo({ url: `/pages/product/detail?id=${encodeURIComponent(productId)}` })
      return
    }
    wx.showToast({ title: "该历史订单暂无法查看商品详情", icon: "none" })
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

  payOrder(event) {
    if (this.data.reviewMode) {
      wx.showToast({ title: "订单已保留，客服会确认付款方式", icon: "none" })
      return
    }
    const order = this.data.recentOrders[event.currentTarget.dataset.index]
    if (!order || isQuoteOrder(order)) return
    this.setData({ payLoadingOrderId: order.id })
    ensureOpenid().then(openid => request("/api/pay/wechat", {
      method: "POST",
      data: {
        orderId: order.id,
        openid,
        userSession: wx.getStorageSync("userSession") || "",
        userToken: wx.getStorageSync("userToken") || ""
      }
    })).then(payData => {
      if (!payData.timeStamp || !payData.nonceStr || !payData.package || !payData.paySign) {
        throw new Error(payData.message || "微信支付暂未完成配置，请联系商家确认订单")
      }
      return new Promise((resolve, reject) => {
        wx.requestPayment({
          ...payData,
          success: resolve,
          fail: err => {
            const msg = String(err.errMsg || "")
            reject(new Error(msg.includes("cancel") ? "已取消支付，订单已保留，可稍后继续支付" : "支付失败，请稍后重试"))
          }
        })
      })
    }).then(() => {
      wx.showToast({ title: "支付成功", icon: "success" })
      this.loadPage()
    }).catch(error => {
      wx.showToast({ title: error.message || "支付失败，请稍后重试", icon: "none" })
    }).finally(() => {
      this.setData({ payLoadingOrderId: "" })
    })
  },

  contactService() {
    wx.showToast({ title: "请点击联系客服按钮", icon: "none" })
  },

  showPickupCode(event) {
    const order = this.data.recentOrders[event.currentTarget.dataset.index]
    if (!order) return
    if (!canShowPickupCode(order)) {
      wx.showToast({ title: "订单支付后可查看取货码", icon: "none" })
      return
    }
    wx.showModal({
      title: "取货码",
      content: `${order.pickupCode || "-"}\n${order.pickupStore?.name || order.pickupLine || ""}`,
      showCancel: false
    })
  },

  confirmReceive(event) {
    const order = this.data.recentOrders[event.currentTarget.dataset.index]
    wx.showModal({
      title: "确认收货",
      content: order ? "如需确认收货，请先联系商家处理。" : "订单不存在",
      showCancel: false
    })
  },

  viewAfterSale() {
    wx.showToast({ title: "售后处理中", icon: "none" })
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
        afterSalesType: event.currentTarget.dataset.type || "退款",
        afterSalesReason: "",
        afterSalesDesc: "",
        afterSalesImages: [],
        contactPhone: wx.getStorageSync("memberPhone") || order.phone || ""
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

  onAfterSalesTypeChange(event) {
    const index = Number(event.detail.value || 0)
    this.setData({ "refundForm.afterSalesType": this.data.afterSalesTypes[index] || "退款" })
  },

  chooseRefundImage() {
    const current = this.data.refundForm.afterSalesImages || []
    const remain = Math.max(0, 6 - current.length)
    if (!remain) {
      wx.showToast({ title: "最多上传6张凭证", icon: "none" })
      return
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: res => {
        const files = (res.tempFiles || []).filter(Boolean)
        if (!files.length) return
        if (files.some(file => file.size && file.size > 10 * 1024 * 1024)) {
          wx.showToast({ title: "图片超过10MB，请压缩后上传", icon: "none" })
          return
        }
        wx.showLoading({ title: "上传中" })
        Promise.all(files.map(file => uploadFileWithFallback("/api/upload/public", {
          filePath: file.tempFilePath,
          name: "file"
        }))).then(results => {
            wx.hideLoading()
            const urls = results.map(data => data.url).filter(Boolean)
            if (!urls.length) {
              wx.showToast({ title: "上传失败，请重试", icon: "none" })
              return
            }
            this.setData({ "refundForm.afterSalesImages": [...current, ...urls].slice(0, 6) })
          }).catch(error => {
            wx.hideLoading()
            wx.showToast({ title: error.message || "上传失败，请重试", icon: "none" })
          })
      }
    })
  },

  removeRefundImage(event) {
    const index = Number(event.currentTarget.dataset.index)
    const next = (this.data.refundForm.afterSalesImages || []).filter((_, itemIndex) => itemIndex !== index)
    this.setData({ "refundForm.afterSalesImages": next })
  },

  submitRefund() {
    const { afterSalesReason, contactPhone } = this.data.refundForm
    if (!afterSalesReason || !contactPhone) {
      wx.showToast({ title: "请填写售后原因和联系电话", icon: "none" })
      return
    }
    this.setData({ submittingRefund: true })
    request(`/api/orders/${encodeURIComponent(this.data.refundOrder.id)}/after-sales/apply`, {
      method: "POST",
      data: {
        ...getUserIdentity(),
        ...this.data.refundForm
      }
    }).then(() => {
      wx.showToast({ title: "已提交售后申请", icon: "success" })
      this.closeRefund()
      this.loadPage()
    }).catch(error => {
      wx.showToast({ title: error.message || "提交失败", icon: "none" })
    }).finally(() => {
      this.setData({ submittingRefund: false })
    })
  }
})
