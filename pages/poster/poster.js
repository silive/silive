const { applyTheme } = require("../../utils/theme")

function downloadImage(url) {
  if (!url) return Promise.resolve("")
  if (url.indexOf("/") === 0) return Promise.resolve(url)
  return new Promise(resolve => {
    wx.downloadFile({
      url,
      success: res => resolve(res.statusCode >= 200 && res.statusCode < 300 ? res.tempFilePath : ""),
      fail: () => resolve("")
    })
  })
}

Page({
  data: {
    title: "邀请海报",
    image: "",
    code: "",
    path: "",
    shareImage: "",
    posterImage: "",
    generating: false,
    themeStyle: "",
    themeClass: "theme-skin01"
  },

  onLoad(options) {
    applyTheme(this)
    const title = decodeURIComponent(options.title || "邀请海报")
    wx.setNavigationBarTitle({ title })
    this.setData({
      title,
      image: decodeURIComponent(options.image || ""),
      code: decodeURIComponent(options.code || ""),
      path: decodeURIComponent(options.path || ""),
      shareImage: decodeURIComponent(options.shareImage || "")
    })
    setTimeout(() => this.generatePoster(), 200)
  },

  onShow() {
    applyTheme(this)
  },

  generatePoster() {
    if (this.data.generating) return
    this.setData({ generating: true })
    Promise.all([downloadImage(this.data.image), downloadImage(this.data.shareImage)])
      .then(([qrPath, sharePath]) => {
        const ctx = wx.createCanvasContext("posterCanvas", this)
        ctx.setFillStyle("#F4F9FF")
        ctx.fillRect(0, 0, 750, 960)
        ctx.setFillStyle("#FFFFFF")
        if (ctx.setShadow) ctx.setShadow(0, 18, 32, "rgba(22,119,255,0.12)")
        ctx.fillRoundRect ? ctx.fillRoundRect(36, 36, 678, 888, 32) : ctx.fillRect(36, 36, 678, 888)
        if (ctx.setShadow) ctx.setShadow(0, 0, 0, "transparent")
        if (sharePath) ctx.drawImage(sharePath, 72, 76, 606, 300)
        else {
          const grad = ctx.createLinearGradient(72, 76, 678, 376)
          grad.addColorStop(0, "#1677FF")
          grad.addColorStop(1, "#36CFC9")
          ctx.setFillStyle(grad)
          ctx.fillRoundRect ? ctx.fillRoundRect(72, 76, 606, 300, 28) : ctx.fillRect(72, 76, 606, 300)
        }
        ctx.setFillStyle("#1F2937")
        ctx.setFontSize(46)
        ctx.fillText("非常智造", 82, 450)
        ctx.setFontSize(28)
        ctx.setFillStyle("#6B7280")
        ctx.fillText("上传照片，定制专属礼物", 82, 500)
        ctx.fillText("3D打印 · 激光雕刻 · 到店自提", 82, 540)
        ctx.setFillStyle("#EEF6FF")
        ctx.fillRoundRect ? ctx.fillRoundRect(82, 580, 586, 86, 20) : ctx.fillRect(82, 580, 586, 86)
        ctx.setFillStyle("#1677FF")
        ctx.setFontSize(26)
        ctx.fillText(`专属邀请码：${this.data.code || "VSCUSTOM"}`, 112, 633)
        if (qrPath) ctx.drawImage(qrPath, 246, 704, 258, 258)
        else {
          ctx.setFillStyle("#FFFFFF")
          ctx.fillRect(246, 704, 258, 258)
          ctx.setFillStyle("#1F2937")
          ctx.setFontSize(24)
          ctx.fillText(this.data.code || "VSCUSTOM", 292, 842)
        }
        ctx.setFillStyle("#6B7280")
        ctx.setFontSize(22)
        ctx.fillText("扫码进入，领取好友推荐权益", 210, 900)
        ctx.draw(false, () => {
          wx.canvasToTempFilePath({
            canvasId: "posterCanvas",
            width: 750,
            height: 960,
            destWidth: 1500,
            destHeight: 1920,
            success: res => this.setData({ posterImage: res.tempFilePath, generating: false }),
            fail: error => {
              this.setData({ generating: false })
              wx.showToast({ title: error.errMsg || "海报生成失败", icon: "none" })
            }
          }, this)
        })
      })
  },

  savePoster() {
    if (!this.data.posterImage) {
      wx.showToast({ title: "海报生成中，请稍后", icon: "none" })
      return
    }
    wx.saveImageToPhotosAlbum({
      filePath: this.data.posterImage,
      success: () => wx.showToast({ title: "已保存到相册", icon: "success" }),
      fail: error => {
        const msg = String(error.errMsg || "")
        wx.showModal({
          title: "保存失败",
          content: msg.includes("auth") ? "请在系统设置中允许保存到相册" : "保存到相册失败，请稍后重试",
          showCancel: false
        })
      }
    })
  }
})
