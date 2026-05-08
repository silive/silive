const { applyTheme } = require("../../utils/theme")

function normalizeCart(items) {
  return (Array.isArray(items) ? items : []).map(item => ({
    ...item,
    selected: item.selected !== false,
    quantity: Math.max(1, Number(item.quantity || 1)),
    amount: (Number(item.price || 0) * Math.max(1, Number(item.quantity || 1))).toFixed(2)
  }))
}

Page({
  data: {
    items: [],
    total: "0.00",
    selectedCount: 0,
    selectedKinds: 0,
    themeStyle: "",
    themeClass: "theme-skin01"
  },

  onShow() {
    applyTheme(this)
    this.loadCart()
  },

  loadCart() {
    const items = normalizeCart(wx.getStorageSync("cartItems") || [])
    this.refresh(items)
  },

  refresh(items) {
    const selected = items.filter(item => item.selected !== false)
    this.setData({
      items,
      selectedKinds: selected.length,
      selectedCount: selected.reduce((sum, item) => sum + Number(item.quantity || 1), 0),
      total: selected.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 1), 0).toFixed(2)
    })
    wx.setStorageSync("cartItems", items)
  },

  toggleItem(event) {
    const index = Number(event.currentTarget.dataset.index)
    const items = this.data.items.map((item, itemIndex) => itemIndex === index ? { ...item, selected: item.selected === false } : item)
    this.refresh(items)
  },

  changeQty(event) {
    const index = Number(event.currentTarget.dataset.index)
    const delta = Number(event.currentTarget.dataset.delta)
    const items = this.data.items.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: Math.max(1, Number(item.quantity || 1) + delta) } : item)
    this.refresh(normalizeCart(items))
  },

  removeItem(event) {
    const index = Number(event.currentTarget.dataset.index)
    wx.showModal({
      title: "删除商品",
      content: "确认从购物车移除该商品吗？",
      success: res => {
        if (!res.confirm) return
        this.refresh(this.data.items.filter((_, itemIndex) => itemIndex !== index))
      }
    })
  },

  checkout() {
    const selected = this.data.items.filter(item => item.selected !== false)
    if (!selected.length) {
      wx.showToast({ title: "请选择商品", icon: "none" })
      return
    }
    wx.navigateTo({ url: `/pages/checkout/checkout?cartItems=${encodeURIComponent(JSON.stringify(selected))}` })
  },

  goShopping() {
    wx.navigateTo({ url: "/pages/category/list?primary=%E6%97%A5%E7%94%A8%E5%A5%BD%E8%B4%A7" })
  }
})
