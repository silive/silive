const { applyTheme } = require("../../utils/theme")
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

function drawImageContain(ctx, image, x, y, width, height) {
  if (!image || !image.path) return false
  if (!image.width || !image.height) {
    ctx.drawImage(image.path, x, y, width, height)
    return true
  }
  const scale = Math.min(width / image.width, height / image.height)
  const drawWidth = image.width * scale
  const drawHeight = image.height * scale
  const drawX = x + (width - drawWidth) / 2
  const drawY = y + (height - drawHeight) / 2
  ctx.drawImage(image.path, drawX, drawY, drawWidth, drawHeight)
  return true
}

Page({
  data: {
    title: "商品海报",
    mode: "product",
    image: "",
    code: "",
    path: "",
    shareImage: "",
    posterImage: "",
    generating: false,
    canSaveAlbum: true,
    themeStyle: "",
    themeClass: "theme-skin01"
  },

  onLoad(options) {
    applyTheme(this)
    const mode = options.mode || "product"
    const title = decodeURIComponent(options.title || (mode === "product" ? "商品海报" : "活动海报"))
    wx.setNavigationBarTitle({ title })
    this.setData({
      title,
      mode,
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
    const hasCodeBlock = !!this.data.code
    const codeImageUrl = hasCodeBlock ? this.data.image : ""
    const coverImageUrl = this.data.shareImage || (hasCodeBlock ? "" : this.data.image)
    Promise.all([downloadImage(codeImageUrl), downloadImage(coverImageUrl)])
      .then(([qrImage, shareImage]) => {
        const ctx = wx.createCanvasContext("posterCanvas", this)
        const isStorePoster = this.data.mode === "store"
        ctx.setFillStyle("#FFF9F3")
        ctx.fillRect(0, 0, 750, 1200)
        ctx.setFillStyle("#FFFFFF")
        if (ctx.setShadow) ctx.setShadow(0, 18, 32, "rgba(255,106,0,0.12)")
        ctx.fillRoundRect ? ctx.fillRoundRect(36, 36, 678, 1128, 32) : ctx.fillRect(36, 36, 678, 1128)
        if (ctx.setShadow) ctx.setShadow(0, 0, 0, "transparent")
        if (isStorePoster) {
          const grad = ctx.createLinearGradient(72, 76, 678, 306)
          grad.addColorStop(0, "#FF5A00")
          grad.addColorStop(1, "#FFD21A")
          ctx.setFillStyle(grad)
          ctx.fillRoundRect ? ctx.fillRoundRect(72, 76, 606, 260, 30) : ctx.fillRect(72, 76, 606, 260)
          ctx.setFillStyle("#FFFFFF")
          ctx.setFontSize(42)
          ctx.fillText(this.data.title || "门店专属码", 108, 172)
          ctx.setFontSize(28)
          ctx.fillText("门店专属码", 108, 224)
          ctx.fillText("定制礼品推荐", 108, 272)
        } else {
          ctx.setFillStyle("#FFF3E8")
          ctx.fillRoundRect ? ctx.fillRoundRect(72, 76, 606, 360, 28) : ctx.fillRect(72, 76, 606, 360)
          const hasShareImage = drawImageContain(ctx, shareImage, 72, 76, 606, 360)
          if (!hasShareImage) {
            const grad = ctx.createLinearGradient(72, 76, 678, 376)
            grad.addColorStop(0, "#FF5A00")
            grad.addColorStop(1, "#FFD21A")
            ctx.setFillStyle(grad)
            ctx.fillRoundRect ? ctx.fillRoundRect(72, 76, 606, 360, 28) : ctx.fillRect(72, 76, 606, 360)
          }
        }
        ctx.setFillStyle("#1F2937")
        ctx.setFontSize(46)
        ctx.fillText(isStorePoster ? "扫码进入门店推荐" : (this.data.title || "非常智造"), 82, isStorePoster ? 420 : 512)
        ctx.setFontSize(28)
        ctx.setFillStyle("#6B7280")
        ctx.fillText(isStorePoster ? "顾客扫码下单，归属门店服务" : "定制礼品推荐", 82, isStorePoster ? 470 : 562)
        ctx.fillText("3D打印 · 激光雕刻 · 创意好物", 82, isStorePoster ? 512 : 604)
        if (qrImage && qrImage.path && this.data.code) {
          ctx.setFillStyle("#FFF3E8")
          ctx.fillRoundRect ? ctx.fillRoundRect(82, isStorePoster ? 550 : 642, 586, 86, 20) : ctx.fillRect(82, isStorePoster ? 550 : 642, 586, 86)
          ctx.setFillStyle("#FF5A00")
          ctx.setFontSize(26)
          const codeLabel = this.data.mode === "store" ? "门店码" : (this.data.mode === "product" ? "商品码" : "推荐码")
          ctx.fillText(`${codeLabel}：${this.data.code}`, 112, isStorePoster ? 603 : 695)
          ctx.setFillStyle("#FFFFFF")
          ctx.fillRoundRect ? ctx.fillRoundRect(235, isStorePoster ? 690 : 780, 280, 280, 28) : ctx.fillRect(235, isStorePoster ? 690 : 780, 280, 280)
          ctx.drawImage(qrImage.path, 250, isStorePoster ? 705 : 795, 250, 250)
          ctx.setFillStyle("#1F2937")
          ctx.setFontSize(26)
          ctx.fillText(this.data.mode === "product" ? "扫码查看商品" : "长按识别进入小程序", 275, isStorePoster ? 1000 : 1090)
        } else {
          ctx.setFillStyle("#FFF3E8")
          ctx.fillRoundRect ? ctx.fillRoundRect(82, 680, 586, 240, 28) : ctx.fillRect(82, 680, 586, 240)
          ctx.setFillStyle("#FF5A00")
          ctx.setFontSize(36)
          ctx.fillText("打开小程序查看商品详情", 142, 790)
          ctx.setFontSize(26)
          ctx.fillText("非常智造 · 年轻人的创意礼品店", 154, 850)
        }
        ctx.setFillStyle("#6B7280")
        ctx.setFontSize(22)
        ctx.fillText("分享给朋友，一起看看这件好物", 200, 1130)
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
        wx.showModal({ title: "海报生成失败", content: error.message || "图片加载失败，请稍后重试", showCancel: false })
      })
  },

  savePoster() {
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
          content: msg.includes("auth") || msg.includes("deny") ? "可手动截图保存，或在设置中开启相册权限" : "保存到相册失败，请稍后重试",
          showCancel: false
        })
      }
    })
  }
})
