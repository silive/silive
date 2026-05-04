const defaultData = require("./default-data")
const { request, uploadFileWithFallback } = require("../../utils/api")
const { applyTheme } = require("../../utils/theme")
const BADGE_TEXT = {
  new: "新品推荐",
  hot: "人气热卖",
  best: "爆品推荐",
  none: ""
}

function normalizeProducts(products) {
  return (products || []).filter(product => product.status !== "off").map(product => ({
    ...product,
    categories: Array.isArray(product.categories) ? product.categories : [],
    badgeText: BADGE_TEXT[product.badge] || product.badge || ""
  }))
}

function normalizeKeyword(value) {
  return String(value || "").trim().toLowerCase()
}

function productMatchesKeyword(product, keyword) {
  if (!keyword) return true
  const fields = [
    product.name,
    product.intro,
    product.desc,
    product.badge,
    product.badgeText,
    ...(Array.isArray(product.categories) ? product.categories : [])
  ]
  return fields.join(" ").toLowerCase().includes(keyword)
}

function buildHomeState(data) {
  const products = normalizeProducts(data.products || defaultData.products)
  const hotProducts = products.filter(product => String(product.isHot) === "true" || ["best", "hot"].includes(product.badge)).slice(0, 6)
  const banners = (data.banners || defaultData.banners || []).slice(0, 3).filter(item => item.imageUrl || item.title || item.desc)
  const homeEntries = (data.homeEntries || defaultData.homeEntries || [])
    .filter(item => String(item.visible) !== "false")
    .sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0))
  return {
    ...defaultData,
    ...data,
    banners,
    products,
    hotProducts: hotProducts.length ? hotProducts : products.slice(0, 4),
    homeEntries,
    reviews: data.reviews || defaultData.reviews,
    contact: {
      ...defaultData.contact,
      ...(data.contact || {})
    }
  }
}

