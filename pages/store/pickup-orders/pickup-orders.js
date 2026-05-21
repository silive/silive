const { request } = require("../../../utils/api")
const { applyTheme } = require("../../../utils/theme")

function pickupText(status) {
  return ({ preparing: "配送到门店中", arrived_store: "待自提", ready_for_pickup: "待自提", arrived: "待自提", picked_up: "已自提", none: "无" })[status] || status || "-"
}

Page({
  data: {
    active: "preparing",
    tabs: [
      { key: "preparing", label: "配送中" },
      { key: "arrived_store", label: "待自提" },
      { key: "picked_up", label: "已自提" },
      { key: "all", label: "全部" }
    ],
    orders: [],
    visibleOrders: [],
    batchMode: false,
    selectedOrderIds: [],
    notifyingOrderId: "",
    batchLoading: false,
    themeStyle: "",
    themeClass: "theme-skin01"
  },

  onShow() {
    applyTheme(this)
    this.load()
  },

  load() {
    request("/api/store/pickup-orders").then(data => {
      const orders = (data.orders || []).map(order => this.normalizeOrder(order))
      this.setData({ orders, selectedOrderIds: [] })
      this.filter()
    }).catch(error => wx.showToast({ title: error.message || "读取失败", icon: "none" }))
  },

  normalizeOrder(order) {
    const reason = order.notifyBlockedReason || (order.canNotifyPickup ? "" : this.localBlockedReason(order))
    return {
      ...order,
      pickupText: pickupText(order.pickupStatus),
      canNotifyPickup: !!order.canNotifyPickup && !reason,
      notifyBlockedReason: reason,
      selected: (this.data.selectedOrderIds || []).includes(order.id)
    }
  },

  localBlockedReason(order = {}) {
    if (order.pickupStatus === "picked_up") return "已自提"
    if (["已退款", "已取消", "退款中"].includes(order.status || "")) return "已退款/已取消"
    if (["arrived_store", "ready_for_pickup", "arrived"].includes(order.pickupStatus || "") || order.notifyStatus === "sent") return "已通知"
    if (!order.pickupCode) return ""
    return ""
  },

  switchTab(event) {
    this.setData({ active: event.currentTarget.dataset.key, selectedOrderIds: [] })
    this.filter()
  },

  filter() {
    const active = this.data.active
    const selected = new Set(this.data.selectedOrderIds || [])
    const matches = order => {
      if (active === "all") return true
      if (active === "arrived_store") return ["arrived_store", "ready_for_pickup", "arrived"].includes(order.pickupStatus)
      return order.pickupStatus === active
    }
    this.setData({
      visibleOrders: this.data.orders
        .filter(matches)
        .map(order => ({ ...order, selected: selected.has(order.id) }))
    })
  },

  toggleBatchMode() {
    this.setData({ batchMode: !this.data.batchMode, selectedOrderIds: [] })
    this.filter()
  },

  toggleSelect(event) {
    const id = event.currentTarget.dataset.id
    const order = this.data.orders.find(item => item.id === id)
    if (!order || !order.canNotifyPickup) {
      wx.showToast({ title: order?.notifyBlockedReason || "该订单暂不可通知", icon: "none" })
      return
    }
    const selected = new Set(this.data.selectedOrderIds || [])
    if (selected.has(id)) selected.delete(id)
    else selected.add(id)
    this.setData({ selectedOrderIds: Array.from(selected) })
    this.filter()
  },

  selectAllNotifiable() {
    const ids = this.data.visibleOrders.filter(order => order.canNotifyPickup).map(order => order.id)
    this.setData({ selectedOrderIds: ids })
    this.filter()
  },

  notifyOne(event) {
    const id = event.currentTarget.dataset.id
    const order = this.data.orders.find(item => item.id === id)
    if (!order || !order.canNotifyPickup) {
      wx.showToast({ title: order?.notifyBlockedReason || "该订单暂不可通知", icon: "none" })
      return
    }
    wx.showModal({
      title: "通知客户自提",
      content: "确认该订单货物已到店，并通知客户到店自提吗？",
      success: res => {
        if (!res.confirm) return
        this.setData({ notifyingOrderId: id })
        request(`/api/store/pickup-orders/${encodeURIComponent(id)}/arrived`, { method: "POST" })
          .then(result => {
            const notifyFailed = Number(result.notifyFailedCount || 0)
            wx.showToast({ title: notifyFailed ? "已标记到店，通知失败" : "已通知客户到店自提", icon: "none" })
            this.load()
          })
          .catch(error => wx.showToast({ title: error.message || "通知失败", icon: "none" }))
          .finally(() => this.setData({ notifyingOrderId: "" }))
      }
    })
  },

  batchNotify() {
    const ids = this.data.selectedOrderIds || []
    if (!ids.length) {
      wx.showToast({ title: "请先选择订单", icon: "none" })
      return
    }
    wx.showModal({
      title: "批量通知自提",
      content: `确认将选中的 ${ids.length} 个订单标记为货已到店，并通知客户到店自提吗？`,
      success: res => {
        if (!res.confirm) return
        this.setData({ batchLoading: true })
        request("/api/store/pickup-orders/batch-arrived", {
          method: "POST",
          data: { orderIds: ids }
        }).then(result => {
          wx.showToast({
            title: `已处理${result.total || ids.length}单 成功${result.successCount || 0}单 跳过${result.skippedCount || 0}单 通知失败${result.notifyFailedCount || 0}单`,
            icon: "none",
            duration: 2600
          })
          this.load()
        }).catch(error => {
          wx.showToast({ title: error.message || "批量通知失败", icon: "none" })
        }).finally(() => this.setData({ batchLoading: false, selectedOrderIds: [] }))
      }
    })
  }
})
