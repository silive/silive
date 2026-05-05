const { request } = require("../../../utils/api")
const { applyTheme } = require("../../../utils/theme")

function pickupText(status) {
  return ({ preparing: "待到店", arrived_store: "待自提", picked_up: "已自提", none: "无" })[status] || status || "-"
}

Page({
  data: {
    active: "arrived_store",
    tabs: [
      { key: "preparing", label: "待到店" },
      { key: "arrived_store", label: "待自提" },
      { key: "picked_up", label: "已自提" },
      { key: "all", label: "全部" }
    ],
    orders: [],
    visibleOrders: [],
    themeStyle: "",
    themeClass: "theme-skin01"
  },

  onShow() {
    applyTheme(this)
    this.load()
  },

  load() {
    request("/api/store/pickup-orders").then(data => {
      const orders = (data.orders || []).map(order => ({ ...order, pickupText: pickupText(order.pickupStatus) }))
      this.setData({ orders })
      this.filter()
    }).catch(error => wx.showToast({ title: error.message || "读取失败", icon: "none" }))
  },

  switchTab(event) {
    this.setData({ active: event.currentTarget.dataset.key })
    this.filter()
  },

  filter() {
    const active = this.data.active
    this.setData({
      visibleOrders: active === "all" ? this.data.orders : this.data.orders.filter(order => order.pickupStatus === active)
    })
  }
})
