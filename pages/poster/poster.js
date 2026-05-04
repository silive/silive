const { applyTheme } = require("../../utils/theme")

Page({
  data: {
    title: "活动海报",
    image: "",
    themeStyle: "",
    themeClass: "theme-skin01"
  },

  onLoad(options) {
    applyTheme(this)
    const title = decodeURIComponent(options.title || "活动海报")
    const image = decodeURIComponent(options.image || "")
    wx.setNavigationBarTitle({ title })
    this.setData({ title, image })
  },

  onShow() {
    applyTheme(this)
  }
})
