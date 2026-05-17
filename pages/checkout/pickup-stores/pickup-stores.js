Page({
  data: {
    stores: [],
    selectedId: ""
  },

  onLoad() {
    const stores = wx.getStorageSync("checkoutPickupStores") || []
    const selectedId = wx.getStorageSync("checkoutSelectedPickupStoreId") || ""
    this.setData({
      stores: Array.isArray(stores) ? stores : [],
      selectedId
    })
  },

  selectStore(event) {
    const id = event.currentTarget.dataset.id || ""
    if (!id) return
    wx.setStorageSync("checkoutSelectedPickupStoreId", id)
    this.setData({ selectedId: id })
    wx.navigateBack()
  }
})
