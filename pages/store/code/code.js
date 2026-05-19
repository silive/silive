const { request } = require("../../../utils/api")
const { applyTheme } = require("../../../utils/theme")
const { isReviewMode } = require("../../../utils/review")
const { copyText, saveImage } = require("../../../utils/privacy")

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
    if (isReviewMode()) {
      wx.showToast({ title: "审核版暂不开放保存二维码", icon: "none" })
      return
    }
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
            const denied = String(error.errMsg || "").includes("auth deny")
            wx.showToast({ title: denied ? "请允许保存到相册" : "保存失败，请重试", icon: "none" })
          }
        })
      },
      fail: () => wx.showToast({ title: "二维码下载失败", icon: "none" })
    })
  },

  copyLink() {
    if (isReviewMode()) {
      wx.showToast({ title: "审核版暂不开放复制链接", icon: "none" })
      return
    }
    const path = this.data.sharePath
    if (!path) return
    copyText(path, {
      data: path,
      success: () => wx.showToast({ title: "推广链接已复制", icon: "success" })
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
