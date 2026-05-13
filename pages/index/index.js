const defaultData = require("./default-data")
const { request, uploadFileWithFallback } = require("../../utils/api")
const { applyTheme } = require("../../utils/theme")
const BADGE_TEXT = {
  new: "新品推荐",
  hot: "人气热卖",
  best: "爆品推荐",
  none: ""
}

function isNormalProduct(product = {}) {
  const categories = Array.isArray(product.categories) ? product.categories : []
  return String(product.productType || product.orderType || "").toLowerCase() === "normal" ||
    String(product.needCustom || "").toLowerCase() === "false" ||
    categories.some(item => ["日用好货", "潮玩手办", "食品饮料", "日用百货"].some(keyword => String(item).includes(keyword)))
}

function normalizeProducts(products) {
  return (products || []).filter(product => product.status !== "off").map(product => ({
    ...product,
    displayImage: product.listImage || product.thumbUrl || product.optimizedUrl || product.imageUrl,
    cartImage: product.cartThumbUrl || product.thumbUrl || product.imageUrl,
    categories: Array.isArray(product.categories) ? product.categories : [],
    badgeText: BADGE_TEXT[product.badge] || product.badge || "",
    isNormalProduct: isNormalProduct(product)
  }))
}

function normalizeBanners(banners = []) {
  return normalizeBannersWithVersion(banners, "")
}

function withVersion(url, version) {
  if (!url) return ""
  if (!version) return url
  return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}`
}

function normalizeBannersWithVersion(banners = [], homeUpdatedAt = "") {
  return banners.map(item => {
    const version = item.version || item.updatedAt || homeUpdatedAt
    const finalImageUrl = item.finalImageUrl || withVersion(item.bannerUrl || item.optimizedUrl || item.imageUrl, version)
    return {
      ...item,
      finalImageUrl,
      displayImage: finalImageUrl || item.bannerUrl || item.optimizedUrl || item.imageUrl,
      placeholderColor: "#eef6ff"
    }
  })
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
  const recommendedProducts = (hotProducts.length ? hotProducts : products).slice(0, 6)
  const burstProducts = (hotProducts.length ? hotProducts : products).slice(0, 4)
  const homeUpdatedAt = data.updatedAt || data.homeUpdatedAt || ""
  const banners = normalizeBannersWithVersion((data.banners || defaultData.banners || []).slice(0, 3).filter(item => item.imageUrl || item.title || item.desc), homeUpdatedAt)
  const homeEntries = (data.homeEntries || defaultData.homeEntries || [])
    .map(item => item.name === "联系客服" || item.targetType === "service" ? {
      ...item,
      name: "日用好货",
      desc: item.desc && item.name !== "联系客服" ? item.desc : "食品饮料 · 日用百货",
      icon: item.icon === "聊" ? "货" : (item.icon || "货"),
      targetType: "primary",
      targetValue: "日用好货"
    } : item)
    .filter(item => String(item.visible) !== "false")
    .sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0))
  return {
    ...defaultData,
    ...data,
    banners,
    products: recommendedProducts,
    searchAllProducts: products,
    hotProducts: burstProducts,
    homeEntries,
    trustTags: (data.trustTags || defaultData.trustTags || []).map(item => ({
      ...item,
      text: item.text === "48小时发货" ? "急速生产" : item.text
    })),
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
    cmsStatus: "local",
    headerAvatar: "",
    headerMarkText: "我"
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
    this.loadHeaderAvatar()
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
    request(`/api/home?_t=${Date.now()}`, { timeout: 8000 })
      .then(data => {
        const nextHome = buildHomeState(data || defaultData)
        const firstBanner = nextHome.banners && nextHome.banners[0] ? nextHome.banners[0] : {}
        console.log("[home-banner-final]", {
          title: firstBanner.title || "",
          imageUrl: firstBanner.imageUrl || "",
          optimizedUrl: firstBanner.optimizedUrl || "",
          bannerUrl: firstBanner.bannerUrl || "",
          finalImageUrl: firstBanner.finalImageUrl || firstBanner.displayImage || "",
          version: firstBanner.version || firstBanner.updatedAt || ""
        })
        this.setData({
          ...nextHome,
          cmsStatus: "online"
        })
      })
      .catch(() => {
        this.setData({
          ...buildHomeState(defaultData),
          cmsStatus: "local"
        })
      })
  },

  onPullDownRefresh() {
    this.loadHomeConfig()
    setTimeout(() => wx.stopPullDownRefresh(), 600)
  },

  loadHeaderAvatar() {
    const localAvatar = wx.getStorageSync("memberAvatar") || ""
    this.setData({
      headerAvatar: localAvatar,
      headerMarkText: "我"
    })
    const { getLoginState } = require("../../utils/auth")
    if (!getLoginState().loggedIn) return
    request("/api/user/profile")
      .then(profile => {
        const avatarUrl = profile.avatarUrl || localAvatar || ""
        if (profile.avatarUrl) wx.setStorageSync("memberAvatar", profile.avatarUrl)
        this.setData({
          headerAvatar: avatarUrl,
          headerMarkText: avatarUrl ? "" : "我"
        })
      })
      .catch(() => {})
  },

  goProfile() {
    wx.switchTab({ url: "/pages/profile/profile" })
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
    if (searchKeyword && (!this.data.searchAllProducts || this.data.searchAllProducts.length <= this.data.products.length)) this.loadSearchProducts()
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
        if (ext && !["jpg", "jpeg", "png", "webp", "heic"].includes(ext)) {
          wx.showToast({ title: "图片格式不支持，请选择jpg/png/webp/heic", icon: "none" })
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
              intro: "待客服确认报价",
              price: "0",
              priceText: "待客服确认报价",
              priceMode: "quote",
              needQuote: true,
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
