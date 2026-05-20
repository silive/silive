const { request } = require("../../../utils/api")
const { applyTheme } = require("../../../utils/theme")
const { saveImage } = require("../../../utils/privacy")

const DEFAULT_SHARE_IMAGE = "/assets/share-promotion.png"

Page({
  data: {
    storeInfo: null,
    qrcodeUrl: "",
    sharePath: "",
    loading: true,
    themeStyle: "",
    themeClass: "theme-skin01"
  },

  onShow() {
    applyTheme(this)
    this.loadCode()
  },

  loadCode() {
    this.setData({ loading: true })
    request("/api/store/qrcode")
      .then(data => {
        this.setData({
          storeInfo: data.storeInfo || null,
          qrcodeUrl: data.url || "",
          sharePath: data.link || "",
          loading: false
        })
      })
      .catch(error => {
        this.setData({ loading: false })
        wx.showToast({ title: error.message || "推广码加载失败", icon: "none" })
      })
  },

  saveCode() {
    const url = this.data.qrcodeUrl
    if (!url) {
      wx.showToast({ title: "二维码还未生成", icon: "none" })
      return
    }
    wx.downloadFile({
      url,
      success: res => {
        if (res.statusCode !== 200) {
          wx.showToast({ title: "二维码下载失败", icon: "none" })
          return
        }
        saveImage(res.tempFilePath, {
          filePath: res.tempFilePath,
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
      },
      fail: () => wx.showToast({ title: "二维码下载失败", icon: "none" })
    })
  },

  createStorePoster() {
    const image = this.data.qrcodeUrl
    if (!image) {
      wx.showToast({ title: "门店码生成中，请稍后", icon: "none" })
      return
    }
    const title = `${this.data.storeInfo?.name || "非常智造"}门店专属码`
    wx.navigateTo({
      url: `/pages/poster/poster?mode=store&title=${encodeURIComponent(title)}&image=${encodeURIComponent(image)}&code=${encodeURIComponent(this.data.storeInfo?.id || "")}&path=${encodeURIComponent(this.data.sharePath || "")}&shareImage=${encodeURIComponent(DEFAULT_SHARE_IMAGE)}`
    })
  },

  onShareAppMessage() {
    return {
      title: "非常智造 · 门店推荐给你",
      path: this.data.sharePath || `/pages/index/index?store_id=${encodeURIComponent(this.data.storeInfo?.id || "")}`,
      imageUrl: this.data.qrcodeUrl || DEFAULT_SHARE_IMAGE
    }
  }
})
