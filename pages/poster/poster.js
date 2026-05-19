const { applyTheme } = require("../../utils/theme")
const { isReviewMode } = require("../../utils/review")
const { saveImage } = require("../../utils/privacy")

function downloadImage(url) {
  if (!url) return Promise.resolve(null)
  const getInfo = src => new Promise(resolve => {
    wx.getImageInfo({
      src,
      success: info => resolve({ path: info.path || src, width: info.width || 0, height: info.height || 0 }),
      fail: () => resolve({ path: src, width: 0, height: 0 })
    })
  })
  if (url.indexOf("/") === 0) return getInfo(url)
  return new Promise(resolve => {
    wx.downloadFile({
      url,
      success: res => {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.tempFilePath) getInfo(res.tempFilePath).then(resolve)
        else resolve(null)
      },
      fail: () => resolve(null)
    })
  })
}

function drawCover(ctx, image, x, y, width, height) {
  if (!image || !image.path) return false
  if (!image.width || !image.height) {
    ctx.drawImage(image.path, x, y, width, height)
    return true
  }
  const sourceRatio = image.width / image.height
  const targetRatio = width / height
  let sx = 0
  let sy = 0
  let sw = image.width
  let sh = image.height
  if (sourceRatio > targetRatio) {
    sw = image.height * targetRatio
    sx = (image.width - sw) / 2
  } else {
    sh = image.width / targetRatio
    sy = (image.height - sh) / 2
  }
  ctx.drawImage(image.path, sx, sy, sw, sh, x, y, width, height)
  return true
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
      .then(([qrImage, shareImage]) => {
        if (!qrImage || !qrImage.path) throw new Error("小程序码加载失败，请稍后重试")
        const ctx = wx.createCanvasContext("posterCanvas", this)
        ctx.setFillStyle("#FFF9F3")
        ctx.fillRect(0, 0, 750, 1200)
        ctx.setFillStyle("#FFFFFF")
        if (ctx.setShadow) ctx.setShadow(0, 18, 32, "rgba(255,106,0,0.12)")
        ctx.fillRoundRect ? ctx.fillRoundRect(36, 36, 678, 1128, 32) : ctx.fillRect(36, 36, 678, 1128)
        if (ctx.setShadow) ctx.setShadow(0, 0, 0, "transparent")
        ctx.setFillStyle("#FFF3E8")
        ctx.fillRoundRect ? ctx.fillRoundRect(72, 76, 606, 360, 28) : ctx.fillRect(72, 76, 606, 360)
        const hasShareImage = drawCover(ctx, shareImage, 72, 76, 606, 360)
        if (!hasShareImage) {
          const grad = ctx.createLinearGradient(72, 76, 678, 376)
          grad.addColorStop(0, "#FF5A00")
          grad.addColorStop(1, "#FFD21A")
          ctx.setFillStyle(grad)
          ctx.fillRoundRect ? ctx.fillRoundRect(72, 76, 606, 360, 28) : ctx.fillRect(72, 76, 606, 360)
        }
        ctx.setFillStyle("#1F2937")
        ctx.setFontSize(46)
        ctx.fillText("非常智造", 82, 512)
        ctx.setFontSize(28)
        ctx.setFillStyle("#6B7280")
        ctx.fillText("上传照片，定制专属礼物", 82, 562)
        ctx.fillText("3D打印 · 激光雕刻 · 到店自提", 82, 604)
        ctx.setFillStyle("#FFF3E8")
        ctx.fillRoundRect ? ctx.fillRoundRect(82, 642, 586, 86, 20) : ctx.fillRect(82, 642, 586, 86)
        ctx.setFillStyle("#FF5A00")
        ctx.setFontSize(26)
        ctx.fillText(`专属邀请码：${this.data.code || "VSCUSTOM"}`, 112, 695)
        ctx.setFillStyle("#FFFFFF")
        ctx.fillRoundRect ? ctx.fillRoundRect(235, 780, 280, 280, 28) : ctx.fillRect(235, 780, 280, 280)
        ctx.drawImage(qrImage.path, 250, 795, 250, 250)
        ctx.setFillStyle("#6B7280")
        ctx.setFontSize(22)
        ctx.fillText("扫码进入，领取好友推荐权益", 210, 1110)
        ctx.draw(false, () => {
          wx.canvasToTempFilePath({
            canvasId: "posterCanvas",
            width: 750,
            height: 1200,
            destWidth: 1500,
            destHeight: 2400,
            success: res => this.setData({ posterImage: res.tempFilePath, generating: false }),
            fail: error => {
              this.setData({ generating: false })
              wx.showToast({ title: error.errMsg || "海报生成失败", icon: "none" })
            }
          }, this)
        })
      })
      .catch(error => {
        this.setData({ generating: false })
        wx.showModal({ title: "海报生成失败", content: error.message || "小程序码加载失败，请稍后重试", showCancel: false })
      })
  },

  savePoster() {
    if (isReviewMode()) {
      wx.showToast({ title: "审核版暂不开放保存海报", icon: "none" })
      return
    }
    if (!this.data.posterImage) {
      wx.showToast({ title: "海报生成中，请稍后", icon: "none" })
      return
    }
    saveImage(this.data.posterImage, {
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
