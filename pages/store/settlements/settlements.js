const { request } = require("../../../utils/api")
const { applyTheme } = require("../../../utils/theme")

Page({
  data: {
    summary: {},
    records: [],
    themeStyle: "",
    themeClass: "theme-skin01"
  },

  onShow() {
    applyTheme(this)
    request("/api/store/settlements").then(data => {
      this.setData({
        summary: data.summary || {},
        records: data.records || []
      })
    }).catch(error => wx.showToast({ title: error.message || "读取失败", icon: "none" }))
  }
})