Page({
  data: {
    ...buildHomeState(defaultData),
    themeStyle: "",
    themeClass: "theme-skin01",
    cmsStatus: "local"
  },

  onLoad(options = {}) {
    applyTheme(this)
    const app = getApp()
    if (app.captureInvite) app.captureInvite({ query: options })
    if (options.invite) wx.setStorageSync("inviterCode", decodeURIComponent(options.invite))
    if (options.inviterCode) wx.setStorageSync("inviterCode", decodeURIComponent(options.inviterCode))
    this.loadHomeConfig()
  },

  onShow() {
    applyTheme(this)
    this.loadHomeConfig()
    this.startLiveSync()
  },

  onHide() {
    this.stopLiveSync()
  },

  onUnload() {
    this.stopLiveSync()
  },

  startLiveSync() {
    this.stopLiveSync()
    this.liveSyncTimer = setInterval(() => {
      this.loadHomeConfig()
    }, 5000)
  },

  stopLiveSync() {
    if (this.liveSyncTimer) {
      clearInterval(this.liveSyncTimer)
      this.liveSyncTimer = null
    }
  },

  loadHomeConfig() {
    request(`/api/home?t=${Date.now()}`, { timeout: 8000 })
      .then(data => {
        this.setData({
          ...buildHomeState(data || defaultData),
          cmsStatus: "online"
        })
        this.loadSearchProducts()
      })
      .catch(() => {
        this.setData({
          ...buildHomeState(defaultData),
          cmsStatus: "local"
        })
        this.loadSearchProducts()
      })
  },

  loadSearchProducts() {
    request("/api/products", { timeout: 8000 }).then(products => {
      const onlineProducts = normalizeProducts(Array.isArray(products) && products.length ? products : defaultData.products)
      const hotProducts = onlineProducts.filter(product => String(product.isHot) === "true" || ["best", "hot"].includes(product.badge)).slice(0, 6)
      this.setData({
        products: onlineProducts,
        hotProducts: hotProducts.length ? hotProducts : onlineProducts.slice(0, 4),
        searchAllProducts: onlineProducts
      })
      this.refreshSearchResults()
    }).catch(() => {
      const fallbackProducts = normalizeProducts(defaultData.products)
      const hotProducts = fallbackProducts.filter(product => String(product.isHot) === "true" || ["best", "hot"].includes(product.badge)).slice(0, 6)
      if (!this.data.products || !this.data.products.length) {
        this.setData({
          products: fallbackProducts,
          hotProducts: hotProducts.length ? hotProducts : fallbackProducts.slice(0, 4)
        })
      }
      this.setData({ searchAllProducts: this.data.products || fallbackProducts })
      this.refreshSearchResults()
    })
  },

  onSearchInput(event) {
    const searchKeyword = event.detail.value || ""
    this.setData({
      searchKeyword
    })
    this.refreshSearchResults(searchKeyword)
  },

  clearSearch() {
    this.setData({
      searchKeyword: "",
      searchProducts: [],
      showSearchResults: false
    })
  },

  refreshSearchResults(nextKeyword) {
    const keyword = normalizeKeyword(nextKeyword === undefined ? this.data.searchKeyword : nextKeyword)
    if (!keyword) {
      this.setData({
        searchProducts: [],
        showSearchResults: false
      })
      return
    }
    const source = this.data.searchAllProducts && this.data.searchAllProducts.length
      ? this.data.searchAllProducts
      : this.data.products
    this.setData({
      searchProducts: (source || []).filter(product => productMatchesKeyword(product, keyword)),
      showSearchResults: true
    })
  },

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: res => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file) return
        const filePath = file.tempFilePath || ""
        const fileName = filePath.split("/").pop() || ""
        const dotIndex = fileName.lastIndexOf(".")
        const ext = dotIndex > -1 ? fileName.slice(dotIndex + 1).toLowerCase() : ""
        if (ext && !["jpg", "jpeg", "png", "webp"].includes(ext)) {
          wx.showToast({ title: "图片格式不支持，请选择jpg/png/webp", icon: "none" })
          return
        }
        if (file.size && file.size > 10 * 1024 * 1024) {
          wx.showToast({ title: "图片超过10MB，请压缩后上传", icon: "none" })
          return
        }
        wx.showLoading({ title: "上传中" })
        uploadFileWithFallback("/api/upload/public", {
          filePath,
          name: "file"
        }).then(data => {
            wx.hideLoading()
            if (!data.ok || !data.url) {
              wx.showToast({ title: data.message || "上传失败，请重试", icon: "none" })
              return
            }
            const product = {
              id: "CUSTOM_UPLOAD",
              name: "上传照片定制",
              intro: "根据已选照片一对一确认设计",
              price: "99",
              badge: "new",
              badgeText: "新品推荐",
              cover: "keyring",
              imageUrl: data.url,
              categories: ["名字礼物"]
            }
            wx.navigateTo({
              url: `/pages/checkout/checkout?product=${encodeURIComponent(JSON.stringify(product))}&customImage=${encodeURIComponent(data.url)}`
            })
          }).catch(error => {
            wx.hideLoading()
            wx.showToast({ title: error.message || "上传失败，请重试", icon: "none" })
          })
      }
    })
  },

  openCategory(event) {
    const name = event.currentTarget.dataset.name
    wx.navigateTo({
      url: `/pages/category/list?primary=${encodeURIComponent(name)}`
    })
  },

  openHomeEntry(event) {
    const entry = this.data.homeEntries[event.currentTarget.dataset.index]
    this.handleTarget(entry)
  },

  openBanner(event) {
    const banner = this.data.banners[event.currentTarget.dataset.index]
    this.handleTarget(banner)
  },

  handleTarget(entry) {
    if (!entry) return
    const value = entry.targetValue || entry.name || ""
    if (entry.targetType === "service") {
      this.showContact()
      return
    }
    if (entry.targetType === "secondary") {
      const parts = value.split("/")
      wx.navigateTo({ url: `/pages/category/list?primary=${encodeURIComponent(parts[0] || "")}&secondary=${encodeURIComponent(parts[1] || "全部")}` })
      return
    }
    if (entry.targetType === "productList") {
      wx.navigateTo({ url: `/pages/category/list?ids=${encodeURIComponent(value)}&primary=${encodeURIComponent(entry.name)}` })
      return
    }
    if (entry.targetType === "product") {
      wx.navigateTo({ url: `/pages/product/detail?id=${encodeURIComponent(value)}` })
      return
    }
    if (entry.targetType === "poster") {
      wx.navigateTo({ url: `/pages/poster/poster?title=${encodeURIComponent(entry.name)}&image=${encodeURIComponent(entry.imageUrl || value || "")}` })
      return
    }
    if (entry.targetType === "custom") {
      if (value.indexOf("/") === 0) wx.navigateTo({ url: value })
      else wx.showModal({ title: entry.name, content: value || "暂未配置链接", showCancel: false })
      return
    }
    wx.navigateTo({ url: `/pages/category/list?primary=${encodeURIComponent(value)}` })
  },

  openProduct(event) {
    const id = event.currentTarget.dataset.id
    const index = event.currentTarget.dataset.index
    const product = this.data.products[index]
    const query = id ? `id=${encodeURIComponent(id)}` : `product=${encodeURIComponent(JSON.stringify(product))}`
    wx.navigateTo({
      url: `/pages/product/detail?${query}`
    })
  },

  showContact() {
    const { phone, wechat, workWechatUrl } = this.data.contact
    const items = ["在线客服（企业微信）", "电话联系", "复制微信号"]
    wx.showActionSheet({
      itemList: items,
      success: res => {
        if (res.tapIndex === 0) {
          if (workWechatUrl && workWechatUrl.indexOf("/") === 0) {
            wx.navigateTo({ url: workWechatUrl })
            return
          }
          wx.showModal({ title: "在线客服", content: workWechatUrl || "暂未配置企业微信客服链接", showCancel: false })
        }
        if (res.tapIndex === 1) {
          if (phone) wx.makePhoneCall({ phoneNumber: phone })
          else wx.showToast({ title: "暂未设置电话", icon: "none" })
        }
        if (res.tapIndex === 2) {
          if (wechat) wx.setClipboardData({ data: wechat })
          else wx.showToast({ title: "暂未设置微信号", icon: "none" })
        }
      }
    })
  }
})
