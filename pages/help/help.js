const { request } = require("../../utils/api")
const { applyTheme } = require("../../utils/theme")

function normalizeArticle(article, index) {
  return {
    ...article,
    id: article.id || `HELP${index + 1}`,
    title: article.title || "帮助文章",
    summary: article.summary || "",
    content: article.content || "",
    imageUrl: article.imageUrl || "",
    expanded: index === 0
  }
}

Page({
  data: {
    articles: [],
    banner: null,
    contact: {},
    themeStyle: "",
    themeClass: "theme-skin01",
    loading: true
  },

  onLoad() {
    applyTheme(this)
    this.loadHelp()
  },

  onShow() {
    applyTheme(this)
  },

  loadHelp() {
    request(`/api/help-center?t=${Date.now()}`)
      .then(data => {
        this.setData({
          articles: (data.articles || []).map(normalizeArticle),
          banner: data.helpBanner || data.banner || null,
          contact: data.contact || {},
          loading: false
        })
      })
      .catch(() => {
        this.setData({ loading: false })
        wx.showToast({ title: "售后保障加载失败", icon: "none" })
      })
  },

  toggleArticle(event) {
    const index = Number(event.currentTarget.dataset.index)
    this.setData({
      articles: this.data.articles.map((item, itemIndex) => ({
        ...item,
        expanded: itemIndex === index ? !item.expanded : item.expanded
      }))
    })
  },

  openBanner() {
    this.handleTarget(this.data.banner)
  },

  contact() {
    const { phone, wechat, workWechatUrl, workWechatId, showWorkWechat, showPhone, showWechat } = this.data.contact || {}
    const actions = []
    if (String(showWorkWechat) !== "false") actions.push({ key: "workWechat", label: "在线客服（企业微信）" })
    if (String(showPhone) !== "false") actions.push({ key: "phone", label: "电话联系" })
    if (String(showWechat) !== "false") actions.push({ key: "wechat", label: "复制微信号" })
    wx.showActionSheet({
      itemList: actions.map(item => item.label),
      success: res => {
        const action = actions[res.tapIndex]
        if (!action) return
        if (action.key === "workWechat") {
          if (workWechatUrl && workWechatUrl.indexOf("/") === 0) wx.navigateTo({ url: workWechatUrl })
          else wx.showModal({ title: "在线客服（企业微信）", content: workWechatId || workWechatUrl || "暂未配置企业微信客服", showCancel: false })
        }
        if (action.key === "phone") {
          if (phone) wx.makePhoneCall({ phoneNumber: phone })
          else wx.showToast({ title: "暂未设置电话", icon: "none" })
        }
        if (action.key === "wechat") {
          if (wechat) wx.setClipboardData({ data: wechat })
          else wx.showToast({ title: "暂未设置微信号", icon: "none" })
        }
      }
    })
  },

  handleTarget(entry) {
    if (!entry) return
    const value = entry.targetValue || ""
    if (entry.targetType === "service") {
      this.contact()
      return
    }
    if (entry.targetType === "secondary") {
      const parts = value.split("/")
      wx.navigateTo({ url: `/pages/category/list?primary=${encodeURIComponent(parts[0] || "")}&secondary=${encodeURIComponent(parts[1] || "全部")}` })
      return
    }
    if (entry.targetType === "product") {
      wx.navigateTo({ url: `/pages/product/detail?id=${encodeURIComponent(value)}` })
      return
    }
    if (entry.targetType === "productList") {
      wx.navigateTo({ url: `/pages/category/list?ids=${encodeURIComponent(value)}&primary=${encodeURIComponent(entry.title || "精选商品")}` })
      return
    }
    if (entry.targetType === "poster") {
      wx.navigateTo({ url: `/pages/poster/poster?title=${encodeURIComponent(entry.title || "活动海报")}&image=${encodeURIComponent(entry.imageUrl || "")}` })
      return
    }
    if (entry.targetType === "custom") {
      if (value.indexOf("/") === 0) wx.navigateTo({ url: value })
      else wx.showModal({ title: entry.title || "链接", content: value || "暂未配置链接", showCancel: false })
      return
    }
    wx.navigateTo({ url: `/pages/category/list?primary=${encodeURIComponent(value || entry.title || "")}` })
  }
})
