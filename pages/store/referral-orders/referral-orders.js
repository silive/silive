const { request } = require("../../../utils/api")
const { applyTheme } = require("../../../utils/theme")

Page({
  data: {
    summary: {},
    orders: [],
    themeStyle: "",
    themeClass: "theme-skin01"
  },

  onShow() {
    applyTheme(this)
    this.load()
  },

  load() {
    request("/api/store/referral-orders").then(data => {
      this.setData({
        summary: data.summary || {},
        orders: data.orders || []
      })
    }).catch(error => {
      wx.showToast({ title: error.message || "读取失败", icon: "none" })
    })
  }
})
